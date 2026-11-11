//! Optional workspace page counts. Third-party code runs on a separate hostname,
//! never in the application document that holds accounts and private reports.
use crate::{ApiError, AppState, auth};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::Next,
    response::{Html, IntoResponse, Response},
};

pub(crate) fn valid_id(id: &str) -> bool {
    id.starts_with("G-")
        && (6..=22).contains(&id.len())
        && id[2..]
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

fn frame_host(headers: &HeaderMap, state: &AppState) -> bool {
    state
        .config
        .analytics_origin
        .as_deref()
        .and_then(|value| url::Url::parse(value).ok())
        .is_some_and(|origin| {
            headers.get(header::HOST).and_then(|h| h.to_str().ok()) == Some(origin.authority())
        })
}

/// The analytics hostname serves only the isolated frame, never account APIs
/// or the website. It must not become a second login origin later.
pub(crate) async fn host_boundary(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    if frame_host(request.headers(), &state)
        && !request.uri().path().starts_with("/api/analytics/frame/")
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    next.run(request).await
}

pub(crate) async fn settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    auth::require_session(&headers, &state).await?;
    Ok(Json(
        serde_json::json!({"enabled":state.config.ga_measurement_id.is_some() && state.config.analytics_origin.is_some(), "frame_origin":state.config.analytics_origin}),
    ))
}

