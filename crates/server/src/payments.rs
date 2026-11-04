//! Exact-output 1Click quotes and settlement accounting. Browser access is
//! limited to session-owned checkout, status and cancellation. Quotes use server-approved terms,
//! never JSON supplied by a requester, relay, webhook or agent.
//!
//! A provider SUCCESS is trusted only after binding it to the saved quote. It is
//! not an independent blockchain proof. The poller has an API key, no treasury
//! signing key, and cannot dispatch work or make payouts.

use axum::{Json, extract::State, http::HeaderMap};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::{ApiError, AppState, auth};

pub mod access;
pub(crate) mod browser_checkout;
pub mod cancellation;
pub mod checkout;
pub(crate) mod desk;
pub mod earnings;
pub mod funding;
pub(crate) mod orders;
pub mod payouts;
pub mod worker;

const API_ORIGIN: &str = "https://1click.chaindefuser.com";
const RESPONSE_LIMIT: usize = 128 * 1024;

/// Amounts are smallest-unit integers, never USD estimates or floating point.
/// A live checkout must set these terms from a server-approved service and
/// treasury configuration before requesting the provider quote.
#[derive(Clone, Deserialize, Serialize)]
pub struct InvoiceTerms {
    pub account_id: Uuid,
    pub request_id: Uuid,
    pub destination_asset: String,
    pub recipient: String,
    pub required_amount: i64,
    /// The exact request sent by core to 1Click, including the refund address.
    pub quote_request: Value,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteResponse {
    pub correlation_id: String,
    pub quote_request: Value,
    pub quote: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderStatus {
    quote_response: StatusQuote,
    status: String,
    updated_at: DateTime<Utc>,
    swap_details: Value,
}

// Live status echoes omit the original correlation ID; the envelope's ID is
// for that HTTP request, not the payment. Always bind the full saved quote and
// request, including deposit address, recipient, refund address and amounts.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusQuote {
    correlation_id: Option<String>,
    quote_request: Value,
    quote: Value,
}

#[derive(Clone, FromRow)]
struct Invoice {
    id: Uuid,
    account_id: Uuid,
    request_id: Uuid,
    asset: String,
    recipient: String,
    required_amount: i64,
    correlation_id: String,
    deposit_address: String,
    deposit_memo: String,
    quote_request: Value,
    quote: Value,
    deadline: DateTime<Utc>,
    watch_until: DateTime<Utc>,
    state: String,
    provider_updated_at: Option<DateTime<Utc>>,
    terminal_reported: bool,
    created_at: DateTime<Utc>,
    poll_token: Option<Uuid>,
}

#[derive(Debug)]
pub enum PaymentError {
    InvalidQuote,
    ConflictingInvoice,
    Database,
    Configuration,
    ProviderUnavailable,
    InvalidResponse,
}
impl std::fmt::Display for PaymentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Do not include URLs, keys, bodies, addresses or SQL in operational logs.
        f.write_str(match self {
            Self::InvalidQuote => "invalid or unsupported payment quote",
            Self::ConflictingInvoice => "payment request already has different terms",
            Self::Database => "payment database operation failed",
            Self::Configuration => "invalid payment worker configuration",
            Self::ProviderUnavailable => "payment provider unavailable",
            Self::InvalidResponse => "invalid payment provider response",
        })
    }
}
impl std::error::Error for PaymentError {}
impl From<sqlx::Error> for PaymentError {
    fn from(_: sqlx::Error) -> Self {
        Self::Database
    }
}

fn atom_amount(value: &Value) -> Option<i64> {
    let value = value.as_str()?;
    if value.is_empty()
        || value.len() > 19
        || !value.bytes().all(|b| b.is_ascii_digit())
        || value.len() > 1 && value.starts_with('0')
    {
        return None;
    }
    value.parse::<i64>().ok().filter(|n| *n >= 0)
}
// Input assets can have far more decimals than the accounting asset. We never
// add or price their raw amounts here, but must not limit e.g. 24-decimal NEAR
// deposits to the i64 range used by this MVP's destination-asset ledger.
fn positive_input_amount(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 78
            && !s.starts_with('0')
            && s.bytes().all(|b| b.is_ascii_digit())
    })
}
fn text(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| {
        !s.is_empty() && s.len() <= 256 && !s.chars().any(|c| c.is_whitespace() || c.is_control())
    })
}
fn date(value: &Value) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|v| v.with_timezone(&Utc))
}

