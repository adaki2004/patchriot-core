//! Session-owned quote preparation. Browser inputs select an allowed payment
//! asset and refund address; price, recipient and deadline come from the server.

use super::*;
use crate::review_target::ReviewTarget;
use access::{
    CheckoutPolicy, CheckoutService, PAYMENT_WINDOW_SECONDS, PaymentPresentation, PaymentToken,
    ReviewAccess, SLIPPAGE_BPS,
};
use axum::{extract::Path, http::StatusCode};
use checkout::{CheckoutError, CheckoutQuote, CheckoutTerms};
use patchriot_protocol::{CancelReview, website_reviews::CreateWebsiteReview};
use serde_json::json;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateCheckout {
    consent: CreateWebsiteReview,
    offer_id: String,
    origin_asset: String,
    refund_address: String,
}

#[derive(Serialize)]
pub(crate) struct DepositView {
    order_id: Uuid,
    request_id: Uuid,
    review_id: Uuid,
    invoice_id: Uuid,
    input: TokenAmount,
    output: TokenAmount,
    deposit_address: String,
    deposit_memo: Option<String>,
    refund_address: String,
    expires_at: DateTime<Utc>,
    provider_app_fee_bps: u64,
}

#[derive(Serialize)]
struct TokenAmount {
    token: PaymentToken,
    amount: String,
}

fn service(state: &AppState) -> Result<&CheckoutService, ApiError> {
    match &state.review_access {
        ReviewAccess::Paid(service) => Ok(service),
        _ => Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "checkout_unavailable",
        )),
    }
}

fn error(error: CheckoutError) -> ApiError {
    let (status, code) = match error {
        CheckoutError::InvalidTerms => (StatusCode::BAD_REQUEST, "invalid_request"),
        CheckoutError::ConflictingTerms => (StatusCode::CONFLICT, "request_conflict"),
        CheckoutError::InProgress | CheckoutError::StaleOperation => {
            (StatusCode::CONFLICT, "checkout_preparing")
        }
        CheckoutError::Closed | CheckoutError::AdmissionRejected => {
            (StatusCode::CONFLICT, "checkout_closed")
        }
        CheckoutError::AccountUnavailable => (StatusCode::UNAUTHORIZED, "sign_in_required"),
        CheckoutError::Database => (StatusCode::SERVICE_UNAVAILABLE, "database_unavailable"),
        _ => (StatusCode::SERVICE_UNAVAILABLE, "checkout_unavailable"),
    };
    ApiError::new(status, code)
}

fn terms(
    policy: &CheckoutPolicy,
    account: Uuid,
    target: ReviewTarget,
    input: &CreateCheckout,
) -> Result<CheckoutTerms, ApiError> {
    if input.offer_id
        != policy
            .id()
            .map_err(|_| error(CheckoutError::InvalidTerms))?
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "checkout_offer_changed",
        ));
    }
    let token = policy
        .inputs
        .iter()
        .find(|token| token.asset_id == input.origin_asset)
        .filter(|token| token.blockchain.accepts_address(&input.refund_address))
        .ok_or_else(|| ApiError::bad("invalid_payment_details"))?;
    let deadline = DateTime::from_timestamp(Utc::now().timestamp() + PAYMENT_WINDOW_SECONDS, 0)
        .ok_or_else(|| error(CheckoutError::InvalidTerms))?;
    let terms = CheckoutTerms {
        site_check_id: target.site_id().unwrap_or_default(),
        source_id: target.source_id(),
        consent: input.consent.clone(),
        payment: InvoiceTerms {
            account_id: account,
            request_id: input.consent.request_id,
            destination_asset: policy.destination.asset_id.clone(),
            recipient: policy.recipient.clone(),
            required_amount: atom_amount(&Value::String(policy.amount.clone()))
                .ok_or_else(|| error(CheckoutError::InvalidTerms))?,
            quote_request: json!({
                "dry":false,"swapType":"EXACT_OUTPUT","depositType":"ORIGIN_CHAIN",
                "refundType":"ORIGIN_CHAIN","depositMode":"SIMPLE","recipientType":policy.recipient_type,
                "destinationAsset":policy.destination.asset_id,"originAsset":token.asset_id,
                "recipient":policy.recipient,"refundTo":input.refund_address,"amount":policy.amount,
                "deadline":deadline,"slippageTolerance":SLIPPAGE_BPS,"quoteWaitingTimeMs":2000,
            }),
        },
        presentation: Some(PaymentPresentation {
            offer_id: input.offer_id.clone(),
            input: token.clone(),
            output: policy.destination.clone(),
        }),
    };
    checkout::admission(&terms).map_err(error)?;
    Ok(terms)
}

