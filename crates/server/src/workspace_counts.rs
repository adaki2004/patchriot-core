//! Private, aggregate counts of authenticated workspace activity. Never accepts
//! a caller-selected account, timestamp, URL or event payload.
use crate::{ApiError, AppState, access, auth};
use axum::{Json, extract::State, http::HeaderMap};
use serde::Serialize;

pub(crate) async fn record(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let session = auth::require_write(&headers, &state).await?;
    if !state.config.workspace_counts_enabled {
        return Ok(Json(serde_json::json!({"enabled": false})));
    }
    // Duplicate tabs/sessions cannot inflate distinct-account totals. Bound
    // database writes to once per minute per account, using the server's clock.
    sqlx::query("INSERT INTO workspace_activity(account_id,last_seen_at) VALUES($1,now()) ON CONFLICT(account_id) DO UPDATE SET last_seen_at=now() WHERE workspace_activity.last_seen_at < now()-interval '1 minute'")
        .bind(session.id).execute(&state.pool).await?;
    // Expired timestamps are pruned as activity is recorded, and on admin reads.
    prune(&state.pool).await?;
    Ok(Json(serde_json::json!({"enabled": true})))
}

async fn prune(pool: &sqlx::PgPool) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM workspace_activity WHERE last_seen_at < now()-interval '30 days'")
        .execute(pool)
        .await?;
    Ok(())
}

#[derive(Serialize, sqlx::FromRow)]
struct Counts {
    active_15m: i64,
    active_24h: i64,
    active_7d: i64,
}

pub(crate) async fn summary(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    access::admin(&state, &headers, false).await?;
    if !state.config.workspace_counts_enabled {
        return Ok(Json(serde_json::json!({"enabled": false})));
    }
    prune(&state.pool).await?;
    let counts: Counts = sqlx::query_as("SELECT count(*) FILTER(WHERE w.last_seen_at >= now()-interval '15 minutes') AS active_15m, count(*) FILTER(WHERE w.last_seen_at >= now()-interval '24 hours') AS active_24h, count(*) FILTER(WHERE w.last_seen_at >= now()-interval '7 days') AS active_7d FROM workspace_activity w JOIN accounts a ON a.id=w.account_id WHERE NOT a.disabled")
        .fetch_one(&state.pool).await?;
    Ok(Json(
        serde_json::json!({"enabled": true, "counts": counts, "as_of": chrono::Utc::now().timestamp()}),
    ))
}
