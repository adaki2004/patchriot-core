use axum::{
    Json, Router,
    body::Body,
    http::{HeaderMap, Request, StatusCode},
    routing::get,
};
use http_body_util::BodyExt;
use patchriot_core::{AppState, Config, create_invite, disable_account, invite_account, router};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;
use uuid::Uuid;

const ORIGIN: &str = "https://patchriot.example";

#[path = "sites/mod.rs"]
mod sites;

#[path = "orders/mod.rs"]
mod orders;

struct TestApp {
    app: Router,
    pool: PgPool,
    admin_pool: PgPool,
    schema: String,
}

impl TestApp {
    async fn new(dispatcher: &str) -> Self {
        let url = std::env::var("PATCHRIOT_TEST_DATABASE_URL")
            .expect("set PATCHRIOT_TEST_DATABASE_URL to a local test PostgreSQL database");
        let admin_pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let schema = format!("test_core_{}", Uuid::new_v4().simple());
        // Only a fixed prefix and generated UUID hex become this identifier.
        sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
            .execute(&admin_pool)
            .await
            .unwrap();
        let search = schema.clone();
        let pool = PgPoolOptions::new()
            .max_connections(3)
            .after_connect(move |connection, _| {
                let search = search.clone();
                Box::pin(async move {
                    sqlx::query("SELECT set_config('search_path', $1, false)")
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
        let config = Config::new(
            ORIGIN.into(),
            dispatcher.into(),
            format!("test-service-{}", Uuid::new_v4()),
            None,
        )
        .unwrap();
        let app = router(AppState::new(pool.clone(), config).unwrap());
        Self {
            app,
            pool,
            admin_pool,
            schema,
        }
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Value,
        headers: &[(&str, &str)],
    ) -> (StatusCode, HeaderMap, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        for (name, value) in headers {
            req = req.header(*name, *value);
        }
        let response = self
            .app
            .clone()
            .oneshot(
                req.body(Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        assert_eq!(headers.get("cache-control").unwrap(), "no-store");
        assert_eq!(headers.get("x-content-type-options").unwrap(), "nosniff");
        assert!(headers.get("content-security-policy").is_some());
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"text": String::from_utf8_lossy(&bytes)}));
        (status, headers, body)
    }

    async fn login(&self, role: &str) -> (String, Value) {
        let code = create_invite(&self.pool, "Example operator", role)
            .await
            .unwrap();
        let (status, headers, _) = self
            .request(
                "POST",
                "/api/auth/redeem",
                json!({"code":code}),
                &[("origin", ORIGIN)],
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        let set_cookie = headers.get("set-cookie").unwrap().to_str().unwrap();
        assert!(set_cookie.starts_with("__Host-patchriot_session="));
        for attribute in ["HttpOnly", "SameSite=Lax", "Path=/", "Secure"] {
            assert!(set_cookie.contains(attribute));
        }
        assert!(!set_cookie.contains("Domain="));
        let cookie = set_cookie.split(';').next().unwrap().to_owned();
        let (_, _, session) = self
            .request("GET", "/api/session", Value::Null, &[("cookie", &cookie)])
            .await;
        assert_eq!(session["account"]["role"], role);
        assert_eq!(session["account"]["auth_method"], "invite");
        (cookie, session)
    }

    async fn finish(self) {
        self.pool.close().await;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DROP SCHEMA {} CASCADE",
            self.schema
        )))
        .execute(&self.admin_pool)
        .await
        .unwrap();
        self.admin_pool.close().await;
    }
}

fn incident_content(title: &str) -> Value {
    json!({"title":title,"occurred_on":"2025-01-01","evidence":"reported",
        "summary":"A public source reports a dependency incident. This is an explicit test fixture.",
        "takeaway":"Check the affected version before drawing a conclusion.",
        "sources":[{"label":"Public advisory","url":"https://github.com/advisories/GHSA-example"}]})
}

#[tokio::test]
async fn incident_drafts_stay_private_and_edits_do_not_replace_the_published_snapshot() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let (cookie, session) = test.login("admin").await;
    let headers = [
        ("cookie", cookie.as_str()),
        ("origin", ORIGIN),
        ("x-csrf-token", session["csrf_token"].as_str().unwrap()),
    ];
    let id = Uuid::new_v4();
    let path = format!("/api/admin/incidents/{id}");
    let (status, _, draft) = test
        .request(
            "POST",
            &path,
            json!({"action":"save","revision":0,"content":incident_content("Private draft")}),
            &headers,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(draft["revision"], 1);
    assert_eq!(
        test.request("GET", "/api/incidents", Value::Null, &[])
            .await
            .2,
        json!([])
    );
    let (_, _, admin_list) = test
        .request("GET", "/api/admin/incidents", Value::Null, &headers)
        .await;
    assert_eq!(admin_list[0]["content"]["title"], "Private draft");
    let (status, _, _) = test
        .request(
            "POST",
            &path,
            json!({"action":"publish","revision":1,"sources_reviewed":false}),
            &headers,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, _, published) = test
        .request(
            "POST",
            &path,
            json!({"action":"publish","revision":1,"sources_reviewed":true}),
            &headers,
        )
        .await;
    assert_eq!(published["published_revision"], 2);
    let public = test
        .request("GET", "/api/incidents", Value::Null, &[])
        .await
        .2;
    assert_eq!(public[0]["content"]["title"], "Private draft");
    assert!(public[0].get("actor_id").is_none());
    assert!(public[0].get("updated_at").is_none());

    let (status, _, updated) = test.request("POST", &path, json!({"action":"save","revision":2,"content":incident_content("Unapproved correction")}), &headers).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["revision"], 3);
    assert_eq!(updated["published_revision"], 2);
    assert_eq!(
        test.request("GET", "/api/incidents", Value::Null, &[])
            .await
            .2,
        public
    );
    let (status, _, _) = test
        .request(
            "POST",
            &path,
            json!({"action":"publish","revision":2,"sources_reviewed":true}),
            &headers,
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _, _) = test
        .request(
            "POST",
            &path,
            json!({"action":"publish","revision":3,"sources_reviewed":true}),
            &headers,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        test.request("GET", "/api/incidents", Value::Null, &[])
            .await
            .2[0]["content"]["title"],
        "Unapproved correction"
    );

