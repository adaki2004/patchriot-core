//! Manually reviewed public research. No customer report is copied here and no
//! source URL is fetched by the server. Drafts and their edit history stay private.

use crate::{ApiError, AppState, auth};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, types::Json as DbJson};
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    label: String,
    url: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Evidence {
    Reported,
    Confirmed,
    Advisory,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Content {
    title: String,
    occurred_on: NaiveDate,
    evidence: Evidence,
    summary: String,
    takeaway: String,
    sources: Vec<Source>,
}

fn text(value: &str, maximum: usize, multiline: bool) -> bool {
    !value.trim().is_empty()
        && value == value.trim()
        && value.len() <= maximum
        && !value
            .chars()
            .any(|c| c.is_control() && !(multiline && c == '\n'))
}

impl Content {
    fn valid(&self) -> bool {
        text(&self.title, 140, false)
            && text(&self.summary, 2400, true)
            && text(&self.takeaway, 1200, true)
            && self.occurred_on >= NaiveDate::from_ymd_opt(1970, 1, 1).unwrap()
            && self.occurred_on <= Utc::now().date_naive()
            && (1..=4).contains(&self.sources.len())
            && self.sources.iter().all(|source| {
                text(&source.label, 100, false)
                    && text(&source.url, 1500, false)
                    && url::Url::parse(&source.url).is_ok_and(|url| {
                        // Sources are public HTTPS links, never executable URLs,
                        // embedded credentials, local IPs or query-string secrets.
                        // This syntax check does not verify a source's claims.
                        url.scheme() == "https"
                            && url.username().is_empty()
                            && url.password().is_none()
                            && url.query().is_none()
                            && url.port().is_none()
                            && matches!(url.host(), Some(url::Host::Domain(host))
                                if host.contains('.') && !host.ends_with('.')
                                    && !["localhost", "local", "internal", "test", "invalid"].iter().any(|suffix|
                                        host == *suffix || host.ends_with(&format!(".{suffix}"))))
                    })
            })
    }
}

#[derive(FromRow, Serialize)]
pub struct Draft {
    id: Uuid,
    revision: i32,
    content: DbJson<Content>,
    published_revision: Option<i32>,
    published_at: Option<DateTime<Utc>>,
    updated_at: DateTime<Utc>,
}

#[derive(FromRow, Serialize)]
pub struct Published {
    id: Uuid,
    revision: i32,
    content: DbJson<Content>,
    published_at: DateTime<Utc>,
}

/// Fixed-size reads keep this informational feed out of the dispatcher path.
/// No requester/device identity, draft, audit record or private finding is returned.
pub async fn list(State(state): State<AppState>) -> Result<Json<Vec<Published>>, ApiError> {
    Ok(Json(sqlx::query_as("SELECT id, published_revision AS revision, published_content AS content, published_at FROM incidents WHERE published_content IS NOT NULL ORDER BY published_at DESC, id LIMIT 50")
        .fetch_all(&state.pool).await?))
}

async fn admin(headers: &HeaderMap, state: &AppState, write: bool) -> Result<Uuid, ApiError> {
    let session = if write {
        auth::require_write(headers, state).await?
    } else {
        auth::require_session(headers, state).await?
    };
    if session.role != "admin" {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "admin_required"));
    }
    Ok(session.id)
}

pub async fn drafts(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<Draft>>, ApiError> {
    admin(&headers, &state, false).await?;
    Ok(Json(sqlx::query_as("SELECT id, revision, content, published_revision, published_at, updated_at FROM incidents ORDER BY updated_at DESC, id LIMIT 100")
        .fetch_all(&state.pool).await?))
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Edit {
    /// Revision 0 creates this UUID. Retrying the same creation cannot duplicate it.
    Save {
        revision: i32,
        content: Content,
    },
    Publish {
        revision: i32,
        sources_reviewed: bool,
    },
    Withdraw {
        revision: i32,
    },
}

pub async fn edit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<Edit>,
) -> Result<Json<Draft>, ApiError> {
    let actor = admin(&headers, &state, true).await?;
    let mut tx = state.pool.begin().await?;
    let (changed, action) = match input {
        Edit::Save { revision, content } => {
            if revision < 0 || !content.valid() {
                return Err(ApiError::bad("invalid_incident"));
            }
            let result = if revision == 0 {
                sqlx::query("INSERT INTO incidents (id, revision, content) VALUES ($1, 1, $2) ON CONFLICT (id) DO NOTHING")
                    .bind(id).bind(DbJson(content)).execute(&mut *tx).await?
            } else {
                sqlx::query("UPDATE incidents SET content = $3, revision = revision + 1, updated_at = now() WHERE id = $1 AND revision = $2 AND revision < 2147483647")
                    .bind(id).bind(revision).bind(DbJson(content)).execute(&mut *tx).await?
            };
            (result.rows_affected(), "draft_saved")
        }
        Edit::Publish {
            revision,
            sources_reviewed,
        } => {
            if revision < 1 || !sources_reviewed {
                return Err(ApiError::bad("sources_review_required"));
            }
            let result = sqlx::query("UPDATE incidents SET published_content = content, published_revision = revision + 1, published_at = now(), revision = revision + 1, updated_at = now() WHERE id = $1 AND revision = $2 AND revision < 2147483647")
                .bind(id).bind(revision).execute(&mut *tx).await?;
            (result.rows_affected(), "published")
        }
        Edit::Withdraw { revision } => {
            if revision < 1 {
                return Err(ApiError::bad("invalid_incident"));
            }
            let result = sqlx::query("UPDATE incidents SET published_content = NULL, published_revision = NULL, published_at = NULL, revision = revision + 1, updated_at = now() WHERE id = $1 AND revision = $2 AND published_content IS NOT NULL AND revision < 2147483647")
                .bind(id).bind(revision).execute(&mut *tx).await?;
            (result.rows_affected(), "withdrawn")
        }
    };
    if changed != 1 {
        return Err(ApiError::new(StatusCode::CONFLICT, "incident_changed"));
    }
    let draft: Draft = sqlx::query_as("SELECT id, revision, content, published_revision, published_at, updated_at FROM incidents WHERE id = $1")
        .bind(id).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO incident_edits (incident_id, revision, actor_id, action, snapshot) VALUES ($1,$2,$3,$4,$5)")
        .bind(id).bind(draft.revision).bind(actor).bind(action).bind(DbJson(&draft)).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(draft))
}
