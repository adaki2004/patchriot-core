//! Internal checkout preparation: save terms, reserve the review, then save a
//! matching invoice before exposing deposit instructions. This is not a public
//! route; callers must choose price/treasury terms from trusted configuration.

use super::*;
use crate::gateway;
use patchriot_protocol::{
    FixtureScenario, ReviewView,
    website_reviews::{AdmitWebsiteReview, CreateWebsiteReview, ReviewPrice},
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CheckoutTerms {
    pub site_check_id: Uuid,
    pub consent: CreateWebsiteReview,
    pub payment: InvoiceTerms,
}

/// Deposit instructions are returned only after both the invoice and its order
/// binding commit. Keep this response private to the paying account.
#[derive(Serialize)]
pub struct CheckoutQuote {
    pub order_id: Uuid,
    pub review_id: Uuid,
    pub invoice_id: Uuid,
    pub payment: QuoteResponse,
}

#[derive(Debug)]
pub enum CheckoutError {
    InvalidTerms,
    ConflictingTerms,
    InProgress,
    Closed,
    AccountUnavailable,
    AdmissionUnavailable,
    AdmissionRejected,
    InvalidAdmission,
    StaleOperation,
    Database,
    Payment(PaymentError),
}
impl std::fmt::Display for CheckoutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidTerms => "invalid checkout terms",
            Self::ConflictingTerms => "checkout request already has different terms",
            Self::InProgress => "checkout preparation is already running",
            Self::Closed => "checkout is no longer payable",
            Self::AccountUnavailable => "checkout account unavailable",
            Self::AdmissionUnavailable => "review admission unavailable",
            Self::AdmissionRejected => "review admission rejected",
            Self::InvalidAdmission => "review admission does not match checkout",
            Self::StaleOperation => "checkout preparation claim expired or changed",
            Self::Database => "checkout database operation failed",
            Self::Payment(error) => return error.fmt(f),
        })
    }
}
impl std::error::Error for CheckoutError {}
impl From<sqlx::Error> for CheckoutError {
    fn from(_: sqlx::Error) -> Self {
        Self::Database
    }
}
impl From<PaymentError> for CheckoutError {
    fn from(error: PaymentError) -> Self {
        Self::Payment(error)
    }
}

#[derive(FromRow)]
struct Order {
    id: Uuid,
    account_id: Uuid,
    terms: Value,
    expires_at: DateTime<Utc>,
    review_id: Option<Uuid>,
    invoice_id: Option<Uuid>,
    state: String,
    operation_token: Option<Uuid>,
    operation_until: Option<DateTime<Utc>>,
}

fn admission(terms: &CheckoutTerms) -> Result<AdmitWebsiteReview, CheckoutError> {
    let deadline = validate_quote_request(&terms.payment, Utc::now())?;
    if terms.site_check_id.is_nil()
        || terms.payment.account_id.is_nil()
        || terms.consent.request_id.is_nil()
        || terms.consent.request_id != terms.payment.request_id
        || !terms.consent.accepts_operator_access
        || terms.consent.device_ids.len() != 3
        || terms.consent.device_ids.iter().any(Uuid::is_nil)
        || terms
            .consent
            .device_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != 3
        || terms.consent.snapshot_sha256.len() != 64
        || !terms
            .consent
            .snapshot_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(CheckoutError::InvalidTerms);
    }
    // Dispatcher uses whole seconds. Round upward so a valid fractional quote
    // deadline is never later than its reservation, by less than one second.
    let expires = deadline.timestamp() + i64::from(deadline.timestamp_subsec_nanos() != 0);
    if expires > Utc::now().timestamp() + 3600 {
        return Err(CheckoutError::InvalidTerms);
    }
    Ok(AdmitWebsiteReview {
        consent: terms.consent.clone(),
        price: ReviewPrice {
            asset: terms.payment.destination_asset.clone(),
            amount: terms.payment.required_amount.to_string(),
        },
        payment_expires_at: expires,
    })
}

async fn enabled(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    account: Uuid,
) -> Result<(), CheckoutError> {
    let enabled: Option<bool> =
        sqlx::query_scalar("SELECT NOT disabled FROM accounts WHERE id = $1 FOR SHARE")
            .bind(account)
            .fetch_optional(&mut **tx)
            .await?;
    if enabled != Some(true) {
        return Err(CheckoutError::AccountUnavailable);
    }
    Ok(())
}

