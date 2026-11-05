use super::*;
use patchriot_protocol::{
    CancelReview,
    website_reviews::{AdmitWebsiteReview, FundReview},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreatePurchase {
    consent: StartPentest,
    amount_cents: i64,
}

#[derive(FromRow)]
pub(super) struct Purchase {
    pub id: Uuid,
    pub account_id: Uuid,
    pub request_id: Uuid,
    pub pentest_id: Uuid,
    pub amount_cents: i64,
    pub consent: Value,
    pub expires_at: DateTime<Utc>,
    pub review_id: Option<Uuid>,
    pub state: String,
    pub cancel_requested_at: Option<DateTime<Utc>>,
    operation_token: Option<Uuid>,
}

#[derive(FromRow, Serialize)]
pub(crate) struct PurchaseView {
    id: Uuid,
    pentest_id: Uuid,
    product: String,
    amount_cents: i64,
    state: String,
    review_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    last_error: Option<String>,
    cancel_requested_at: Option<DateTime<Utc>>,
}

pub(super) async fn list(pool: &PgPool, account: Uuid) -> Result<Vec<PurchaseView>, sqlx::Error> {
    sqlx::query_as("SELECT * FROM credit_purchases WHERE account_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50")
        .bind(account).fetch_all(pool).await
}

pub(crate) async fn purchase_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<PurchaseView>, ApiError> {
    let account = auth::require_session(&headers, &state).await?.id;
    owned(&state.pool, account, id).await.map(Json)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CancelPurchase {}

pub(crate) async fn cancel_purchase(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(_): Json<CancelPurchase>,
) -> Result<Json<PurchaseView>, ApiError> {
    let account = auth::require_write(&headers, &state).await?.id;
    owned(&state.pool, account, id).await?;
    // Persist intent; do not assume a remote funding call has failed or refund
    // from the browser request. The worker confirms cancellation with dispatcher.
    sqlx::query("UPDATE credit_purchases SET cancel_requested_at=COALESCE(cancel_requested_at,now()),next_check_at=now(),updated_at=now() WHERE id=$1 AND account_id=$2 AND state IN ('reserved','admitted','funding','activated')")
        .bind(id).bind(account).execute(&state.pool).await?;
    owned(&state.pool, account, id).await.map(Json)
}

async fn owned(pool: &PgPool, account: Uuid, id: Uuid) -> Result<PurchaseView, ApiError> {
    sqlx::query_as("SELECT * FROM credit_purchases WHERE id=$1 AND account_id=$2")
        .bind(id)
        .bind(account)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "not_found"))
}