    let (status, _, _) = test
        .request(
            "POST",
            &path,
            json!({"action":"withdraw","revision":4}),
            &headers,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        test.request("GET", "/api/incidents", Value::Null, &[])
            .await
            .2,
        json!([])
    );
    let edits: Vec<(i32, String)> = sqlx::query_as(
        "SELECT revision, action FROM incident_edits WHERE incident_id = $1 ORDER BY revision",
    )
    .bind(id)
    .fetch_all(&test.pool)
    .await
    .unwrap();
    assert_eq!(
        edits,
        vec![
            (1, "draft_saved".into()),
            (2, "published".into()),
            (3, "draft_saved".into()),
            (4, "published".into()),
            (5, "withdrawn".into())
        ]
    );
    test.finish().await;
}

#[tokio::test]
async fn incident_authoring_requires_admin_origin_csrf_and_handles_concurrent_edits() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let (admin, session) = test.login("admin").await;
    let (member, member_session) = test.login("member").await;
    let headers = [
        ("cookie", admin.as_str()),
        ("origin", ORIGIN),
        ("x-csrf-token", session["csrf_token"].as_str().unwrap()),
    ];
    let id = Uuid::new_v4();
    let path = format!("/api/admin/incidents/{id}");
    let save = json!({"action":"save","revision":0,"content":incident_content("One incident")});
    assert_eq!(
        test.request("GET", "/api/admin/incidents", Value::Null, &[])
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        test.request(
            "GET",
            "/api/admin/incidents",
            Value::Null,
            &[("cookie", &member)]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        test.request(
            "POST",
            &path,
            save.clone(),
            &[
                ("cookie", &member),
                ("origin", ORIGIN),
                (
                    "x-csrf-token",
                    member_session["csrf_token"].as_str().unwrap()
                ),
                ("x-patchriot-role", "admin")
            ]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        test.request(
            "POST",
            &path,
            save.clone(),
            &[("cookie", &admin), ("origin", ORIGIN)]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        test.request(
            "POST",
            &path,
            save.clone(),
            &[
                ("cookie", &admin),
                ("origin", "https://wrong.example"),
                ("x-csrf-token", session["csrf_token"].as_str().unwrap())
            ]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );

    let (first, second) = tokio::join!(
        test.request("POST", &path, save.clone(), &headers),
        test.request("POST", &path, save, &headers)
    );
    assert_eq!(
        [first.0, second.0]
            .iter()
            .filter(|&&s| s == StatusCode::OK)
            .count(),
        1
    );
    assert_eq!(
        [first.0, second.0]
            .iter()
            .filter(|&&s| s == StatusCode::CONFLICT)
            .count(),
        1
    );
    let save = json!({"action":"save","revision":1,"content":incident_content("Edited once")});
    let (first, second) = tokio::join!(
        test.request("POST", &path, save.clone(), &headers),
        test.request("POST", &path, save, &headers)
    );
    assert_eq!(
        [first.0, second.0]
            .iter()
            .filter(|&&s| s == StatusCode::OK)
            .count(),
        1
    );
    assert_eq!(
        [first.0, second.0]
            .iter()
            .filter(|&&s| s == StatusCode::CONFLICT)
            .count(),
        1
    );
    let (records, edits): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM incidents), (SELECT count(*) FROM incident_edits)",
    )
    .fetch_one(&test.pool)
    .await
    .unwrap();
    assert_eq!((records, edits), (1, 2));
    test.finish().await;
}

#[tokio::test]
async fn incident_sources_reject_executable_private_and_secret_bearing_links() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let (cookie, session) = test.login("admin").await;
    let headers = [
        ("cookie", cookie.as_str()),
        ("origin", ORIGIN),
        ("x-csrf-token", session["csrf_token"].as_str().unwrap()),
    ];
    let path = format!("/api/admin/incidents/{}", Uuid::new_v4());
    for url in [
        "javascript:alert(1)",
        "data:text/html,unsafe",
        "http://public.example/advisory",
        "https://user:secret@public.example/",
        "https://public.example/?token=secret",
        "https://127.0.0.1/",
        "https://[::1]/",
        "https://host.local/advisory",
        "https://localhost/",
        "https://public.example:8443/",
        "https://public.example\n/path",
    ] {
        let mut content = incident_content("Invalid source");
        content["sources"][0]["url"] = url.into();
        assert_eq!(
            test.request(
                "POST",
                &path,
                json!({"action":"save","revision":0,"content":content}),
                &headers
            )
            .await
            .0,
            StatusCode::BAD_REQUEST,
            "{url}"
        );
    }
    for field in ["title", "summary", "takeaway"] {
        let mut content = incident_content("Empty text");
        content[field] = " ".into();
        assert_eq!(
            test.request(
                "POST",
                &path,
                json!({"action":"save","revision":0,"content":content}),
                &headers
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM incidents")
        .fetch_one(&test.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    test.finish().await;
}

#[tokio::test]
async fn payment_totals_are_private_and_do_not_enable_checkout() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let (cookie, session) = test.login("member").await;
    let account: Uuid = session["account"]["id"].as_str().unwrap().parse().unwrap();
    let deadline = chrono::Utc::now() + chrono::Duration::minutes(5);
    let request = json!({"dry":false,"swapType":"EXACT_OUTPUT","depositType":"ORIGIN_CHAIN","refundType":"ORIGIN_CHAIN","depositMode":"SIMPLE","recipientType":"INTENTS","destinationAsset":"nep141:fixture.near","originAsset":"nep141:fixture.input.near","recipient":"treasury.fixture.near","refundTo":"refund.fixture.near","amount":"1000000","deadline":deadline});
    let terms = patchriot_core::payments::InvoiceTerms {
        account_id: account,
        request_id: Uuid::new_v4(),
        destination_asset: "nep141:fixture.near".into(),
        recipient: "treasury.fixture.near".into(),
        required_amount: 1_000_000,
        quote_request: request.clone(),
    };
    let quote = patchriot_core::payments::QuoteResponse {
        correlation_id: Uuid::new_v4().to_string(),
        quote_request: request,
        quote: json!({"amountOut":"1000000","amountIn":"1000000","depositAddress":"deposit.fixture.near","deadline":deadline}),
    };
    let invoice = patchriot_core::payments::record_quote(&test.pool, &terms, &quote)
        .await
        .unwrap();
    sqlx::query("INSERT INTO payment_ledger (id,invoice_id,account_id,asset,amount,debit,credit) VALUES ($1,$2,$3,'nep141:fixture.near',1000000,'treasury_asset','customer_funds')")
        .bind(Uuid::new_v4()).bind(invoice).bind(account).execute(&test.pool).await.unwrap();
    let (code, _, body) = test
        .request("GET", "/api/payments", Value::Null, &[("cookie", &cookie)])
        .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        body,
        json!({"checkout_enabled":false,"totals":[{"asset":"nep141:fixture.near","credit":"customer_funds","amount":"1000000"}]})
    );
    let (other, _) = test.login("admin").await;
    let (_, _, body) = test
        .request(
            "GET",
            "/api/payments",
            Value::Null,
            &[
                ("cookie", &other),
                ("x-patchriot-account", &account.to_string()),
            ],
        )
        .await;
    assert_eq!(body["totals"], json!([]));
    assert_eq!(
        test.request("GET", "/api/payments", Value::Null, &[])
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        test.request(
            "POST",
            "/api/payments",
            json!({"amount":1000000}),
            &[("cookie", &cookie)]
        )
        .await
        .0,
        StatusCode::METHOD_NOT_ALLOWED
    );
    test.finish().await;
}

#[tokio::test]
async fn invitations_are_one_use_even_when_redeemed_concurrently_and_secrets_are_hashed() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let code = create_invite(&test.pool, "Alice", "member").await.unwrap();
    let body = json!({"code":code});
    let headers = [("origin", ORIGIN)];
    let (first, second) = tokio::join!(
        test.request("POST", "/api/auth/redeem", body.clone(), &headers),
        test.request("POST", "/api/auth/redeem", body, &headers)
    );
    assert_eq!(
        [first.0, second.0]
            .iter()
            .filter(|&&status| status == StatusCode::OK)
            .count(),
        1
    );
    let success = if first.0 == StatusCode::OK {
        first
    } else {
        second
    };
    let bearer = success.1["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .split_once('=')
        .unwrap()
        .1;
    let hashes: Vec<String> = sqlx::query_scalar("SELECT token_hash FROM sessions")
        .fetch_all(&test.pool)
        .await
        .unwrap();
    assert_eq!(hashes.len(), 1);
    assert_ne!(hashes[0], bearer);
    let saved_invite: String = sqlx::query_scalar("SELECT token_hash FROM invites")
        .fetch_one(&test.pool)
        .await
        .unwrap();
    assert_ne!(saved_invite, code);
    test.finish().await;
}

#[tokio::test]
async fn origin_and_csrf_are_required_and_logout_invalidates_the_session() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let code = create_invite(&test.pool, "Alice", "member").await.unwrap();
    for headers in [vec![], vec![("origin", "https://untrusted.example")]] {
        let response = test
            .request("POST", "/api/auth/redeem", json!({"code":code}), &headers)
            .await;
        assert_eq!(response.0, StatusCode::FORBIDDEN);
    }
    let (cookie, session) = test.login("member").await;
    for csrf in [None, Some("incorrect")] {
        let mut headers = vec![("origin", ORIGIN), ("cookie", cookie.as_str())];
        if let Some(csrf) = csrf {
            headers.push(("x-csrf-token", csrf));
        }
        let response = test
            .request("POST", "/api/auth/logout", Value::Null, &headers)
            .await;
        assert_eq!(response.0, StatusCode::FORBIDDEN);
    }
    let response = test
        .request(
            "POST",
            "/api/auth/logout",
            Value::Null,
            &[
                ("origin", ORIGIN),
                ("cookie", &cookie),
                ("x-csrf-token", session["csrf_token"].as_str().unwrap()),
            ],
        )
        .await;
    assert_eq!(response.0, StatusCode::OK);
    assert!(
        response.1["set-cookie"]
            .to_str()
            .unwrap()
            .contains("Max-Age=0")
    );
    let response = test
        .request("GET", "/api/devices", Value::Null, &[("cookie", &cookie)])
        .await;
    assert_eq!(response.0, StatusCode::UNAUTHORIZED);
    test.finish().await;
}

#[tokio::test]
async fn expired_invites_sessions_disabled_accounts_and_duplicate_cookies_cannot_authenticate() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let code = create_invite(&test.pool, "Alice", "member").await.unwrap();
    sqlx::query("UPDATE invites SET expires_at = now() - interval '1 second'")
        .execute(&test.pool)
        .await
        .unwrap();
    let response = test
        .request(
            "POST",
            "/api/auth/redeem",
            json!({"code":code}),
            &[("origin", ORIGIN)],
        )
        .await;
    assert_eq!(response.0, StatusCode::BAD_REQUEST);
    let (cookie, _) = test.login("member").await;
    let duplicate = format!("{cookie}; {cookie}");
    let response = test
        .request(
            "GET",
            "/api/devices",
            Value::Null,
            &[("cookie", &duplicate)],
        )
        .await;
    assert_eq!(response.0, StatusCode::UNAUTHORIZED);
    sqlx::query("UPDATE sessions SET expires_at = now() - interval '1 second'")
        .execute(&test.pool)
        .await
        .unwrap();
    let response = test
        .request("GET", "/api/devices", Value::Null, &[("cookie", &cookie)])
        .await;
    assert_eq!(response.0, StatusCode::UNAUTHORIZED);
    let (cookie, admin) = test.login("admin").await;
    let admin_id = admin["account"]["id"].as_str().unwrap().parse().unwrap();
    assert!(disable_account(&test.pool, admin_id).await.unwrap());
    let response = test
        .request("GET", "/api/devices", Value::Null, &[("cookie", &cookie)])
        .await;
    assert_eq!(response.0, StatusCode::UNAUTHORIZED);
    test.finish().await;
}

