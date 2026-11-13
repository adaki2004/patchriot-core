//! Browser sessions and an authenticated gateway to the private dispatcher.
//! GitHub/Google sign-in creates member accounts. Legacy invitations/passwords
//! remain separate identities and never become verified provider identities.

mod access;
mod analytics;
mod auth;
mod contact;
mod coupons;
mod diagnostics;
mod gateway;
mod incidents;
mod ingress;
mod login_page;
pub mod payments;
mod pentests;
mod response_budget;
pub mod review_codes;
mod review_target;
mod sites;
mod sources;
mod sso;
mod trials;
mod wallet;
mod workspace_counts;

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
pub use sso::SsoConfig;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
    pub client: reqwest::Client,
    pub(crate) response_slots: Arc<tokio::sync::Semaphore>,
    pub(crate) public_auth_slots: Arc<tokio::sync::Semaphore>,
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
    /// Optional public contact address. Inquiry delivery is the private inbox.
    pub contact_email: Option<String>,
    pub ga_measurement_id: Option<String>,
    pub analytics_origin: Option<String>,
    pub workspace_counts_enabled: bool,
    pub sso: SsoConfig,
    pub wallet_project_id: Option<String>,
    pub(crate) trust_client_ip_header: bool,
}

impl Config {
    pub fn with_workspace_counts(mut self, enabled: bool) -> Self {
        self.workspace_counts_enabled = enabled;
        self
    }

