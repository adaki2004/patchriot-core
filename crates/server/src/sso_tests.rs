use super::*;
use axum::{
    Router,
    body::Body,
    http::Request,
    routing::{get, post},
};
use chrono::{Duration, Utc};
use http_body_util::BodyExt;
use openidconnect::{
    Audience, EmptyAdditionalClaims, EndUserEmail, JsonWebKeyId, PrivateSigningKey, StandardClaims,
    SubjectIdentifier,
    core::{CoreIdToken, CoreIdTokenClaims, CoreJwsSigningAlgorithm, CoreRsaPrivateSigningKey},
};
use rsa::pkcs1::EncodeRsaPrivateKey;
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::sync::{Arc, LazyLock, Mutex};
use tower::ServiceExt;

const ORIGIN: &str = "https://patchriot.example";

struct TestApp {
    state: AppState,
    admin: PgPool,
    schema: String,
}
impl TestApp {
    async fn new(origin: Option<String>) -> Self {
        let url =
            std::env::var("PATCHRIOT_TEST_DATABASE_URL").expect("local test database required");
        let admin = PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let schema = format!("test_sso_{}", Uuid::new_v4().simple());
        sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
            .execute(&admin)
            .await
            .unwrap();
        let search = schema.clone();
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .after_connect(move |connection, _| {
                let search = search.clone();
                Box::pin(async move {
                    sqlx::query("SELECT set_config('search_path',$1,false)")
                        .bind(search)
                        .execute(connection)
                        .await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let mut sso = SsoConfig::new(
            Some(("github-id".into(), "fixture-github-secret".into())),
            Some(("google-id".into(), "fixture-google-secret".into())),
        )
        .unwrap();
        sso.test_origin = origin;
        let config = Config::new(
            ORIGIN.into(),
            "http://127.0.0.1:1".into(),
            "local-test-service-key".repeat(2),
            None,
        )
        .unwrap()
        .with_sso(sso);
        Self {
            state: AppState::new(pool, config).unwrap(),
            admin,
            schema,
        }
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
    ) -> (StatusCode, HeaderMap, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        for (key, value) in headers {
            request = request.header(*key, *value);
        }
        let response = crate::router(self.state.clone())
            .oneshot(request.body(Body::from("{}")).unwrap())
            .await
            .unwrap();
        let (parts, body) = response.into_parts();
        let bytes = body.collect().await.unwrap().to_bytes();
        (
            parts.status,
            parts.headers,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
    async fn begin(&self, provider: &str) -> (String, String, Value) {
        let (status, headers, result) = self
            .request(
                "POST",
                &format!("/api/auth/{provider}/start"),
                &[("origin", ORIGIN)],
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        let cookie = headers[header::SET_COOKIE].to_str().unwrap();
        assert!(cookie.contains("HttpOnly; SameSite=Lax; Path=/; Max-Age=600; Secure"));
        let cookie = cookie.split(';').next().unwrap().to_owned();
        let url = url::Url::parse(result["authorization_url"].as_str().unwrap()).unwrap();
        let params: BTreeMap<String, String> = url.query_pairs().into_owned().collect();
        (
            cookie,
            params["state"].clone(),
            serde_json::to_value(params).unwrap(),
        )
    }
    async fn callback(
        &self,
        provider: &str,
        cookie: &str,
        state: &str,
        code: &str,
    ) -> (StatusCode, HeaderMap, Value) {
        self.request(
            "GET",
            &format!("/api/auth/{provider}/callback?state={state}&code={code}"),
            &[("cookie", cookie)],
        )
        .await
    }
    async fn count(&self, table: &str) -> i64 {
        assert!(["accounts", "sessions", "oauth_attempts", "oauth_identities"].contains(&table));
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT count(*) FROM {table}")))
            .fetch_one(&self.state.pool)
            .await
            .unwrap()
    }
    async fn finish(self) {
        self.state.pool.close().await;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DROP SCHEMA {} CASCADE",
            self.schema
        )))
        .execute(&self.admin)
        .await
        .unwrap();
        self.admin.close().await;
    }
}

#[test]
fn incomplete_or_malformed_configuration_never_enables_a_provider() {
    assert!(SsoConfig::new(Some(("".into(), "secret".into())), None).is_err());
    assert!(SsoConfig::new(Some(("id\n".into(), "secret".into())), None).is_err());
    assert!(SsoConfig::new(None, Some(("id".into(), "\n".into()))).is_err());
    assert!(SsoConfig::default().get(Provider::Google).is_err());
}

#[tokio::test]
async fn start_requires_origin_and_binds_pkce_state_nonce_and_ten_minute_browser_cookie() {
    let test = TestApp::new(None).await;
    for origin in [None, Some("https://attacker.example")] {
        let headers = origin.map(|v| vec![("origin", v)]).unwrap_or_default();
        assert_eq!(
            test.request("POST", "/api/auth/google/start", &headers)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(test.count("oauth_attempts").await, 0);
    let (cookie, state, params) = test.begin("google").await;
    assert_eq!(params["code_challenge_method"], "S256");
    assert_eq!(
        params["redirect_uri"],
        format!("{ORIGIN}/api/auth/google/callback")
    );
    assert_eq!(params["scope"], "openid email profile");
    let saved:(String,String,String,i64)=sqlx::query_as("SELECT verifier,nonce,browser_hash,EXTRACT(EPOCH FROM expires_at-now())::bigint FROM oauth_attempts WHERE state_hash=$1")
        .bind(auth::hash(&state)).fetch_one(&test.state.pool).await.unwrap();
    assert_eq!(
        params["code_challenge"],
        PkceCodeChallenge::from_code_verifier_sha256(&PkceCodeVerifier::new(saved.0)).as_str()
    );
    assert_eq!(params["nonce"], saved.1);
    assert_eq!(saved.2, auth::hash(cookie.split('=').nth(1).unwrap()));
    assert!((590..=600).contains(&saved.3));
    assert!(!params.to_string().contains("secret"));
    assert_eq!(
        test.request("GET", "/api/auth/providers", &[]).await.2,
        json!({"github":true,"google":true,"wallet":false})
    );
    // A new attempt in the same browser invalidates the old one.
    assert_eq!(
        test.request(
            "POST",
            "/api/auth/github/start",
            &[("origin", ORIGIN), ("cookie", &cookie)]
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(test.count("oauth_attempts").await, 1);
    test.finish().await;
}

#[tokio::test]
async fn callbacks_reject_wrong_browser_provider_expiry_denial_and_duplicate_cookies_without_sessions()
 {
    let test = TestApp::new(None).await;
    let (cookie, state, _) = test.begin("github").await;
    for (provider, cookie_value, query_state) in [
        ("github", String::new(), state.clone()),
        (
            "github",
            format!("__Host-patchriot_oauth={}", "0".repeat(64)),
            state.clone(),
        ),
        ("google", cookie.clone(), state.clone()),
        ("github", cookie.clone(), "0".repeat(64)),
        ("github", format!("{cookie}; {cookie}"), state.clone()),
    ] {
        let response = test
            .callback(provider, &cookie_value, &query_state, "invalid")
            .await;
        assert_eq!(response.1[header::LOCATION], "/?signin=failed#/request");
        assert_eq!(response.1[header::CACHE_CONTROL], "no-store");
        assert_eq!(test.count("oauth_attempts").await, 1);
    }
    let denied=test.request("GET",&format!("/api/auth/github/callback?state={state}&error=access_denied&error_description=private-details"),&[("cookie",&cookie)]).await;
    assert_eq!(denied.1[header::LOCATION], "/?signin=failed#/request");
    assert_eq!(test.count("oauth_attempts").await, 0);
    let (cookie, state, _) = test.begin("github").await;
    sqlx::query("UPDATE oauth_attempts SET expires_at=now()-interval '1 second'")
        .execute(&test.state.pool)
        .await
        .unwrap();
    assert_eq!(
        test.callback("github", &cookie, &state, "invalid").await.1[header::LOCATION],
        "/?signin=failed#/request"
    );
    assert_eq!(test.count("sessions").await, 0);
    assert_eq!(test.count("accounts").await, 0);
    test.finish().await;
}

async fn mock_server(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    (
        url,
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() }),
    )
}

#[tokio::test]
async fn github_exchanges_once_checks_verified_email_and_never_inherits_an_email_matched_admin() {
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let records = seen.clone();
    let verified = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let verified_copy = verified.clone();
    let router=Router::new()
        .route("/login/oauth/access_token",post(move |body:String| { let records=records.clone(); async move { records.lock().unwrap().push(body); Json(json!({"access_token":"local-only-fixture-access","token_type":"bearer"})) } }))
        .route("/user",get(|headers:HeaderMap| async move { assert_eq!(headers[header::AUTHORIZATION],"Bearer local-only-fixture-access"); Json(json!({"id":42,"login":"A tester","type":"User"})) }))
        .route("/user/emails",get(move || { let verified=verified_copy.clone(); async move { Json(json!([{"email":"admin@example.org","primary":true,"verified":verified.load(std::sync::atomic::Ordering::Relaxed)}])) } }));
    let (origin, server) = mock_server(router).await;
    let test = TestApp::new(Some(origin)).await;
    let admin = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts(id,display_name,role,auth_method,contact_email) VALUES($1,'Admin','admin','password','admin@example.org')").bind(admin).execute(&test.state.pool).await.unwrap();
    let (cookie, state, _) = test.begin("github").await;
    let expected_verifier: String = sqlx::query_scalar("SELECT verifier FROM oauth_attempts")
        .fetch_one(&test.state.pool)
        .await
        .unwrap();
    let (one, two) = tokio::join!(
        test.callback("github", &cookie, &state, "fixture-code"),
        test.callback("github", &cookie, &state, "fixture-code")
    );
    let success = [one, two]
        .into_iter()
        .find(|r| r.1[header::LOCATION] == "/#/overview")
        .expect("one callback succeeds");
    assert_eq!(test.count("sessions").await, 1);
    assert_eq!(test.count("accounts").await, 2);
    let record = seen.lock().unwrap().clone();
    assert_eq!(record.len(), 1);
    let form: BTreeMap<_, _> = url::form_urlencoded::parse(record[0].as_bytes())
        .into_owned()
        .collect();
    assert_eq!(form["code_verifier"], expected_verifier);
    assert_eq!(
        form["redirect_uri"],
        format!("{ORIGIN}/api/auth/github/callback")
    );
    let session_cookie = success
        .1
        .get_all(header::SET_COOKIE)
        .iter()
        .find_map(|h| {
            let s = h.to_str().unwrap();
            s.starts_with("__Host-patchriot_session=")
                .then(|| s.split(';').next().unwrap().to_owned())
        })
        .unwrap();
    let session = test
        .request("GET", "/api/session", &[("cookie", &session_cookie)])
        .await
        .2;
    assert_eq!(session["account"]["role"], "member");
    assert_eq!(session["account"]["auth_method"], "github");
    assert_ne!(session["account"]["id"], admin.to_string());
    assert_eq!(
        test.request(
            "POST",
            "/api/auth/github/start",
            &[("origin", ORIGIN), ("cookie", &session_cookie)]
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    verified.store(false, std::sync::atomic::Ordering::Relaxed);
    let (cookie, state, _) = test.begin("github").await;
    assert_eq!(
        test.callback("github", &cookie, &state, "other-code")
            .await
            .1[header::LOCATION],
        "/?signin=failed#/request"
    );
    assert_eq!(test.count("sessions").await, 1);
    server.abort();
    test.finish().await;
}

#[tokio::test]
async fn stable_subject_serializes_concurrent_signup_and_disabled_accounts_stay_disabled() {
    let test = TestApp::new(None).await;
    let identity = || Identity {
        subject: "stable-subject".into(),
        email: "a@example.org".into(),
        name: "Tester".into(),
    };
    let (one, two) = tokio::join!(
        login_identity(&test.state, Provider::Google, identity()),
        login_identity(&test.state, Provider::Google, identity())
    );
    assert!(one.is_ok() && two.is_ok());
    assert_eq!(test.count("accounts").await, 1);
    let mut changed = identity();
    changed.email = "renamed@example.org".into();
    assert!(
        login_identity(&test.state, Provider::Google, changed)
            .await
            .is_ok()
    );
    assert_eq!(test.count("accounts").await, 1);
    sqlx::query("UPDATE accounts SET disabled=true")
        .execute(&test.state.pool)
        .await
        .unwrap();
    assert!(
        login_identity(&test.state, Provider::Google, identity())
            .await
            .is_err()
    );
    assert_eq!(test.count("sessions").await, 3);
    test.finish().await;
}

// Generated at runtime: no reusable signing key or external provider is needed.
static SIGNING_KEY: LazyLock<CoreRsaPrivateSigningKey> = LazyLock::new(|| {
    let key = rsa::RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048).unwrap();
    CoreRsaPrivateSigningKey::from_pem(
        key.to_pkcs1_pem(Default::default()).unwrap().as_str(),
        Some(JsonWebKeyId::new("fixture".into())),
    )
    .unwrap()
});

#[tokio::test]
async fn google_verifies_the_signed_subject_nonce_issuer_audience_expiry_and_email() {
    let token = Arc::new(Mutex::new(String::new()));
    let stored_token = token.clone();
    let metadata = Arc::new(Mutex::new(json!({})));
    let stored_metadata = metadata.clone();
    let token_forms = Arc::new(Mutex::new(Vec::<String>::new()));
    let observed = token_forms.clone();
    let router=Router::new()
        .route("/.well-known/openid-configuration",get(move || {let data=stored_metadata.clone();async move{Json(data.lock().unwrap().clone())}}))
        .route("/oauth2/v3/certs",get(||async {Json(json!({"keys":[SIGNING_KEY.as_verification_key()]}))}))
        .route("/token",post(move |body:String| {let data=stored_token.clone();let observed=observed.clone();async move{observed.lock().unwrap().push(body);Json(json!({"id_token":data.lock().unwrap().clone(),"access_token":"fixture-access","token_type":"Bearer","expires_in":3600}))}}));
    let (origin, server) = mock_server(router).await;
    *metadata.lock().unwrap() = json!({"issuer":format!("{origin}/"),"authorization_endpoint":format!("{origin}/authorize"),"token_endpoint":format!("{origin}/token"),"jwks_uri":format!("{origin}/oauth2/v3/certs"),"response_types_supported":["code"],"subject_types_supported":["public"],"id_token_signing_alg_values_supported":["RS256"]});
    let test = TestApp::new(Some(origin.clone())).await;
    for fault in [
        "none",
        "nonce",
        "issuer",
        "audience",
        "expired",
        "unverified",
        "signature",
        "access_hash",
        "metadata_ssrf",
    ] {
        let (cookie, state, params) = test.begin("google").await;
        let claims = CoreIdTokenClaims::new(
            IssuerUrl::new(if fault == "issuer" {
                "https://wrong.example/".into()
            } else {
                format!("{origin}/")
            })
            .unwrap(),
            vec![Audience::new(
                if fault == "audience" {
                    "other-client"
                } else {
                    "google-id"
                }
                .into(),
            )],
            Utc::now() + Duration::seconds(if fault == "expired" { -3600 } else { 300 }),
            Utc::now(),
            StandardClaims::new(SubjectIdentifier::new("google-stable-user".into()))
                .set_email(Some(EndUserEmail::new("tester@example.org".into())))
                .set_email_verified(Some(fault != "unverified")),
            EmptyAdditionalClaims {},
        )
        .set_nonce(Some(Nonce::new(if fault == "nonce" {
            "wrong".into()
        } else {
            params["nonce"].as_str().unwrap().into()
        })));
        let access = openidconnect::AccessToken::new(
            if fault == "access_hash" {
                "wrong-access"
            } else {
                "fixture-access"
            }
            .into(),
        );
        let signed = CoreIdToken::new(
            claims,
            &*SIGNING_KEY,
            CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha256,
            Some(&access),
            None,
        )
        .unwrap()
        .to_string();
        *token.lock().unwrap() = if fault == "signature" {
            let (head, _) = signed.rsplit_once('.').unwrap();
            format!("{head}.AAAA")
        } else {
            signed
        };
        if fault == "metadata_ssrf" {
            metadata.lock().unwrap()["token_endpoint"] = json!("http://127.0.0.1:1/secret");
        }
        let response = test
            .callback("google", &cookie, &state, "fixture-code")
            .await;
        assert_eq!(
            response.1[header::LOCATION],
            if fault == "none" {
                "/#/overview"
            } else {
                "/?signin=failed#/request"
            },
            "accepted or rejected wrong case: {fault}"
        );
    }
    assert_eq!(test.count("sessions").await, 1);
    assert_eq!(test.count("accounts").await, 1);
    let forms = token_forms.lock().unwrap().clone();
    assert_eq!(
        forms.len(),
        8,
        "unapproved token endpoint must not receive secrets"
    );
    for raw in forms {
        let form: BTreeMap<_, _> = url::form_urlencoded::parse(raw.as_bytes())
            .into_owned()
            .collect();
        assert_eq!(form["client_id"], "google-id");
        assert_eq!(form["grant_type"], "authorization_code");
        assert!(form["code_verifier"].len() >= 43);
        assert_eq!(
            form["redirect_uri"],
            format!("{ORIGIN}/api/auth/google/callback")
        );
    }
    server.abort();
    test.finish().await;
}

#[tokio::test]
async fn identity_transport_rejects_redirects_large_bodies_and_unknown_endpoints() {
    let (origin, server) = mock_server(
        Router::new()
            .route(
                "/redirect",
                get(|| async { Redirect::to("http://127.0.0.1:1/secret") }),
            )
            .route("/oversize", get(|| async { "x".repeat(256 * 1024 + 1) })),
    )
    .await;
    let transport = GoogleTransport {
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap(),
        allowed: [
            format!("{origin}/redirect"),
            format!("{origin}/oversize"),
            format!("{origin}/missing"),
        ],
    };
    for path in ["redirect", "oversize", "unapproved"] {
        let request = Request::builder()
            .uri(format!("{origin}/{path}"))
            .body(vec![])
            .unwrap();
        assert!(transport.call(request).await.is_err());
    }
    server.abort();
}
