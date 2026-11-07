use super::*;
use access::{PAYMENT_WINDOW_SECONDS, PaymentPresentation, SLIPPAGE_BPS};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateTopup {
    request_id: Uuid,
    amount_cents: i64,
    offer_id: String,
    origin_asset: String,
    refund_address: String,
}

#[derive(FromRow)]
struct Saved {
    id: Uuid,
    account_id: Uuid,
    request_id: Uuid,
    amount_cents: i64,
    terms: Value,
    presentation: Value,
    invoice_id: Option<Uuid>,
    expires_at: DateTime<Utc>,
    operation_until: Option<DateTime<Utc>>,
}

#[derive(FromRow, Serialize)]
pub(super) struct TopupView {
    id: Uuid,
    amount_cents: i64,
    state: String,
    expires_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
}

pub(super) async fn list(pool: &PgPool, account: Uuid) -> Result<Vec<TopupView>, sqlx::Error> {
    sqlx::query_as("SELECT t.id,t.amount_cents,COALESCE(i.state,CASE WHEN t.expires_at<=now() THEN 'expired' ELSE 'preparing' END) AS state,t.expires_at,t.created_at FROM credit_topups t LEFT JOIN payment_invoices i ON i.id=t.invoice_id WHERE t.account_id=$1 ORDER BY t.created_at DESC,t.id DESC LIMIT 50")
        .bind(account).fetch_all(pool).await
}

pub(crate) async fn create_topup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateTopup>,
) -> Result<Json<Value>, ApiError> {
    let account = auth::require_write(&headers, &state).await?.id;
    let service = service(&state)?;
    if input.request_id.is_nil() {
        return Err(ApiError::bad("invalid_topup_amount"));
    }
    let mut tx = state.pool.begin().await?;
    lock_account(&mut tx, account).await?;
    let saved: Option<Saved> =
        sqlx::query_as("SELECT * FROM credit_topups WHERE account_id=$1 AND request_id=$2")
            .bind(account)
            .bind(input.request_id)
            .fetch_optional(&mut *tx)
            .await?;
    let id = if let Some(saved) = saved {
        if saved.amount_cents != input.amount_cents
            || saved.terms["quote_request"]["originAsset"] != input.origin_asset
            || saved.terms["quote_request"]["refundTo"] != input.refund_address
            || saved.presentation["offer_id"] != input.offer_id
        {
            return Err(ApiError::new(StatusCode::CONFLICT, "request_conflict"));
        }
        saved.id
    } else {
        // Apply the pilot cap to new commitments. Existing deposits keep their
        // exact terms and remain recoverable through idempotent retries.
        if !(MINIMUM_TOPUP_CENTS..=MAXIMUM_TOPUP_CENTS).contains(&input.amount_cents) {
            return Err(ApiError::bad("invalid_topup_amount"));
        }
        if input.offer_id != service.policy.id().map_err(payment_error)? {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "checkout_offer_changed",
            ));
        }
        let token = service
            .policy
            .inputs
            .iter()
            .find(|t| {
                t.asset_id == input.origin_asset
                    && t.blockchain.accepts_address(&input.refund_address)
            })
            .ok_or_else(|| ApiError::bad("invalid_payment_details"))?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM credit_topups WHERE account_id=$1 AND created_at>now()-interval '15 minutes'")
            .bind(account).fetch_one(&mut *tx).await?;
        if count >= 10 {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "try_again_later",
            ));
        }
        let occupied: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM checkout_orders WHERE account_id=$1 AND request_id=$2) OR EXISTS(SELECT 1 FROM review_codes WHERE account_id=$1 AND request_id=$2) OR EXISTS(SELECT 1 FROM credit_purchases WHERE account_id=$1 AND request_id=$2)")
            .bind(account).bind(input.request_id).fetch_one(&mut *tx).await?;
        if occupied {
            return Err(ApiError::new(StatusCode::CONFLICT, "request_conflict"));
        }
        let deadline = DateTime::from_timestamp(Utc::now().timestamp() + PAYMENT_WINDOW_SECONDS, 0)
            .ok_or_else(|| ApiError::bad("invalid_request"))?;
        let amount = input.amount_cents * ATOMS_PER_CENT;
        let terms = InvoiceTerms {
            account_id: account,
            request_id: input.request_id,
            destination_asset: service.policy.destination.asset_id.clone(),
            recipient: service.policy.recipient.clone(),
            required_amount: amount,
            quote_request: json!({"dry":false,"swapType":"EXACT_OUTPUT","depositType":"ORIGIN_CHAIN","refundType":"ORIGIN_CHAIN","depositMode":"SIMPLE","recipientType":service.policy.recipient_type,
                "destinationAsset":service.policy.destination.asset_id,"originAsset":token.asset_id,"recipient":service.policy.recipient,"refundTo":input.refund_address,"amount":amount.to_string(),"deadline":deadline,"slippageTolerance":SLIPPAGE_BPS,"quoteWaitingTimeMs":2000}),
        };
        let presentation = PaymentPresentation {
            offer_id: input.offer_id,
            input: token.clone(),
            output: service.policy.destination.clone(),
        };
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO credit_topups(id,account_id,request_id,amount_cents,terms,presentation,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)")
            .bind(id).bind(account).bind(input.request_id).bind(input.amount_cents).bind(json!(terms)).bind(json!(presentation)).bind(deadline).execute(&mut *tx).await?;
        id
    };
    tx.commit().await?;
    prepare(&state, account, id).await.map(Json)
}