fn matches(
    terms: &CheckoutTerms,
    account: Uuid,
    target: ReviewTarget,
    input: &CreateCheckout,
) -> bool {
    ReviewTarget::from_ids(Some(terms.site_check_id), terms.source_id) == Some(target)
        && terms.payment.account_id == account
        && terms.payment.request_id == input.consent.request_id
        && terms.consent.request_id == input.consent.request_id
        && terms.consent.snapshot_sha256 == input.consent.snapshot_sha256
        && terms.consent.device_ids == input.consent.device_ids
        && terms.consent.accepts_operator_access == input.consent.accepts_operator_access
        && terms.payment.quote_request["originAsset"] == input.origin_asset
        && terms.payment.quote_request["refundTo"] == input.refund_address
        && terms
            .presentation
            .as_ref()
            .is_some_and(|v| v.offer_id == input.offer_id)
}

#[derive(FromRow)]
struct Saved {
    terms: Value,
    state: String,
    expires_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl Saved {
    fn resumable(self, account: Uuid) -> Result<CheckoutTerms, ApiError> {
        if !matches!(self.state.as_str(), "preparing" | "awaiting_payment")
            || self.expires_at <= Utc::now()
        {
            return Err(error(CheckoutError::Closed));
        }
        let terms: CheckoutTerms =
            serde_json::from_value(self.terms).map_err(|_| error(CheckoutError::Database))?;
        if terms.payment.account_id != account || terms.presentation.is_none() {
            return Err(error(CheckoutError::Closed));
        }
        if self.updated_at > Utc::now() - Duration::seconds(10) {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "try_again_later",
            ));
        }
        Ok(terms)
    }
}

async fn save(
    pool: &PgPool,
    policy: &CheckoutPolicy,
    account: Uuid,
    target: ReviewTarget,
    input: &CreateCheckout,
) -> Result<CheckoutTerms, ApiError> {
    let mut tx = pool.begin().await?;
    // Serialize creation per account, including the count check. No lock spans
    // admission or provider HTTP. Retries load the first saved terms verbatim.
    let enabled: Option<bool> =
        sqlx::query_scalar("SELECT NOT disabled FROM accounts WHERE id = $1 FOR UPDATE")
            .bind(account)
            .fetch_optional(&mut *tx)
            .await?;
    if enabled != Some(true) {
        return Err(ApiError::denied());
    }
    let sponsored: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM review_codes WHERE account_id = $1 AND request_id = $2)",
    )
    .bind(account)
    .bind(input.consent.request_id)
    .fetch_one(&mut *tx)
    .await?;
    if sponsored {
        return Err(error(CheckoutError::ConflictingTerms));
    }
    let saved: Option<Saved> = sqlx::query_as("SELECT terms, state, expires_at, updated_at FROM checkout_orders WHERE account_id = $1 AND request_id = $2")
        .bind(account).bind(input.consent.request_id).fetch_optional(&mut *tx).await?;
    let terms = if let Some(saved) = saved {
        let stored: CheckoutTerms = serde_json::from_value(saved.terms.clone())
            .map_err(|_| error(CheckoutError::Database))?;
        if !matches(&stored, account, target, input) {
            return Err(error(CheckoutError::ConflictingTerms));
        }
        saved.resumable(account)?
    } else {
        let terms = terms(policy, account, target, input)?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM checkout_orders WHERE account_id = $1 AND created_at > now() - interval '15 minutes'")
            .bind(account).fetch_one(&mut *tx).await?;
        if count >= 5 {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "try_again_later",
            ));
        }
        let expires = date(&terms.payment.quote_request["deadline"])
            .ok_or_else(|| error(CheckoutError::InvalidTerms))?;
        sqlx::query("INSERT INTO checkout_orders (id,account_id,request_id,terms,expires_at) VALUES ($1,$2,$3,$4,$5)")
            .bind(Uuid::new_v4()).bind(account).bind(input.consent.request_id)
            .bind(serde_json::to_value(&terms).map_err(|_| error(CheckoutError::InvalidTerms))?).bind(expires)
            .execute(&mut *tx).await?;
        terms
    };
    tx.commit().await?;
    Ok(terms)
}

