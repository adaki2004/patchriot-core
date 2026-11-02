//! Browser sessions and an authenticated gateway to the private dispatcher.
//! Prototype access uses approved invitations and passwords. Google federation is a separate
//! integration; an invitation must never be presented as a verified Google identity.

mod access;
mod auth;
mod diagnostics;
mod gateway;
mod incidents;
pub mod payments;
pub mod review_codes;
mod review_target;
mod sites;
mod sources;

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

pub use access::bootstrap_admin;
pub use auth::{create_invite, disable_account, invite_account};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
    pub client: reqwest::Client,
    pub(crate) review_access: payments::access::ReviewAccess,
    pub(crate) payouts: Option<Arc<payments::payouts::PayoutService>>,
}

pub struct Config {
    pub public_origin: String,
    pub dispatcher_url: String,
    /// Public relay endpoint, configured separately from the private gateway URL.
    pub relay_origin: Option<String>,
    pub internal_key: String,
    pub web_root: Option<PathBuf>,
    pub secure_cookies: bool,
}

impl Config {
    fn origin(value: &str) -> Result<url::Url, &'static str> {
        let url = url::Url::parse(value).map_err(|_| "invalid service URL")?;
        let local = match url.host() {
            Some(url::Host::Domain("localhost")) => true,
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        };
        if !(url.scheme() == "https" || url.scheme() == "http" && local)
            || url.host().is_none()
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

    pub fn with_relay_origin(mut self, value: Option<String>) -> Result<Self, &'static str> {
        self.relay_origin = value
            .map(|value| Self::origin(&value).map(|url| url.origin().ascii_serialization()))
            .transpose()?;
        Ok(self)
    }

    pub fn new(
        public_origin: String,
        dispatcher_url: String,
        internal_key: String,
        web_root: Option<PathBuf>,
    ) -> Result<Self, &'static str> {
        let public = Self::origin(&public_origin)?;
        let dispatcher = Self::origin(&dispatcher_url)?;
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
            relay_origin: None,
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
            review_access: payments::access::ReviewAccess::default(),
            payouts: None,
        })
    }

    pub fn with_review_access(mut self, access: payments::access::ReviewAccess) -> Self {
        self.review_access = access;
        self
    }
    pub fn with_payouts(mut self, service: Arc<payments::payouts::PayoutService>) -> Self {
        self.payouts = Some(service);
        self
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
    // PostgreSQL checks database CREATE permission even with IF NOT EXISTS.
    // A provisioned service role only needs to own its existing schema.
    let schema_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'patchriot_core')",
    )
    .fetch_one(&pool)
    .await?;
    if !schema_exists {
        sqlx::query("CREATE SCHEMA IF NOT EXISTS patchriot_core")
            .execute(&pool)
            .await?;
    }
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
        .route("/api/earnings", get(payments::earnings::list))
        .route(
            "/api/withdrawals",
            get(payments::payouts::list).post(payments::payouts::create),
        )
        .route(
            "/api/withdrawals/{id}/confirm",
            post(payments::payouts::confirm),
        )
        .route(
            "/api/withdrawals/{id}/cancel",
            post(payments::payouts::cancel),
        )
        .route("/api/admin/treasury", get(payments::payouts::desk))
        .route("/api/admin/payments", get(payments::desk::list))
        .route("/api/checkout", get(payments::access::settings))
        .route("/api/review-codes", get(review_codes::list))
        .route("/api/review-codes/{id}/resume", post(review_codes::resume))
        .route(
            "/api/site-checks/{id}/review-code",
            post(review_codes::redeem),
        )
        .route(
            "/api/site-checks/{id}/checkout",
            post(payments::browser_checkout::create),
        )
        .route(
            "/api/orders/{id}/quote",
            post(payments::browser_checkout::resume),
        )
        .route("/api/orders", get(payments::orders::list))
        .route("/api/orders/{id}", get(payments::orders::detail))
        .route("/api/orders/{id}/cancel", post(payments::orders::cancel))
        .route("/api/incidents", get(incidents::list))
        .route("/api/admin/incidents", get(incidents::drafts))
        .route("/api/admin/incidents/{id}", post(incidents::edit))
        .route("/api/auth/redeem", post(auth::redeem))
        .route("/api/auth/login", post(access::login))
        .route("/api/auth/activate", post(access::activate))
        .route("/api/access-requests", post(access::request_access))
        .route("/api/admin/access", get(access::list))
        .route("/api/admin/access/{id}/decision", post(access::decide))
        .route("/api/admin/accounts", post(access::create_account))
        .route(
            "/api/admin/accounts/{id}/invite",
            post(access::renew_invite),
        )
        .route(
            "/api/admin/accounts/{id}/coupon",
            post(access::issue_coupon),
        )
        .route("/api/admin/accounts/{id}/disable", post(access::disable))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/fleet", get(gateway::fleet))
        .route("/api/devices", get(gateway::devices))
        .route("/api/agents", get(gateway::agents))
        .route("/api/pairing-info", get(gateway::pairing_info))
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
            "/api/sources",
            get(sources::list)
                .post(sources::create)
                .layer(DefaultBodyLimit::max(
                    patchriot_protocol::sources::MAX_SOURCE_BODY_BYTES,
                )),
        )
        .route("/api/sources/{id}", get(sources::detail))
        .route("/api/sources/{id}/decision", post(sources::decide))
        .route("/api/sources/{id}/delete", post(sources::delete))
        .route("/api/sources/{id}/evidence", get(sources::evidence))
        .route("/api/sources/{id}/review-plan", get(sources::review_plan))
        .route("/api/sources/{id}/review", post(sources::create_review))
        .route(
            "/api/sources/{id}/review-code",
            post(review_codes::redeem_source),
        )
        .route(
            "/api/sources/{id}/checkout",
            post(payments::browser_checkout::create_source),
        )
        .route("/api/site-checks", get(sites::list).post(sites::create))
        .route("/api/site-checks/{id}", get(sites::detail))
        .route(
            "/api/site-checks/{id}/compare/{baseline_id}",
            get(sites::compare),
        )
        .route("/api/site-checks/{id}/decision", post(sites::decide))
        .route("/api/site-checks/{id}/cancel", post(sites::cancel))
        .route("/api/site-checks/{id}/evidence", get(sites::evidence))
        .route("/api/site-checks/{id}/review-plan", get(sites::review_plan))
        .route("/api/site-checks/{id}/review", post(sites::create_review))
        .route(
            "/api/{*path}",
            axum::routing::any(|| async { ApiError::new(StatusCode::NOT_FOUND, "not_found") }),
        )
        .route(
            "/api",
            axum::routing::any(|| async { ApiError::new(StatusCode::NOT_FOUND, "not_found") }),
        );
    routes = routes.layer(axum::middleware::from_fn(diagnostics::response_time));
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
        let mut response = (self.status, Json(ErrorBody { error: self.code })).into_response();
        response
            .extensions_mut()
            .insert(diagnostics::ErrorCode(self.code));
        response
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(_: sqlx::Error) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "database_unavailable")
    }
}
