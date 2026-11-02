//! Operator-approved accounts. Requests do not grant access; invitation tokens
//! are one use, passwords are Argon2id hashes, and every admin write is recorded.

use crate::{ApiError, AppState, auth};
use argon2::{
    Argon2,
    password_hash::{PasswordHasher, PasswordVerifier, phc::PasswordHash},
};
use axum::{
    Extension, Json,
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use std::net::SocketAddr;
use tokio::sync::Semaphore;
use uuid::Uuid;
use zeroize::Zeroizing;

// Keep the permit inside the blocking task: a disconnected browser cannot free
// a slot while its password hash is still consuming memory and CPU.
static HASH_SLOTS: Semaphore = Semaphore::const_new(2);

fn busy() -> ApiError {
    ApiError::new(StatusCode::TOO_MANY_REQUESTS, "try_again_later")
}
fn invalid_login() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "invalid_credentials")
}
fn conflict() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "account_access_changed")
}

fn username(value: &str) -> Result<String, ApiError> {
    let name = value.to_ascii_lowercase();
    if !(3..=40).contains(&name.len())
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || !name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_.-".contains(&b))
    {
        return Err(ApiError::bad("invalid_username"));
    }
    Ok(name)
}

fn password(value: &str) -> Result<(), ApiError> {
    if value.chars().count() < 15 || value.len() > 256 || value.contains('\0') {
        return Err(ApiError::bad("invalid_password"));
    }
    Ok(())
}

fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

pub(crate) fn contact(value: &str) -> Result<String, ApiError> {
    let value = value.trim().to_ascii_lowercase();
    let valid = value.split_once('@').is_some_and(|(local, domain)| {
        !local.is_empty()
            && !domain.starts_with('.')
            && !domain.ends_with('.')
            && domain.contains('.')
            && !domain.contains('@')
            && !domain.contains("..")
    });
    if value.len() > 254
        || !value.is_ascii()
        || value
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
        || !valid
    {
        return Err(ApiError::bad("invalid_contact"));
    }
    Ok(value)
}

async fn hash_password(value: Zeroizing<String>) -> Result<String, ApiError> {
    let permit = HASH_SLOTS.try_acquire().map_err(|_| busy())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        Argon2::default()
            .hash_password(value.as_bytes())
            .map(|hash| hash.to_string())
    })
    .await
    .map_err(|_| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "login_unavailable"))?
    .map_err(|_| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "login_unavailable"))
}

async fn verify_password(
    value: Zeroizing<String>,
    saved: Option<String>,
) -> Result<bool, ApiError> {
    let permit = HASH_SLOTS.try_acquire().map_err(|_| busy())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        match saved {
            Some(saved) => PasswordHash::new(&saved).ok().is_some_and(|hash| {
                Argon2::default()
                    .verify_password(value.as_bytes(), &hash)
                    .is_ok()
            }),
            None => {
                let _ = Argon2::default().hash_password(value.as_bytes());
                false
            }
        }
    })
    .await
    .map_err(|_| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "login_unavailable"))
}

pub(crate) async fn rate(
    pool: &PgPool,
    key: &str,
    limit: i32,
    seconds: i32,
) -> Result<(), ApiError> {
    let used: Option<i32> = sqlx::query_scalar("INSERT INTO auth_attempts (key,started_at,attempts) VALUES ($1,now(),1) ON CONFLICT (key) DO UPDATE SET started_at = CASE WHEN auth_attempts.started_at <= now() - make_interval(secs => $3) THEN now() ELSE auth_attempts.started_at END, attempts = CASE WHEN auth_attempts.started_at <= now() - make_interval(secs => $3) THEN 1 ELSE auth_attempts.attempts + 1 END WHERE auth_attempts.started_at <= now() - make_interval(secs => $3) OR auth_attempts.attempts < $2 RETURNING attempts")
        .bind(auth::hash(key)).bind(limit).bind(f64::from(seconds)).fetch_optional(pool).await?;
    used.map(|_| ()).ok_or_else(busy)
}