#[tokio::test]
async fn gateway_uses_session_identity_and_ignores_forged_browser_authority() {
    let received = Arc::new(Mutex::new(Vec::<HeaderMap>::new()));
    let capture = received.clone();
    let downstream = Router::new().route(
        "/internal/devices",
        get(move |headers: HeaderMap| {
            let capture = capture.clone();
            async move {
                capture.lock().unwrap().push(headers);
                Json(json!([]))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, downstream).await.unwrap() });
    let test = TestApp::new(&url).await;
    let (alice_cookie, alice) = test.login("member").await;
    let (bob_cookie, bob) = test.login("member").await;
    for (cookie, session) in [(&alice_cookie, &alice), (&bob_cookie, &bob)] {
        let response = test
            .request(
                "GET",
                "/api/devices",
                Value::Null,
                &[
                    ("cookie", cookie),
                    ("x-patchriot-account", "forged-account"),
                    ("x-patchriot-role", "admin"),
                    ("authorization", "Bearer forged-service-credential"),
                ],
            )
            .await;
        assert_eq!(response.0, StatusCode::OK);
        let observed = received.lock().unwrap().last().unwrap().clone();
        assert_eq!(
            observed["x-patchriot-account"],
            session["account"]["id"].as_str().unwrap()
        );
        assert_eq!(observed["x-patchriot-role"], "member");
        assert_ne!(
            observed["authorization"],
            "Bearer forged-service-credential"
        );
        assert!(observed.get("cookie").is_none());
    }
    let response = test
        .request(
            "POST",
            &format!("/api/devices/{}/decision", Uuid::new_v4()),
            json!({"action":"approve","reason":null}),
            &[
                ("cookie", &alice_cookie),
                ("origin", ORIGIN),
                ("x-csrf-token", alice["csrf_token"].as_str().unwrap()),
                ("x-patchriot-role", "admin"),
            ],
        )
        .await;
    assert_eq!(response.0, StatusCode::FORBIDDEN);
    assert_eq!(response.2["error"], "admin_required");
    assert_eq!(received.lock().unwrap().len(), 2);
    server.abort();
    test.finish().await;
}

#[tokio::test]
async fn unavailable_dispatcher_is_an_error_not_an_empty_fleet_and_api_typos_stay_json() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let response = test.request("GET", "/api/fleet", Value::Null, &[]).await;
    assert_eq!(response.0, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.2, json!({"error":"dispatcher_unavailable"}));
    let response = test
        .request("GET", "/api/misspelled", Value::Null, &[])
        .await;
    assert_eq!(response.0, StatusCode::NOT_FOUND);
    assert_eq!(response.2, json!({"error":"not_found"}));
    let response = test
        .request(
            "POST",
            "/api/auth/redeem",
            json!({"code":"x".repeat(20_000)}),
            &[("origin", ORIGIN)],
        )
        .await;
    assert_eq!(response.0, StatusCode::PAYLOAD_TOO_LARGE);
    test.finish().await;
}

