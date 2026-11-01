//! One-use sponsorship for an approved snapshot review. Codes cover work, not
//! money. The original consent is saved before dispatch and reused on every retry.

use crate::{ApiError, AppState, auth, gateway, payments::access::ReviewAccess};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use patchriot_protocol::{
    FixtureScenario, ReviewMode, ReviewView, website_reviews::CreateWebsiteReview,
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

#[derive(Serialize)]
pub struct IssuedCode {
    pub id: Uuid,
    pub code: String,
    pub expires_at: DateTime<Utc>,
}

/// Operator CLI only. The raw code is shown once; the database keeps its hash.
pub async fn issue(pool: &PgPool, label: &str) -> Result<IssuedCode, String> {
    if label.trim().is_empty() || label.len() > 80 || label.chars().any(char::is_control) {
        return Err("use a label of 1–80 characters".into());
    }
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| "random source unavailable")?;
    let code = format!("pr-{}", hex::encode(bytes));
    let id = Uuid::new_v4();
    let expires_at = sqlx::query_scalar("INSERT INTO review_codes (id,code_hash,label,expires_at) VALUES ($1,$2,$3,now() + interval '7 days') RETURNING expires_at")
        .bind(id).bind(hash(&code)).bind(label.trim()).fetch_one(pool).await.map_err(|_| "review code creation failed")?;
    Ok(IssuedCode {
        id,
        code,
        expires_at,
    })
}

/// Only unused codes can be revoked. An existing review has its own cancellation.
pub async fn revoke(pool: &PgPool, id: Uuid) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query("UPDATE review_codes SET revoked_at = now(), updated_at = now() WHERE id = $1 AND account_id IS NULL AND revoked_at IS NULL")
        .bind(id).execute(pool).await?.rows_affected() == 1)
}

fn hash(code: &str) -> String {
    hex::encode(Sha256::digest(code.as_bytes()))
}

fn available(state: &AppState) -> Result<(), ApiError> {
    if !matches!(
        state.review_access,
        ReviewAccess::Coupons | ReviewAccess::Paid(_)
    ) {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "review_codes_unavailable",
        ));
    }
    Ok(())
}