pub(crate) async fn frame(
    State(state): State<AppState>,
    Path(page): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    // Never serve this same-origin-capable frame on the account hostname.
    // Do not trust a caller's X-Forwarded-Host as the browser's authority.
    if !frame_host(&headers, &state) {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "not_found"));
    }
    let id = state
        .config
        .ga_measurement_id
        .as_deref()
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "not_found"))?;
    let (path, title) = match page.as_str() {
        "dashboard" => ("/workspace/dashboard", "Patchriot workspace"),
        "audits" => ("/workspace/audits", "Patchriot audits"),
        "setup" => ("/workspace/setup", "Patchriot test setup"),
        "report" => ("/workspace/report", "Patchriot report"),
        "account" => ("/workspace/account", "Patchriot account"),
        "orders" => ("/workspace/orders", "Patchriot orders"),
        "agents" => ("/workspace/agents", "Patchriot agents"),
        _ => return Err(ApiError::new(StatusCode::NOT_FOUND, "not_found")),
    };
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let origin = &state.config.public_origin;
    let escape = |s: &str| {
        s.replace('&', "&amp;")
            .replace('"', "&quot;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\"><title>Optional workspace page counts</title></head><body><script nonce=\"{nonce}\" data-measurement-id=\"{id}\" data-parent-origin=\"{}\" data-page-location=\"{}{path}\" data-page-title=\"{title}\">{}</script></body></html>",
        escape(origin),
        escape(origin),
        include_str!("analytics.js")
    );
    let mut response = Html(html).into_response();
    // Google needs a real origin even with analytics storage denied. The
    // separate hostname and host-only app cookies preserve account isolation.
    // Forms, popups, top navigation and application fetches remain prohibited.
    let policy = format!(
        "sandbox allow-scripts allow-same-origin; default-src 'none'; script-src 'nonce-{nonce}' https://www.googletagmanager.com; connect-src https://www.google-analytics.com https://region1.google-analytics.com; img-src https://www.google-analytics.com https://region1.google-analytics.com; frame-ancestors {origin}; base-uri 'none'; form-action 'none'"
    );
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_str(&policy).expect("fixed policy and hex nonce"),
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn app(id: Option<&str>) -> axum::Router {
        let config = crate::Config::new(
            "https://patchriot.example".into(),
            "http://127.0.0.1:1".into(),
            "x".repeat(32),
            None,
        )
        .unwrap()
        .with_ga_measurement_id(id.map(str::to_owned))
        .unwrap()
        .with_analytics_origin(id.map(|_| "https://counts.example".to_owned()))
        .unwrap();
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/unused")
            .unwrap();
        crate::router(AppState::new(pool, config).unwrap())
    }

    #[tokio::test]
    async fn analytics_is_off_by_default_and_rejects_private_or_injected_page_names() {
        for uri in ["/api/analytics/frame/home", "/api/analytics/frame/reviews"] {
            let reply = app(None)
                .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(reply.status(), StatusCode::NOT_FOUND);
        }
        for page in ["home", "docs", "events", "activate", "auth", "customer-id"] {
            let reply = app(Some("G-EXAMPLE123"))
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/analytics/frame/{page}"))
                        .header("host", "counts.example")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(reply.status(), StatusCode::NOT_FOUND);
        }
        for id in [
            "",
            "G-<script>",
            "G-test",
            "G-EXAMPLE?x=1",
            "G-EXAMPLE\n",
            "G-😀😀",
        ] {
            assert!(!valid_id(id));
        }
        let reply = app(None)
            .oneshot(
                Request::builder()
                    .uri("/api/analytics")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(reply.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn only_the_separate_frame_can_load_google_and_it_never_uses_incoming_urls_or_headers() {
        for page in ["dashboard", "setup", "report"] {
            let reply = app(Some("G-EXAMPLE123"))
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/analytics/frame/{page}?token=PRIVATE_QUERY"))
                        .header("host", "counts.example")
                        .header("referer", "https://private.example/SECRET_REPORT")
                        .header("cookie", "session=PRIVATE_COOKIE")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(reply.status(), StatusCode::OK);
            let policy = reply.headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .to_owned();
            assert!(policy.starts_with("sandbox allow-scripts allow-same-origin;"));
            assert!(!policy.contains("unsafe-inline"));
            assert!(
                policy.contains("frame-ancestors https://patchriot.example;")
                    && policy.contains("connect-src https://www.google-analytics.com")
            );
            assert!(!policy.contains("connect-src 'self'"));
            assert_eq!(reply.headers()[header::REFERRER_POLICY], "no-referrer");
            assert_eq!(reply.headers()[header::CACHE_CONTROL], "no-store");
            let body = String::from_utf8(
                reply
                    .into_body()
                    .collect()
                    .await
                    .unwrap()
                    .to_bytes()
                    .to_vec(),
            )
            .unwrap();
            assert!(body.contains(include_str!("analytics.js")) && body.contains("G-EXAMPLE123"));
            assert!(!body.contains("PRIVATE_") && !body.contains("SECRET_REPORT"));
            let nonce = body
                .split("nonce=\"")
                .nth(1)
                .unwrap()
                .split('"')
                .next()
                .unwrap();
            assert_eq!(nonce.len(), 32);
            assert!(policy.contains(&format!("'nonce-{nonce}'")));
        }
        let reply = app(Some("G-EXAMPLE123"))
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let policy = reply.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap();
        assert!(
            policy.contains("script-src 'self'")
                && policy.contains("frame-src https://counts.example")
        );
        assert!(!policy.contains("google"));
    }

    #[tokio::test]
    async fn analytics_host_cannot_serve_the_app_and_forwarded_host_cannot_enable_a_frame() {
        for (host, path) in [
            ("patchriot.example", "/api/analytics/frame/home"),
            ("counts.example", "/api/session"),
            ("counts.example", "/api/auth/login"),
            ("counts.example", "/"),
        ] {
            let reply = app(Some("G-EXAMPLE123"))
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .header("host", host)
                        .header("x-forwarded-host", "counts.example")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(reply.status(), StatusCode::NOT_FOUND);
        }
    }

    #[test]
    fn configuration_requires_a_separate_hostname_and_rejects_url_payloads() {
        for origin in [
            "https://patchriot.example",
            "https://patchriot.example:8443",
            "https://elsewhere.example/path",
            "https://user@elsewhere.example",
            "http://elsewhere.example",
            "https://elsewhere.example/?token=x",
        ] {
            let config = crate::Config::new(
                "https://patchriot.example".into(),
                "http://127.0.0.1:1".into(),
                "x".repeat(32),
                None,
            )
            .unwrap()
            .with_ga_measurement_id(Some("G-EXAMPLE123".into()))
            .unwrap();
            assert!(config.with_analytics_origin(Some(origin.into())).is_err());
        }
        let config = crate::Config::new(
            "https://patchriot.example".into(),
            "http://127.0.0.1:1".into(),
            "x".repeat(32),
            None,
        )
        .unwrap();
        assert!(
            config
                .with_analytics_origin(Some("https://counts.example".into()))
                .is_err()
        );
    }
}
