//! Requested sponsorship requires staff approval; judge gifts remain separate.
use crate::{ApiError, AppState, access, auth, review_codes};
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Serialize, FromRow)]
pub(crate) struct Coupon {
    id: Uuid,
    label: String,
    expires_at: DateTime<Utc>,
}
const SELECT: &str = "SELECT id,label,expires_at FROM review_codes WHERE issued_to=$1 AND account_id IS NULL AND reserved_at IS NULL AND revoked_at IS NULL AND expires_at>now() ORDER BY expires_at,id LIMIT 100";

pub(crate) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<Coupon>>, ApiError> {
    let account = auth::require_session(&headers, &state).await?;
    Ok(Json(
        sqlx::query_as(SELECT)
            .bind(account.id)
            .fetch_all(&state.pool)
            .await?,
    ))
}

// Old clients may still call this endpoint. It never issues a coupon.
pub(crate) async fn welcome(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    auth::require_write(&headers, &state).await?;
    Ok(Json(serde_json::json!({"ok":true})))
}

#[derive(Serialize, FromRow)]
pub(crate) struct CouponRequest {
    id: Uuid,
    status: String,
    note: String,
    created_at: DateTime<Utc>,
    decided_at: Option<DateTime<Utc>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RequestCoupon {
    #[serde(default)]
    note: String,
}
pub(crate) async fn request_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let account = auth::require_session(&headers, &state).await?;
    let request: Option<CouponRequest> = sqlx::query_as(
        "SELECT id,status,note,created_at,decided_at FROM coupon_requests WHERE account_id=$1",
    )
    .bind(account.id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(Json(serde_json::json!({"request":request})))
}
pub(crate) async fn request_coupon(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<RequestCoupon>,
) -> Result<Json<CouponRequest>, ApiError> {
    let account = auth::require_write(&headers, &state).await?;
    let note = input.note.trim();
    if note.len() > 1000 || note.chars().any(|c| c.is_control() && c != '\n') {
        return Err(ApiError::bad("invalid_coupon_request"));
    }
    access::rate(
        &state.pool,
        &format!("coupon-request:{}", account.id),
        10,
        3600,
    )
    .await?;
    // The unique account key also makes concurrent submissions and lost replies
    // idempotent. A request never touches review_codes or the free-audit budget.
    let mut tx = state.pool.begin().await?;
    sqlx::query("INSERT INTO coupon_requests(id,account_id,note) VALUES($1,$2,$3) ON CONFLICT(account_id) DO NOTHING")
        .bind(Uuid::new_v4()).bind(account.id).bind(note).execute(&mut *tx).await?;
    let row = sqlx::query_as(
        "SELECT id,status,note,created_at,decided_at FROM coupon_requests WHERE account_id=$1",
    )
    .bind(account.id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(row))
}
#[derive(Serialize, FromRow)]
pub(crate) struct StaffRequest {
    id: Uuid,
    account_id: Uuid,
    display_name: String,
    note: String,
    status: String,
    created_at: DateTime<Utc>,
}
pub(crate) async fn requests(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<StaffRequest>>, ApiError> {
    access::admin(&state, &headers, false).await?;
    Ok(Json(sqlx::query_as("SELECT r.id,r.account_id,a.display_name,r.note,r.status,r.created_at FROM coupon_requests r JOIN accounts a ON a.id=r.account_id WHERE r.status='pending' ORDER BY r.created_at,r.id LIMIT 100")
        .fetch_all(&state.pool).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CouponDecision {
    decision: String,
}
pub(crate) async fn decide(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<CouponDecision>,
) -> Result<Json<CouponRequest>, ApiError> {
    let actor = access::admin(&state, &headers, true).await?;
    let status = match input.decision.as_str() {
        "approve" => "approved",
        "decline" => "declined",
        _ => return Err(ApiError::bad("invalid_decision")),
    };
    let mut tx = state.pool.begin().await?;
    access::lock_admin(&mut tx, actor.id).await?;
    let account: Uuid = sqlx::query_scalar("SELECT account_id FROM coupon_requests WHERE id=$1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::new(axum::http::StatusCode::NOT_FOUND, "not_found"))?;
    let enabled: bool =
        sqlx::query_scalar("SELECT NOT disabled FROM accounts WHERE id=$1 FOR UPDATE")
            .bind(account)
            .fetch_one(&mut *tx)
            .await?;
    let prior: String =
        sqlx::query_scalar("SELECT status FROM coupon_requests WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if prior != "pending" && prior != status {
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "coupon_request_already_decided",
        ));
    }
    if prior == "pending" {
        let mut code_id = None;
        if status == "approved" {
            review_codes::available(&state)?;
            if !enabled {
                return Err(ApiError::bad("account_disabled"));
            }
            sqlx::query("SELECT singleton FROM welcome_coupon_program WHERE singleton FOR UPDATE")
                .execute(&mut *tx)
                .await?;
            let prior_grant: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account_coupon_grants WHERE account_id=$1) OR EXISTS(SELECT 1 FROM trial_claims WHERE account_id=$1)")
                .bind(account).fetch_one(&mut *tx).await?;
            if prior_grant {
                return Err(ApiError::new(
                    axum::http::StatusCode::CONFLICT,
                    "coupon_already_granted",
                ));
            }
            let used: i64 = sqlx::query_scalar("SELECT count(*) FROM account_coupon_grants")
                .fetch_one(&mut *tx)
                .await?;
            if used >= 100 {
                return Err(ApiError::new(
                    axum::http::StatusCode::CONFLICT,
                    "sponsorship_pool_exhausted",
                ));
            }
            let code = Uuid::new_v4();
            let secret = format!("pr-{}", auth::token()?);
            sqlx::query("INSERT INTO review_codes(id,code_hash,label,expires_at,issued_to) VALUES($1,$2,'Sponsored · one website assessment',now()+interval '30 days',$3)")
                .bind(code).bind(auth::hash(&secret)).bind(account).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO account_coupon_grants(account_id,code_id,public_slot) VALUES($1,$2,$3)")
                .bind(account).bind(code).bind((used+1) as i32).execute(&mut *tx).await?;
            code_id = Some(code);
        }
        sqlx::query("UPDATE coupon_requests SET status=$2,decided_at=now(),decided_by=$3,code_id=$4 WHERE id=$1")
            .bind(id).bind(status).bind(actor.id).bind(code_id).execute(&mut *tx).await?;
    }
    let row = sqlx::query_as(
        "SELECT id,status,note,created_at,decided_at FROM coupon_requests WHERE id=$1",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(row))
}

#[derive(Serialize, FromRow)]
pub(crate) struct JudgeCoupon {
    slot: i32,
    code: String,
    expires_at: DateTime<Utc>,
    used: bool,
}
/// A fixed batch of eight DM codes, separate from the public allocation. Only
/// staff can issue/read the batch. Repeating issuance never replaces used codes.
pub(crate) async fn judges(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<JudgeCoupon>>, ApiError> {
    access::admin(&state, &headers, false).await?;
    Ok(Json(judge_rows(&state.pool).await?))
}
pub(crate) async fn reserve_judges(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<JudgeCoupon>>, ApiError> {
    let actor = access::admin(&state, &headers, true).await?;
    review_codes::available(&state)?;
    let mut tx = state.pool.begin().await?;
    access::lock_admin(&mut tx, actor.id).await?;
    sqlx::query("SELECT singleton FROM welcome_coupon_program WHERE singleton FOR UPDATE")
        .execute(&mut *tx)
        .await?;
    for slot in 1..=8 {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM judge_coupon_pool WHERE slot=$1)")
                .bind(slot)
                .fetch_one(&mut *tx)
                .await?;
        if exists {
            continue;
        }
        let id = Uuid::new_v4();
        let code = format!("pr-{}", auth::token()?);
        sqlx::query("INSERT INTO review_codes(id,code_hash,label,expires_at) VALUES($1,$2,'Judge · one website assessment',now()+interval '30 days')")
            .bind(id).bind(auth::hash(&code)).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO judge_coupon_pool(slot,code_id,display_code,granted_by) VALUES($1,$2,$3,$4)")
            .bind(slot).bind(id).bind(code).bind(actor.id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(judge_rows(&state.pool).await?))
}
async fn judge_rows(pool: &sqlx::PgPool) -> Result<Vec<JudgeCoupon>, sqlx::Error> {
    sqlx::query_as("SELECT j.slot,j.display_code AS code,r.expires_at,(r.account_id IS NOT NULL OR r.revoked_at IS NOT NULL OR r.expires_at<=now()) AS used FROM judge_coupon_pool j JOIN review_codes r ON r.id=j.code_id ORDER BY j.slot")
        .fetch_all(pool).await
}