pub(crate) async fn create_purchase(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<CreatePurchase>,
) -> Result<Json<PurchaseView>, ApiError> {
    let account = auth::require_write(&headers, &state).await?.id;
    service(&state)?;
    let consent = json!(input.consent);
    if input.consent.request_id.is_nil() {
        return Err(ApiError::bad("invalid_request"));
    }
    // Recover a lost reply before asking the dispatcher whether a setup is
    // still editable. Admission intentionally makes it no longer editable.
    if let Some(saved) = existing(&state.pool, account, input.consent.request_id).await? {
        check_retry(&saved, id, input.amount_cents, &consent)?;
        return owned(&state.pool, account, saved.id).await.map(Json);
    }
    let Json(target): Json<PentestView> = gateway::request_for_account::<(), _>(
        &state,
        reqwest::Method::GET,
        &format!("/internal/pentests/{id}"),
        account,
        None,
    )
    .await?;
    if target.id != id
        || !target.is_requester
        || !target.can_start
        || target.scope_sha256 != input.consent.scope_sha256
    {
        return Err(ApiError::new(StatusCode::CONFLICT, "test_setup_changed"));
    }
    let (product, amount) = price(&target);
    if input.amount_cents != amount {
        return Err(ApiError::new(StatusCode::CONFLICT, "credit_price_changed"));
    }
    let mut tx = state.pool.begin().await?;
    lock_account(&mut tx, account).await?;
    let saved: Option<Purchase> =
        sqlx::query_as("SELECT * FROM credit_purchases WHERE account_id=$1 AND request_id=$2")
            .bind(account)
            .bind(input.consent.request_id)
            .fetch_optional(&mut *tx)
            .await?;
    let purchase = if let Some(saved) = saved {
        check_retry(&saved, id, amount, &consent)?;
        saved.id
    } else {
        let occupied: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM credit_purchases WHERE pentest_id=$3) OR EXISTS(SELECT 1 FROM checkout_orders WHERE account_id=$1 AND (request_id=$2 OR terms->>'pentest_id'=$3::text)) OR EXISTS(SELECT 1 FROM review_codes WHERE account_id=$1 AND (request_id=$2 OR pentest_id=$3)) OR EXISTS(SELECT 1 FROM credit_topups WHERE account_id=$1 AND request_id=$2)")
            .bind(account).bind(input.consent.request_id).bind(id).fetch_one(&mut *tx).await?;
        if occupied {
            return Err(ApiError::new(StatusCode::CONFLICT, "request_conflict"));
        }
        let balance: i64 = sqlx::query_scalar(
            "SELECT COALESCE(sum(amount_cents),0)::bigint FROM credit_ledger WHERE account_id=$1",
        )
        .bind(account)
        .fetch_one(&mut *tx)
        .await?;
        if balance < amount {
            return Err(ApiError::new(StatusCode::CONFLICT, "insufficient_credits"));
        }
        let purchase = Uuid::new_v4();
        let expiry = DateTime::from_timestamp(Utc::now().timestamp() + 300, 0)
            .ok_or_else(|| ApiError::bad("invalid_request"))?;
        sqlx::query("INSERT INTO credit_purchases(id,account_id,request_id,pentest_id,product,amount_cents,consent,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
            .bind(purchase).bind(account).bind(input.consent.request_id).bind(id).bind(product).bind(amount).bind(consent).bind(expiry).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO credit_ledger(id,account_id,kind,amount_cents,purchase_id) VALUES($1,$2,'reserve',$3,$4)")
            .bind(Uuid::new_v4()).bind(account).bind(-amount).bind(purchase).execute(&mut *tx).await?;
        purchase
    };
    tx.commit().await?;
    owned(&state.pool, account, purchase).await.map(Json)
}

async fn existing(
    pool: &PgPool,
    account: Uuid,
    request: Uuid,
) -> Result<Option<Purchase>, sqlx::Error> {
    sqlx::query_as("SELECT * FROM credit_purchases WHERE account_id=$1 AND request_id=$2")
        .bind(account)
        .bind(request)
        .fetch_optional(pool)
        .await
}

fn check_retry(
    saved: &Purchase,
    target: Uuid,
    amount: i64,
    consent: &Value,
) -> Result<(), ApiError> {
    if saved.pentest_id != target || saved.amount_cents != amount || saved.consent != *consent {
        return Err(ApiError::new(StatusCode::CONFLICT, "request_conflict"));
    }
    Ok(())
}

impl Purchase {
    pub(super) fn price(&self) -> ReviewPrice {
        ReviewPrice {
            asset: earnings::SETTLEMENT_ASSET.into(),
            amount: (self.amount_cents * ATOMS_PER_CENT).to_string(),
        }
    }
    fn consent(&self) -> Result<CreateWebsiteReview, PaymentError> {
        serde_json::from_value::<StartPentest>(self.consent.clone())
            .map(Into::into)
            .map_err(|_| PaymentError::InvalidResponse)
    }
    pub(super) fn matches(&self, view: &ReviewView) -> bool {
        self.consent()
            .is_ok_and(|c| ReviewTarget::Pentest(self.pentest_id).matches(view, &c))
            && self.review_id.is_none_or(|id| id == view.id)
            && view.payment.as_ref().is_some_and(|p| {
                p.price == self.price() && p.expires_at == self.expires_at.timestamp()
            })
    }
    fn funded(&self, view: &ReviewView) -> bool {
        self.matches(view)
            && view
                .payment
                .as_ref()
                .is_some_and(|p| p.invoice_id == Some(self.id) && p.funded_at.is_some())
    }
}

#[derive(Default, Serialize)]
pub struct CreditSummary {
    pub checked: usize,
    pub advanced: usize,
}

