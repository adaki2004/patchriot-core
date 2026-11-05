use crate::{ApiError, AppState, Config};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use subtle::ConstantTimeEq;
use uuid::Uuid;

pub(crate) fn token() -> Result<String, ApiError> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "random_source_unavailable",
        )
    })?;
    Ok(hex::encode(bytes))
}
pub(crate) fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

/// The CLI/operator may issue a one-use invitation. No HTTP route lets an
/// unauthenticated browser choose its own role or create an administrator.
pub async fn create_invite(pool: &PgPool, name: &str, role: &str) -> Result<String, String> {
    if name.trim().is_empty()
        || name.len() > 80
        || name.chars().any(char::is_control)
        || !["member", "admin"].contains(&role)
    {
        return Err("invalid invite name or role".into());
    }
    let invite = token().map_err(|_| "random source unavailable")?;
    let mut tx = pool.begin().await.map_err(|_| "database unavailable")?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id, display_name, role) VALUES ($1,$2,$3)")
        .bind(id)
        .bind(name.trim())
        .bind(role)
        .execute(&mut *tx)
        .await
        .map_err(|_| "account creation failed")?;
    sqlx::query("INSERT INTO invites (token_hash, account_id, expires_at) VALUES ($1,$2,now() + interval '1 day')").bind(hash(&invite)).bind(id).execute(&mut *tx).await.map_err(|_| "invite creation failed")?;
    tx.commit().await.map_err(|_| "invite commit failed")?;
    Ok(invite)
}

/// Issue fresh login access without creating a second operator identity. A
/// disabled account cannot be recovered through this command.
pub async fn invite_account(pool: &PgPool, id: Uuid) -> Result<String, String> {
    let invite = token().map_err(|_| "random source unavailable")?;
    let result = sqlx::query("INSERT INTO invites (token_hash, account_id, expires_at) SELECT $1, id, now() + interval '1 day' FROM accounts WHERE id = $2 AND NOT disabled")
        .bind(hash(&invite)).bind(id).execute(pool).await.map_err(|_| "invite creation failed")?;
    if result.rows_affected() != 1 {
        return Err("account not found or disabled".into());
    }
    Ok(invite)
}

/// Disable login and invalidate all sessions. This operator-only CLI operation
/// also provides cleanup for local browser smoke-test accounts.
pub async fn disable_account(pool: &PgPool, id: Uuid) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let result = sqlx::query("UPDATE accounts SET disabled = true WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE account_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(result.rows_affected() == 1)
}

#[derive(Serialize)]
pub(crate) struct Account {
    pub id: Uuid,
    pub display_name: String,
    pub role: String,
    pub auth_method: String,
}

#[derive(FromRow)]
pub(crate) struct Session {
    pub id: Uuid,
    pub display_name: String,
    pub role: String,
    pub auth_method: String,
    pub csrf_token: String,
    token_hash: String,
}
impl Session {
    fn view(&self) -> serde_json::Value {
        serde_json::json!({"account":Account { id:self.id, display_name:self.display_name.clone(), role:self.role.clone(), auth_method:self.auth_method.clone() }, "csrf_token":self.csrf_token})
    }
}

fn cookie_token(headers: &HeaderMap, config: &Config) -> Option<String> {
    cookie_value(headers, config.cookie_name())
}

pub(crate) fn cookie_value(headers: &HeaderMap, cookie_name: &str) -> Option<String> {
    let mut found = None;
    for header in headers.get_all(header::COOKIE) {
        for pair in header.to_str().ok()?.split(';') {
            let Some((name, value)) = pair.trim().split_once('=') else {
                continue;
            };
            if name == cookie_name {
                if found.is_some()
                    || value.len() != 64
                    || !value.bytes().all(|b| b.is_ascii_hexdigit())
                {
                    return None;
                }
                found = Some(value.to_owned());
            }
        }
    }
    found
}

pub(crate) async fn require_session(
    headers: &HeaderMap,
    state: &AppState,
) -> Result<Session, ApiError> {
    let value = cookie_token(headers, &state.config).ok_or_else(ApiError::denied)?;
    sqlx::query_as::<_, Session>("SELECT a.id, a.display_name, a.role, a.auth_method, s.csrf_token, s.token_hash FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT a.disabled")
        .bind(hash(&value)).fetch_optional(&state.pool).await?.ok_or_else(ApiError::denied)
}

