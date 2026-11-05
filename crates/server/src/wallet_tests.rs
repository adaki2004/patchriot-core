use super::*;
use axum::{body::Body, http::Request};
use ed25519_dalek::Signer;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower::ServiceExt;
const ORIGIN: &str = "https://patchriot.example";
struct TestApp {
    state: AppState,
    admin: PgPool,
    schema: String,
}
impl TestApp {
    async fn new() -> Self {
        let url =
            std::env::var("PATCHRIOT_TEST_DATABASE_URL").expect("local test database required");
        let admin = PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let schema = format!("test_wallet_{}", Uuid::new_v4().simple());
        sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
            .execute(&admin)
            .await
            .unwrap();
        let search = schema.clone();
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .after_connect(move |c, _| {
                let search = search.clone();
                Box::pin(async move {
                    sqlx::query("SELECT set_config('search_path',$1,false)")
                        .bind(search)
                        .execute(c)
                        .await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let config = Config::new(
            ORIGIN.into(),
            "http://127.0.0.1:1".into(),
            "local-fixture-service-key".repeat(2),
            None,
        )
        .unwrap()
        .with_wallet_project_id(Some("a".repeat(32)))
        .unwrap();
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
        body: Value,
    ) -> (StatusCode, HeaderMap, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        for (k, v) in headers {
            request = request.header(*k, *v);
        }
        let response = crate::router(self.state.clone())
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let (parts, body) = response.into_parts();
        (
            parts.status,
            parts.headers,
            serde_json::from_slice(&body.collect().await.unwrap().to_bytes())
                .unwrap_or(Value::Null),
        )
    }
    async fn begin(&self, who: &Identity) -> (String, Value) {
        let (status, headers, body) = self
            .request(
                "POST",
                "/api/auth/wallet/challenge",
                &[("origin", ORIGIN)],
                json!({"network":who.network,"address":who.address}),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        let cookie = headers[header::SET_COOKIE].to_str().unwrap();
        assert!(cookie.contains("HttpOnly; SameSite=Strict; Path=/; Max-Age=300; Secure"));
        (cookie.split(';').next().unwrap().into(), body)
    }
    async fn verify(
        &self,
        who: &Identity,
        cookie: &str,
        body: &Value,
    ) -> (StatusCode, HeaderMap, Value) {
        self.request(
            "POST",
            "/api/auth/wallet/verify",
            &[("origin", ORIGIN), ("cookie", cookie)],
            json!({"nonce":body["nonce"],"signature":who.sign(body["message"].as_str().unwrap())}),
        )
        .await
    }
    async fn close(self) {
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
struct Identity {
    network: &'static str,
    address: String,
    key: [u8; 32],
}
impl Identity {
    fn new(network: &'static str) -> Self {
        let mut key = [0; 32];
        getrandom::fill(&mut key).unwrap();
        let address = if network == "ethereum" {
            let key = secp256k1::SecretKey::from_byte_array(key).unwrap();
            let pk = secp256k1::PublicKey::from_secret_key(&secp256k1::Secp256k1::new(), &key)
                .serialize_uncompressed();
            Address::from_slice(&alloy_primitives::keccak256(&pk[1..])[12..]).to_checksum(None)
        } else {
            bs58::encode(
                ed25519_dalek::SigningKey::from_bytes(&key)
                    .verifying_key()
                    .as_bytes(),
            )
            .into_string()
        };
        Self {
            network,
            address,
            key,
        }
    }
    fn sign(&self, message: &str) -> String {
        if self.network == "ethereum" {
            let secret = secp256k1::SecretKey::from_byte_array(self.key).unwrap();
            let message = secp256k1::Message::from_digest(
                alloy_primitives::eip191_hash_message(message).into(),
            );
            let (id, bytes) = secp256k1::Secp256k1::new()
                .sign_ecdsa_recoverable(message, &secret)
                .serialize_compact();
            format!("0x{}{:02x}", hex::encode(bytes), 27 + i32::from(id))
        } else {
            bs58::encode(
                ed25519_dalek::SigningKey::from_bytes(&self.key)
                    .sign(message.as_bytes())
                    .to_bytes(),
            )
            .into_string()
        }
    }
}
#[tokio::test]
async fn ethereum_and_solana_create_only_members_and_a_one_use_session() {
    let app = TestApp::new().await;
    for network in ["ethereum", "solana"] {
        let who = Identity::new(network);
        let (cookie, body) = app.begin(&who).await;
        let message = body["message"].as_str().unwrap();
        assert!(message.starts_with("patchriot.example wants you to sign in"));
        assert!(message.contains("URI: https://patchriot.example\nVersion: 1"));
        assert!(message.contains("does not authorize a payment"));
        let (status, headers, _) = app.verify(&who, &cookie, &body).await;
        assert_eq!(status, StatusCode::OK);
        let session = headers
            .get_all(header::SET_COOKIE)
            .iter()
            .find(|s| s.to_str().unwrap().starts_with("__Host-patchriot_session="))
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let (_, _, account) = app
            .request("GET", "/api/session", &[("cookie", session)], Value::Null)
            .await;
        assert_eq!(account["account"]["role"], "member");
        assert_eq!(account["account"]["auth_method"], "wallet");
        // A connected payment wallet must never replace a signed-in identity.
        assert_eq!(
            app.request(
                "POST",
                "/api/auth/wallet/challenge",
                &[("origin", ORIGIN), ("cookie", session)],
                json!({"network":who.network,"address":who.address})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            app.verify(&who, &cookie, &body).await.0,
            StatusCode::BAD_REQUEST
        );
        assert!(
            headers
                .get_all(header::SET_COOKIE)
                .iter()
                .any(|v| v.to_str().unwrap().contains("Max-Age=0"))
        );
    }
    app.close().await;
}

#[tokio::test]
async fn wallet_transport_policy_is_limited_to_app_shells_and_config_fails_closed() {
    let mut app = TestApp::new().await;
    for path in ["/api/session", "/wallet/config", "/wallet/", "/login"] {
        let (_, headers, _) = app.request("GET", path, &[], Value::Null).await;
        assert!(
            !headers[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .contains("walletconnect")
        );
    }
    for path in ["/", "/wallet"] {
        let (_, headers, _) = app.request("GET", path, &[], Value::Null).await;
        let policy = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        assert!(policy.contains("wss://relay.walletconnect.com"));
        assert!(policy.contains("script-src 'self'"));
        assert!(
            policy
                .split(';')
                .find(|s| s.trim().starts_with("script-src "))
                .is_some_and(|s| s.trim() == "script-src 'self'")
        );
        assert!(policy.contains("style-src-attr 'unsafe-inline'"));
    }
    std::sync::Arc::get_mut(&mut app.state.config)
        .unwrap()
        .wallet_project_id = None;
    let (status, _, config) = app
        .request("GET", "/api/wallet/config", &[], Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(config["enabled"], false);
    assert!(config["project_id"].is_null());
    assert_eq!(
        app.request(
            "POST",
            "/api/auth/wallet/challenge",
            &[("origin", ORIGIN)],
            json!({"network":"ethereum","address":Identity::new("ethereum").address})
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let (_, headers, _) = app.request("GET", "/wallet", &[], Value::Null).await;
    assert!(
        !headers[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .contains("walletconnect")
    );
    app.close().await;
}

#[tokio::test]
async fn failed_signatures_consume_the_challenge_and_start_is_rate_limited() {
    let app = TestApp::new().await;
    let owner = Identity::new("solana");
    let stranger = Identity::new("solana");
    let (cookie, challenge) = app.begin(&owner).await;
    assert_eq!(
        app.verify(&stranger, &cookie, &challenge).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        app.verify(&owner, &cookie, &challenge).await.0,
        StatusCode::BAD_REQUEST
    );
    for _ in 1..30 {
        app.begin(&owner).await;
    }
    assert_eq!(
        app.request(
            "POST",
            "/api/auth/wallet/challenge",
            &[("origin", ORIGIN)],
            json!({"network":"solana","address":owner.address})
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    app.close().await;
}
#[tokio::test]
async fn replay_concurrency_and_disabled_wallets_cannot_create_another_session() {
    let app = TestApp::new().await;
    let who = Identity::new("ethereum");
    let (c, b) = app.begin(&who).await;
    let (a, z) = tokio::join!(app.verify(&who, &c, &b), app.verify(&who, &c, &b));
    assert_eq!(
        [a.0, z.0]
            .into_iter()
            .filter(|s| *s == StatusCode::OK)
            .count(),
        1
    );
    let (c1, b1) = app.begin(&who).await;
    let (c2, b2) = app.begin(&who).await;
    let (a, z) = tokio::join!(app.verify(&who, &c1, &b1), app.verify(&who, &c2, &b2));
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(z.0, StatusCode::OK);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM accounts")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
    sqlx::query("UPDATE accounts SET disabled=true")
        .execute(&app.state.pool)
        .await
        .unwrap();
    let (c, b) = app.begin(&who).await;
    assert_eq!(app.verify(&who, &c, &b).await.0, StatusCode::BAD_REQUEST);
    app.close().await;
}
#[tokio::test]
async fn challenges_require_origin_exact_signature_browser_and_expiry() {
    let app = TestApp::new().await;
    let who = Identity::new("ethereum");
    for headers in [vec![], vec![("origin", "https://attacker.example")]] {
        assert_eq!(
            app.request(
                "POST",
                "/api/auth/wallet/challenge",
                &headers,
                json!({"network":"ethereum","address":who.address})
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    let (c, b) = app.begin(&who).await;
    let (_, other) = app.begin(&who).await;
    assert_eq!(
        app.verify(&who, &c, &other).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        app.verify(&who, &format!("{c}; {c}"), &b).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut tampered = b.clone();
    tampered["message"] = json!(
        b["message"]
            .as_str()
            .unwrap()
            .replace(ORIGIN, "https://attacker.example")
    );
    assert_eq!(
        app.verify(&who, &c, &tampered).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(app.verify(&who, &c, &b).await.0, StatusCode::BAD_REQUEST);
    let (c, b) = app.begin(&who).await;
    sqlx::query("UPDATE wallet_challenges SET expires_at=now()-interval '1 second'")
        .execute(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(app.verify(&who, &c, &b).await.0, StatusCode::BAD_REQUEST);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    app.close().await;
}
#[test]
fn malformed_addresses_signatures_and_changed_messages_are_rejected() {
    for network in ["ethereum", "solana"] {
        let who = Identity::new(network);
        let mut saved = SavedChallenge {
            network: network.into(),
            address: who.address.clone(),
            message: "nonce-bound fixture".into(),
        };
        let sig = who.sign(&saved.message);
        assert!(verify_signature(&saved, &sig).is_ok());
        saved.message.push('!');
        assert!(verify_signature(&saved, &sig).is_err());
        assert!(verify_signature(&saved, "not a signature").is_err());
        assert!(address(network, "http://127.0.0.1").is_err());
    }
    assert!(address("solana", "11111111111111111111111111111111").is_err());
    assert!(address("ethereum", "0x0000000000000000000000000000000000000000").is_err());
}