/// 1Click echoes server defaults and the partner fee schedule. Those do not
/// change our fixed recipient/output amount. Bound their cost and reject any
/// other addition; save the complete accepted echo for exact status matching.
fn matches_request(requested: &Value, echoed: &Value) -> bool {
    if app_fee_bps(&echoed["appFees"]).is_none() {
        return false;
    }
    let (Some(requested), Some(echoed)) = (requested.as_object(), echoed.as_object()) else {
        return false;
    };
    if !requested.iter().all(|(key, value)| {
        if key == "deadline" {
            match (date(value), echoed.get(key).and_then(date)) {
                (Some(wanted), Some(actual)) => {
                    wanted.timestamp_millis() == actual.timestamp_millis() && actual <= wanted
                }
                _ => false,
            }
        } else {
            echoed.get(key) == Some(value)
        }
    }) {
        return false;
    }
    echoed.iter().all(|(key, value)| {
        if requested.contains_key(key) {
            return true;
        }
        match key.as_str() {
            "confidentiality" => value == "public",
            "quoteWaitingTimeMs" => value == 0,
            "insured" => value == false,
            "appFees" => app_fee_bps(value).is_some(),
            _ => false,
        }
    })
}

/// Provider-added app fees may total at most 1%. The payer sees the exact input
/// amount before transferring; this ceiling never reduces the service output.
fn app_fee_bps(value: &Value) -> Option<u64> {
    if value.is_null() {
        return Some(0);
    }
    let fees = value.as_array()?;
    if fees.len() > 8 {
        return None;
    }
    let mut total = 0_u64;
    for fee in fees {
        let fee = fee.as_object()?;
        if fee
            .keys()
            .any(|key| !["recipient", "fee", "limitOrderId"].contains(&key.as_str()))
            || fee
                .get("limitOrderId")
                .is_some_and(|value| !value.is_null())
            || !access::Blockchain::Near.accepts_address(fee.get("recipient")?.as_str()?)
        {
            return None;
        }
        total = total.checked_add(fee.get("fee")?.as_u64()?)?;
    }
    (total <= 100).then_some(total)
}

fn validate_quote_request(
    terms: &InvoiceTerms,
    now: DateTime<Utc>,
) -> Result<DateTime<Utc>, PaymentError> {
    let request = &terms.quote_request;
    let requested_deadline = date(&request["deadline"]).ok_or(PaymentError::InvalidQuote)?;
    if terms.required_amount <= 0
        || request["dry"] != false
        || request["swapType"] != "EXACT_OUTPUT"
        || request["depositType"] != "ORIGIN_CHAIN"
        || request["refundType"] != "ORIGIN_CHAIN"
        || request["depositMode"] != "SIMPLE"
        || !["DESTINATION_CHAIN", "INTENTS"]
            .contains(&request["recipientType"].as_str().unwrap_or(""))
        || request["destinationAsset"] != terms.destination_asset
        || request["recipient"] != terms.recipient
        || text(&request["destinationAsset"]).is_none()
        || text(&request["recipient"]).is_none()
        || text(&request["originAsset"]).is_none()
        || text(&request["refundTo"]).is_none()
        || atom_amount(&request["amount"]) != Some(terms.required_amount)
        || request.to_string().len() > 16 * 1024
        || requested_deadline <= now
        || requested_deadline > now + Duration::hours(1)
        || [
            "virtualChainRecipient",
            "virtualChainRefundRecipient",
            "customRecipientMsg",
        ]
        .iter()
        .any(|field| !request[*field].is_null())
    {
        return Err(PaymentError::InvalidQuote);
    }
    Ok(requested_deadline)
}

