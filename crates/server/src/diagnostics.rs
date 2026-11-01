//! API timings stop when a response is ready, before its body is transferred.
//! Logs contain route templates, never submitted URLs, record IDs or credentials.

use axum::{
    extract::{MatchedPath, Request},
    http::{HeaderValue, Method},
    middleware::Next,
    response::Response,
};
use serde::Serialize;
use std::{
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};
use uuid::Uuid;

/// Set only by our fixed API errors; upstream response bodies are never logged.
#[derive(Clone, Copy)]
pub(crate) struct ErrorCode(pub &'static str);

#[derive(Serialize)]
struct RequestLabel {
    method: &'static str,
    route: String,
}

impl RequestLabel {
    fn from_request(request: &Request) -> Self {
        let method = match *request.method() {
            Method::GET => "GET",
            Method::HEAD => "HEAD",
            Method::POST => "POST",
            Method::PUT => "PUT",
            Method::PATCH => "PATCH",
            Method::DELETE => "DELETE",
            Method::OPTIONS => "OPTIONS",
            _ => "OTHER",
        };
        Self {
            method,
            route: request
                .extensions()
                .get::<MatchedPath>()
                .map(|path| path.as_str())
                .unwrap_or("unmatched")
                .to_owned(),
        }
    }
}

// One slow/error event per second per process. A failing upstream must not fill
// the journal with a line for every poll. This is a diagnostic sample, not audit history.
#[derive(Default)]
struct LogWindow {
    next_ms: AtomicU64,
    skipped: AtomicU64,
}

impl LogWindow {
    fn take(&self, now_ms: u64) -> Option<u64> {
        let next = self.next_ms.load(Ordering::Relaxed);
        if now_ms < next
            || self
                .next_ms
                .compare_exchange(
                    next,
                    now_ms.saturating_add(1000),
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                )
                .is_err()
        {
            self.skipped.fetch_add(1, Ordering::Relaxed);
            None
        } else {
            Some(self.skipped.swap(0, Ordering::Relaxed))
        }
    }
}

#[derive(Serialize)]
struct Event<'a> {
    event: &'static str,
    request_id: Uuid,
    #[serde(flatten)]
    label: &'a RequestLabel,
    status: u16,
    elapsed_ms: u64,
    skipped_events: u64,
    error: Option<&'static str>,
}

pub(crate) async fn response_time(request: Request, next: Next) -> Response {
    let path = request.uri().path();
    if path != "/api" && !path.starts_with("/api/") {
        return next.run(request).await;
    }
    let label = RequestLabel::from_request(&request);
    // Do not trust a caller-supplied identifier or echo its contents into logs.
    let request_id = Uuid::new_v4();
    let started = Instant::now();
    let mut response = next.run(request).await;
    let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    response.headers_mut().insert(
        "x-request-id",
        HeaderValue::from_str(&request_id.to_string()).expect("UUID is a valid header"),
    );
    response.headers_mut().insert(
        "server-timing",
        HeaderValue::from_str(&format!("core;dur={elapsed_ms}"))
            .expect("integer timing is a valid header"),
    );
    if response.status().is_server_error() || elapsed_ms >= 1000 {
        static EPOCH: OnceLock<Instant> = OnceLock::new();
        static WINDOW: LogWindow = LogWindow {
            next_ms: AtomicU64::new(0),
            skipped: AtomicU64::new(0),
        };
        let now = EPOCH
            .get_or_init(Instant::now)
            .elapsed()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        if let Some(skipped_events) = WINDOW.take(now) {
            let event = Event {
                event: "core_request",
                request_id,
                label: &label,
                status: response.status().as_u16(),
                elapsed_ms,
                skipped_events,
                error: response.extensions().get::<ErrorCode>().map(|code| code.0),
            };
            if let Ok(line) = serde_json::to_string(&event) {
                eprintln!("{line}");
            }
        }
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        body::Body,
        http::StatusCode,
        middleware,
        routing::{get, post},
    };
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn timing_preserves_replies_and_labels_never_include_private_inputs() {
        let app = Router::new()
            .route(
                "/api/reviews/{id}",
                post(|request: Request| async move {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    Json(RequestLabel::from_request(&request))
                }),
            )
            .route(
                "/api/fail",
                get(|| async { (StatusCode::SERVICE_UNAVAILABLE, "fixed error") }),
            )
            .layer(middleware::from_fn(response_time));
        let first = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/reviews/private-record?code=private-query")
                    .header("cookie", "private-cookie")
                    .header("authorization", "private-key")
                    .header("x-request-id", "private-client-id")
                    .body(Body::from("private-body"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let id = first.headers()["x-request-id"].to_str().unwrap();
        assert!(Uuid::parse_str(id).is_ok());
        assert_ne!(id, "private-client-id");
        let duration: u64 = first.headers()["server-timing"]
            .to_str()
            .unwrap()
            .strip_prefix("core;dur=")
            .unwrap()
            .parse()
            .unwrap();
        assert!(duration >= 20);
        let body = first.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({"method":"POST","route":"/api/reviews/{id}"})
        );
        let failed = app
            .oneshot(
                Request::builder()
                    .uri("/api/fail")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(failed.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(failed.headers().contains_key("server-timing"));
        assert_eq!(
            failed.into_body().collect().await.unwrap().to_bytes(),
            "fixed error"
        );
    }

    #[tokio::test]
    async fn static_files_are_not_timed_and_bad_methods_do_not_become_log_fields() {
        let label = RequestLabel::from_request(
            &Request::builder()
                .method("PRIVATEVALUE")
                .uri("/private-path")
                .body(Body::empty())
                .unwrap(),
        );
        assert_eq!(label.method, "OTHER");
        assert_eq!(label.route, "unmatched");
        let app = Router::new()
            .route("/", get(|| async { "site" }))
            .route("/api/fleet", get(|| async { "fleet" }))
            .layer(middleware::from_fn(response_time));
        let page = app
            .clone()
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(!page.headers().contains_key("x-request-id"));
        let rejected = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/fleet")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert!(rejected.headers().contains_key("x-request-id"));
    }

    #[test]
    fn concurrent_errors_cannot_flood_the_log_and_suppression_is_reported() {
        let window = LogWindow::default();
        let results = std::thread::scope(|scope| {
            let threads: Vec<_> = (0..16).map(|_| scope.spawn(|| window.take(0))).collect();
            threads
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert_eq!(results.iter().filter(|value| value.is_some()).count(), 1);
        assert_eq!(window.take(999), None);
        let already_reported: u64 = results.into_iter().flatten().sum();
        assert_eq!(window.take(1000).unwrap() + already_reported, 16);
        assert_eq!(window.take(2000), Some(0));
    }
}