pub(crate) fn origin(headers: &HeaderMap, config: &Config) -> Result<(), ApiError> {
    if headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
        != Some(config.public_origin.as_str())
    {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "origin_not_allowed"));
    }
    Ok(())
}

pub(crate) async fn require_write(
    headers: &HeaderMap,
    state: &AppState,
) -> Result<Session, ApiError> {
    origin(headers, &state.config)?;
    let session = require_session(headers, state).await?;
    let csrf = headers
        .get("x-csrf-token")
        .and_then(|h| h.to_str().ok())
        .ok_or_else(|| ApiError::new(StatusCode::FORBIDDEN, "csrf_required"))?;
    let expected: [u8; 32] = Sha256::digest(session.csrf_token.as_bytes()).into();
    let supplied: [u8; 32] = Sha256::digest(csrf.as_bytes()).into();
    if !bool::from(expected.ct_eq(&supplied)) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "csrf_required"));
    }
    Ok(session)
}

pub async fn session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    match require_session(&headers, &state).await {
        Ok(session) => Ok(Json(session.view())),
        Err(error) if error.status == StatusCode::UNAUTHORIZED => {
            Ok(Json(serde_json::json!({"account":null,"csrf_token":null})))
        }
        Err(error) => Err(error),
    }
}

/// Unlike the public session probe, this endpoint requires authentication.
/// HTTP assessment clients can compare an anonymous 401 with a signed-in 200.
pub(crate) async fn account(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let session = require_session(&headers, &state).await?;
    Ok(Json(serde_json::json!({"account": Account {
        id: session.id, display_name: session.display_name,
        role: session.role, auth_method: session.auth_method,
    }})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Redeem {
    code: String,
}

pub async fn redeem(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Redeem>,
) -> Result<Response, ApiError> {
    origin(&headers, &state.config)?;
    if input.code.len() != 64 || !input.code.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::bad("invalid_or_expired_invite"));
    }
    let mut tx = state.pool.begin().await?;
    let invite: Option<(Uuid, DateTime<Utc>, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT account_id, expires_at, redeemed_at FROM invites WHERE token_hash = $1 AND purpose = 'login' FOR UPDATE",
    )
    .bind(hash(&input.code))
    .fetch_optional(&mut *tx)
    .await?;
    let Some((account, expires, redeemed)) = invite else {
        return Err(ApiError::bad("invalid_or_expired_invite"));
    };
    if redeemed.is_some() || expires <= Utc::now() {
        return Err(ApiError::bad("invalid_or_expired_invite"));
    }
    let enabled: bool = sqlx::query_scalar("SELECT NOT disabled FROM accounts WHERE id = $1")
        .bind(account)
        .fetch_one(&mut *tx)
        .await?;
    if !enabled {
        return Err(ApiError::bad("invalid_or_expired_invite"));
    }
    sqlx::query("UPDATE invites SET redeemed_at = now() WHERE token_hash = $1")
        .bind(hash(&input.code))
        .execute(&mut *tx)
        .await?;
    let bearer = new_session(&mut tx, account).await?;
    tx.commit().await?;
    cookie_response(&state.config, &bearer)
}

pub(crate) async fn new_session(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    account: Uuid,
) -> Result<String, ApiError> {
    let bearer = token()?;
    let csrf = token()?;
    sqlx::query("INSERT INTO sessions (token_hash, account_id, csrf_token, expires_at) VALUES ($1,$2,$3,now() + interval '12 hours')")
        .bind(hash(&bearer)).bind(account).bind(csrf).execute(&mut **tx).await?;
    Ok(bearer)
}

pub(crate) fn cookie_response(config: &Config, bearer: &str) -> Result<Response, ApiError> {
    let cookie = format!(
        "{}={bearer}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200{}",
        config.cookie_name(),
        if config.secure_cookies {
            "; Secure"
        } else {
            ""
        }
    );
    let mut response = Json(serde_json::json!({"ok":true})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie)
            .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "cookie_failed"))?,
    );
    Ok(response)
}

pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let session = require_write(&headers, &state).await?;
    sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
        .bind(session.token_hash)
        .execute(&state.pool)
        .await?;
    let mut response = Json(serde_json::json!({"ok":true})).into_response();
    let cookie = format!(
        "{}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0{}",
        state.config.cookie_name(),
        if state.config.secure_cookies {
            "; Secure"
        } else {
            ""
        }
    );
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie)
            .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "cookie_failed"))?,
    );
    Ok(response)
}
