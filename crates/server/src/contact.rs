//! A bounded contact inbox, not an account invitation or test authorization.
//! Content stays with staff; no automated email or model receives it.
use crate::{ApiError, AppState, access, auth};
use axum::{
    Extension, Json,
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::net::SocketAddr;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Inquiry {
    request_id: Uuid,
    name: String,
    email: String,
    organization: String,
    message: String,
}

pub(crate) async fn details(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({"email":state.config.contact_email}))
}

pub(crate) async fn create(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(input): Json<Inquiry>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    auth::origin(&headers, &state.config)?;
    // Separate from sign-in limits. Forwarded headers are not a trusted identity;
    // behind a proxy the socket-peer bucket is deliberately shared.
    access::rate(&state.pool, "contact:global", 100, 900).await?;
    let peer = peer
        .map(|Extension(ConnectInfo(a))| a.ip().to_string())
        .unwrap_or_else(|| "unknown-peer".into());
    access::rate(&state.pool, &format!("contact:peer:{peer}"), 10, 900).await?;
    let email = access::contact(&input.email)?;
    access::rate(&state.pool, &format!("contact:email:{email}"), 3, 86400).await?;
    sqlx::query("DELETE FROM auth_attempts WHERE started_at < now() - interval '2 days'")
        .execute(&state.pool)
        .await?;
    let name = input.name.trim();
    let organization = input.organization.trim();
    let message = input.message.trim();
    let line =
        |v: &str, max: usize| !v.is_empty() && v.len() <= max && !v.chars().any(char::is_control);
    if input.request_id.is_nil()
        || !line(name, 80)
        || !line(organization, 160)
        || !(20..=3000).contains(&message.len())
        || message
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
    {
        return Err(ApiError::bad("invalid_inquiry"));
    }
    let saved: Option<Uuid> = sqlx::query_scalar("INSERT INTO enterprise_inquiries(id,name,email,organization,message) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET id=enterprise_inquiries.id WHERE enterprise_inquiries.name=$2 AND enterprise_inquiries.email=$3 AND enterprise_inquiries.organization=$4 AND enterprise_inquiries.message=$5 RETURNING id")
        .bind(input.request_id).bind(name).bind(email).bind(organization).bind(message)
        .fetch_optional(&state.pool).await?;
    if saved.is_none() {
        return Err(ApiError::new(StatusCode::CONFLICT, "inquiry_changed"));
    }
    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::json!({"received":true})),
    ))
}

#[derive(Serialize, FromRow)]
pub(crate) struct Saved {
    id: Uuid,
    name: String,
    email: String,
    organization: String,
    message: String,
    state: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

pub(crate) async fn inbox(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<Saved>>, ApiError> {
    access::admin(&state, &headers, false).await?;
    Ok(Json(sqlx::query_as("SELECT * FROM enterprise_inquiries ORDER BY (state='open') DESC,created_at DESC,id LIMIT 100")
        .fetch_all(&state.pool).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Decision {
    handled: bool,
}

pub(crate) async fn decide(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<Decision>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let session = access::admin(&state, &headers, true).await?;
    let mut tx = state.pool.begin().await?;
    access::lock_admin(&mut tx, session.id).await?;
    let next = if input.handled { "handled" } else { "open" };
    let changed = sqlx::query("UPDATE enterprise_inquiries SET state=$2,updated_at=CASE WHEN state<>$2 THEN now() ELSE updated_at END,updated_by=CASE WHEN state<>$2 THEN $3 ELSE updated_by END WHERE id=$1")
        .bind(id).bind(next).bind(session.id).execute(&mut *tx).await?;
    if changed.rows_affected() != 1 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "inquiry_not_found"));
    }
    tx.commit().await?;
    Ok(Json(serde_json::json!({"saved":true})))
}