// Do not accept a caller-supplied forwarding header as its identity. Behind a
// proxy this deliberately shares the peer limit; username/global limits remain.
async fn public_rate(
    state: &AppState,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    action: &str,
    limit: i32,
    seconds: i32,
) -> Result<(), ApiError> {
    rate(&state.pool, "public-auth", 180, 900).await?;
    sqlx::query("DELETE FROM auth_attempts WHERE started_at < now() - interval '1 day'")
        .execute(&state.pool)
        .await?;
    let peer = peer
        .map(|Extension(ConnectInfo(addr))| addr.ip().to_string())
        .unwrap_or_else(|| "unknown-peer".into());
    rate(&state.pool, &format!("{action}:{peer}"), limit, seconds).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Login {
    username: String,
    password: String,
}

#[derive(FromRow)]
struct Credential {
    account_id: Uuid,
    password_hash: String,
    disabled: bool,
}

pub(crate) async fn login(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(input): Json<Login>,
) -> Result<Response, ApiError> {
    let supplied = Zeroizing::new(input.password);
    auth::origin(&headers, &state.config)?;
    public_rate(&state, peer, "login", 60, 900).await?;
    let name = username(&input.username).map_err(|_| invalid_login())?;
    if supplied.is_empty() || supplied.len() > 256 {
        return Err(invalid_login());
    }
    rate(&state.pool, &format!("username:{name}"), 10, 900).await?;
    let saved: Option<Credential> = sqlx::query_as("SELECT c.account_id,c.password_hash,a.disabled FROM account_credentials c JOIN accounts a ON a.id = c.account_id WHERE c.username = $1")
        .bind(name).fetch_optional(&state.pool).await?;
    if !verify_password(supplied, saved.as_ref().map(|s| s.password_hash.clone())).await? {
        return Err(invalid_login());
    }
    let saved = saved.filter(|s| !s.disabled).ok_or_else(invalid_login)?;
    let mut tx = state.pool.begin().await?;
    // Recheck after hashing so disabling an account or changing its password
    // cannot race an in-flight login and leave a fresh, valid session behind.
    let enabled: Option<bool> =
        sqlx::query_scalar("SELECT NOT disabled FROM accounts WHERE id = $1 FOR UPDATE")
            .bind(saved.account_id)
            .fetch_optional(&mut *tx)
            .await?;
    let current: Option<String> =
        sqlx::query_scalar("SELECT password_hash FROM account_credentials WHERE account_id = $1")
            .bind(saved.account_id)
            .fetch_optional(&mut *tx)
            .await?;
    if enabled != Some(true) || current.as_deref() != Some(&saved.password_hash) {
        return Err(invalid_login());
    }
    let bearer = auth::new_session(&mut tx, saved.account_id).await?;
    tx.commit().await?;
    auth::cookie_response(&state.config, &bearer)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Activate {
    code: String,
    username: String,
    password: String,
}

pub(crate) async fn activate(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(input): Json<Activate>,
) -> Result<Response, ApiError> {
    let supplied = Zeroizing::new(input.password);
    auth::origin(&headers, &state.config)?;
    public_rate(&state, peer, "activate", 10, 900).await?;
    let name = username(&input.username)?;
    password(&supplied)?;
    let invalid = || ApiError::bad("invalid_or_expired_invite");
    if input.code.len() != 64 || !input.code.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    let code_hash = auth::hash(&input.code);
    let account: Uuid = sqlx::query_scalar("SELECT account_id FROM invites WHERE token_hash = $1 AND purpose = 'activation' AND redeemed_at IS NULL AND expires_at > now()")
        .bind(&code_hash).fetch_optional(&state.pool).await?.ok_or_else(invalid)?;
    let hashed = hash_password(supplied).await?;
    let mut tx = state.pool.begin().await?;
    let enabled: bool =
        sqlx::query_scalar("SELECT NOT disabled FROM accounts WHERE id = $1 FOR UPDATE")
            .bind(account)
            .fetch_one(&mut *tx)
            .await?;
    let claimed = sqlx::query("UPDATE invites SET redeemed_at = now() WHERE token_hash = $1 AND purpose = 'activation' AND redeemed_at IS NULL AND expires_at > now()")
        .bind(&code_hash).execute(&mut *tx).await?.rows_affected();
    if !enabled || claimed != 1 {
        return Err(invalid());
    }
    sqlx::query("INSERT INTO account_credentials (account_id,username,password_hash) VALUES ($1,$2,$3) ON CONFLICT (account_id) DO UPDATE SET username = EXCLUDED.username, password_hash = EXCLUDED.password_hash, updated_at = now()")
        .bind(account).bind(name).bind(hashed).execute(&mut *tx).await.map_err(username_error)?;
    sqlx::query("UPDATE accounts SET auth_method = 'password' WHERE id = $1")
        .bind(account)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE invites SET redeemed_at = now() WHERE account_id = $1 AND redeemed_at IS NULL",
    )
    .bind(account)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM sessions WHERE account_id = $1")
        .bind(account)
        .execute(&mut *tx)
        .await?;
    let bearer = auth::new_session(&mut tx, account).await?;
    tx.commit().await?;
    auth::cookie_response(&state.config, &bearer)
}

fn username_error(error: sqlx::Error) -> ApiError {
    if error
        .as_database_error()
        .is_some_and(|e| e.is_unique_violation())
    {
        ApiError::bad("username_unavailable")
    } else {
        error.into()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AccessRequest {
    display_name: String,
    email: String,
    note: String,
}

pub(crate) async fn request_access(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(input): Json<AccessRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    auth::origin(&headers, &state.config)?;
    public_rate(&state, peer, "request-access", 5, 3600).await?;
    if !text(&input.display_name, 80) || !text(&input.note, 1000) {
        return Err(ApiError::bad("invalid_request"));
    }
    let email = contact(&input.email)?;
    // A repeat neither reveals an existing account nor replaces a pending note.
    sqlx::query("INSERT INTO access_requests (id,display_name,email,note) SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE contact_email = $3) ON CONFLICT DO NOTHING")
        .bind(Uuid::new_v4()).bind(input.display_name.trim()).bind(email).bind(input.note.trim()).execute(&state.pool).await?;
    Ok((StatusCode::ACCEPTED, Json(serde_json::json!({"ok": true}))))
}

pub(crate) async fn admin(
    state: &AppState,
    headers: &HeaderMap,
    write: bool,
) -> Result<auth::Session, ApiError> {
    let session = if write {
        auth::require_write(headers, state).await?
    } else {
        auth::require_session(headers, state).await?
    };
    if session.role != "admin" {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "admin_required"));
    }
    Ok(session)
}

pub(crate) async fn lock_admin(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<(), ApiError> {
    let permitted: bool = sqlx::query_scalar(
        "SELECT role = 'admin' AND NOT disabled FROM accounts WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_one(&mut **tx)
    .await?;
    if !permitted {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "admin_required"));
    }
    Ok(())
}

#[derive(Serialize, FromRow)]
pub(crate) struct RequestView {
    id: Uuid,
    display_name: String,
    email: String,
    note: String,
    status: String,
    account_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    decided_at: Option<DateTime<Utc>>,
}
#[derive(Serialize, FromRow)]
pub(crate) struct AccountView {
    id: Uuid,
    display_name: String,
    contact_email: Option<String>,
    username: Option<String>,
    role: String,
    disabled: bool,
    created_at: DateTime<Utc>,
    unused_coupons: i64,
}
#[derive(Serialize)]
pub(crate) struct Desk {
    requests: Vec<RequestView>,
    accounts: Vec<AccountView>,
}

pub(crate) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Desk>, ApiError> {
    admin(&state, &headers, false).await?;
    let requests = sqlx::query_as("SELECT id,display_name,email,note,status,account_id,created_at,decided_at FROM access_requests ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 100").fetch_all(&state.pool).await?;
    let accounts = sqlx::query_as("SELECT a.id,a.display_name,a.contact_email,c.username,a.role,a.disabled,a.created_at,(SELECT count(*) FROM review_codes r WHERE r.issued_to = a.id AND r.account_id IS NULL AND r.revoked_at IS NULL AND r.expires_at > now()) AS unused_coupons FROM accounts a LEFT JOIN account_credentials c ON c.account_id = a.id ORDER BY a.created_at DESC LIMIT 100").fetch_all(&state.pool).await?;
    Ok(Json(Desk { requests, accounts }))
}

#[derive(Serialize)]
pub(crate) struct AccessGrant {
    account_id: Uuid,
    invitation: String,
    expires_at: DateTime<Utc>,
    coupon: Option<crate::review_codes::IssuedCode>,
}

async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    actor: Uuid,
    account: Option<Uuid>,
    request: Option<Uuid>,
    action: &str,
) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO account_access_log (actor_id,account_id,request_id,action) VALUES ($1,$2,$3,$4)")
        .bind(actor).bind(account).bind(request).bind(action).execute(&mut **tx).await?;
    Ok(())
}