fn validate_quote<'a>(
    terms: &InvoiceTerms,
    response: &'a QuoteResponse,
) -> Result<(DateTime<Utc>, &'a str, &'a str), PaymentError> {
    let now = Utc::now();
    let requested_deadline = validate_quote_request(terms, now)?;
    let quote = &response.quote;
    let provider_deadline = date(&quote["deadline"]).ok_or(PaymentError::InvalidQuote)?;
    // Live 1Click deposits can remain active for three days after the requested
    // deadline. Our payment window stays shorter; late receipts are held for
    // review. The existing seven-day poll window covers that provider grace.
    let deadline = provider_deadline.min(requested_deadline);
    if !matches_request(&terms.quote_request, &response.quote_request)
        || atom_amount(&quote["amountOut"]) != Some(terms.required_amount)
        || !positive_input_amount(&quote["amountIn"])
        || deadline <= now
        || provider_deadline > requested_deadline + Duration::days(3)
        || text(&Value::String(response.correlation_id.clone())).is_none()
        || [
            "virtualChainRecipient",
            "virtualChainRefundRecipient",
            "customRecipientMsg",
        ]
        .iter()
        .any(|field| !quote[*field].is_null())
    {
        return Err(PaymentError::InvalidQuote);
    }
    let address = text(&quote["depositAddress"]).ok_or(PaymentError::InvalidQuote)?;
    let memo = match quote.get("depositMemo") {
        None | Some(Value::Null) => "",
        Some(value) => text(value).ok_or(PaymentError::InvalidQuote)?,
    };
    Ok((deadline, address, memo))
}

/// Store a non-dry, exact-output quote received directly from 1Click. The first
/// MVP adapter supports SIMPLE deposits and normal destination-chain or Intents
/// recipients only; arbitrary recipient messages and virtual-chain routing are
/// excluded. An identical retry while the quote is valid returns its saved ID.
/// The destination asset must fit positive i64 smallest units; origin amounts
/// remain decimal strings so higher-decimal input assets are supported.
pub async fn record_quote(
    pool: &PgPool,
    terms: &InvoiceTerms,
    response: &QuoteResponse,
) -> Result<Uuid, PaymentError> {
    let mut tx = pool.begin().await?;
    let id = record_quote_in(&mut tx, terms, response).await?;
    tx.commit().await?;
    Ok(id)
}

/// Checkout saves the invoice and attaches it to its order in one transaction,
/// before returning any deposit instructions to the requester.
async fn record_quote_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    terms: &InvoiceTerms,
    response: &QuoteResponse,
) -> Result<Uuid, PaymentError> {
    let (deadline, address, memo) = validate_quote(terms, response)?;
    let request = &response.quote_request;
    let quote = &response.quote;
    let id = Uuid::new_v4();
    let enabled: Option<bool> =
        sqlx::query_scalar("SELECT NOT disabled FROM accounts WHERE id = $1 FOR SHARE")
            .bind(terms.account_id)
            .fetch_optional(&mut **tx)
            .await?;
    if enabled != Some(true) {
        return Err(PaymentError::InvalidQuote);
    }
    let inserted: Option<Uuid> = sqlx::query_scalar("INSERT INTO payment_invoices (id, account_id, request_id, asset, recipient, required_amount, correlation_id, deposit_address, deposit_memo, quote_request, quote, deadline, watch_until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12 + interval '7 days') ON CONFLICT DO NOTHING RETURNING id")
        .bind(id).bind(terms.account_id).bind(terms.request_id).bind(&terms.destination_asset)
        .bind(&terms.recipient).bind(terms.required_amount).bind(&response.correlation_id)
        .bind(address).bind(memo).bind(request).bind(quote).bind(deadline)
        .fetch_optional(&mut **tx).await?;
    let result = if let Some(id) = inserted {
        id
    } else {
        let existing: Option<Invoice> = sqlx::query_as(
            "SELECT * FROM payment_invoices WHERE account_id = $1 AND request_id = $2",
        )
        .bind(terms.account_id)
        .bind(terms.request_id)
        .fetch_optional(&mut **tx)
        .await?;
        let existing = existing.ok_or(PaymentError::ConflictingInvoice)?;
        if existing.asset != terms.destination_asset
            || existing.recipient != terms.recipient
            || existing.required_amount != terms.required_amount
            || existing.quote_request != *request
            || existing.quote != *quote
            || existing.correlation_id != response.correlation_id
        {
            return Err(PaymentError::ConflictingInvoice);
        }
        existing.id
    };
    Ok(result)
}

