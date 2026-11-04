//! Browser-bound OAuth sign-in. Provider tokens never enter the browser, database
//! or dispatcher. Email is contact data; only provider + subject identifies a user.
use crate::{ApiError, AppState, Config, access, auth};
use axum::{
    Extension, Json,
    extract::{ConnectInfo, Path, Query, State, rejection::QueryRejection},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Redirect, Response},
};
use openidconnect::{
    AccessTokenHash, AsyncHttpClient, AuthType, AuthorizationCode, ClientId, ClientSecret,
    HttpRequest, HttpResponse, IssuerUrl, Nonce, OAuth2TokenResponse, PkceCodeChallenge,
    PkceCodeVerifier, RedirectUrl, TokenResponse,
    core::{CoreClient, CoreProviderMetadata},
};
use serde::Deserialize;
use sqlx::FromRow;
use std::{collections::BTreeMap, net::SocketAddr};
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Provider {
    Github,
    Google,
}
impl Provider {
    fn parse(value: &str) -> Result<Self, ApiError> {
        match value {
            "github" => Ok(Self::Github),
            "google" => Ok(Self::Google),
            _ => Err(unavailable()),
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Google => "google",
        }
    }
    fn authorization(self) -> &'static str {
        match self {
            Self::Github => "https://github.com/login/oauth/authorize",
            Self::Google => "https://accounts.google.com/o/oauth2/v2/auth",
        }
    }
}
struct Credentials {
    client_id: String,
    secret: Zeroizing<String>,
}