async fn coupon(
    tx: &mut Transaction<'_, Postgres>,
    account: Uuid,
) -> Result<crate::review_codes::IssuedCode, ApiError> {
    let id = Uuid::new_v4();
    let code = format!("pr-{}", auth::token()?);
    let expires_at = sqlx::query_scalar("INSERT INTO review_codes (id,code_hash,label,expires_at,issued_to) VALUES ($1,$2,'Account review',now() + interval '7 days',$3) RETURNING expires_at")
        .bind(id).bind(auth::hash(&code)).bind(account).fetch_one(&mut **tx).await?;
    Ok(crate::review_codes::IssuedCode {
        id,
        code,
        expires_at,
    })
}

async fn invitation(
    tx: &mut Transaction<'_, Postgres>,
    account: Uuid,
    with_coupon: bool,
) -> Result<AccessGrant, ApiError> {
    let invitation = auth::token()?;
    sqlx::query(
        "UPDATE invites SET redeemed_at = now() WHERE account_id = $1 AND redeemed_at IS NULL",
    )
    .bind(account)
    .execute(&mut **tx)
    .await?;
    let expires_at = sqlx::query_scalar("INSERT INTO invites (token_hash,account_id,purpose,expires_at) VALUES ($1,$2,'activation',now() + interval '1 day') RETURNING expires_at")
        .bind(auth::hash(&invitation)).bind(account).fetch_one(&mut **tx).await?;
    let coupon = if with_coupon {
        Some(coupon(tx, account).await?)
    } else {
        None
    };
    Ok(AccessGrant {
        account_id: account,
        invitation,
        expires_at,
        coupon,
    })
}