fn payable(order: &Order) -> bool {
    matches!(order.state.as_str(), "preparing" | "awaiting_payment")
        && order.expires_at > Utc::now()
}

async fn claim(
    pool: &PgPool,
    terms: &CheckoutTerms,
    input: &AdmitWebsiteReview,
    token: Uuid,
) -> Result<Order, CheckoutError> {
    let saved = serde_json::to_value(terms).map_err(|_| CheckoutError::InvalidTerms)?;
    let expires =
        DateTime::from_timestamp(input.payment_expires_at, 0).ok_or(CheckoutError::InvalidTerms)?;
    let mut tx = pool.begin().await?;
    enabled(&mut tx, terms.payment.account_id).await?;
    sqlx::query("INSERT INTO checkout_orders (id, account_id, request_id, terms, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (account_id, request_id) DO NOTHING")
        .bind(Uuid::new_v4()).bind(terms.payment.account_id).bind(terms.payment.request_id)
        .bind(&saved).bind(expires).execute(&mut *tx).await?;
    let order: Order = sqlx::query_as(
        "SELECT * FROM checkout_orders WHERE account_id = $1 AND request_id = $2 FOR UPDATE",
    )
    .bind(terms.payment.account_id)
    .bind(terms.payment.request_id)
    .fetch_one(&mut *tx)
    .await?;
    if order.terms != saved {
        return Err(CheckoutError::ConflictingTerms);
    }
    if !payable(&order) {
        return Err(CheckoutError::Closed);
    }
    if order
        .operation_until
        .is_some_and(|until| until > Utc::now())
    {
        return Err(CheckoutError::InProgress);
    }
    sqlx::query("UPDATE checkout_orders SET operation_token = $2, operation_until = now() + interval '30 seconds', last_error = NULL, updated_at = now() WHERE id = $1")
        .bind(order.id).bind(token).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(order)
}

fn matches_admission(view: &ReviewView, terms: &CheckoutTerms, input: &AdmitWebsiteReview) -> bool {
    !view.id.is_nil()
        && view.request_id == terms.payment.request_id
        && view.scenario == FixtureScenario::WebsiteSnapshotV1
        && view.mode == "website_agent"
        && view.state == "awaiting_payment"
        && view.website.as_ref().is_some_and(|context| {
            context.site_check_id == terms.site_check_id
                && context.snapshot_sha256 == terms.consent.snapshot_sha256
                && context
                    .reviewers
                    .iter()
                    .map(|r| r.device_id)
                    .collect::<Vec<_>>()
                    == terms.consent.device_ids
        })
        && view.payment.as_ref().is_some_and(|payment| {
            payment.price == input.price
                && payment.expires_at == input.payment_expires_at
                && payment.invoice_id.is_none()
                && payment.funded_at.is_none()
        })
}

async fn current(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    token: Uuid,
) -> Result<Order, CheckoutError> {
    let order: Order = sqlx::query_as("SELECT * FROM checkout_orders WHERE id = $1 FOR UPDATE")
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    if order.operation_token != Some(token)
        || order
            .operation_until
            .is_none_or(|until| until <= Utc::now())
    {
        return Err(CheckoutError::StaleOperation);
    }
    if !payable(&order) {
        return Err(CheckoutError::Closed);
    }
    enabled(tx, order.account_id).await?;
    Ok(order)
}

/// Retry with the original saved terms, including deadline and refund address.
/// A changed request needs a new request ID and fresh consent. A provider POST
/// is never automatically retried; a failed operation must be resumed explicitly.
pub async fn prepare(
    state: &AppState,
    provider: &OneClick,
    terms: &CheckoutTerms,
) -> Result<CheckoutQuote, CheckoutError> {
    let input = admission(terms)?;
    let token = Uuid::new_v4();
    let order = claim(&state.pool, terms, &input, token).await?;
    let result = prepare_claimed(state, provider, terms, &input, &order, token).await;
    if let Err(error) = &result {
        // Never clear another worker's claim after a late HTTP reply. Errors
        // contain no provider bodies, addresses, credentials or SQL.
        let closed = matches!(error, CheckoutError::InvalidAdmission);
        sqlx::query("UPDATE checkout_orders SET operation_token = NULL, operation_until = NULL, last_error = $3, state = CASE WHEN $4 THEN 'needs_review' WHEN expires_at <= now() THEN 'expired' ELSE state END, updated_at = now() WHERE id = $1 AND operation_token = $2")
            .bind(order.id).bind(token).bind(error.to_string()).bind(closed)
            .execute(&state.pool).await?;
    }
    result
}