// A separate committed counter includes rejected guesses. No HTTP call holds a
// database transaction, and neither the raw code nor an upstream body is logged.
async fn rate(pool: &PgPool, account: Uuid) -> Result<(), ApiError> {
    let count: Option<i32> = sqlx::query_scalar("INSERT INTO review_code_attempts (account_id,started_at,attempts) VALUES ($1,now(),1) ON CONFLICT (account_id) DO UPDATE SET started_at = CASE WHEN review_code_attempts.started_at <= now() - interval '15 minutes' THEN now() ELSE review_code_attempts.started_at END, attempts = CASE WHEN review_code_attempts.started_at <= now() - interval '15 minutes' THEN 1 ELSE review_code_attempts.attempts + 1 END WHERE review_code_attempts.started_at <= now() - interval '15 minutes' OR review_code_attempts.attempts < 20 RETURNING attempts")
        .bind(account).fetch_optional(pool).await?;
    count
        .map(|_| ())
        .ok_or_else(|| ApiError::new(StatusCode::TOO_MANY_REQUESTS, "try_again_later"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RedeemCode {
    code: String,
    consent: CreateWebsiteReview,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ResumeCode {}

#[derive(FromRow)]
struct Saved {
    id: Uuid,
    issued_to: Option<Uuid>,
    expires_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
    account_id: Option<Uuid>,
    site_check_id: Option<Uuid>,
    consent: Option<Value>,
    review_id: Option<Uuid>,
    operation_until: Option<DateTime<Utc>>,
}

#[derive(Serialize, FromRow)]
pub(crate) struct Reservation {
    id: Uuid,
    label: String,
    site_check_id: Uuid,
    request_id: Uuid,
    consent: Value,
    reserved_at: DateTime<Utc>,
    review_id: Option<Uuid>,
    last_error: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct Started {
    redemption_id: Uuid,
    request_id: Uuid,
    review_id: Uuid,
}

fn unavailable() -> ApiError {
    ApiError::bad("invalid_or_used_review_code")
}

fn preparing() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "review_code_preparing")
}

async fn reserve(
    pool: &PgPool,
    account: Uuid,
    site: Uuid,
    input: RedeemCode,
) -> Result<Uuid, ApiError> {
    let code = input.code.trim().to_ascii_lowercase();
    if code.len() != 67
        || !code.starts_with("pr-")
        || !code[3..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(unavailable());
    }
    let consent = &input.consent;
    if !consent.accepts_operator_access
        || consent.device_ids.len() != 3
        || consent
            .device_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != 3
        || consent.snapshot_sha256.len() != 64
        || !consent
            .snapshot_sha256
            .bytes()
            .all(|b| b.is_ascii_hexdigit())
    {
        return Err(ApiError::bad("invalid_request"));
    }
    let terms = serde_json::to_value(consent).map_err(|_| ApiError::bad("invalid_request"))?;
    let mut tx = pool.begin().await?;
    let enabled: Option<bool> =
        sqlx::query_scalar("SELECT NOT disabled FROM accounts WHERE id = $1 FOR UPDATE")
            .bind(account)
            .fetch_optional(&mut *tx)
            .await?;
    if enabled != Some(true) {
        return Err(ApiError::denied());
    }
    let saved: Saved = sqlx::query_as("SELECT id,issued_to,expires_at,revoked_at,account_id,site_check_id,consent,review_id,operation_until FROM review_codes WHERE code_hash = $1 FOR UPDATE")
        .bind(hash(&code)).fetch_optional(&mut *tx).await?.ok_or_else(unavailable)?;
    if saved
        .issued_to
        .is_some_and(|recipient| recipient != account)
    {
        return Err(unavailable());
    }
    if let Some(owner) = saved.account_id {
        if owner != account {
            return Err(unavailable());
        }
        if saved.site_check_id != Some(site) || saved.consent.as_ref() != Some(&terms) {
            return Err(ApiError::new(StatusCode::CONFLICT, "review_code_bound"));
        }
    } else {
        if saved.revoked_at.is_some() || saved.expires_at <= Utc::now() {
            return Err(unavailable());
        }
        let occupied: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM review_codes WHERE account_id = $1 AND request_id = $2) OR EXISTS (SELECT 1 FROM checkout_orders WHERE account_id = $1 AND request_id = $2)")
            .bind(account).bind(consent.request_id).fetch_one(&mut *tx).await?;
        if occupied {
            return Err(ApiError::new(StatusCode::CONFLICT, "request_conflict"));
        }
        sqlx::query("UPDATE review_codes SET account_id = $2,request_id = $3,site_check_id = $4,consent = $5,reserved_at = now(),updated_at = now() WHERE id = $1")
            .bind(saved.id).bind(account).bind(consent.request_id).bind(site).bind(terms).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(saved.id)
}

async fn start(state: &AppState, account: Uuid, id: Uuid) -> Result<Started, ApiError> {
    let mut tx = state.pool.begin().await?;
    let enabled: Option<bool> =
        sqlx::query_scalar("SELECT NOT disabled FROM accounts WHERE id = $1 FOR UPDATE")
            .bind(account)
            .fetch_optional(&mut *tx)
            .await?;
    if enabled != Some(true) {
        return Err(ApiError::denied());
    }
    let saved: Saved = sqlx::query_as("SELECT id,issued_to,expires_at,revoked_at,account_id,site_check_id,consent,review_id,operation_until FROM review_codes WHERE id = $1 AND account_id = $2 FOR UPDATE")
        .bind(id).bind(account).fetch_optional(&mut *tx).await?.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "not_found"))?;
    let site = saved
        .site_check_id
        .ok_or_else(|| ApiError::bad("invalid_request"))?;
    let consent: CreateWebsiteReview = serde_json::from_value(
        saved
            .consent
            .ok_or_else(|| ApiError::bad("invalid_request"))?,
    )
    .map_err(|_| ApiError::bad("invalid_request"))?;
    if let Some(review_id) = saved.review_id {
        return Ok(Started {
            redemption_id: id,
            request_id: consent.request_id,
            review_id,
        });
    }
    if saved
        .operation_until
        .is_some_and(|until| until > Utc::now())
    {
        return Err(preparing());
    }
    let operation = Uuid::new_v4();
    sqlx::query("UPDATE review_codes SET operation_token = $2, operation_until = now() + interval '30 seconds', last_error = NULL, updated_at = now() WHERE id = $1")
        .bind(id).bind(operation).execute(&mut *tx).await?;
    tx.commit().await?;
    let reply: Result<Json<ReviewView>, ApiError> = gateway::request_for_account(
        state,
        Method::POST,
        &format!("/internal/site-checks/{site}/review"),
        account,
        Some(&consent),
    )
    .await;
    let result = match reply {
        Ok(Json(review)) if matches_review(&review, site, &consent) => Ok(review.id),
        Ok(_) => Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "invalid_dispatcher_response",
        )),
        Err(error) => Err(error),
    };
    // Never free a reserved code after an error: the dispatcher might already
    // have started the review. Resume uses the same snapshot, agents and key.
    let changed = sqlx::query("UPDATE review_codes SET review_id = $3, last_error = $4, operation_token = NULL, operation_until = NULL, updated_at = now() WHERE id = $1 AND account_id = $5 AND operation_token = $2")
        .bind(id).bind(operation).bind(result.as_ref().ok().copied()).bind(result.as_ref().err().map(|e| e.code)).bind(account)
        .execute(&state.pool).await?.rows_affected();
    if changed != 1 {
        return Err(preparing());
    }
    Ok(Started {
        redemption_id: id,
        request_id: consent.request_id,
        review_id: result?,
    })
}