/// 1Click quote/status client. The production origin is fixed so an operator
/// typo cannot forward its API credential to an arbitrary server. It cannot
/// sign or send funds. Tests inject loopback through the private constructor.
pub struct OneClick {
    client: reqwest::Client,
    origin: String,
    api_key: reqwest::header::HeaderValue,
}
impl OneClick {
    pub fn new(api_key: &str) -> Result<Self, PaymentError> {
        Self::with_origin(API_ORIGIN, api_key)
    }

    fn with_origin(origin: &str, api_key: &str) -> Result<Self, PaymentError> {
        if api_key.trim() != api_key || api_key.is_empty() || api_key.len() > 4096 {
            return Err(PaymentError::Configuration);
        }
        let mut api_key = reqwest::header::HeaderValue::from_str(api_key)
            .map_err(|_| PaymentError::Configuration)?;
        api_key.set_sensitive(true);
        Ok(Self {
            origin: origin.into(),
            api_key,
            client: reqwest::Client::builder()
                .user_agent(concat!("Patchriot/", env!("CARGO_PKG_VERSION")))
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(std::time::Duration::from_secs(2))
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .map_err(|_| PaymentError::Configuration)?,
        })
    }

    /// Ask the provider for deposit instructions matching approved terms.
    ///
    /// The caller must admit the work, serialize quote creation for its order,
    /// and persist this response with `record_quote` before showing a deposit
    /// address. This method does not authorize work, create credit or retry a
    /// POST. A lost response must not be treated as a saved invoice.
    pub async fn quote(&self, terms: &InvoiceTerms) -> Result<QuoteResponse, PaymentError> {
        validate_quote_request(terms, Utc::now())?;
        let request = self
            .client
            .post(format!("{}/v0/quote", self.origin))
            .header("X-API-Key", self.api_key.clone())
            .json(&terms.quote_request);
        let response: QuoteResponse = self.response(request).await?;
        validate_quote(terms, &response)?;
        Ok(response)
    }

    async fn status(&self, invoice: &Invoice) -> Result<ProviderStatus, PaymentError> {
        let mut url = url::Url::parse(&format!("{}/v0/status", self.origin))
            .map_err(|_| PaymentError::Configuration)?;
        url.query_pairs_mut()
            .append_pair("depositAddress", &invoice.deposit_address);
        if !invoice.deposit_memo.is_empty() {
            url.query_pairs_mut()
                .append_pair("depositMemo", &invoice.deposit_memo);
        }
        let request = self
            .client
            .get(url)
            .header("X-API-Key", self.api_key.clone());
        self.response(request).await
    }