async fn prepare_claimed(
    state: &AppState,
    provider: &OneClick,
    terms: &CheckoutTerms,
    input: &AdmitWebsiteReview,
    order: &Order,
    token: Uuid,
) -> Result<CheckoutQuote, CheckoutError> {
    let Json(review): Json<ReviewView> = gateway::request_for_account(
        state,
        reqwest::Method::POST,
        &format!("/internal/site-checks/{}/admit-review", terms.site_check_id),
        order.account_id,
        Some(input),
    )
    .await
    .map_err(|error| {
        if error.status.is_server_error() || error.status.as_u16() == 429 {
            CheckoutError::AdmissionUnavailable
        } else {
            CheckoutError::AdmissionRejected
        }
    })?;
    if !matches_admission(&review, terms, input)
        || order.review_id.is_some_and(|id| id != review.id)
    {
        return Err(CheckoutError::InvalidAdmission);
    }
    let mut tx = state.pool.begin().await?;
    let checked = current(&mut tx, order.id, token).await?;
    if checked.review_id.is_some_and(|id| id != review.id) {
        return Err(CheckoutError::InvalidAdmission);
    }
    sqlx::query("UPDATE checkout_orders SET review_id = $2, updated_at = now() WHERE id = $1")
        .bind(order.id)
        .bind(review.id)
        .execute(&mut *tx)
        .await?;
    if let Some(invoice_id) = checked.invoice_id {
        let invoice: Invoice = sqlx::query_as("SELECT * FROM payment_invoices WHERE id = $1 AND account_id = $2 AND request_id = $3 FOR SHARE")
            .bind(invoice_id).bind(order.account_id).bind(terms.payment.request_id)
            .fetch_one(&mut *tx).await?;
        if invoice.state != "pending" || invoice.deadline <= Utc::now() {
            return Err(CheckoutError::Closed);
        }
        let payment = QuoteResponse {
            correlation_id: invoice.correlation_id,
            quote_request: invoice.quote_request,
            quote: invoice.quote,
        };
        validate_quote(&terms.payment, &payment)?;
        clear_claim(&mut tx, order.id).await?;
        tx.commit().await?;
        return Ok(CheckoutQuote {
            order_id: order.id,
            review_id: review.id,
            invoice_id,
            payment,
        });
    }
    tx.commit().await?;
    let payment = provider.quote(&terms.payment).await?;
    let mut tx = state.pool.begin().await?;
    current(&mut tx, order.id, token).await?;
    let invoice_id = record_quote_in(&mut tx, &terms.payment, &payment).await?;
    sqlx::query(
        "UPDATE checkout_orders SET invoice_id = $2, state = 'awaiting_payment' WHERE id = $1",
    )
    .bind(order.id)
    .bind(invoice_id)
    .execute(&mut *tx)
    .await?;
    clear_claim(&mut tx, order.id).await?;
    tx.commit().await?;
    Ok(CheckoutQuote {
        order_id: order.id,
        review_id: review.id,
        invoice_id,
        payment,
    })
}

async fn clear_claim(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
) -> Result<(), CheckoutError> {
    sqlx::query("UPDATE checkout_orders SET operation_token = NULL, operation_until = NULL, last_error = NULL, updated_at = now() WHERE id = $1")
        .bind(id).execute(&mut **tx).await?;
    Ok(())
}

/// Load server-saved terms rather than generating a new deadline or price on a
/// browser retry. The caller still needs an authenticated account; this function
/// checks that account again before any external call or deposit response.
pub async fn resume(
    state: &AppState,
    provider: &OneClick,
    account: Uuid,
    request: Uuid,
) -> Result<CheckoutQuote, CheckoutError> {
    let terms: Option<Value> = sqlx::query_scalar(
        "SELECT terms FROM checkout_orders WHERE account_id = $1 AND request_id = $2",
    )
    .bind(account)
    .bind(request)
    .fetch_optional(&state.pool)
    .await?;
    let terms: CheckoutTerms = serde_json::from_value(terms.ok_or(CheckoutError::Closed)?)
        .map_err(|_| CheckoutError::Database)?;
    if terms.payment.account_id != account || terms.payment.request_id != request {
        return Err(CheckoutError::ConflictingTerms);
    }
    prepare(state, provider, &terms).await
}