fn matches_review(review: &ReviewView, site: Uuid, consent: &CreateWebsiteReview) -> bool {
    review.request_id == consent.request_id
        && review.mode == ReviewMode::WebsiteAgent.as_str()
        && review.scenario == FixtureScenario::WebsiteSnapshotV1
        && review.payment.is_none()
        && review.website.as_ref().is_some_and(|context| {
            context.site_check_id == site
                && context.snapshot_sha256 == consent.snapshot_sha256
                && context
                    .reviewers
                    .iter()
                    .map(|r| r.device_id)
                    .collect::<Vec<_>>()
                    == consent.device_ids
        })
}

pub(crate) async fn redeem(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(site): Path<Uuid>,
    Json(input): Json<RedeemCode>,
) -> Result<Json<Started>, ApiError> {
    let session = auth::require_write(&headers, &state).await?;
    available(&state)?;
    rate(&state.pool, session.id).await?;
    let id = reserve(&state.pool, session.id, site, input).await?;
    Ok(Json(start(&state, session.id, id).await?))
}

pub(crate) async fn resume(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(_): Json<ResumeCode>,
) -> Result<Json<Started>, ApiError> {
    let session = auth::require_write(&headers, &state).await?;
    available(&state)?;
    rate(&state.pool, session.id).await?;
    Ok(Json(start(&state, session.id, id).await?))
}

pub(crate) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<Reservation>>, ApiError> {
    let session = auth::require_session(&headers, &state).await?;
    let rows = sqlx::query_as("SELECT id,label,site_check_id,request_id,consent,reserved_at,review_id,last_error FROM review_codes WHERE account_id = $1 ORDER BY (review_id IS NULL) DESC, reserved_at DESC LIMIT 50")
        .bind(session.id).fetch_all(&state.pool).await?;
    Ok(Json(rows))
}
