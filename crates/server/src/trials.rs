//! Requested, account-bound sponsorship. The campaign limits cost; it does not
//! identify a unique human. All normal scope, consent and redemption checks apply.
use crate::{ApiError, AppState, access, auth, review_codes};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Serialize, FromRow)]
pub(crate) struct Campaign {
    campaign_id: Uuid,
    started_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
    claim_limit: i32,
    claimed: i32,
    stopped_at: Option<DateTime<Utc>>,
}
impl Campaign {
    fn open(&self) -> bool {
        self.stopped_at.is_none()
            && self.started_at <= Utc::now()
            && self.ends_at > Utc::now()
            && self.claimed < self.claim_limit
    }
}

#[derive(Serialize, FromRow)]
pub(crate) struct Claim {
    id: Uuid,
    code: String,
    expires_at: DateTime<Utc>,
    reserved_at: Option<DateTime<Utc>>,
    review_id: Option<Uuid>,
    revoked_at: Option<DateTime<Utc>>,
}
const CLAIM_SELECT: &str = "SELECT r.id,c.display_code AS code,r.expires_at,r.reserved_at,r.review_id,r.revoked_at FROM trial_claims c JOIN review_codes r ON r.id=c.code_id WHERE c.account_id=$1 AND r.issued_to=$1";

#[derive(Serialize)]
pub(crate) struct Offer {
    available: bool,
    ends_at: Option<DateTime<Utc>>,
    claim: Option<Claim>,
}
pub(crate) async fn offer(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Offer>, ApiError> {
    let session = auth::require_session(&headers, &state).await?;
    let claim = sqlx::query_as::<_, Claim>(CLAIM_SELECT)
        .bind(session.id)
        .fetch_optional(&state.pool)
        .await?;
    let welcome_granted: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM account_coupon_grants WHERE account_id=$1)",
    )
    .bind(session.id)
    .fetch_one(&state.pool)
    .await?;
    let campaign = sqlx::query_as::<_, Campaign>("SELECT * FROM trial_campaign")
        .fetch_optional(&state.pool)
        .await?;
    Ok(Json(Offer {
        available: review_codes::available(&state).is_ok()
            && claim.is_none()
            && !welcome_granted
            && campaign.as_ref().is_some_and(Campaign::open),
        ends_at: campaign.map(|c| c.ends_at),
        claim,
    }))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ClaimRequest {
    accepts_trial: bool,
}
pub(crate) async fn claim(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ClaimRequest>,
) -> Result<Json<Claim>, ApiError> {
    let session = auth::require_write(&headers, &state).await?;
    review_codes::available(&state)?;
    if !input.accepts_trial {
        return Err(ApiError::bad("trial_confirmation_required"));
    }
    review_codes::rate(&state.pool, session.id).await?;
    let mut tx = state.pool.begin().await?;
    let enabled: Option<bool> =
        sqlx::query_scalar("SELECT NOT disabled FROM accounts WHERE id=$1 FOR UPDATE")
            .bind(session.id)
            .fetch_optional(&mut *tx)
            .await?;
    if enabled != Some(true) {
        return Err(ApiError::denied());
    }
    // Lock the account first, just like coupon reservation. Repeated or concurrent
    // requests return the same code; neither consumes another campaign place.
    if let Some(saved) = sqlx::query_as::<_, Claim>(CLAIM_SELECT)
        .bind(session.id)
        .fetch_optional(&mut *tx)
        .await?
    {
        return Ok(Json(saved));
    }
    let welcome_granted: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM account_coupon_grants WHERE account_id=$1)",
    )
    .bind(session.id)
    .fetch_one(&mut *tx)
    .await?;
    if welcome_granted {
        return Err(ApiError::new(StatusCode::CONFLICT, "trial_unavailable"));
    }
    let campaign = sqlx::query_as::<_, Campaign>("SELECT * FROM trial_campaign FOR UPDATE")
        .fetch_optional(&mut *tx)
        .await?;
    let campaign = campaign
        .filter(Campaign::open)
        .ok_or_else(|| ApiError::new(StatusCode::CONFLICT, "trial_unavailable"))?;
    let id = Uuid::new_v4();
    let code = format!("pr-{}", auth::token()?);
    // Seven days to arrange DNS, even if the claim campaign closes sooner.
    sqlx::query("INSERT INTO review_codes(id,code_hash,label,expires_at,issued_to) VALUES($1,$2,'Free trial',now()+interval '7 days',$3)").bind(id).bind(auth::hash(&code)).bind(session.id).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO trial_claims(account_id,campaign_id,code_id,display_code) VALUES($1,$2,$3,$4)",
    )
    .bind(session.id)
    .bind(campaign.campaign_id)
    .bind(id)
    .bind(code)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE trial_campaign SET claimed=claimed+1 WHERE singleton")
        .execute(&mut *tx)
        .await?;
    let saved = sqlx::query_as(CLAIM_SELECT)
        .bind(session.id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(saved))
}