/// Bounded polling resumes after restarts. Short claims prevent normal overlap;
/// dispatcher idempotency and account locks also protect slow, overlapping calls.
pub async fn process_once(state: &AppState) -> Result<CreditSummary, PaymentError> {
    let mut result = CreditSummary::default();
    for _ in 0..10 {
        let claim = Uuid::new_v4();
        let row: Option<Purchase> = sqlx::query_as("UPDATE credit_purchases SET operation_token=$1,operation_until=now()+interval '30 seconds',next_check_at=now()+interval '30 seconds' WHERE id=(SELECT id FROM credit_purchases WHERE state NOT IN ('completed','released','needs_review') AND next_check_at<=now() AND (operation_until IS NULL OR operation_until<now()) ORDER BY next_check_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *")
            .bind(claim).fetch_optional(&state.pool).await?;
        let Some(mut p) = row else { break };
        result.checked += 1;
        match advance(state, &mut p).await {
            Ok(changed) => result.advanced += usize::from(changed),
            Err(PaymentError::Database) => return Err(PaymentError::Database),
            Err(_) => {
                mark(
                    state,
                    &p,
                    "needs_review",
                    Some("credit_work_requires_review"),
                )
                .await?;
            }
        }
        sqlx::query("UPDATE credit_purchases SET operation_token=NULL,operation_until=NULL WHERE id=$1 AND operation_token=$2")
            .bind(p.id).bind(claim).execute(&state.pool).await?;
    }
    Ok(result)
}

async fn advance(state: &AppState, p: &mut Purchase) -> Result<bool, PaymentError> {
    let enabled: bool = sqlx::query_scalar("SELECT NOT disabled FROM accounts WHERE id=$1")
        .bind(p.account_id)
        .fetch_one(&state.pool)
        .await?;
    if p.review_id.is_none() {
        // No funding request has been made. Even if admission's reply was lost,
        // an unpaid reservation cannot execute and expires on the dispatcher.
        if !enabled || p.cancel_requested_at.is_some() || p.expires_at <= Utc::now() {
            return release(state, p, "work_not_started").await;
        }
        let body = AdmitWebsiteReview {
            consent: p.consent()?,
            price: p.price(),
            payment_expires_at: p.expires_at.timestamp(),
        };
        let response = gateway::request_review_for_account(
            state,
            reqwest::Method::POST,
            &format!("/internal/pentests/{}/admit-review", p.pentest_id),
            p.account_id,
            Some(&body),
        )
        .await;
        let view = match response {
            Ok(Json(v)) => v,
            Err(e) if e.status.is_server_error() || e.status == StatusCode::TOO_MANY_REQUESTS => {
                return Ok(false);
            }
            Err(_) => return release(state, p, "work_not_admitted").await,
        };
        if !p.matches(&view)
            || view
                .payment
                .as_ref()
                .is_none_or(|v| v.funded_at.is_some() || v.invoice_id.is_some())
        {
            return Err(PaymentError::InvalidResponse);
        }
        let n = sqlx::query("UPDATE credit_purchases SET review_id=$2,state='admitted',updated_at=now() WHERE id=$1 AND operation_token=$3 AND state='reserved'")
            .bind(p.id).bind(view.id).bind(p.operation_token).execute(&state.pool).await?.rows_affected();
        if n != 1 {
            return Ok(false);
        }
        p.review_id = Some(view.id);
        p.state = "admitted".into();
    }
    let id = p.review_id.ok_or(PaymentError::InvalidResponse)?;
    let Json(view) = match gateway::request_review_for_account::<()>(
        state,
        reqwest::Method::GET,
        &format!("/internal/reviews/{id}"),
        p.account_id,
        None,
    )
    .await
    {
        Ok(v) => v,
        Err(e) if e.status == StatusCode::NOT_FOUND => return Err(PaymentError::InvalidResponse),
        Err(_) => return Ok(false),
    };
    if !p.matches(&view) {
        return Err(PaymentError::InvalidResponse);
    }
    if p.cancel_requested_at.is_some()
        && ["awaiting_payment", "queued", "running"].contains(&view.state.as_str())
    {
        return stop_unfunded(state, p, &view).await;
    }
    if p.funded(&view) {
        if p.state != "activated" {
            mark(state, p, "activated", None).await?;
            p.state = "activated".into();
        }
        if view.state == "completed" {
            earnings::allocate_credit(&state.pool, p.id, &view).await?;
            return mark(state, p, "completed", None).await;
        }
        if !["queued", "running"].contains(&view.state.as_str()) {
            return mark(
                state,
                p,
                "needs_review",
                Some("started_work_requires_review"),
            )
            .await;
        }
        return Ok(true);
    }
    if view
        .payment
        .as_ref()
        .is_none_or(|p| p.invoice_id.is_some() || p.funded_at.is_some())
        || p.state == "activated"
    {
        return Err(PaymentError::InvalidResponse);
    }
    if !enabled || p.expires_at <= Utc::now() || view.state != "awaiting_payment" {
        return stop_unfunded(state, p, &view).await;
    }
    // Commit intent BEFORE the remote call. An expired claim must not erase the
    // possibility that this request succeeded while its reply was lost.
    if !mark(state, p, "funding", None).await? {
        return Ok(false);
    }
    let body = FundReview {
        request_id: p.request_id,
        invoice_id: p.id,
        price: p.price(),
    };
    match gateway::request_review_for_account(
        state,
        reqwest::Method::POST,
        &format!("/internal/reviews/{id}/fund"),
        p.account_id,
        Some(&body),
    )
    .await
    {
        Ok(Json(v)) if p.funded(&v) => mark(state, p, "activated", None).await,
        Ok(_) => Err(PaymentError::InvalidResponse),
        Err(e) if e.status.is_server_error() || e.status == StatusCode::TOO_MANY_REQUESTS => {
            Ok(false)
        }
        Err(_) => stop_unfunded(state, p, &view).await,
    }
}