async fn create_member(
    tx: &mut Transaction<'_, Postgres>,
    name: &str,
    email: &str,
) -> Result<Uuid, ApiError> {
    let account = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO accounts (id,display_name,role,contact_email) VALUES ($1,$2,'member',$3)",
    )
    .bind(account)
    .bind(name.trim())
    .bind(email)
    .execute(&mut **tx)
    .await
    .map_err(|error| {
        if error
            .as_database_error()
            .is_some_and(|e| e.is_unique_violation())
        {
            conflict()
        } else {
            error.into()
        }
    })?;
    Ok(account)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateAccount {
    display_name: String,
    email: String,
    with_coupon: bool,
}

pub(crate) async fn create_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateAccount>,
) -> Result<Json<AccessGrant>, ApiError> {
    let actor = admin(&state, &headers, true).await?;
    if !text(&input.display_name, 80) {
        return Err(ApiError::bad("invalid_request"));
    }
    let email = contact(&input.email)?;
    let mut tx = state.pool.begin().await?;
    lock_admin(&mut tx, actor.id).await?;
    let account = create_member(&mut tx, &input.display_name, &email).await?;
    let grant = invitation(&mut tx, account, input.with_coupon).await?;
    audit(&mut tx, actor.id, Some(account), None, "created").await?;
    tx.commit().await?;
    Ok(Json(grant))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Decision {
    decision: String,
    with_coupon: bool,
}

pub(crate) async fn decide(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<Decision>,
) -> Result<Json<Option<AccessGrant>>, ApiError> {
    let actor = admin(&state, &headers, true).await?;
    if !["approve", "decline"].contains(&input.decision.as_str())
        || input.decision == "decline" && input.with_coupon
    {
        return Err(ApiError::bad("invalid_request"));
    }
    let mut tx = state.pool.begin().await?;
    lock_admin(&mut tx, actor.id).await?;
    let request: Option<(String, String, String)> = sqlx::query_as(
        "SELECT display_name,email,status FROM access_requests WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let (name, email, status) =
        request.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "not_found"))?;
    if status != "pending" {
        return Err(conflict());
    }
    let grant = if input.decision == "approve" {
        let account = create_member(&mut tx, &name, &email).await?;
        Some(invitation(&mut tx, account, input.with_coupon).await?)
    } else {
        None
    };
    let status = if grant.is_some() {
        "approved"
    } else {
        "declined"
    };
    let account = grant.as_ref().map(|g| g.account_id);
    sqlx::query("UPDATE access_requests SET status = $2,account_id = $3,decided_by = $4,decided_at = now() WHERE id = $1")
        .bind(id).bind(status).bind(account).bind(actor.id).execute(&mut *tx).await?;
    audit(&mut tx, actor.id, account, Some(id), status).await?;
    tx.commit().await?;
    Ok(Json(grant))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Empty {}

async fn lock_member(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> Result<(), ApiError> {
    let enabled: Option<bool> = sqlx::query_scalar(
        "SELECT role = 'member' AND NOT disabled FROM accounts WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?;
    if enabled != Some(true) {
        return Err(ApiError::bad("account_unavailable"));
    }
    Ok(())
}

pub(crate) async fn renew_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(_): Json<Empty>,
) -> Result<Json<AccessGrant>, ApiError> {
    let actor = admin(&state, &headers, true).await?;
    let mut tx = state.pool.begin().await?;
    lock_admin(&mut tx, actor.id).await?;
    lock_member(&mut tx, id).await?;
    let grant = invitation(&mut tx, id, false).await?;
    audit(&mut tx, actor.id, Some(id), None, "invite_renewed").await?;
    tx.commit().await?;
    Ok(Json(grant))
}

pub(crate) async fn issue_coupon(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(_): Json<Empty>,
) -> Result<Json<crate::review_codes::IssuedCode>, ApiError> {
    let actor = admin(&state, &headers, true).await?;
    let mut tx = state.pool.begin().await?;
    lock_admin(&mut tx, actor.id).await?;
    lock_member(&mut tx, id).await?;
    // Replacing an unshared code cannot create extra free reviews. A reserved
    // code stays attached to its existing job; this one is explicitly new work.
    sqlx::query("UPDATE review_codes SET revoked_at = now(), updated_at = now() WHERE issued_to = $1 AND account_id IS NULL AND revoked_at IS NULL").bind(id).execute(&mut *tx).await?;
    let issued = coupon(&mut tx, id).await?;
    audit(&mut tx, actor.id, Some(id), None, "coupon_issued").await?;
    tx.commit().await?;
    Ok(Json(issued))
}

pub(crate) async fn disable(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(_): Json<Empty>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let actor = admin(&state, &headers, true).await?;
    let mut tx = state.pool.begin().await?;
    lock_admin(&mut tx, actor.id).await?;
    lock_member(&mut tx, id).await?;
    sqlx::query("UPDATE accounts SET disabled = true WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE account_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    audit(&mut tx, actor.id, Some(id), None, "disabled").await?;
    tx.commit().await?;
    Ok(Json(serde_json::json!({"ok": true})))
}

/// Local operator bootstrap. Reads a password supplied by the CLI, never a
/// checked-in default. An existing admin identity may be kept during migration.
pub async fn bootstrap_admin(
    pool: &PgPool,
    name: &str,
    password_value: String,
    existing: Option<Uuid>,
) -> Result<Uuid, String> {
    let supplied = Zeroizing::new(password_value);
    let name = username(name).map_err(|_| "invalid username")?;
    password(&supplied)
        .map_err(|_| "use a password of 15 or more characters, at most 256 bytes")?;
    let hashed = hash_password(supplied)
        .await
        .map_err(|_| "password hashing unavailable")?;
    let mut tx = pool.begin().await.map_err(|_| "database unavailable")?;
    let id = if let Some(id) = existing {
        let allowed: Option<bool> = sqlx::query_scalar(
            "SELECT role = 'admin' AND NOT disabled FROM accounts WHERE id = $1 FOR UPDATE",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| "database unavailable")?;
        if allowed != Some(true) {
            return Err("account is not an enabled administrator".into());
        }
        id
    } else {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO accounts (id,display_name,role,auth_method) VALUES ($1,$2,'admin','password')").bind(id).bind(&name).execute(&mut *tx).await.map_err(|_| "account creation failed")?;
        id
    };
    sqlx::query(
        "INSERT INTO account_credentials (account_id,username,password_hash) VALUES ($1,$2,$3)",
    )
    .bind(id)
    .bind(name)
    .bind(hashed)
    .execute(&mut *tx)
    .await
    .map_err(|_| "credentials already exist or creation failed")?;
    sqlx::query("UPDATE accounts SET auth_method = 'password' WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|_| "account update failed")?;
    tx.commit().await.map_err(|_| "account commit failed")?;
    Ok(id)
}