#[derive(Serialize)]
pub(crate) struct Desk {
    campaign: Option<Campaign>,
    total_claimed: i64,
    reserved: i64,
    started: i64,
}
pub(crate) async fn desk(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Desk>, ApiError> {
    access::admin(&state, &headers, false).await?;
    let campaign = sqlx::query_as("SELECT * FROM trial_campaign")
        .fetch_optional(&state.pool)
        .await?;
    let (total_claimed,reserved,started)=sqlx::query_as("SELECT count(*),count(*) FILTER(WHERE r.reserved_at IS NOT NULL),count(*) FILTER(WHERE r.review_id IS NOT NULL) FROM trial_claims c JOIN review_codes r ON r.id=c.code_id").fetch_one(&state.pool).await?;
    Ok(Json(Desk {
        campaign,
        total_claimed,
        reserved,
        started,
    }))
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum CampaignAction {
    Start { hours: i32, claim_limit: i32 },
    Stop,
}
pub(crate) async fn configure(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CampaignAction>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let actor = access::admin(&state, &headers, true).await?;
    let mut tx = state.pool.begin().await?;
    access::lock_admin(&mut tx, actor.id).await?;
    // Also serializes the first campaign, before a singleton row exists.
    sqlx::query("SELECT pg_advisory_xact_lock(709108)")
        .execute(&mut *tx)
        .await?;
    let current = sqlx::query_as::<_, Campaign>("SELECT * FROM trial_campaign FOR UPDATE")
        .fetch_optional(&mut *tx)
        .await?;
    let (campaign_id, action) = match input {
        CampaignAction::Start { hours, claim_limit } => {
            review_codes::available(&state)?;
            if ![24, 48].contains(&hours) || !(1..=10000).contains(&claim_limit) {
                return Err(ApiError::bad("invalid_trial_campaign"));
            }
            if current
                .as_ref()
                .is_some_and(|c| c.stopped_at.is_none() && c.ends_at > Utc::now())
            {
                return Err(ApiError::new(StatusCode::CONFLICT, "trial_campaign_active"));
            }
            let id = Uuid::new_v4();
            sqlx::query("INSERT INTO trial_campaign(singleton,campaign_id,started_at,ends_at,claim_limit,claimed,created_by) VALUES(true,$1,now(),now()+make_interval(hours=>$2),$3,0,$4) ON CONFLICT(singleton) DO UPDATE SET campaign_id=EXCLUDED.campaign_id,started_at=EXCLUDED.started_at,ends_at=EXCLUDED.ends_at,claim_limit=EXCLUDED.claim_limit,claimed=0,stopped_at=NULL,created_by=EXCLUDED.created_by").bind(id).bind(hours).bind(claim_limit).bind(actor.id).execute(&mut *tx).await?;
            (id, "started")
        }
        CampaignAction::Stop => {
            let id = current
                .ok_or_else(|| ApiError::bad("trial_unavailable"))?
                .campaign_id;
            sqlx::query(
                "UPDATE trial_campaign SET stopped_at=COALESCE(stopped_at,now()) WHERE singleton",
            )
            .execute(&mut *tx)
            .await?;
            (id, "stopped")
        }
    };
    sqlx::query("INSERT INTO trial_campaign_log(campaign_id,actor_id,action) VALUES($1,$2,$3)")
        .bind(campaign_id)
        .bind(actor.id)
        .bind(action)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(serde_json::json!({"ok":true})))
}
