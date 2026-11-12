//! Wallet ownership establishes a member session, never payment or operator access.
//! Sign only the server's short-lived, browser-bound message; no client-built SIWE
//! fields, account linking by address, arbitrary chain RPC or contract signatures.
use crate::{ApiError, AppState, Config, access, auth};
use alloy_primitives::{Address, Signature};
use axum::{
    Extension, Json,
    extract::{ConnectInfo, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{Duration, SecondsFormat, Utc};
use serde::Deserialize;
use sqlx::FromRow;
use std::net::SocketAddr;
use uuid::Uuid;

fn invalid() -> ApiError {
    ApiError::bad("wallet_signin_failed")
}
fn enabled(config: &Config) -> Result<&str, ApiError> {
    config
        .wallet_project_id
        .as_deref()
        .ok_or_else(|| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "wallet_unavailable"))
}
pub(crate) async fn settings(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(
        serde_json::json!({"enabled":state.config.wallet_project_id.is_some(),"project_id":state.config.wallet_project_id,"origin":state.config.public_origin}),
    )
}
fn binding_name(config: &Config) -> &'static str {
    if config.secure_cookies {
        "__Host-patchriot_wallet"
    } else {
        "patchriot_dev_wallet"
    }
}
fn binding_cookie(config: &Config, value: &str, age: u32) -> Result<HeaderValue, ApiError> {
    HeaderValue::from_str(&format!(
        "{}={value}; HttpOnly; SameSite=Strict; Path=/; Max-Age={age}{}",
        binding_name(config),
        if config.secure_cookies {
            "; Secure"
        } else {
            ""
        }
    ))
    .map_err(|_| invalid())
}
async fn signed_out(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    match auth::require_session(headers, state).await {
        Err(e) if e.status == StatusCode::UNAUTHORIZED => Ok(()),
        Err(e) => Err(e),
        Ok(_) => Err(ApiError::new(StatusCode::CONFLICT, "already_signed_in")),
    }
}
fn address(network: &str, value: &str) -> Result<String, ApiError> {
    match network {
        "ethereum" if value.len() == 42 && value.starts_with("0x") => {
            let address: Address = value.parse().map_err(|_| invalid())?;
            if address.is_zero() {
                return Err(invalid());
            }
            Ok(address.to_checksum(None))
        }
        "solana" if (32..=44).contains(&value.len()) => {
            let bytes: [u8; 32] = bs58::decode(value)
                .into_vec()
                .map_err(|_| invalid())?
                .try_into()
                .map_err(|_| invalid())?;
            let key = ed25519_dalek::VerifyingKey::from_bytes(&bytes).map_err(|_| invalid())?;
            if key.is_weak() || bs58::encode(bytes).into_string() != value {
                return Err(invalid());
            }
            Ok(value.into())
        }
        _ => Err(invalid()),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Challenge {
    network: String,
    address: String,
}
pub(crate) async fn challenge(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(input): Json<Challenge>,
) -> Result<Response, ApiError> {
    enabled(&state.config)?;
    auth::origin(&headers, &state.config)?;
    signed_out(&state, &headers).await?;
    access::public_rate(&state, &headers, peer, "wallet-start", 30, 900).await?;
    let address = address(&input.network, &input.address)?;
    let nonce = auth::token()?;
    let browser = auth::token()?;
    let now = Utc::now();
    let expires = now + Duration::minutes(5);
    let origin = url::Url::parse(&state.config.public_origin).map_err(|_| invalid())?;
    let domain = &origin[url::Position::BeforeHost..url::Position::AfterPort];
    let (label, chain) = if input.network == "ethereum" {
        ("Ethereum", "1")
    } else {
        ("Solana", "mainnet")
    };
    // SIWE permits one statement line. The UI displays this with paragraphs;
    // embedding that layout here would break EIP-4361 message parsers.
    let message = format!(
        "{domain} wants you to sign in with your {label} account:\n{address}\n\nWelcome to Patchriot! By signing this message, you are securely logging into your account. This action will NOT cost any gas fees. This does not authorize any transactions or payments. Click sign to verify your wallet and enter!\n\nURI: {}\nVersion: 1\nChain ID: {chain}\nNonce: {nonce}\nIssued At: {}\nExpiration Time: {}",
        state.config.public_origin,
        now.to_rfc3339_opts(SecondsFormat::Secs, true),
        expires.to_rfc3339_opts(SecondsFormat::Secs, true)
    );
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM wallet_challenges WHERE expires_at<=now()")
        .execute(&mut *tx)
        .await?;
    if let Some(previous) = auth::cookie_value(&headers, binding_name(&state.config)) {
        sqlx::query("DELETE FROM wallet_challenges WHERE browser_hash=$1")
            .bind(auth::hash(&previous))
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT INTO wallet_challenges(nonce_hash,browser_hash,network,address,message,expires_at) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(auth::hash(&nonce)).bind(auth::hash(&browser)).bind(input.network).bind(address).bind(&message).bind(expires).execute(&mut *tx).await?;
    tx.commit().await?;
    let mut response =
        Json(serde_json::json!({"nonce":nonce,"message":message,"expires_at":expires}))
            .into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        binding_cookie(&state.config, &browser, 300)?,
    );
    Ok(response)
}
#[derive(FromRow)]
struct SavedChallenge {
    network: String,
    address: String,
    message: String,
}
fn verify_signature(saved: &SavedChallenge, signature: &str) -> Result<(), ApiError> {
    match saved.network.as_str() {
        "ethereum" => {
            if signature.len() != 132 || !signature.starts_with("0x") {
                return Err(invalid());
            }
            let signature: Signature = signature.parse().map_err(|_| invalid())?;
            let recovered = signature
                .recover_address_from_msg(&saved.message)
                .map_err(|_| invalid())?;
            if recovered.to_checksum(None) != saved.address {
                return Err(invalid());
            }
        }
        "solana" => {
            if !(64..=88).contains(&signature.len()) {
                return Err(invalid());
            }
            let bytes: [u8; 32] = bs58::decode(&saved.address)
                .into_vec()
                .map_err(|_| invalid())?
                .try_into()
                .map_err(|_| invalid())?;
            let key = ed25519_dalek::VerifyingKey::from_bytes(&bytes).map_err(|_| invalid())?;
            let signature = ed25519_dalek::Signature::from_slice(
                &bs58::decode(signature).into_vec().map_err(|_| invalid())?,
            )
            .map_err(|_| invalid())?;
            key.verify_strict(saved.message.as_bytes(), &signature)
                .map_err(|_| invalid())?;
        }
        _ => return Err(invalid()),
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Verify {
    nonce: String,
    signature: String,
}
pub(crate) async fn verify(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(input): Json<Verify>,
) -> Result<Response, ApiError> {
    enabled(&state.config)?;
    auth::origin(&headers, &state.config)?;
    signed_out(&state, &headers).await?;
    access::public_rate(&state, &headers, peer, "wallet-verify", 60, 900).await?;
    if input.nonce.len() != 64
        || !input.nonce.bytes().all(|b| b.is_ascii_hexdigit())
        || input.signature.len() > 132
    {
        return Err(invalid());
    }
    let browser = auth::cookie_value(&headers, binding_name(&state.config)).ok_or_else(invalid)?;
    // Atomic consumption before signature checks. A wrong signature cannot reuse
    // a challenge, and concurrent submissions cannot mint two sessions.
    let saved:SavedChallenge=sqlx::query_as("DELETE FROM wallet_challenges WHERE nonce_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING network,address,message")
        .bind(auth::hash(&input.nonce)).bind(auth::hash(&browser)).fetch_optional(&state.pool).await?.ok_or_else(invalid)?;
    verify_signature(&saved, &input.signature)?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("wallet:{}:{}", saved.network, saved.address))
        .execute(&mut *tx)
        .await?;
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT account_id FROM wallet_identities WHERE network=$1 AND address=$2",
    )
    .bind(&saved.network)
    .bind(&saved.address)
    .fetch_optional(&mut *tx)
    .await?;
    let account = if let Some(id) = existing {
        let disabled: bool =
            sqlx::query_scalar("SELECT disabled FROM accounts WHERE id=$1 FOR UPDATE")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
        if disabled {
            return Err(invalid());
        }
        id
    } else {
        let id = Uuid::new_v4();
        let label = format!(
            "{}…{}",
            &saved.address[..6],
            &saved.address[saved.address.len() - 4..]
        );
        sqlx::query("INSERT INTO accounts(id,display_name,role,auth_method) VALUES($1,$2,'member','wallet')").bind(id).bind(label).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO wallet_identities(network,address,account_id) VALUES($1,$2,$3)")
            .bind(saved.network)
            .bind(saved.address)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        id
    };
    let bearer = auth::new_session(&mut tx, account).await?;
    tx.commit().await?;
    let mut response = auth::cookie_response(&state.config, &bearer)?;
    response.headers_mut().append(
        header::SET_COOKIE,
        binding_cookie(&state.config, &browser, 0)?,
    );
    Ok(response)
}

#[cfg(test)]
#[path = "wallet_tests.rs"]
mod tests;

/// Wallet code loads only after an explicit user action. The application shell
/// allows the fixed Reown transport endpoints when wallet access is configured;
/// external scripts and arbitrary RPC hosts remain blocked.
pub(crate) async fn page_policy(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let wallet_page =
        matches!(request.uri().path(), "/" | "/wallet") && state.config.wallet_project_id.is_some();
    let mut response = next.run(request).await;
    if wallet_page {
        response.headers_mut().insert(header::CONTENT_SECURITY_POLICY,HeaderValue::from_str(&format!("default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://rpc.walletconnect.com https://rpc.walletconnect.org https://relay.walletconnect.com https://relay.walletconnect.org wss://relay.walletconnect.com wss://relay.walletconnect.org https://verify.walletconnect.com https://verify.walletconnect.org https://verify.reown.com https://api.mainnet-beta.solana.com; frame-src https://verify.walletconnect.com https://verify.walletconnect.org https://verify.reown.com {}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",state.config.analytics_origin.as_deref().unwrap_or(""))).expect("validated wallet origins"));
    }
    response
}