/// No provider is enabled without its complete server-side configuration.
#[derive(Default)]
pub struct SsoConfig {
    credentials: BTreeMap<Provider, Credentials>,
    #[cfg(test)]
    test_origin: Option<String>,
}
impl SsoConfig {
    pub fn new(
        github: Option<(String, String)>,
        google: Option<(String, String)>,
    ) -> Result<Self, &'static str> {
        let mut config = Self::default();
        for (provider, pair) in [(Provider::Github, github), (Provider::Google, google)] {
            if let Some((client_id, secret)) = pair {
                if !bounded(&client_id, 256)
                    || !bounded(&secret, 4096)
                    || client_id.contains(char::is_whitespace)
                {
                    return Err("invalid OAuth client credentials");
                }
                config.credentials.insert(
                    provider,
                    Credentials {
                        client_id,
                        secret: Zeroizing::new(secret),
                    },
                );
            }
        }
        Ok(config)
    }
    pub fn from_env() -> Result<Self, &'static str> {
        fn pair(prefix: &str) -> Result<Option<(String, String)>, &'static str> {
            let read = |suffix| match std::env::var(format!("{prefix}_{suffix}")) {
                Ok(value) => Ok(Some(value)),
                Err(std::env::VarError::NotPresent) => Ok(None),
                Err(_) => Err("invalid OAuth environment setting"),
            };
            match (read("CLIENT_ID")?, read("CLIENT_SECRET")?) {
                (None, None) => Ok(None),
                (Some(id), Some(secret)) => Ok(Some((id, secret))),
                _ => Err("set both OAuth CLIENT_ID and CLIENT_SECRET, or neither"),
            }
        }
        Self::new(pair("GITHUB")?, pair("GOOGLE")?)
    }
    fn get(&self, provider: Provider) -> Result<&Credentials, ApiError> {
        self.credentials.get(&provider).ok_or_else(unavailable)
    }
    fn endpoint(&self, ordinary: &str) -> String {
        #[cfg(test)]
        if let Some(origin) = &self.test_origin {
            return format!("{origin}{}", url::Url::parse(ordinary).unwrap().path());
        }
        ordinary.into()
    }
}
fn unavailable() -> ApiError {
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "sso_unavailable")
}
fn invalid() -> ApiError {
    ApiError::bad("sso_signin_failed")
}
fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn nonce(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn callback_url(config: &Config, provider: Provider) -> String {
    format!(
        "{}/api/auth/{}/callback",
        config.public_origin,
        provider.name()
    )
}
fn binding_name(config: &Config) -> &'static str {
    if config.secure_cookies {
        "__Host-patchriot_oauth"
    } else {
        "patchriot_dev_oauth"
    }
}
fn binding_cookie(config: &Config, value: &str, age: u32) -> Result<HeaderValue, ApiError> {
    HeaderValue::from_str(&format!(
        "{}={value}; HttpOnly; SameSite=Lax; Path=/; Max-Age={age}{}",
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
        Err(error) if error.status == StatusCode::UNAUTHORIZED => Ok(()),
        Err(error) => Err(error),
        Ok(_) => Err(ApiError::new(StatusCode::CONFLICT, "already_signed_in")),
    }
}
pub(crate) async fn providers(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(
        serde_json::json!({"github":state.config.sso.credentials.contains_key(&Provider::Github),"google":state.config.sso.credentials.contains_key(&Provider::Google)}),
    )
}
pub(crate) async fn start(
    State(state): State<AppState>,
    Path(name): Path<String>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(_): Json<access::Empty>,
) -> Result<Response, ApiError> {
    auth::origin(&headers, &state.config)?;
    signed_out(&state, &headers).await?;
    let provider = Provider::parse(&name)?;
    let credentials = state.config.sso.get(provider)?;
    access::public_rate(&state, peer, "oauth-start", 30, 900).await?;
    let state_value = auth::token()?;
    let browser = auth::token()?;
    let id_nonce = auth::token()?;
    let verifier = PkceCodeVerifier::new(auth::token()?);
    let challenge = PkceCodeChallenge::from_code_verifier_sha256(&verifier);
    let mut url = url::Url::parse(provider.authorization()).map_err(|_| unavailable())?;
    url.query_pairs_mut().extend_pairs([
        ("client_id", credentials.client_id.as_str()),
        ("redirect_uri", &callback_url(&state.config, provider)),
        ("response_type", "code"),
        ("state", &state_value),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
        (
            "scope",
            if provider == Provider::Google {
                "openid email profile"
            } else {
                "user:email"
            },
        ),
    ]);
    if provider == Provider::Google {
        url.query_pairs_mut().append_pair("nonce", &id_nonce);
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM oauth_attempts WHERE expires_at<=now()")
        .execute(&mut *tx)
        .await?;
    if let Some(previous) = auth::cookie_value(&headers, binding_name(&state.config)) {
        sqlx::query("DELETE FROM oauth_attempts WHERE browser_hash=$1")
            .bind(auth::hash(&previous))
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT INTO oauth_attempts(state_hash,browser_hash,provider,verifier,nonce,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')")
        .bind(auth::hash(&state_value)).bind(auth::hash(&browser)).bind(provider.name()).bind(verifier.secret()).bind(id_nonce).execute(&mut *tx).await?;
    tx.commit().await?;
    let mut response = Json(serde_json::json!({"authorization_url":url.as_str()})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        binding_cookie(&state.config, &browser, 600)?,
    );
    Ok(response)
}

#[derive(Deserialize)]
pub(crate) struct Callback {
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
}
#[derive(FromRow)]
struct Attempt {
    verifier: String,
    nonce: String,
}
struct Identity {
    subject: String,
    email: String,
    name: String,
}

pub(crate) async fn callback(
    State(state): State<AppState>,
    Path(name): Path<String>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    query: Result<Query<Callback>, QueryRejection>,
) -> Response {
    // Fixed destinations erase the provider's code from the next URL. Neither
    // arbitrary next URLs nor provider error descriptions reach the browser.
    let result = if access::public_rate(&state, peer, "oauth-callback", 60, 900)
        .await
        .is_err()
    {
        Err(invalid())
    } else {
        finish(
            &state,
            &headers,
            &name,
            query.map(|q| q.0).map_err(|_| invalid()),
        )
        .await
    };
    let mut response = match result {
        Ok(bearer) => match auth::cookie_response(&state.config, &bearer) {
            Ok(mut response) => {
                *response.status_mut() = StatusCode::SEE_OTHER;
                response
                    .headers_mut()
                    .insert(header::LOCATION, HeaderValue::from_static("/#/audits"));
                response
            }
            Err(_) => Redirect::to("/?signin=failed#/request").into_response(),
        },
        Err(_) => Redirect::to("/?signin=failed#/request").into_response(),
    };
    if let Ok(cookie) = binding_cookie(&state.config, "", 0) {
        response.headers_mut().append(header::SET_COOKIE, cookie);
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}
async fn finish(
    state: &AppState,
    headers: &HeaderMap,
    name: &str,
    query: Result<Callback, ApiError>,
) -> Result<String, ApiError> {
    let provider = Provider::parse(name)?;
    state.config.sso.get(provider)?;
    signed_out(state, headers).await?;
    let query = query?;
    let value = query.state.filter(|s| nonce(s)).ok_or_else(invalid)?;
    let browser = auth::cookie_value(headers, binding_name(&state.config)).ok_or_else(invalid)?;
    // Consume atomically before network IO. A provider timeout needs a new login,
    // never a replayed code exchange or two sessions from one callback.
    let attempt:Attempt=sqlx::query_as("DELETE FROM oauth_attempts WHERE state_hash=$1 AND browser_hash=$2 AND provider=$3 AND expires_at>now() RETURNING verifier,nonce")
        .bind(auth::hash(&value)).bind(auth::hash(&browser)).bind(provider.name()).fetch_optional(&state.pool).await?.ok_or_else(invalid)?;
    if query.error.is_some() {
        return Err(invalid());
    }
    let code = query
        .code
        .filter(|s| bounded(s, 4096))
        .ok_or_else(invalid)?;
    let identity = match provider {
        Provider::Github => github_identity(state, &code, &attempt).await?,
        Provider::Google => google_identity(state, &code, &attempt).await?,
    };
    login_identity(state, provider, identity).await
}

async fn login_identity(
    state: &AppState,
    provider: Provider,
    identity: Identity,
) -> Result<String, ApiError> {
    if !bounded(&identity.subject, 255) {
        return Err(invalid());
    }
    let email = access::contact(&identity.email).map_err(|_| invalid())?;
    let name: String = identity
        .name
        .chars()
        .filter(|c| !c.is_control())
        .scan(0, |bytes, c| {
            *bytes += c.len_utf8();
            (*bytes <= 80).then_some(c)
        })
        .collect();
    let name = if name.trim().is_empty() {
        "Patchriot user"
    } else {
        name.trim()
    };
    let mut tx = state.pool.begin().await?;
    // Concurrent first logins for the same provider ID create one account.
    // Email collisions, including an admin's address, never select that account.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("oauth:{}:{}", provider.name(), identity.subject))
        .execute(&mut *tx)
        .await?;
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT account_id FROM oauth_identities WHERE provider=$1 AND subject=$2",
    )
    .bind(provider.name())
    .bind(&identity.subject)
    .fetch_optional(&mut *tx)
    .await?;
    let account = if let Some(account) = existing {
        let disabled: bool =
            sqlx::query_scalar("SELECT disabled FROM accounts WHERE id=$1 FOR SHARE")
                .bind(account)
                .fetch_one(&mut *tx)
                .await?;
        if disabled {
            return Err(invalid());
        }
        account
    } else {
        let account = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO accounts(id,display_name,role,auth_method) VALUES($1,$2,'member',$3)",
        )
        .bind(account)
        .bind(name)
        .bind(provider.name())
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO oauth_identities(provider,subject,account_id,verified_email) VALUES($1,$2,$3,$4)").bind(provider.name()).bind(identity.subject).bind(account).bind(email).execute(&mut *tx).await?;
        account
    };
    let bearer = auth::new_session(&mut tx, account).await?;
    tx.commit().await?;
    Ok(bearer)
}

async fn body(mut response: reqwest::Response) -> Result<Vec<u8>, ApiError> {
    if !response.status().is_success() || response.content_length().is_some_and(|n| n > 256 * 1024)
    {
        return Err(invalid());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| invalid())? {
        if data.len() + chunk.len() > 256 * 1024 {
            return Err(invalid());
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}
async fn github_identity(
    state: &AppState,
    code: &str,
    attempt: &Attempt,
) -> Result<Identity, ApiError> {
    #[derive(Deserialize)]
    struct Tokens {
        access_token: String,
        token_type: String,
    }
    #[derive(Deserialize)]
    struct User {
        id: u64,
        login: String,
        #[serde(rename = "type")]
        kind: String,
    }
    #[derive(Deserialize)]
    struct Email {
        email: String,
        primary: bool,
        verified: bool,
    }
    let config = &state.config.sso;
    let credentials = config.get(Provider::Github)?;
    let response = state
        .client
        .post(config.endpoint("https://github.com/login/oauth/access_token"))
        .header(header::ACCEPT, "application/json")
        .header(header::USER_AGENT, "Patchriot sign-in")
        .form(&[
            ("client_id", credentials.client_id.as_str()),
            ("client_secret", credentials.secret.as_str()),
            ("code", code),
            (
                "redirect_uri",
                &callback_url(&state.config, Provider::Github),
            ),
            ("code_verifier", attempt.verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|_| invalid())?;
    let token: Tokens = serde_json::from_slice(&body(response).await?).map_err(|_| invalid())?;
    let access = Zeroizing::new(token.access_token);
    if !token.token_type.eq_ignore_ascii_case("bearer") || !bounded(&access, 4096) {
        return Err(invalid());
    }
    let get = |url| {
        state
            .client
            .get(config.endpoint(url))
            .bearer_auth(access.as_str())
            .header(header::ACCEPT, "application/vnd.github+json")
            .header(header::USER_AGENT, "Patchriot sign-in")
    };
    let user: User = serde_json::from_slice(
        &body(
            get("https://api.github.com/user")
                .send()
                .await
                .map_err(|_| invalid())?,
        )
        .await?,
    )
    .map_err(|_| invalid())?;
    let emails: Vec<Email> = serde_json::from_slice(
        &body(
            get("https://api.github.com/user/emails")
                .query(&[("per_page", "100")])
                .send()
                .await
                .map_err(|_| invalid())?,
        )
        .await?,
    )
    .map_err(|_| invalid())?;
    let primary = emails
        .into_iter()
        .find(|e| e.primary && e.verified)
        .ok_or_else(invalid)?;
    if user.id == 0 || user.kind != "User" {
        return Err(invalid());
    }
    Ok(Identity {
        subject: user.id.to_string(),
        email: primary.email,
        name: user.login,
    })
}

async fn google_identity(
    state: &AppState,
    code: &str,
    attempt: &Attempt,
) -> Result<Identity, ApiError> {
    let config = &state.config.sso;
    let credentials = config.get(Provider::Google)?;
    let transport = GoogleTransport {
        client: state.client.clone(),
        allowed: [
            "https://accounts.google.com/.well-known/openid-configuration",
            "https://www.googleapis.com/oauth2/v3/certs",
            "https://oauth2.googleapis.com/token",
        ]
        .map(|url| config.endpoint(url)),
    };
    let issuer =
        IssuerUrl::new(config.endpoint("https://accounts.google.com")).map_err(|_| invalid())?;
    let metadata = CoreProviderMetadata::discover_async(issuer, &transport)
        .await
        .map_err(|_| invalid())?;
    let client = CoreClient::from_provider_metadata(
        metadata,
        ClientId::new(credentials.client_id.clone()),
        Some(ClientSecret::new(credentials.secret.to_string())),
    )
    .set_auth_type(AuthType::RequestBody)
    .set_redirect_uri(
        RedirectUrl::new(callback_url(&state.config, Provider::Google)).map_err(|_| invalid())?,
    );
    let tokens = client
        .exchange_code(AuthorizationCode::new(code.into()))
        .map_err(|_| invalid())?
        .set_pkce_verifier(PkceCodeVerifier::new(attempt.verifier.clone()))
        .request_async(&transport)
        .await
        .map_err(|_| invalid())?;
    let id = tokens.id_token().ok_or_else(invalid)?;
    let verifier = client.id_token_verifier();
    let claims = id
        .claims(&verifier, &Nonce::new(attempt.nonce.clone()))
        .map_err(|_| invalid())?;
    if let Some(expected) = claims.access_token_hash() {
        let actual = AccessTokenHash::from_token(
            tokens.access_token(),
            id.signing_alg().map_err(|_| invalid())?,
            id.signing_key(&verifier).map_err(|_| invalid())?,
        )
        .map_err(|_| invalid())?;
        if actual != *expected {
            return Err(invalid());
        }
    }
    if claims.email_verified() != Some(true) {
        return Err(invalid());
    }
    let email = claims.email().ok_or_else(invalid)?.as_str().to_owned();
    let name = claims
        .name()
        .and_then(|name| name.get(None))
        .map(|s| s.as_str())
        .unwrap_or("Patchriot user")
        .to_owned();
    Ok(Identity {
        subject: claims.subject().as_str().into(),
        email,
        name,
    })
}

/// A bounded, non-redirecting OIDC transport. Discovery cannot redirect a
/// credential-bearing token exchange to an arbitrary URL.
struct GoogleTransport {
    client: reqwest::Client,
    allowed: [String; 3],
}
impl<'c> AsyncHttpClient<'c> for GoogleTransport {
    type Error = std::io::Error;
    type Future = std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<HttpResponse, Self::Error>> + Send + 'c>,
    >;

    fn call(&'c self, request: HttpRequest) -> Self::Future {
        Box::pin(async move {
            if !self
                .allowed
                .iter()
                .any(|url| url == &request.uri().to_string())
            {
                return Err(std::io::Error::other("unapproved identity endpoint"));
            }
            let (parts, data) = request.into_parts();
            let response = self
                .client
                .request(parts.method, parts.uri.to_string())
                .headers(parts.headers)
                .body(data)
                .send()
                .await
                .map_err(|_| std::io::Error::other("identity provider unavailable"))?;
            let status = response.status();
            let headers = response.headers().clone();
            let bytes = body(response)
                .await
                .map_err(|_| std::io::Error::other("invalid identity response"))?;
            let mut response = HttpResponse::new(bytes);
            *response.status_mut() = status;
            *response.headers_mut() = headers;
            Ok(response)
        })
    }
}

#[cfg(test)]
#[path = "sso_tests.rs"]
mod tests;