async fn stop_unfunded(
    state: &AppState,
    p: &Purchase,
    view: &ReviewView,
) -> Result<bool, PaymentError> {
    // A confirmed cancellation serializes against funding on the dispatcher.
    // A timeout, expired browser, or stale GET by itself cannot release funds.
    let Json(final_view) = match gateway::request_review_for_account(
        state,
        reqwest::Method::POST,
        &format!("/internal/reviews/{}/cancel", view.id),
        p.account_id,
        Some(&CancelReview {}),
    )
    .await
    {
        Ok(v) => v,
        Err(_) => return Ok(false),
    };
    if p.funded(&final_view) {
        return if final_view.state == "cancelled" {
            mark(
                state,
                p,
                "needs_review",
                Some("cancelled_started_work_requires_review"),
            )
            .await
        } else {
            mark(state, p, "activated", None).await
        };
    }
    if !p.matches(&final_view)
        || !["cancelled", "expired", "failed"].contains(&final_view.state.as_str())
        || final_view
            .payment
            .as_ref()
            .is_none_or(|v| v.funded_at.is_some() || v.invoice_id.is_some())
    {
        return Err(PaymentError::InvalidResponse);
    }
    release(state, p, "work_not_started").await
}

async fn mark(
    state: &AppState,
    p: &Purchase,
    status: &str,
    error: Option<&str>,
) -> Result<bool, PaymentError> {
    Ok(sqlx::query("UPDATE credit_purchases SET state=$2,last_error=$3,updated_at=now() WHERE id=$1 AND operation_token=$4 AND state NOT IN ('completed','released','needs_review') AND ($2<>'funding' OR cancel_requested_at IS NULL)")
        .bind(p.id).bind(status).bind(error).bind(p.operation_token).execute(&state.pool).await?.rows_affected()==1)
}

async fn release(state: &AppState, p: &Purchase, reason: &str) -> Result<bool, PaymentError> {
    let mut tx = state.pool.begin().await?;
    // Disabled accounts still receive refunds, but cannot spend them.
    sqlx::query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE")
        .bind(p.account_id)
        .execute(&mut *tx)
        .await?;
    let n=sqlx::query("UPDATE credit_purchases SET state='released',last_error=$3,updated_at=now() WHERE id=$1 AND operation_token=$2 AND state IN ('reserved','admitted','funding')")
        .bind(p.id).bind(p.operation_token).bind(reason).execute(&mut *tx).await?.rows_affected();
    if n == 0 {
        return Ok(false);
    }
    sqlx::query("INSERT INTO credit_ledger(id,account_id,kind,amount_cents,purchase_id) VALUES($1,$2,'release',$3,$4)")
        .bind(Uuid::new_v4()).bind(p.account_id).bind(p.amount_cents).bind(p.id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(true)
}

pub(in crate::payments) async fn for_allocation(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    view: &ReviewView,
) -> Result<i64, PaymentError> {
    let p: Purchase = sqlx::query_as("SELECT * FROM credit_purchases WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    if !["activated", "completed"].contains(&p.state.as_str()) || !p.funded(view) {
        return Err(PaymentError::InvalidResponse);
    }
    Ok(p.amount_cents * ATOMS_PER_CENT)
}