    pub fn with_client_ip_source(mut self, value: &str) -> Result<Self, &'static str> {
        self.trust_client_ip_header = match value {
            "peer" => false,
            "trusted_x_real_ip" => true,
            _ => return Err("PATCHRIOT_CLIENT_IP_SOURCE must be peer or trusted_x_real_ip"),
        };
        Ok(self)
    }
    pub fn with_wallet_project_id(mut self, value: Option<String>) -> Result<Self, &'static str> {
        if value
            .as_ref()
            .is_some_and(|id| id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err("invalid WC_REOWNED_PRJ_ID");
        }
        self.wallet_project_id = value;
        Ok(self)
    }

    pub fn with_sso(mut self, sso: SsoConfig) -> Self {
        self.sso = sso;
        self
    }
    pub fn with_ga_measurement_id(mut self, value: Option<String>) -> Result<Self, &'static str> {
        if value.as_ref().is_some_and(|id| !analytics::valid_id(id)) {
            return Err("invalid PATCHRIOT_GA_MEASUREMENT_ID");
        }
        self.ga_measurement_id = value;
        Ok(self)
    }
    pub fn with_analytics_origin(mut self, value: Option<String>) -> Result<Self, &'static str> {
        self.analytics_origin = value
            .map(|value| {
                let analytics = Self::origin(&value, false)?;
                let public = Self::origin(&self.public_origin, false)?;
                // This legacy host is reserved and returns 404. Never reserve the app itself.
                if analytics.host() == public.host() {
                    return Err("legacy analytics hostname must differ from the application");
                }
                Ok(analytics.origin().ascii_serialization())
            })
            .transpose()?;
        Ok(self)
    }
    pub fn with_contact_email(mut self, value: Option<String>) -> Result<Self, &'static str> {
        self.contact_email = value
            .map(|value| access::contact(&value).map_err(|_| "invalid PATCHRIOT_CONTACT_EMAIL"))
            .transpose()?;
        Ok(self)
    }
    fn origin(value: &str, railway_internal: bool) -> Result<url::Url, &'static str> {
        let url = url::Url::parse(value).map_err(|_| "invalid service URL")?;
        let local = match url.host() {
            Some(url::Host::Domain("localhost")) => true,
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        };
        // An operator may select Railway's encrypted private network for the
        // dispatcher hop. Never apply this exception to browser/relay origins.
        let railway = railway_internal
            && url
                .host_str()
                .and_then(|h| h.strip_suffix(".railway.internal"))
                .is_some_and(|label| {
                    !label.is_empty()
                        && label.len() <= 63
                        && !label.starts_with('-')
                        && !label.ends_with('-')
                        && label
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                });
        if !(url.scheme() == "https" || url.scheme() == "http" && (local || railway))
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
            .map(|value| Self::origin(&value, false).map(|url| url.origin().ascii_serialization()))
            .transpose()?;
        Ok(self)
    }

    pub fn new(
        public_origin: String,
        dispatcher_url: String,
        internal_key: String,
        web_root: Option<PathBuf>,
    ) -> Result<Self, &'static str> {
        let public = Self::origin(&public_origin, false)?;
        let dispatcher = Self::origin(&dispatcher_url, true)?;
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
            contact_email: None,
            ga_measurement_id: None,
            analytics_origin: None,
            workspace_counts_enabled: false,
            sso: SsoConfig::default(),
            wallet_project_id: None,
            trust_client_ip_header: false,
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
            public_auth_slots: Arc::new(tokio::sync::Semaphore::new(32)),
            response_slots: Arc::new(tokio::sync::Semaphore::new(1)),
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
    let google_scripts = if state.config.ga_measurement_id.is_some() {
        " https://www.googletagmanager.com"
    } else {
        ""
    };
    let google_requests = if state.config.ga_measurement_id.is_some() {
        " https://www.google-analytics.com https://region1.google-analytics.com"
    } else {
        ""
    };
    let page_policy = HeaderValue::from_str(&format!("default-src 'self'; script-src 'self'{google_scripts}; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:{google_requests}; connect-src 'self'{google_requests}; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"))
        .expect("fixed analytics origins");
    let mut routes = Router::new()
        .route(
            "/api/health",
            get(|| async {
                Json(serde_json::json!({"status":"ok", "version":env!("CARGO_PKG_VERSION")}))
            }),
        )
        .route("/api/session", get(auth::session))
        .route("/api/account", get(auth::account))
        .route("/account", get(login_page::account_entry))
        .route("/login", get(login_page::page).post(login_page::submit))
        .route("/login.css", get(login_page::styles))
        .route("/api/analytics", get(analytics::settings))
        .route("/api/analytics/activity", post(workspace_counts::record))
        .route(
            "/api/admin/workspace-counts",
            get(workspace_counts::summary),
        )
        .route("/api/contact", get(contact::details).post(contact::create))
        .route("/api/admin/inquiries", get(contact::inbox))
        .route("/api/admin/inquiries/{id}", post(contact::decide))
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
        .route(
            "/api/admin/credit-purchases",
            get(payments::credits::admin_purchases),
        )
        .route("/api/admin/review-stats", get(gateway::review_stats))
        .route("/api/checkout", get(payments::access::settings))
        .route(
            "/api/credits/purchases/{id}/cancel",
            post(payments::credits::cancel_purchase),
        )
        .route("/api/credits", get(payments::credits::summary))
        .route("/api/credits/topups", post(payments::credits::create_topup))
        .route(
            "/api/credits/topups/{id}/quote",
            post(payments::credits::topup_quote),
        )
        .route(
            "/api/credits/purchases/{id}",
            get(payments::credits::purchase_detail),
        )
        .route(
            "/api/pentests/{id}/credit-offer",
            get(payments::credits::offer),
        )
        .route(
            "/api/pentests/{id}/credits",
            post(payments::credits::create_purchase),
        )
        .route("/api/trial", get(trials::offer).post(trials::claim))
        .route("/api/coupons", get(coupons::list))
        .route("/api/coupons/welcome", post(coupons::welcome))
        .route(
            "/api/coupons/request",
            get(coupons::request_status).post(coupons::request_coupon),
        )
        .route("/api/admin/coupons/requests", get(coupons::requests))
        .route(
            "/api/admin/coupons/requests/{id}/decision",
            post(coupons::decide),
        )
        .route(
            "/api/admin/coupons/judges",
            get(coupons::judges).post(coupons::reserve_judges),
        )
        .route(
            "/api/admin/trial",
            get(trials::desk).post(trials::configure),
        )
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
        .route("/api/auth/providers", get(sso::providers))
        .route("/api/wallet/config", get(wallet::settings))
        .route("/api/auth/wallet/challenge", post(wallet::challenge))
        .route("/api/auth/wallet/verify", post(wallet::verify))
        .route("/api/auth/{provider}/start", post(sso::start))
        .route("/api/auth/{provider}/callback", get(sso::callback))
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
        .route("/api/pentests/{id}/ownership", get(pentests::ownership))
        .route(
            "/api/pentests/{id}/ownership/refresh",
            post(pentests::refresh_ownership),
        )
        .route("/api/devices/{id}/decision", post(gateway::decision))
        .route(
            "/api/reviews",
            get(gateway::reviews).post(gateway::create_review),
        )
        .route("/api/reviews/{id}", get(gateway::review))
        .route("/api/reviews/{id}/cancel", post(gateway::cancel_review))
        .route("/api/reviews/{id}/report", post(gateway::report))
        .route(
            "/api/reviews/{id}/consistency-check",
            get(gateway::report_check),
        )
        .route(
            "/api/sources",
            get(sources::list)
                .post(sources::create)
                .layer(DefaultBodyLimit::max(
                    patchriot_protocol::sources::MAX_SOURCE_BODY_BYTES,
                )),
        )
        .route("/api/pentests", get(pentests::list).post(pentests::create))
        .route("/api/pentests/{id}/decision", post(pentests::decide))
        .route("/api/pentests/{id}/setup", post(pentests::update_setup))
        .route("/api/pentests/{id}/prepare", post(pentests::prepare))
        .route(
            "/api/pentests/{id}/credentials",
            post(pentests::set_credentials),
        )
        .route(
            "/api/pentests/{id}/authorize-owned-test",
            post(pentests::authorize_owned_test),
        )
        .route("/api/pentests/{id}/authorize", post(pentests::authorize))
        .route("/api/pentests/{id}/review-plan", get(pentests::plan))
        .route("/api/pentest-tools", get(pentests::tools))
        .route("/api/pentests/{id}/review", post(pentests::start))
        .route(
            "/api/pentests/{id}/review-code",
            post(review_codes::redeem_pentest),
        )
        .route(
            "/api/pentests/{id}/checkout",
            post(payments::browser_checkout::create_pentest),
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
    // Wallet pages retain their own policy. The Google tag is allowed only when configured.
    routes
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            ingress::public_capacity,
        ))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            page_policy,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            analytics::host_boundary,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            wallet::page_policy,
        ))
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