/// Retry refers to the same deposit, never silently creates another address.
pub(crate) async fn topup_quote(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let account = auth::require_write(&headers, &state).await?.id;
    prepare(&state, account, id).await.map(Json)
}

async fn prepare(state: &AppState, account: Uuid, id: Uuid) -> Result<Value, ApiError> {
    let service = service(state)?;
    let mut tx = state.pool.begin().await?;
    lock_account(&mut tx, account).await?;
    let saved: Saved =
        sqlx::query_as("SELECT * FROM credit_topups WHERE id=$1 AND account_id=$2 FOR UPDATE")
            .bind(id)
            .bind(account)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "not_found"))?;
    if saved.expires_at <= Utc::now() {
        return Err(ApiError::new(StatusCode::CONFLICT, "checkout_closed"));
    }
    if let Some(invoice) = saved.invoice_id {
        tx.commit().await?;
        return deposit(state, &saved, invoice).await;
    }
    if saved.operation_until.is_some_and(|t| t > Utc::now()) {
        return Err(ApiError::new(StatusCode::CONFLICT, "checkout_preparing"));
    }
    let claim = Uuid::new_v4();
    sqlx::query("UPDATE credit_topups SET operation_token=$2,operation_until=now()+interval '30 seconds',updated_at=now() WHERE id=$1")
        .bind(id).bind(claim).execute(&mut *tx).await?;
    tx.commit().await?;
    let terms: InvoiceTerms =
        serde_json::from_value(saved.terms.clone()).map_err(|_| ApiError::bad("invalid_topup"))?;
    let presentation: PaymentPresentation = serde_json::from_value(saved.presentation.clone())
        .map_err(|_| ApiError::bad("invalid_topup"))?;
    let response = service
        .provider
        .quote(&terms)
        .await
        .map_err(payment_error)?;
    presentation
        .validate_quote(&terms, &response)
        .map_err(payment_error)?;
    let mut tx = state.pool.begin().await?;
    lock_account(&mut tx, account).await?;
    let current: Option<Uuid> =
        sqlx::query_scalar("SELECT operation_token FROM credit_topups WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if current != Some(claim) {
        return Err(ApiError::new(StatusCode::CONFLICT, "checkout_preparing"));
    }
    let invoice = record_quote_in(&mut tx, &terms, &response)
        .await
        .map_err(payment_error)?;
    sqlx::query("UPDATE credit_topups SET invoice_id=$2,operation_token=NULL,operation_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1")
        .bind(id).bind(invoice).execute(&mut *tx).await?;
    tx.commit().await?;
    deposit(state, &saved, invoice).await
}

async fn deposit(state: &AppState, saved: &Saved, id: Uuid) -> Result<Value, ApiError> {
    let invoice: Invoice = sqlx::query_as(
        "SELECT * FROM payment_invoices WHERE id=$1 AND account_id=$2 AND request_id=$3",
    )
    .bind(id)
    .bind(saved.account_id)
    .bind(saved.request_id)
    .fetch_one(&state.pool)
    .await?;
    if invoice.state != "pending" || invoice.deadline <= Utc::now() {
        return Err(ApiError::new(StatusCode::CONFLICT, "checkout_closed"));
    }
    Ok(
        json!({"payment_kind":"topup","order_id":saved.id,"request_id":saved.request_id,"invoice_id":id,"amount_cents":saved.amount_cents,
        "input":{"token":saved.presentation["input"],"amount":invoice.quote["amountIn"]},"output":{"token":saved.presentation["output"],"amount":invoice.required_amount.to_string()},
        "deposit_address":invoice.deposit_address,"deposit_memo":if invoice.deposit_memo.is_empty(){None}else{Some(invoice.deposit_memo)},"refund_address":invoice.quote_request["refundTo"],"expires_at":invoice.deadline,
        "provider_app_fee_bps":app_fee_bps(&invoice.quote_request["appFees"]).unwrap_or(0)}),
    )
}
