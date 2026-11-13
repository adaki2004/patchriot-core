//! Optional standard Google Analytics tag configuration. Only public settings leave this route.
use crate::AppState;
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};

pub(crate) fn valid_id(id: &str) -> bool {
    id.starts_with("G-")
        && (6..=22).contains(&id.len())
        && id[2..]
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

/// Fixed Google origins shared by the normal shell and its wallet-enabled policy.
pub(crate) fn csp_sources(enabled: bool) -> (&'static str, &'static str) {
    if enabled {
        (
            " https://www.googletagmanager.com",
            " https://www.google-analytics.com https://region1.google-analytics.com",
        )
    } else {
        ("", "")
    }
}

fn legacy_host(headers: &HeaderMap, state: &AppState) -> bool {
    state
        .config
        .analytics_origin
        .as_deref()
        .and_then(|value| url::Url::parse(value).ok())
        .is_some_and(|origin| {
            headers.get(header::HOST).and_then(|h| h.to_str().ok()) == Some(origin.authority())
        })
}

/// Keep a previously configured analytics hostname from becoming a second login origin.
pub(crate) async fn host_boundary(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    if legacy_host(request.headers(), &state) {
        return StatusCode::NOT_FOUND.into_response();
    }
    next.run(request).await
}

/// The browser needs this before sign-in. Measurement IDs are public, not API secrets.
pub(crate) async fn settings(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "enabled": state.config.ga_measurement_id.is_some(),
        "measurement_id": state.config.ga_measurement_id,
        "workspace_counts_enabled": state.config.workspace_counts_enabled
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn app(id: Option<&str>, legacy_host: bool) -> axum::Router {
        app_with_wallet(id, legacy_host, false)
    }

    fn app_with_wallet(id: Option<&str>, legacy_host: bool, wallet: bool) -> axum::Router {
        let config = crate::Config::new(
            "https://patchriot.example".into(),
            "http://127.0.0.1:1".into(),
            "x".repeat(32),
            None,
        )
        .unwrap()
        .with_ga_measurement_id(id.map(str::to_owned))
        .unwrap()
        .with_analytics_origin(legacy_host.then(|| "https://counts.example".to_owned()))
        .unwrap()
        .with_wallet_project_id(wallet.then(|| "a".repeat(32)))
        .unwrap();
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/unused")
            .unwrap();
        crate::router(AppState::new(pool, config).unwrap())
    }

    #[tokio::test]
    async fn wallet_enabled_home_keeps_google_policy_but_wallet_login_stays_isolated() {
        for id in [None, Some("G-EXAMPLE123")] {
            for path in ["/", "/wallet"] {
                let response = app_with_wallet(id, false, true)
                    .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                    .await
                    .unwrap();
                let policy = response.headers()[header::CONTENT_SECURITY_POLICY]
                    .to_str()
                    .unwrap();
                let google_allowed = path == "/" && id.is_some();
                assert_eq!(
                    policy.contains("https://www.googletagmanager.com"),
                    google_allowed
                );
                assert_eq!(
                    policy.contains("https://www.google-analytics.com"),
                    google_allowed
                );
                assert_eq!(
                    policy.contains("https://region1.google-analytics.com"),
                    google_allowed
                );
                assert!(policy.contains("wss://relay.walletconnect.com"));
                assert!(!policy.contains("script-src 'self' 'unsafe-inline'"));
                assert!(!policy.contains("unsafe-eval"));
            }
        }
    }

    #[tokio::test]
    async fn public_settings_need_no_session_and_analytics_is_off_by_default() {
        for id in [None, Some("G-EXAMPLE123")] {
            let reply = app(id, false)
                .oneshot(
                    Request::builder()
                        .uri("/api/analytics?token=PRIVATE_QUERY")
                        .header("referer", "https://private.example/SECRET_REPORT")
                        .header("cookie", "session=PRIVATE_COOKIE")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(reply.status(), StatusCode::OK);
            assert_eq!(reply.headers()[header::CACHE_CONTROL], "no-store");
            let policy = reply.headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap();
            assert_eq!(
                policy.contains("https://www.googletagmanager.com"),
                id.is_some()
            );
            assert_eq!(
                policy.contains("https://www.google-analytics.com"),
                id.is_some()
            );
            assert!(!policy.contains("script-src 'self' 'unsafe-inline'"));
            assert!(!policy.contains("unsafe-eval"));
            let body = reply.into_body().collect().await.unwrap().to_bytes();
            let data: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(
                data,
                serde_json::json!({"enabled":id.is_some(), "measurement_id":id, "workspace_counts_enabled":false})
            );
        }
    }

    #[tokio::test]
    async fn legacy_analytics_hostname_cannot_serve_the_app_or_account_apis() {
        for path in [
            "/",
            "/api/session",
            "/api/auth/login",
            "/api/analytics",
            "/api/analytics/frame/dashboard",
        ] {
            let reply = app(Some("G-EXAMPLE123"), true)
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .header("host", "counts.example")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(reply.status(), StatusCode::NOT_FOUND);
        }
        let reply = app(Some("G-EXAMPLE123"), true)
            .oneshot(
                Request::builder()
                    .uri("/api/analytics")
                    .header("host", "patchriot.example")
                    .header("x-forwarded-host", "counts.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(reply.status(), StatusCode::OK);
    }

    #[test]
    fn measurement_id_rejects_url_payloads_and_script_injection() {
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
        assert!(valid_id("G-EXAMPLE123"));
    }
}
