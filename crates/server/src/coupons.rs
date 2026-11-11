//! Account-owned welcome coupons; only staff can retrieve transferable judge codes.
use crate::{ApiError, AppState, access, auth, review_codes};
use axum::{Json, extract::State, http::HeaderMap};
use chrono::{DateTime, Utc};
use serde::Serialize;
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

// Called once on entering the signed-in workspace. GET remains read-only.
// Only members created after this release receive a launch coupon automatically.
pub(crate) async fn welcome(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let account = auth::require_write(&headers, &state).await?;
    if review_codes::available(&state).is_err() {
        return Ok(Json(serde_json::json!({"ok":true})));
    }
    let mut tx = state.pool.begin().await?;
    let eligible:bool=sqlx::query_scalar("SELECT NOT disabled AND role='member' AND created_at >= (SELECT starts_at FROM welcome_coupon_program WHERE singleton) FROM accounts WHERE id=$1 FOR UPDATE")
        .bind(account.id).fetch_one(&mut *tx).await?;
    if eligible {
        // Global lock serializes the last available slot; account lock serializes
        // duplicate requests, including requests from several browser tabs.
        sqlx::query("SELECT singleton FROM welcome_coupon_program WHERE singleton FOR UPDATE")
            .execute(&mut *tx)
            .await?;
        let granted:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account_coupon_grants WHERE account_id=$1) OR EXISTS(SELECT 1 FROM trial_claims WHERE account_id=$1)")
            .bind(account.id).fetch_one(&mut *tx).await?;
        let used: i64 = sqlx::query_scalar("SELECT count(*) FROM account_coupon_grants")
            .fetch_one(&mut *tx)
            .await?;
        if !granted && used < 100 {
            let id = Uuid::new_v4();
            let secret = format!("pr-{}", auth::token()?);
            sqlx::query("INSERT INTO review_codes(id,code_hash,label,expires_at,issued_to) VALUES($1,$2,'Welcome · one website assessment',now()+interval '30 days',$3)")
                .bind(id).bind(auth::hash(&secret)).bind(account.id).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO account_coupon_grants(account_id,code_id,public_slot) VALUES($1,$2,$3)")
                .bind(account.id).bind(id).bind((used+1) as i32).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    Ok(Json(serde_json::json!({"ok":true})))
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
