//! Optional public page counts. Third-party code runs in an opaque sandbox,
//! never in the application document that holds accounts and private reports.
use crate::{ApiError, AppState};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Response},
};

pub(crate) fn valid_id(id: &str) -> bool {
    id.starts_with("G-")
        && (6..=22).contains(&id.len())
        && id[2..]
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

pub(crate) async fn settings(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({"enabled":state.config.ga_measurement_id.is_some()}))
}

pub(crate) async fn frame(
    State(state): State<AppState>,
    Path(page): Path<String>,
) -> Result<Response, ApiError> {
    let id = state
        .config
        .ga_measurement_id
        .as_deref()
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "not_found"))?;
    let (path, title) = match page.as_str() {
        "home" => ("/", "Patchriot"),
        "docs" => ("/docs", "Patchriot documentation"),
        "events" => ("/events", "Patchriot recent events"),
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
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\"><title>Optional public page counts</title></head><body><script nonce=\"{nonce}\" data-measurement-id=\"{id}\" data-parent-origin=\"{}\" data-page-location=\"{}{path}\" data-page-title=\"{title}\">{}</script></body></html>",
        escape(origin),
        escape(origin),
        include_str!("analytics.js")
    );
    let mut response = Html(html).into_response();
    // Also sandbox direct navigation. No same-origin privilege, form, popup,
    // top navigation, application fetch, or arbitrary exfiltration destination.
    let policy = format!(
        "sandbox allow-scripts; default-src 'none'; script-src 'nonce-{nonce}' https://www.googletagmanager.com; connect-src https://www.google-analytics.com https://region1.google-analytics.com; img-src https://www.google-analytics.com https://region1.google-analytics.com; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
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
        for page in ["reviews", "orders", "activate", "auth", "customer-id"] {
            let reply = app(Some("G-EXAMPLE123"))
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/analytics/frame/{page}"))
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
        assert_eq!(
            reply.into_body().collect().await.unwrap().to_bytes(),
            "{\"enabled\":false}"
        );
    }

    #[tokio::test]
    async fn only_the_opaque_frame_can_load_google_and_it_never_uses_incoming_urls_or_headers() {
        for page in ["home", "docs", "events"] {
            let reply = app(Some("G-EXAMPLE123"))
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/analytics/frame/{page}?token=PRIVATE_QUERY"))
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
            assert!(policy.starts_with("sandbox allow-scripts;"));
            assert!(!policy.contains("allow-same-origin") && !policy.contains("unsafe-inline"));
            assert!(
                policy.contains("frame-ancestors 'self'")
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
        assert!(policy.contains("script-src 'self'") && policy.contains("frame-src 'self'"));
        assert!(!policy.contains("google"));
    }
}