fn view(terms: CheckoutTerms, quote: CheckoutQuote) -> Result<DepositView, ApiError> {
    let (deadline, address, memo) = validate_quote(&terms.payment, &quote.payment)
        .map_err(|error_| error(CheckoutError::Payment(error_)))?;
    let presentation = terms
        .presentation
        .ok_or_else(|| error(CheckoutError::Closed))?;
    presentation
        .validate_quote(&terms.payment, &quote.payment)
        .map_err(|e| error(CheckoutError::Payment(e)))?;
    Ok(DepositView {
        order_id: quote.order_id,
        request_id: terms.consent.request_id,
        review_id: quote.review_id,
        invoice_id: quote.invoice_id,
        input: TokenAmount {
            token: presentation.input,
            amount: quote.payment.quote["amountIn"]
                .as_str()
                .ok_or_else(|| error(CheckoutError::Database))?
                .into(),
        },
        output: TokenAmount {
            token: presentation.output,
            amount: terms.payment.required_amount.to_string(),
        },
        deposit_address: address.into(),
        deposit_memo: (!memo.is_empty()).then(|| memo.into()),
        refund_address: terms.payment.quote_request["refundTo"]
            .as_str()
            .ok_or_else(|| error(CheckoutError::Database))?
            .into(),
        expires_at: deadline,
        provider_app_fee_bps: app_fee_bps(&quote.payment.quote_request["appFees"])
            .ok_or_else(|| error(CheckoutError::Database))?,
    })
}

pub(crate) async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(site): Path<Uuid>,
    Json(input): Json<CreateCheckout>,
) -> Result<Json<DepositView>, ApiError> {
    let account = auth::require_write(&headers, &state).await?.id;
    let service = service(&state)?;
    let terms = save(
        &state.pool,
        &service.policy,
        account,
        ReviewTarget::Website(site),
        &input,
    )
    .await?;
    let quote = checkout::prepare(&state, &service.provider, &terms)
        .await
        .map_err(error)?;
    view(terms, quote).map(Json)
}

pub(crate) async fn create_source(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(site): Path<Uuid>,
    Json(input): Json<CreateCheckout>,
) -> Result<Json<DepositView>, ApiError> {
    let account = auth::require_write(&headers, &state).await?.id;
    let service = service(&state)?;
    let terms = save(
        &state.pool,
        &service.policy,
        account,
        ReviewTarget::Source(site),
        &input,
    )
    .await?;
    let quote = checkout::prepare(&state, &service.provider, &terms)
        .await
        .map_err(error)?;
    view(terms, quote).map(Json)
}

pub(crate) async fn resume(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(_input): Json<CancelReview>,
) -> Result<Json<DepositView>, ApiError> {
    let account = auth::require_write(&headers, &state).await?.id;
    let service = service(&state)?;
    let saved: Saved = sqlx::query_as("SELECT terms, state, expires_at, updated_at FROM checkout_orders WHERE id = $1 AND account_id = $2")
        .bind(id).bind(account).fetch_optional(&state.pool).await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "not_found"))?;
    let terms = saved.resumable(account)?;
    let quote = checkout::prepare(&state, &service.provider, &terms)
        .await
        .map_err(error)?;
    view(terms, quote).map(Json)
}
