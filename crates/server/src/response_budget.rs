//! Keep large private responses inside a fixed memory/concurrency budget through
//! serialization and client delivery, not just while reading the upstream body.
use crate::{ApiError, AppState};
use axum::{
    body::{Body, Bytes, HttpBody},
    http::StatusCode,
    response::Response,
};
use http_body::{Frame, SizeHint};
use std::{
    pin::Pin,
    task::{Context, Poll},
};
use tokio::sync::OwnedSemaphorePermit;

/// Call only after authentication and request-body validation. Slow or
/// unauthenticated uploads must not reserve the private-report budget.
pub(crate) fn acquire(state: &AppState) -> Result<OwnedSemaphorePermit, ApiError> {
    state
        .response_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::new(StatusCode::TOO_MANY_REQUESTS, "try_again_later"))
}
pub(crate) fn deliver(response: Response, permit: OwnedSemaphorePermit) -> Response {
    let (parts, body) = response.into_parts();
    Response::from_parts(
        parts,
        Body::new(BudgetBody {
            body,
            pending: Bytes::new(),
            permit: Some(permit),
        }),
    )
}

/// Small frames prevent a slow reader from moving a complete large allocation
/// into the HTTP writer, releasing its permit, then repeating that attack.
struct BudgetBody {
    body: Body,
    pending: Bytes,
    permit: Option<OwnedSemaphorePermit>,
}
impl HttpBody for BudgetBody {
    type Data = Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        if self.pending.is_empty() {
            match Pin::new(&mut self.body).poll_frame(cx) {
                Poll::Ready(Some(Ok(frame))) => match frame.into_data() {
                    Ok(bytes) => self.pending = bytes,
                    Err(frame) => return Poll::Ready(Some(Ok(frame))),
                },
                Poll::Ready(end) => {
                    self.pending = Bytes::new();
                    self.body = Body::empty();
                    self.permit.take();
                    return Poll::Ready(end);
                }
                Poll::Pending => return Poll::Pending,
            }
        }
        let size = self.pending.len().min(64 * 1024);
        Poll::Ready(Some(Ok(Frame::data(self.pending.split_to(size)))))
    }
    fn size_hint(&self) -> SizeHint {
        let mut hint = self.body.size_hint();
        let pending = self.pending.len() as u64;
        let upper = hint.upper().map(|v| v.saturating_add(pending));
        hint.set_lower(hint.lower().saturating_add(pending));
        if let Some(upper) = upper {
            hint.set_upper(upper);
        }
        hint
    }
}

/// Background payment readers share the same budget, with bounded waiting and
/// their existing retry paths when it is busy. The permit follows the
/// parsed value until the caller finishes using it, including across awaits.
pub(crate) struct ReviewLease {
    pub(crate) value: patchriot_protocol::ReviewView,
    pub(crate) _permit: OwnedSemaphorePermit,
}
impl std::ops::Deref for ReviewLease {
    type Target = patchriot_protocol::ReviewView;
    fn deref(&self) -> &Self::Target {
        &self.value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use std::sync::Arc;
    #[tokio::test]
    async fn permit_covers_delivery_and_cancel_releases_it() {
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = slots.clone().try_acquire_owned().unwrap();
        let mut body = BudgetBody {
            body: Body::from(vec![0; 200_000]),
            pending: Bytes::new(),
            permit: Some(permit),
        };
        assert_eq!(
            body.frame()
                .await
                .unwrap()
                .unwrap()
                .into_data()
                .unwrap()
                .len(),
            65536
        );
        assert_eq!(slots.available_permits(), 0);
        drop(body);
        assert_eq!(slots.available_permits(), 1);
        let mut body = BudgetBody {
            body: Body::from("small"),
            pending: Bytes::new(),
            permit: Some(slots.clone().try_acquire_owned().unwrap()),
        };
        assert!(body.frame().await.is_some());
        assert_eq!(slots.available_permits(), 0);
        assert!(body.frame().await.is_none());
        assert_eq!(slots.available_permits(), 1);
    }
    #[tokio::test]
    async fn background_readers_wait_without_buffering_and_cancel_releases_capacity() {
        use axum::{Json, Router, routing::get};
        use serde_json::json;
        use uuid::Uuid;
        let entered = Arc::new(tokio::sync::Notify::new());
        let signal = entered.clone();
        let app=Router::new().route("/ok",get(|| async {Json(json!({"id":Uuid::nil(),"request_id":Uuid::nil(),"scenario":"website_snapshot_v1","mode":"website_agent","state":"completed","created_at":1,"deadline_at":2,"evidence_source":"fixture","steps":[]}))}))
            .route("/bad",get(|| async {"not json: private upstream content"}))
            .route("/private-error",get(|| async {(StatusCode::INTERNAL_SERVER_ERROR,"private credentials must not escape")}))
            .route("/slow",get(move || {let signal=signal.clone();async move {signal.notify_one();std::future::pending::<()>().await;"done"}}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/unused")
            .unwrap();
        let state = AppState::new(
            pool,
            crate::Config::new("https://example.com".into(), url, "k".repeat(32), None).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            state.review_access,
            crate::payments::access::ReviewAccess::Closed
        ));
        let read = |state: AppState, path: &'static str| async move {
            crate::gateway::request_review_for_account::<()>(
                &state,
                reqwest::Method::GET,
                path,
                Uuid::nil(),
                None,
            )
            .await
        };
        let first = read(state.clone(), "/ok").await.ok().unwrap();
        let waiting = tokio::spawn(read(state.clone(), "/ok"));
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!waiting.is_finished());
        drop(first);
        let second = tokio::time::timeout(std::time::Duration::from_secs(1), waiting)
            .await
            .unwrap()
            .unwrap()
            .ok()
            .unwrap();
        assert_eq!(state.response_slots.available_permits(), 0);
        drop(second);
        for (path, code) in [
            ("/bad", "invalid_dispatcher_response"),
            ("/private-error", "dispatcher_unavailable"),
        ] {
            let err = read(state.clone(), path).await.err().unwrap();
            assert_eq!(err.code, code);
            assert_eq!(state.response_slots.available_permits(), 1);
        }
        let running = tokio::spawn(read(state.clone(), "/slow"));
        entered.notified().await;
        assert_eq!(state.response_slots.available_permits(), 0);
        running.abort();
        let _ = running.await;
        assert_eq!(state.response_slots.available_permits(), 1);
        server.abort();
    }
}
