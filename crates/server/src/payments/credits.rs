//! Prepaid service credit, backed by settled USDC. Cents are integers; coupons
//! grant work separately. A reservation is released only after we know it could
//! not start work. A timeout alone is never evidence that funding failed.

use super::*;
use crate::{gateway, review_target::ReviewTarget};
use axum::{extract::Path, http::StatusCode};
use patchriot_protocol::{
    ReviewView,
    pentests::{PentestView, StartPentest},
    website_reviews::{CreateWebsiteReview, ReviewPrice},
};
use serde_json::json;

mod purchases;
mod topups;
pub(super) use purchases::for_allocation;
pub use purchases::{CreditSummary, process_once};
pub(crate) use purchases::{cancel_purchase, create_purchase, purchase_detail};
pub(crate) use topups::{create_topup, topup_quote};

const ATOMS_PER_CENT: i64 = 10_000;
const BLACK_CENTS: i64 = 100;
const GREY_CENTS: i64 = 250;
const MINIMUM_TOPUP_CENTS: i64 = 100;
const MAXIMUM_TOPUP_CENTS: i64 = 500;

fn service(state: &AppState) -> Result<&access::CheckoutService, ApiError> {
    match &state.review_access {
        access::ReviewAccess::Paid(s)
            if s.policy.destination.asset_id == earnings::SETTLEMENT_ASSET
                && s.policy.destination.decimals == 6 =>
        {
            Ok(s)
        }
        _ => Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "credits_unavailable",
        )),
    }
}

fn payment_error(_: PaymentError) -> ApiError {
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "payment_unavailable")
}

async fn lock_account(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    account: Uuid,
) -> Result<(), ApiError> {
    let enabled: Option<bool> =
        sqlx::query_scalar("SELECT NOT disabled FROM accounts WHERE id=$1 FOR UPDATE")
            .bind(account)
            .fetch_optional(&mut **tx)
            .await?;
    if enabled != Some(true) {
        return Err(ApiError::denied());
    }
    Ok(())
}

async fn available(pool: &PgPool, account: Uuid) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT COALESCE(sum(amount_cents),0)::bigint FROM credit_ledger WHERE account_id=$1",
    )
    .bind(account)
    .fetch_one(pool)
    .await
}

#[derive(Serialize, FromRow)]
struct CreditEntry {
    id: Uuid,
    kind: String,
    amount_cents: i64,
    topup_id: Option<Uuid>,
    purchase_id: Option<Uuid>,
    created_at: DateTime<Utc>,
}

/// Entire account view is local: a slow dispatcher cannot hide the balance or
/// confirmed deposits. Reads never trigger another provider quote.
pub(crate) async fn summary(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let account = auth::require_session(&headers, &state).await?.id;
    let history: Vec<CreditEntry> = sqlx::query_as("SELECT * FROM credit_ledger WHERE account_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100")
        .bind(account).fetch_all(&state.pool).await?;
    let topups = topups::list(&state.pool, account).await?;
    let purchases = purchases::list(&state.pool, account).await?;
    let offer = service(&state)
        .ok()
        .map(|s| s.policy.offer())
        .transpose()
        .map_err(payment_error)?;
    Ok(Json(
        json!({"available_cents":available(&state.pool,account).await?,"history":history,"topups":topups,"purchases":purchases,
        "topup_offer":offer,"minimum_topup_cents":MINIMUM_TOPUP_CENTS,"maximum_topup_cents":MAXIMUM_TOPUP_CENTS,
        "prices":{"black":BLACK_CENTS,"grey":GREY_CENTS,"white":999},"white_available":false}),
    ))
}

pub(crate) async fn offer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let account = auth::require_session(&headers, &state).await?.id;
    service(&state)?;
    let Json(target): Json<PentestView> = gateway::request_for_account::<(), _>(
        &state,
        reqwest::Method::GET,
        &format!("/internal/pentests/{id}"),
        account,
        None,
    )
    .await?;
    if target.id != id || !target.is_requester {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "not_found"));
    }
    let (product, price) = price(&target);
    Ok(Json(
        json!({"pentest_id":id,"scope_sha256":target.scope_sha256,"product":product,"amount_cents":price,"available_cents":available(&state.pool,account).await?}),
    ))
}

fn price(target: &PentestView) -> (&'static str, i64) {
    if target.scope.authentication.is_some() {
        ("grey", GREY_CENTS)
    } else {
        ("black", BLACK_CENTS)
    }
}

/// Local, read-only recovery queue. Does not retry work or release customer funds.
pub(crate) async fn admin_purchases(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let session = auth::require_session(&headers, &state).await?;
    if session.role != "admin" {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "admin_required"));
    }
    let rows: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',p.id,'account_name',a.display_name,'amount_cents',p.amount_cents,'product',p.product,'state',p.state,'review_id',p.review_id,'last_error',p.last_error,'created_at',p.created_at) FROM credit_purchases p JOIN accounts a ON a.id=p.account_id ORDER BY (p.state='needs_review') DESC,p.created_at DESC,p.id DESC LIMIT 100")
        .fetch_all(&state.pool).await?;
    Ok(Json(json!(rows)))
}

/// Invoked in the same transaction that settles the invoice. The deferred DB
/// constraint verifies the receipt, amount, account and asset before commit.
pub(super) async fn credit_settled(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    invoice: Uuid,
) -> Result<bool, sqlx::Error> {
    let row: Option<(Uuid, Uuid, i64)> =
        sqlx::query_as("SELECT id,account_id,amount_cents FROM credit_topups WHERE invoice_id=$1")
            .bind(invoice)
            .fetch_optional(&mut **tx)
            .await?;
    let Some((topup, account, cents)) = row else {
        return Ok(false);
    };
    sqlx::query("INSERT INTO credit_ledger(id,account_id,kind,amount_cents,topup_id) VALUES($1,$2,'topup',$3,$4) ON CONFLICT(topup_id) DO NOTHING")
        .bind(Uuid::new_v4()).bind(account).bind(cents).bind(topup).execute(&mut **tx).await?;
    Ok(true)
}

#[cfg(test)]
mod tests;