    async fn response<T: serde::de::DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, PaymentError> {
        let mut response = request
            .send()
            .await
            .map_err(|_| PaymentError::ProviderUnavailable)?;
        if !response.status().is_success() {
            return Err(PaymentError::ProviderUnavailable);
        }
        if response
            .content_length()
            .is_some_and(|n| n > RESPONSE_LIMIT as u64)
        {
            return Err(PaymentError::InvalidResponse);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| PaymentError::ProviderUnavailable)?
        {
            if bytes.len().saturating_add(chunk.len()) > RESPONSE_LIMIT {
                return Err(PaymentError::InvalidResponse);
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| PaymentError::InvalidResponse)
    }
}

#[derive(Default, Serialize)]
pub struct PollSummary {
    pub checked: usize,
    pub unavailable: usize,
}

/// Poll at most ten due invoices sequentially. Claim each row for 30 seconds,
/// commit before HTTP, then require that claim token when applying the reply.
/// Concurrent workers and a restart after posting the ledger cannot pay twice.
pub async fn reconcile_once(pool: &PgPool, client: &OneClick) -> Result<PollSummary, PaymentError> {
    let mut summary = PollSummary::default();
    for _ in 0..10 {
        let token = Uuid::new_v4();
        let invoice: Option<Invoice> = sqlx::query_as("UPDATE payment_invoices SET poll_token = $1, poll_until = now() + interval '30 seconds' WHERE id = (SELECT id FROM payment_invoices WHERE state NOT IN ('settled', 'held', 'needs_review') AND next_check_at <= now() AND (poll_until IS NULL OR poll_until < now()) ORDER BY next_check_at, id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *")
            .bind(token).fetch_optional(pool).await?;
        let Some(invoice) = invoice else { break };
        if invoice.watch_until <= Utc::now() {
            sqlx::query("UPDATE payment_invoices SET state = 'needs_review', reason = 'reconciliation_window_elapsed', poll_token = NULL, poll_until = NULL, updated_at = now() WHERE id = $1 AND poll_token = $2")
                .bind(invoice.id).bind(token).execute(pool).await?;
            summary.checked += 1;
            continue;
        }
        match client.status(&invoice).await {
            Ok(status) => {
                apply_status(pool, invoice.id, token, status).await?;
            }
            Err(error) => {
                let code = if matches!(error, PaymentError::InvalidResponse) {
                    "invalid_provider_response"
                } else {
                    "provider_unavailable"
                };
                sqlx::query("UPDATE payment_invoices SET poll_error = $3, next_check_at = now() + interval '60 seconds', poll_token = NULL, poll_until = NULL, updated_at = now() WHERE id = $1 AND poll_token = $2")
                    .bind(invoice.id).bind(token).bind(code).execute(pool).await?;
                summary.unavailable += 1;
            }
        }
        summary.checked += 1;
    }
    Ok(summary)
}

fn transaction_evidence(details: &Value, recipient_type: &Value) -> bool {
    if recipient_type == "DESTINATION_CHAIN" {
        details["destinationChainTxHashes"]
            .as_array()
            .is_some_and(|items| {
                !items.is_empty()
                    && items.len() <= 32
                    && items.iter().all(|item| text(&item["hash"]).is_some())
            })
    } else {
        ["intentHashes", "nearTxHashes"].iter().all(|field| {
            details[*field].as_array().is_some_and(|items| {
                !items.is_empty()
                    && items.len() <= 32
                    && items.iter().all(|item| text(item).is_some())
            })
        })
    }
}

fn matches_status_request(saved: &Value, echo: &Value) -> bool {
    // Live status omits these request-processing defaults. Neither chooses the
    // asset, amount, recipient or refund route; all payment terms stay exact.
    let mut echo = echo.clone();
    let Some(echo_fields) = echo.as_object_mut() else {
        return false;
    };
    for field in [
        "referral",
        "virtualChainRecipient",
        "virtualChainRefundRecipient",
    ] {
        if saved.get(field).is_none() && echo_fields.get(field) == Some(&Value::Null) {
            echo_fields.remove(field);
        }
    }
    let mut saved = saved.clone();
    let Some(object) = saved.as_object_mut() else {
        return false;
    };
    if echo.get("quoteWaitingTimeMs").is_none()
        && object
            .get("quoteWaitingTimeMs")
            .is_some_and(|v| v.as_u64().is_some_and(|n| n <= 30_000))
    {
        object.remove("quoteWaitingTimeMs");
    }
    if echo.get("insured").is_none() && object.get("insured") == Some(&Value::Bool(false)) {
        object.remove("insured");
    }
    saved == echo
}

fn matches_status_quote(saved: &Value, echo: &Value) -> bool {
    // 1Click can refresh the origin-chain refund fee after quoting. That fee
    // does not select our recipient or the exact amount credited to the user.
    // Keep every other field exact, including all addresses and swap amounts.
    let (Some(mut saved), Some(mut echo)) = (saved.as_object().cloned(), echo.as_object().cloned())
    else {
        return false;
    };
    for quote in [&mut saved, &mut echo] {
        if let Some(fee) = quote.remove("refundFee")
            && fee.as_str() != Some("0")
            && !positive_input_amount(&fee)
        {
            return false;
        }
    }
    saved == echo
}

async fn apply_status(
    pool: &PgPool,
    id: Uuid,
    token: Uuid,
    status: ProviderStatus,
) -> Result<(), PaymentError> {
    let mut tx = pool.begin().await?;
    let invoice: Invoice =
        sqlx::query_as("SELECT * FROM payment_invoices WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if invoice.poll_token != Some(token)
        || ["settled", "held", "needs_review"].contains(&invoice.state.as_str())
    {
        return Ok(());
    }
    let now = Utc::now();
    let response = &status.quote_response;
    let (mut state, mut reason, mut received) =
        ("needs_review", Some("unsupported_provider_status"), None);
    if response
        .correlation_id
        .as_ref()
        .is_some_and(|id| id != &invoice.correlation_id)
        || !matches_status_request(&invoice.quote_request, &response.quote_request)
        || !matches_status_quote(&invoice.quote, &response.quote)
    {
        reason = Some("quote_binding_mismatch");
    } else if status.updated_at > now + Duration::seconds(30)
        || status.updated_at < invoice.created_at - Duration::seconds(30)
    {
        reason = Some("provider_clock_invalid");
    } else if invoice
        .provider_updated_at
        .is_some_and(|previous| status.updated_at < previous)
    {
        // A stale cache cannot undo a newer status or manufacture a settlement.
        sqlx::query("UPDATE payment_invoices SET poll_error = 'stale_provider_response', poll_token = NULL, poll_until = NULL, next_check_at = now() + interval '60 seconds' WHERE id = $1")
            .bind(id).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(());
    } else {
        match status.status.as_str() {
            "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" => {
                state = if now > invoice.deadline {
                    "expired"
                } else {
                    "pending"
                };
                reason = None;
            }
            "PROCESSING" => {
                state = "processing";
                reason = None;
            }
            "INCOMPLETE_DEPOSIT" => {
                state = "incomplete";
                reason = None;
            }
            "REFUNDED" => {
                state = "refunded";
                reason = None;
            }
            "FAILED" => {
                state = "failed";
                reason = None;
            }
            "SUCCESS" => {
                let amount = atom_amount(&status.swap_details["amountOut"]);
                if amount.is_none_or(|n| n <= 0)
                    || !transaction_evidence(
                        &status.swap_details,
                        &invoice.quote_request["recipientType"],
                    )
                {
                    reason = Some("incomplete_settlement_evidence");
                } else {
                    received = amount;
                    state = "held";
                    reason = if amount != Some(invoice.required_amount) {
                        Some("settlement_amount_mismatch")
                    } else if status.updated_at > invoice.deadline {
                        Some("settlement_after_deadline")
                    } else if invoice.terminal_reported {
                        Some("settlement_after_terminal_report")
                    } else {
                        state = "settled";
                        None
                    };
                }
            }
            _ => {}
        }
    }
    if let Some(amount) = received {
        sqlx::query("INSERT INTO payment_ledger (id, invoice_id, account_id, asset, amount, debit, credit) VALUES ($1,$2,$3,$4,$5,'treasury_asset',$6)")
            .bind(Uuid::new_v4()).bind(id).bind(invoice.account_id).bind(&invoice.asset).bind(amount)
            .bind(if state == "settled" { "customer_funds" } else { "customer_held_funds" })
            .execute(&mut *tx).await?;
        if state == "settled" {
            sqlx::query("INSERT INTO payment_funding_events (invoice_id, account_id, request_id, asset, amount) VALUES ($1,$2,$3,$4,$5)")
                .bind(id).bind(invoice.account_id).bind(invoice.request_id).bind(&invoice.asset).bind(amount)
                .execute(&mut *tx).await?;
        }
    }
    sqlx::query("UPDATE payment_invoices SET state = $2, reason = $3, received_amount = $4, provider_updated_at = $5, terminal_reported = terminal_reported OR $6, poll_error = NULL, next_check_at = now() + interval '60 seconds', poll_token = NULL, poll_until = NULL, updated_at = now() WHERE id = $1")
        .bind(id).bind(state).bind(reason).bind(received).bind(status.updated_at)
        .bind(["refunded", "failed"].contains(&state)).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// Only the signed-in account's ledger totals; no caller-supplied account ID.
/// Strings preserve integer precision in browser clients. These are recorded
/// liabilities, not a spendable wallet or withdrawal API.
pub(crate) async fn summary(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let account = auth::require_session(&headers, &state).await?;
    #[derive(FromRow, Serialize)]
    struct Total {
        asset: String,
        credit: String,
        amount: String,
    }
    let totals: Vec<Total> = sqlx::query_as("SELECT asset, credit, sum(amount)::text AS amount FROM payment_ledger WHERE account_id = $1 GROUP BY asset, credit ORDER BY asset, credit")
        .bind(account.id).fetch_all(&state.pool).await?;
    Ok(Json(
        serde_json::json!({"checkout_enabled":state.review_access.is_paid(), "totals": totals}),
    ))
}

#[cfg(test)]
mod tests;
