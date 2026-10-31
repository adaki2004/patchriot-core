//! Browser sessions and an authenticated gateway to the private dispatcher.
//! Prototype access uses one-use invitations. Google federation is a separate
//! integration; an invitation must never be presented as a verified Google identity.

mod auth;
mod gateway;
mod incidents;
pub mod payments;

use axum::{
    Json, Router,
    extract::DefaultBodyLimit,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Serialize;
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

pub use auth::{create_invite, disable_account, invite_account};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
    pub client: reqwest::Client,
}

pub struct Config {
    pub public_origin: String,
    pub dispatcher_url: String,
    pub internal_key: String,
    pub web_root: Option<PathBuf>,
    pub secure_cookies: bool,
}

impl Config {
    pub fn new(
        public_origin: String,
        dispatcher_url: String,
        internal_key: String,
        web_root: Option<PathBuf>,
    ) -> Result<Self, &'static str> {
        fn origin(value: &str) -> Result<url::Url, &'static str> {
            let url = url::Url::parse(value).map_err(|_| "invalid service URL")?;
            let local = match url.host() {
                Some(url::Host::Domain("localhost")) => true,
                Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                _ => false,
            };
            if !(url.scheme() == "https" || url.scheme() == "http" && local)
                || !url.username().is_empty()
                || url.password().is_some()
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(
                    "service URLs require HTTPS except explicit loopback, and cannot contain credentials, paths or queries",
                );
            }
            Ok(url)
        }
        let public = origin(&public_origin)?;
        let dispatcher = origin(&dispatcher_url)?;
        if internal_key.len() < 32
            || internal_key.len() > 256
            || internal_key.chars().any(char::is_whitespace)
        {
            return Err("invalid internal service key");
        }
        Ok(Self {
            secure_cookies: public.scheme() == "https",
            public_origin: public.origin().ascii_serialization(),
            dispatcher_url: dispatcher.origin().ascii_serialization(),
            internal_key,
            web_root,
        })
    }

    fn cookie_name(&self) -> &'static str {
        if self.secure_cookies {
            "__Host-patchriot_session"
        } else {
            "patchriot_dev_session"
        }
    }
}

impl AppState {
    pub fn new(pool: PgPool, config: Config) -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .build()?;
        Ok(Self {
            pool,
            config: Arc::new(config),
            client,
        })
    }
}

pub async fn connect(url: &str) -> Result<PgPool, sqlx::Error> {
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(5))
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query("SET search_path TO patchriot_core")
                    .execute(&mut *connection)
                    .await?;
                sqlx::query("SET statement_timeout = '5s'")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect(url)
        .await?;
    sqlx::query("CREATE SCHEMA IF NOT EXISTS patchriot_core")
        .execute(&pool)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

pub fn router(state: AppState) -> Router {
    let mut routes = Router::new()
        .route(
            "/api/health",
            get(|| async {
                Json(serde_json::json!({"status":"ok", "version":env!("CARGO_PKG_VERSION")}))
            }),
        )
        .route("/api/session", get(auth::session))
        .route("/api/payments", get(payments::summary))
        .route("/api/incidents", get(incidents::list))
        .route("/api/admin/incidents", get(incidents::drafts))
        .route("/api/admin/incidents/{id}", post(incidents::edit))
        .route("/api/auth/redeem", post(auth::redeem))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/fleet", get(gateway::fleet))
        .route("/api/devices", get(gateway::devices))
        .route("/api/pairings/claim", post(gateway::claim))
        .route("/api/devices/{id}/decision", post(gateway::decision))
        .route(
            "/api/reviews",
            get(gateway::reviews).post(gateway::create_review),
        )
        .route("/api/reviews/{id}", get(gateway::review))
        .route("/api/reviews/{id}/cancel", post(gateway::cancel_review))
        .route("/api/reviews/{id}/report", get(gateway::report))
        .route(
            "/api/{*path}",
            axum::routing::any(|| async { ApiError::new(StatusCode::NOT_FOUND, "not_found") }),
        )
        .route(
            "/api",
            axum::routing::any(|| async { ApiError::new(StatusCode::NOT_FOUND, "not_found") }),
        );
    if let Some(root) = &state.config.web_root {
        routes = routes.fallback_service(
            ServeDir::new(root).not_found_service(ServeFile::new(root.join("index.html"))),
        );
    }
    routes.layer(DefaultBodyLimit::max(16 * 1024))
        .layer(SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("no-store")))
        .layer(SetResponseHeaderLayer::overriding(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::overriding(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")))
        .layer(SetResponseHeaderLayer::overriding(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")))
        .with_state(state)
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}
pub(crate) struct ApiError {
    status: StatusCode,
    code: &'static str,
}
impl ApiError {
    fn new(status: StatusCode, code: &'static str) -> Self {
        Self { status, code }
    }
    fn denied() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "sign_in_required")
    }
    fn bad(code: &'static str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(ErrorBody { error: self.code })).into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(_: sqlx::Error) -> Self {
        eprintln!("core database operation failed");
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "database_unavailable")
    }
}
