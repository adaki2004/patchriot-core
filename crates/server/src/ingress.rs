//! Explicit client-address trust and short-lived public-auth capacity limits.
use crate::{ApiError, AppState, Config};
use axum::{
    Extension,
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

/// Header mode is an operator assertion that every path to this listener passes
/// through a trusted ingress which overwrites X-Real-IP. It is never inferred
/// from a hostname, another forwarding header, or a private socket address.
pub(crate) fn client_address(
    config: &Config,
    headers: &HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
) -> Result<String, ApiError> {
    let address = if config.trust_client_ip_header {
        let mut values = headers.get_all("x-real-ip").iter();
        let raw = values
            .next()
            .filter(|_| values.next().is_none())
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| ApiError::bad("invalid_client_address"))?;
        raw.parse::<IpAddr>()
            .map_err(|_| ApiError::bad("invalid_client_address"))?
    } else if let Some(Extension(ConnectInfo(peer))) = peer {
        peer.ip()
    } else {
        // In-process callers without socket metadata share a conservative bucket.
        return Ok("unknown-peer".into());
    };
    Ok(match address {
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map_or_else(|| ip.to_string(), |v| v.to_string()),
        IpAddr::V4(ip) => ip.to_string(),
    })
}

/// Bound concurrent public authentication without letting one burst exhaust a
/// shared fifteen-minute sign-in allowance for every other customer.
pub(crate) async fn public_capacity(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    let limited = path == "/login"
        || path.starts_with("/api/auth/")
            && !matches!(path, "/api/auth/providers" | "/api/auth/logout");
    if !limited {
        return next.run(request).await;
    }
    let Ok(_permit) = state.public_auth_slots.try_acquire() else {
        return ApiError::new(StatusCode::TOO_MANY_REQUESTS, "try_again_later").into_response();
    };
    // Includes body extraction: an unfinished upload must not hold one of the
    // shared slots indefinitely. Human interaction happens between requests,
    // not inside the bounded OAuth callback or password submission.
    match tokio::time::timeout(Duration::from_secs(30), next.run(request)).await {
        Ok(response) => response,
        Err(_) => {
            ApiError::new(StatusCode::REQUEST_TIMEOUT, "auth_request_timeout").into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(source: &str) -> Config {
        Config::new(
            "https://app.example".into(),
            "http://localhost:7411".into(),
            "k".repeat(32),
            None,
        )
        .unwrap()
        .with_client_ip_source(source)
        .unwrap()
    }
    fn peer() -> Option<Extension<ConnectInfo<SocketAddr>>> {
        Some(Extension(ConnectInfo("127.0.0.1:1234".parse().unwrap())))
    }
    #[test]
    fn socket_mode_ignores_forged_forwarding_headers() {
        let mut h = HeaderMap::new();
        h.insert("x-real-ip", "198.51.100.4".parse().unwrap());
        h.insert("x-forwarded-for", "203.0.113.5".parse().unwrap());
        assert_eq!(
            client_address(&config("peer"), &h, peer()).ok().unwrap(),
            "127.0.0.1"
        );
    }
    #[test]
    fn trusted_mode_separates_clients_and_canonicalizes_addresses() {
        let c = config("trusted_x_real_ip");
        let mut h = HeaderMap::new();
        for (input, expected) in [
            ("198.51.100.4", "198.51.100.4"),
            ("198.51.100.5", "198.51.100.5"),
            ("::ffff:198.51.100.4", "198.51.100.4"),
            ("2001:db8:0::1", "2001:db8::1"),
        ] {
            h.insert("x-real-ip", input.parse().unwrap());
            assert_eq!(client_address(&c, &h, peer()).ok().unwrap(), expected);
        }
    }
    #[test]
    fn missing_ambiguous_and_invalid_trusted_headers_fail_closed() {
        let c = config("trusted_x_real_ip");
        let mut h = HeaderMap::new();
        assert!(client_address(&c, &h, peer()).is_err());
        for bad in [
            "198.51.100.1, 198.51.100.2",
            "unknown",
            "198.51.100.1:80",
            "[2001:db8::1]",
            " 198.51.100.1",
        ] {
            h.insert("x-real-ip", bad.parse().unwrap());
            assert!(client_address(&c, &h, peer()).is_err());
        }
        h.insert("x-real-ip", "198.51.100.1".parse().unwrap());
        h.append("x-real-ip", "198.51.100.2".parse().unwrap());
        assert!(client_address(&c, &h, peer()).is_err());
        assert!(
            config("peer")
                .with_client_ip_source("trust_everything")
                .is_err()
        );
    }
}

#[cfg(test)]
mod capacity_tests {
    use super::*;
    use axum::{Router, body::Body, routing::get};
    use std::sync::Arc;
    use tower::ServiceExt;
    #[tokio::test]
    async fn active_auth_is_bounded_and_cancel_releases_the_slot() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/unused")
            .unwrap();
        let config = Config::new(
            "https://example.com".into(),
            "http://localhost:7411".into(),
            "k".repeat(32),
            None,
        )
        .unwrap();
        let state = AppState::new(pool, config).unwrap();
        let slots = state.public_auth_slots.clone();
        let held = slots.clone().acquire_many_owned(31).await.unwrap();
        let entered = Arc::new(tokio::sync::Notify::new());
        let signal = entered.clone();
        let app = Router::new()
            .route(
                "/api/auth/fixture",
                get(move || {
                    let signal = signal.clone();
                    async move {
                        signal.notify_one();
                        std::future::pending::<()>().await;
                        "done"
                    }
                }),
            )
            .route("/api/auth/providers", get(|| async { "providers" }))
            .layer(axum::middleware::from_fn_with_state(state, public_capacity));
        let running = tokio::spawn(
            app.clone().oneshot(
                Request::builder()
                    .uri("/api/auth/fixture")
                    .body(Body::empty())
                    .unwrap(),
            ),
        );
        entered.notified().await;
        assert_eq!(slots.available_permits(), 0);
        let busy = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/auth/fixture")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(busy.status(), StatusCode::TOO_MANY_REQUESTS);
        let providers = app
            .oneshot(
                Request::builder()
                    .uri("/api/auth/providers")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(providers.status(), StatusCode::OK);
        running.abort();
        let _ = running.await;
        assert_eq!(slots.available_permits(), 1);
        drop(held);
        assert_eq!(slots.available_permits(), 32);
    }

    #[tokio::test(start_paused = true)]
    async fn unfinished_auth_body_times_out_and_releases_capacity() {
        struct StalledBody;
        impl http_body::Body for StalledBody {
            type Data = axum::body::Bytes;
            type Error = std::io::Error;
            fn poll_frame(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>>
            {
                std::task::Poll::Pending
            }
        }
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/unused")
            .unwrap();
        let config = Config::new(
            "https://example.com".into(),
            "http://localhost:7411".into(),
            "k".repeat(32),
            None,
        )
        .unwrap();
        let state = AppState::new(pool, config).unwrap();
        let slots = state.public_auth_slots.clone();
        let app = Router::new()
            .route(
                "/api/auth/fixture",
                axum::routing::post(|_: axum::body::Bytes| async { "done" }),
            )
            .layer(axum::middleware::from_fn_with_state(state, public_capacity));
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/fixture")
                    .body(Body::new(StalledBody))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
        assert_eq!(slots.available_permits(), 32);
        let next = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/fixture")
                    .body(Body::from("small complete request"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(next.status(), StatusCode::OK);
        assert_eq!(slots.available_permits(), 32);
    }
}