#[test]
fn service_configuration_rejects_insecure_or_credentialed_destinations() {
    let key = format!("test-service-{}", Uuid::new_v4());
    for bad in [
        "http://public.example",
        "https://user:password@public.example",
        "https://public.example/path",
        "https://public.example?query=1",
        "https://public.example/#fragment",
    ] {
        assert!(
            Config::new(
                bad.into(),
                "http://127.0.0.1:7411".into(),
                key.clone(),
                None
            )
            .is_err()
        );
        assert!(Config::new(ORIGIN.into(), bad.into(), key.clone(), None).is_err());
    }
    assert!(
        Config::new(
            ORIGIN.into(),
            "http://127.0.0.1:7411".into(),
            "short".into(),
            None
        )
        .is_err()
    );
}

#[tokio::test]
async fn renewed_invites_keep_the_same_account_and_cannot_enable_disabled_accounts() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let (_, previous) = test.login("member").await;
    let id: Uuid = previous["account"]["id"].as_str().unwrap().parse().unwrap();
    sqlx::query("UPDATE sessions SET expires_at = now() - interval '1 second'")
        .execute(&test.pool)
        .await
        .unwrap();
    let code = invite_account(&test.pool, id).await.unwrap();
    let response = test
        .request(
            "POST",
            "/api/auth/redeem",
            json!({"code":code}),
            &[("origin", ORIGIN)],
        )
        .await;
    assert_eq!(response.0, StatusCode::OK);
    let cookie = response.1["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let renewed = test
        .request("GET", "/api/session", Value::Null, &[("cookie", cookie)])
        .await;
    assert_eq!(renewed.2["account"], previous["account"]);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM accounts")
        .fetch_one(&test.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let unused = invite_account(&test.pool, id).await.unwrap();
    assert!(disable_account(&test.pool, id).await.unwrap());
    assert!(invite_account(&test.pool, id).await.is_err());
    let response = test
        .request(
            "POST",
            "/api/auth/redeem",
            json!({"code":unused}),
            &[("origin", ORIGIN)],
        )
        .await;
    assert_eq!(response.0, StatusCode::BAD_REQUEST);
    test.finish().await;
}
