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

#[tokio::test]
async fn ownership_refresh_requires_session_csrf_and_forwards_only_the_authenticated_identity() {
    let id = Uuid::new_v4();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let records = seen.clone();
    let downstream = Router::new().fallback(move |headers: HeaderMap, uri: axum::http::Uri| {
        let records = records.clone();
        async move {
            records.lock().unwrap().push((headers["x-patchriot-account"].to_str().unwrap().to_owned(), headers["x-patchriot-role"].to_str().unwrap().to_owned(), uri.path().to_owned()));
            Json(json!({"pentest_id":id,"scope_sha256":"a".repeat(64),"verified":false,"challenges":[],"private_connection":"never forward"}))
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, downstream).await.unwrap() });
    let test = TestApp::new(&url).await;
    let path = format!("/api/pentests/{id}/ownership/refresh");
    let body = json!({"scope_sha256":"a".repeat(64)});
    assert_eq!(
        test.request("POST", &path, body.clone(), &[("origin", ORIGIN)])
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (cookie, session) = test.login("member").await;
    assert_eq!(
        test.request("POST", &path, body.clone(), &[("cookie", &cookie)])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert!(seen.lock().unwrap().is_empty());
    let headers = [
        ("cookie", cookie.as_str()),
        ("origin", ORIGIN),
        ("x-csrf-token", session["csrf_token"].as_str().unwrap()),
        ("x-patchriot-role", "admin"),
    ];
    for (method, path, body) in [
        ("POST", path, body),
        ("GET", format!("/api/pentests/{id}/ownership"), Value::Null),
    ] {
        let reply = test.request(method, &path, body, &headers).await;
        assert_eq!(reply.0, StatusCode::OK);
        assert!(reply.2.get("private_connection").is_none());
    }
    assert!(seen.lock().unwrap().iter().all(|(account, role, _)| account
        == session["account"]["id"].as_str().unwrap()
        && role == "member"));
    server.abort();
    test.finish().await;
}

#[tokio::test]
async fn live_pilot_requires_session_csrf_and_cannot_bypass_coupon_or_closed_access() {
    use patchriot_core::payments::access::ReviewAccess;
    for mode in [ReviewAccess::Coupons, ReviewAccess::Closed] {
        // No downstream listener: all rejected writes must stop at core.
        let test = TestApp::with_access("http://127.0.0.1:1", mode).await;
        let (cookie, session) = test.login("member").await;
        let path = format!("/api/pentests/{}/review", Uuid::new_v4());
        let input = json!({"request_id":Uuid::new_v4(),"scope_sha256":"a".repeat(64),"device_ids":[Uuid::new_v4(),Uuid::new_v4(),Uuid::new_v4()],"accepts_operator_access":true,"accepts_provider_access":true});
        assert_eq!(
            test.request("POST", &path, input.clone(), &[("origin", ORIGIN)])
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            test.request("POST", &path, input.clone(), &[("cookie", &cookie)])
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        let headers = [
            ("cookie", cookie.as_str()),
            ("origin", ORIGIN),
            ("x-csrf-token", session["csrf_token"].as_str().unwrap()),
        ];
        let denied = test.request("POST", &path, input, &headers).await;
        assert_eq!(denied.0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(denied.2["error"], "live_test_pilot_only");
        let decision=test.request("POST",&format!("/api/pentests/{}/decision",Uuid::new_v4()),json!({"approved":true,"scope_sha256":"a".repeat(64),"note":"member cannot approve"}),&headers).await;
        assert_eq!(decision.0, StatusCode::FORBIDDEN);
        let account_path = format!("/api/pentests/{}/credentials", Uuid::new_v4());
        let account = json!({"scope_sha256":"a".repeat(64),"credentials":{"kind":"session","username":"test-account","password":"fixture-password-only"}});
        assert_eq!(
            test.request(
                "POST",
                &account_path,
                account.clone(),
                &[("origin", ORIGIN)]
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            test.request(
                "POST",
                &account_path,
                account,
                &[("origin", ORIGIN), ("cookie", cookie.as_str())]
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let staff_path = format!("/api/pentests/{}/authorize-owned-test", Uuid::new_v4());
        let grant = json!({"scope_sha256":"a".repeat(64),"note":"member cannot grant permission"});
        assert_eq!(
            test.request("POST", &staff_path, grant.clone(), &headers)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        let (admin_cookie, _) = test.login("admin").await;
        assert_eq!(
            test.request(
                "POST",
                &staff_path,
                grant,
                &[("cookie", &admin_cookie), ("origin", ORIGIN)]
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        test.finish().await;
    }
}

#[path = "sites/mod.rs"]
mod sites;
#[path = "sources/mod.rs"]
mod sources;

#[path = "orders/mod.rs"]
mod orders;

#[path = "review_codes/mod.rs"]
mod review_codes;

#[path = "access/mod.rs"]
mod access;

#[tokio::test]
async fn personal_audit_lists_narrow_admin_reads_without_elevating_members() {
    let seen = Arc::new(Mutex::new(Vec::<(String, String, String)>::new()));
    let captured = seen.clone();
    let downstream = Router::new().fallback(move |headers: HeaderMap, uri: axum::http::Uri| {
        let captured = captured.clone();
        async move {
            captured.lock().unwrap().push((
                uri.path().to_owned(),
                headers["x-patchriot-account"].to_str().unwrap().to_owned(),
                headers["x-patchriot-role"].to_str().unwrap().to_owned(),
            ));
            Json(json!([]))
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, downstream).await.unwrap() });
    let test = TestApp::new(&url).await;
    for role in ["admin", "member"] {
        let (cookie, session) = test.login(role).await;
        for path in [
            "/api/reviews",
            "/api/site-checks",
            "/api/sources",
            "/api/pentests",
        ] {
            for scope in ["mine", "all"] {
                let response = test
                    .request(
                        "GET",
                        &format!("{path}?scope={scope}"),
                        Value::Null,
                        &[("cookie", cookie.as_str()), ("x-patchriot-role", "admin")],
                    )
                    .await;
                assert_eq!(response.0, StatusCode::OK);
                let last = seen.lock().unwrap().last().unwrap().clone();
                assert_eq!(last.1, session["account"]["id"].as_str().unwrap());
                assert_eq!(last.2, if scope == "mine" { "member" } else { role });
            }
            let response = test
                .request(
                    "GET",
                    &format!("{path}?scope=other-account"),
                    Value::Null,
                    &[("cookie", cookie.as_str())],
                )
                .await;
            assert_eq!(response.0, StatusCode::BAD_REQUEST);
        }
    }
    for path in [
        "/api/reviews?scope=mine",
        "/api/site-checks?scope=mine",
        "/api/sources?scope=mine",
    ] {
        assert_eq!(
            test.request("GET", path, Value::Null, &[]).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    server.abort();
    test.finish().await;
}

#[tokio::test]
async fn pairing_setup_requires_staff_and_agent_metadata_requires_an_enabled_account() {
    let downstream = Router::new().fallback(|headers: HeaderMap, uri: axum::http::Uri| async move {
        assert!(headers.contains_key("authorization"));
        assert!(headers.contains_key("x-patchriot-account"));
        if uri.path() == "/internal/pairing-info" {
            Json(json!({"audience":"fixture-deployment", "private_key":"must not be forwarded"}))
        } else {
            Json(json!([{"id":Uuid::nil(),"reported_os":"linux","runtime":"hermes","runtime_version":"example","declared_model":"local","state":"online","last_seen_at":1,"operator_name":"private name","compute_group":"private hostname","task":"private customer data"}]))
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, downstream).await.unwrap() });
    let mut test = TestApp::new(&url).await;
    for path in ["/api/agents", "/api/pairing-info"] {
        assert_eq!(
            test.request("GET", path, Value::Null, &[]).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    let (member_cookie, member_session) = test.login("member").await;
    let member_headers = [
        ("cookie", member_cookie.as_str()),
        ("origin", ORIGIN),
        (
            "x-csrf-token",
            member_session["csrf_token"].as_str().unwrap(),
        ),
        ("x-patchriot-role", "admin"),
    ];
    let denied = test
        .request("GET", "/api/pairing-info", Value::Null, &member_headers)
        .await;
    assert_eq!(denied.0, StatusCode::FORBIDDEN);
    assert_eq!(denied.2, json!({"error":"public_pairing_disabled"}));
    let denied = test.request("POST", "/api/pairings/claim", json!({"user_code":"ABCD-EF01-2345","display_name":"Example operator","hosting":"own_machine","accepts_private_work_rules":true}), &member_headers).await;
    assert_eq!(denied.0, StatusCode::FORBIDDEN);
    assert_eq!(denied.2, json!({"error":"public_pairing_disabled"}));
    assert_eq!(
        test.request("GET", "/api/agents", Value::Null, &member_headers)
            .await
            .0,
        StatusCode::OK
    );
    let (cookie, session) = test.login("admin").await;
    let headers = [("cookie", cookie.as_str())];
    assert_eq!(
        test.request("GET", "/api/pairing-info", Value::Null, &headers)
            .await
            .2["error"],
        "pairing_setup_unavailable"
    );
    let config = Config::new(
        ORIGIN.into(),
        url,
        format!("test-service-{}", Uuid::new_v4()),
        None,
    )
    .unwrap()
    .with_relay_origin(Some("https://relay.example".into()))
    .unwrap();
    test.app = router(AppState::new(test.pool.clone(), config).unwrap());
    let (status, _, setup) = test
        .request("GET", "/api/pairing-info", Value::Null, &headers)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        setup,
        json!({"audience":"fixture-deployment", "relay_origin":"https://relay.example"})
    );
    let (status, _, agents) = test
        .request("GET", "/api/agents", Value::Null, &headers)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(agents[0].as_object().unwrap().len(), 10);
    assert_eq!(agents[0]["live_tools"], json!([]));
    assert_eq!(agents[0]["reports_received"], 0);
    for private in ["operator_name", "compute_group", "task"] {
        assert!(agents[0].get(private).is_none());
    }
    let account: Uuid = serde_json::from_value(session["account"]["id"].clone()).unwrap();
    disable_account(&test.pool, account).await.unwrap();
    for path in ["/api/agents", "/api/pairing-info"] {
        assert_eq!(
            test.request("GET", path, Value::Null, &headers).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    server.abort();
    test.finish().await;
}

struct TestApp {
    app: Router,
    pool: PgPool,
    admin_pool: PgPool,
    schema: String,
}

impl TestApp {
    async fn new(dispatcher: &str) -> Self {
        Self::with_access(
            dispatcher,
            patchriot_core::payments::access::ReviewAccess::FreePilot,
        )
        .await
    }

    async fn with_access(
        dispatcher: &str,
        access: patchriot_core::payments::access::ReviewAccess,
    ) -> Self {
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
        let app = router(
            AppState::new(pool.clone(), config)
                .unwrap()
                .with_review_access(access),
        );
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
async fn incident_catalogue_preserves_full_research_and_validates_nested_fields() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let (cookie, session) = test.login("admin").await;
    let headers = [
        ("cookie", cookie.as_str()),
        ("origin", ORIGIN),
        ("x-csrf-token", session["csrf_token"].as_str().unwrap()),
    ];
    let mut content = incident_content("Detailed public research");
    content["catalogue"] = json!({
        "short_name": "Example dependency", "qualifying": "January 1, 2025 disclosure",
        "category": "Published advisory", "fix": "Apply the vendor update.",
        "report": {"label": "Research source", "url": "https://example.com/research"},
        "sections": [{"label": "Impact and limits", "body": "Potential exposure is not a confirmed infection count."}]
    });
    let path = format!("/api/admin/incidents/{}", Uuid::new_v4());
    let (status, _, _) = test
        .request(
            "POST",
            &path,
            json!({"action":"save", "revision":0, "content":content}),
            &headers,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = test
        .request(
            "POST",
            &path,
            json!({"action":"publish", "revision":1, "sources_reviewed":true}),
            &headers,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, _, published) = test
        .request("GET", "/api/incidents", Value::Null, &[])
        .await;
    assert_eq!(published[0]["content"], content);

    let mut bad_url = content.clone();
    bad_url["catalogue"]["report"]["url"] = json!("javascript:alert(1)");
    let mut long_body = content.clone();
    long_body["catalogue"]["sections"][0]["body"] = json!("x".repeat(1601));
    let mut too_many = content.clone();
    too_many["catalogue"]["sections"] = json!(vec![content["catalogue"]["sections"][0].clone(); 9]);
    let mut empty = content.clone();
    empty["catalogue"]["short_name"] = json!(" ");
    for invalid in [bad_url, long_body, too_many, empty] {
        let (status, _, _) = test
            .request(
                "POST",
                &format!("/api/admin/incidents/{}", Uuid::new_v4()),
                json!({"action":"save", "revision":0, "content":invalid}),
                &headers,
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let (_, _, after) = test
        .request("GET", "/api/incidents", Value::Null, &[])
        .await;
    assert_eq!(after, published);
    test.finish().await;
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
                let operator = headers["x-patchriot-account"].to_str().unwrap().to_owned();
                capture.lock().unwrap().push(headers);
                let device = json!({"id":Uuid::new_v4(),"operator_id":operator,"operator_name":"Owned test operator","label":"Report counter","runtime":"owned_fixture","runtime_version":"0.0.1","declared_model":null,"compute_group":"owned-test","approval":"approved","state":"online","last_seen_at":null,"sequence":1,"reports_received":4});
                let mut older = device.clone();
                older["id"] = json!(Uuid::new_v4());
                older.as_object_mut().unwrap().remove("reports_received");
                Json(json!([device, older]))
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
        assert_eq!(response.2[0]["reports_received"], 4);
        assert!(response.2[1].get("reports_received").is_none());
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
        assert!(
            Config::new(
                ORIGIN.into(),
                "http://127.0.0.1:7411".into(),
                key.clone(),
                None
            )
            .unwrap()
            .with_relay_origin(Some(bad.into()))
            .is_err()
        );
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

#[test]
fn railway_private_http_is_only_allowed_for_the_configured_dispatcher() {
    let key = format!("test-service-{}", Uuid::new_v4());
    let private = "http://dispatcher.railway.internal:7411";
    let config = Config::new(ORIGIN.into(), private.into(), key.clone(), None).unwrap();
    assert_eq!(config.dispatcher_url, private);
    assert!(config.with_relay_origin(Some(private.into())).is_err());
    assert!(Config::new(private.into(), private.into(), key.clone(), None).is_err());
    for bad in [
        "http://railway.internal",
        "http://dispatcher.railway.internal.evil.example",
        "http://dispatcher.railway.internal/path",
        "http://key@dispatcher.railway.internal",
        "http://dispatcher.railway.internal?token=secret",
        "http://other.internal",
        "http://-bad.railway.internal",
        "http://a.b.railway.internal",
    ] {
        assert!(
            Config::new(ORIGIN.into(), bad.into(), key.clone(), None).is_err(),
            "{bad}"
        );
    }
}

#[tokio::test]
async fn pairing_recovery_errors_are_specific_without_forwarding_private_dispatcher_text() {
    let payload = Arc::new(Mutex::new((
        StatusCode::CONFLICT,
        json!({"error":"pairing_expired"}),
    )));
    let reply = payload.clone();
    let downstream = Router::new().fallback(move || {
        let (status, body) = reply.lock().unwrap().clone();
        async move { (status, Json(body)) }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, downstream).await.unwrap() });
    let test = TestApp::new(&url).await;
    let (cookie, session) = test.login("admin").await;
    let headers = [
        ("cookie", cookie.as_str()),
        ("origin", ORIGIN),
        ("x-csrf-token", session["csrf_token"].as_str().unwrap()),
    ];
    let claim = json!({"user_code":"ABCD-EF01-2345","display_name":"Example operator","hosting":"own_machine","accepts_private_work_rules":true});
    let mut results = Vec::new();
    for (status, body, expected) in [
        (
            StatusCode::CONFLICT,
            json!({"error":"pairing_expired"}),
            "pairing_expired",
        ),
        (
            StatusCode::CONFLICT,
            json!({"error":"pairing_already_claimed"}),
            "pairing_already_claimed",
        ),
        (
            StatusCode::NOT_FOUND,
            json!({"error":"private database detail"}),
            "pairing_code_unavailable",
        ),
        (
            StatusCode::CONFLICT,
            json!({"error":"private operator detail"}),
            "request_conflict",
        ),
        (
            StatusCode::CONFLICT,
            json!({"error":"pairing_expired","private":"x".repeat(2048)}),
            "request_conflict",
        ),
        (
            StatusCode::CONFLICT,
            json!("not an error object"),
            "request_conflict",
        ),
        (
            StatusCode::FORBIDDEN,
            json!({"error":"pairing_expired"}),
            "action_not_allowed",
        ),
    ] {
        *payload.lock().unwrap() = (status, body);
        let result = test
            .request("POST", "/api/pairings/claim", claim.clone(), &headers)
            .await;
        results.push((status, expected, result));
    }
    *payload.lock().unwrap() = (StatusCode::CONFLICT, json!({"error":"pairing_expired"}));
    let unrelated = test
        .request(
            "GET",
            &format!("/api/reviews/{}", Uuid::new_v4()),
            Value::Null,
            &headers,
        )
        .await;
    test.finish().await;
    server.abort();
    let _ = server.await;
    for (status, expected, result) in results {
        assert_eq!(result.0, status);
        assert_eq!(result.2, json!({"error":expected}));
    }
    assert_eq!(unrelated.0, StatusCode::CONFLICT);
    assert_eq!(unrelated.2, json!({"error":"request_conflict"}));
}

#[tokio::test]
async fn bounded_fleet_and_review_lists_fit_the_gateway_even_with_escaped_labels() {
    use patchriot_protocol::website_reviews::ReviewPrice;
    use patchriot_protocol::{DeviceIntroduction, DeviceView, ReviewView, RuntimeKind};

    // These are permitted byte lengths, including characters that JSON must
    // escape. A bounded number of rows can still exceed the detail-body limit.
    let intro = DeviceIntroduction {
        label: "\"".repeat(80),
        runtime: RuntimeKind::Hermes,
        runtime_version: "\"".repeat(80),
        declared_model: Some("\"".repeat(160)),
        reported_os: None,
        compute_group: "\"".repeat(80),
        slots: 1,
    };
    intro.validate().unwrap();
    let operator = Uuid::new_v4();
    let devices: Vec<DeviceView> = (0..200)
        .map(|_| DeviceView {
            system: None,
            id: Uuid::new_v4(),
            operator_id: operator,
            operator_name: "\"".repeat(80),
            label: intro.label.clone(),
            runtime: intro.runtime,
            runtime_version: intro.runtime_version.clone(),
            declared_model: intro.declared_model.clone(),
            reported_os: None,
            compute_group: intro.compute_group.clone(),
            approval: "approved".into(),
            private_work_approved: true,
            website_reviews: true,
            live_tests: false,
            state: "online".into(),
            last_seen_at: Some(1_793_513_000),
            sequence: 1,
            reports_received: Some(0),
        })
        .collect();
    let reviewers: Vec<Value> = devices[..3].iter().map(|device| json!({
        "device_id":device.id,"operator_id":device.operator_id,"operator_name":device.operator_name,
        "device_name":device.label,"declared_model":device.declared_model,"compute_group":device.compute_group,
    })).collect();
    let price = ReviewPrice {
        asset: "\"".repeat(256),
        amount: i64::MAX.to_string(),
    };
    assert!(price.valid());
    let reviews: Vec<ReviewView> = (0..50).map(|_| {
        let steps: Vec<_> = ["investigator", "reproducer", "challenger"].iter().enumerate().map(|(i, role)| json!({
            "role":role,"state":"completed","attempts":3,"device_id":devices[i].id,"operator_id":operator,
            "compute_group":intro.compute_group,"result":null,"fixture_matches":false,"evidence_complete":false,
        })).collect();
        serde_json::from_value(json!({
            "id":Uuid::new_v4(),"request_id":Uuid::new_v4(),"scenario":"website_snapshot_v1",
            "mode":"website_agent","state":"needs_review","created_at":1_793_513_000,"deadline_at":1_793_518_700,
            "evidence_source":"operator_reported_static_website_review_not_a_safety_verdict","steps":steps,
            "website":{"site_check_id":Uuid::new_v4(),"snapshot_sha256":"a".repeat(64),"reviewers":reviewers},
            "payment":{"price":price,"expires_at":1_793_513_300,"invoice_id":Uuid::new_v4(),"funded_at":1_793_513_100},
        })).unwrap()
    }).collect();
    let lists = [
        ("/api/devices", serde_json::to_value(devices).unwrap()),
        ("/api/reviews", serde_json::to_value(reviews).unwrap()),
    ];
    for (path, value) in &lists {
        let bytes = serde_json::to_vec(value).unwrap().len();
        assert!(
            bytes > 256 * 1024 && bytes < 512 * 1024,
            "{path}: {bytes} bytes"
        );
    }
    let payload = Arc::new(Mutex::new(Value::Null));
    let reply = payload.clone();
    let downstream = Router::new().fallback(get(move || {
        let value = reply.lock().unwrap().clone();
        async move { Json(value) }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, downstream).await.unwrap() });
    let test = TestApp::new(&url).await;
    let (cookie, _) = test.login("admin").await;
    let mut observations = Vec::new();
    for (path, expected) in &lists {
        *payload.lock().unwrap() = expected.clone();
        let denied = test.request("GET", path, Value::Null, &[]).await;
        let accepted = test
            .request("GET", path, Value::Null, &[("cookie", &cookie)])
            .await;
        *payload.lock().unwrap() = json!("x".repeat(512 * 1024));
        let oversized = test
            .request("GET", path, Value::Null, &[("cookie", &cookie)])
            .await;
        observations.push((path, expected, denied, accepted, oversized));
    }
    *payload.lock().unwrap() = json!("x".repeat(patchriot_protocol::pentests::MAX_REVIEW_BYTES));
    let detail = test
        .request(
            "GET",
            &format!("/api/reviews/{}", Uuid::new_v4()),
            Value::Null,
            &[("cookie", &cookie)],
        )
        .await;
    test.finish().await;
    server.abort();
    let _ = server.await;
    for (path, expected, denied, accepted, oversized) in observations {
        assert_eq!(denied.0, StatusCode::UNAUTHORIZED, "{path}");
        assert_eq!(accepted.0, StatusCode::OK, "{path}: {}", accepted.2);
        assert_eq!(&accepted.2, expected, "{path}");
        assert_eq!(oversized.0, StatusCode::BAD_GATEWAY, "{path}");
        assert_eq!(
            oversized.2["error"], "dispatcher_response_too_large",
            "{path}"
        );
    }
    assert_eq!(detail.0, StatusCode::BAD_GATEWAY);
    assert_eq!(detail.2["error"], "dispatcher_response_too_large");
}

#[tokio::test]
async fn large_private_report_survives_detail_export_and_cancellation() {
    use patchriot_protocol::pentests::{MAX_RESULT_BYTES, MAX_REVIEW_BYTES};
    let id = Uuid::new_v4();
    let result = json!({"kind":"pentest_agent_v1","scope_sha256":"a".repeat(64),
        "execution":{"state":"completed","provider":"abliteration.ai","model":"abliterated-model-large-v2","image_digest":"owned-fixture","duration_ms":1,"inference_calls":1,"http_requests":1,"cost_upper_microusd":1,"cleanup_confirmed":true},
        "assessment":null,"evidence":[{"id":1,"method":"GET","url":"https://owned.example/","request_headers":{},"status":200,"headers":{},"body_excerpt":"x".repeat(MAX_RESULT_BYTES-4096),"truncated":true,"error":null,"observed_at":1}],"raw_summary":""});
    let expected: patchriot_protocol::ReviewView = serde_json::from_value(json!({
        "id":id,"request_id":Uuid::new_v4(),"scenario":"live_http_v1","mode":"pentest_agent",
        "state":"needs_review","created_at":1,"deadline_at":2,"evidence_source":"owned fixture",
        "steps":(["investigator","reproducer","challenger"].iter().map(|role|json!({"role":role,"state":"completed","attempts":1,"device_id":null,"operator_id":null,"compute_group":null,"result":result,"fixture_matches":null})).collect::<Vec<_>>())
    })).unwrap();
    let expected = serde_json::to_value(expected).unwrap();
    let length = serde_json::to_vec(&expected).unwrap().len();
    assert!(length > 3 * MAX_RESULT_BYTES - 16384 && length < MAX_REVIEW_BYTES);
    let reply = expected.clone();
    let downstream = Router::new().fallback(move || {
        let value = reply.clone();
        async move { Json(value) }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, downstream).await.unwrap() });
    let test = TestApp::new(&url).await;
    let (cookie, session) = test.login("member").await;
    let headers = [
        ("cookie", cookie.as_str()),
        ("origin", ORIGIN),
        ("x-csrf-token", session["csrf_token"].as_str().unwrap()),
    ];
    for (method, suffix) in [("GET", ""), ("POST", "/report"), ("POST", "/cancel")] {
        let path = format!("/api/reviews/{id}{suffix}");
        assert_eq!(
            test.request(method, &path, json!({}), &[("origin", ORIGIN)])
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        let response = test.request(method, &path, json!({}), &headers).await;
        assert_eq!(response.0, StatusCode::OK, "{}", response.2);
        assert_eq!(response.2, expected);
    }
    assert_eq!(
        test.request(
            "GET",
            &format!("/api/reviews/{id}/report"),
            json!({}),
            &headers
        )
        .await
        .0,
        StatusCode::METHOD_NOT_ALLOWED
    );
    assert_eq!(
        test.request(
            "POST",
            &format!("/api/reviews/{id}/report"),
            json!({}),
            &[("cookie", &cookie), ("origin", ORIGIN)]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    test.finish().await;
    server.abort();
    let _ = server.await;
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

#[tokio::test]
async fn enterprise_inquiries_are_private_retry_safe_and_do_not_grant_access() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let body = json!({"request_id":Uuid::new_v4(),"name":"Example owner","email":"Owner@EXAMPLE.com","organization":"Owned example","message":"Please discuss a private network for our staging systems."});
    let id = body["request_id"].as_str().unwrap();
    assert_eq!(
        test.request("POST", "/api/contact", body.clone(), &[])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    for _ in 0..2 {
        let (status, _, saved) = test
            .request("POST", "/api/contact", body.clone(), &[("origin", ORIGIN)])
            .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(saved, json!({"received":true}));
    }
    let mut altered = body.clone();
    altered["message"] = json!("This different message must not overwrite the original.");
    assert_eq!(
        test.request("POST", "/api/contact", altered, &[("origin", ORIGIN)])
            .await
            .0,
        StatusCode::CONFLICT
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM enterprise_inquiries")
        .fetch_one(&test.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let accounts: i64 = sqlx::query_scalar("SELECT count(*) FROM accounts")
        .fetch_one(&test.pool)
        .await
        .unwrap();
    assert_eq!(accounts, 0);
    assert_eq!(
        test.request("GET", "/api/admin/inquiries", Value::Null, &[])
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        test.request("GET", "/api/contact", Value::Null, &[])
            .await
            .2,
        json!({"email":null})
    );
    let (member, ms) = test.login("member").await;
    let member_headers = [
        ("cookie", member.as_str()),
        ("origin", ORIGIN),
        ("x-csrf-token", ms["csrf_token"].as_str().unwrap()),
        ("x-patchriot-role", "admin"),
    ];
    assert_eq!(
        test.request("GET", "/api/admin/inquiries", Value::Null, &member_headers)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let path = format!("/api/admin/inquiries/{id}");
    assert_eq!(
        test.request("POST", &path, json!({"handled":true}), &member_headers)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (admin, session) = test.login("admin").await;
    assert_eq!(
        test.request(
            "POST",
            &path,
            json!({"handled":true}),
            &[("cookie", admin.as_str()), ("origin", ORIGIN)]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let headers = [
        ("cookie", admin.as_str()),
        ("origin", ORIGIN),
        ("x-csrf-token", session["csrf_token"].as_str().unwrap()),
    ];
    let inbox = test
        .request("GET", "/api/admin/inquiries", Value::Null, &headers)
        .await;
    assert_eq!(inbox.0, StatusCode::OK);
    assert_eq!(inbox.2[0]["email"], "owner@example.com");
    assert_eq!(inbox.2[0]["message"], body["message"]);
    for handled in [true, true, false] {
        assert_eq!(
            test.request("POST", &path, json!({"handled":handled}), &headers)
                .await
                .0,
            StatusCode::OK
        );
        let state: String =
            sqlx::query_scalar("SELECT state FROM enterprise_inquiries WHERE id=$1")
                .bind(Uuid::parse_str(id).unwrap())
                .fetch_one(&test.pool)
                .await
                .unwrap();
        assert_eq!(state, if handled { "handled" } else { "open" });
    }
    let actor: Uuid = sqlx::query_scalar("SELECT updated_by FROM enterprise_inquiries WHERE id=$1")
        .bind(Uuid::parse_str(id).unwrap())
        .fetch_one(&test.pool)
        .await
        .unwrap();
    assert_eq!(
        actor.to_string(),
        session["account"]["id"].as_str().unwrap()
    );
    test.finish().await;
}

#[tokio::test]
async fn enterprise_inquiry_validation_and_rate_limits_are_separate_from_login() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let body = json!({"request_id":Uuid::new_v4(),"name":"Owner","email":"owner@example.com","organization":"Example","message":"We need a private network for owned infrastructure."});
    for (key, value) in [
        ("name", json!("line\nbreak")),
        ("message", json!("tiny")),
        ("email", json!("broken")),
        ("organization", json!("")),
    ] {
        let mut bad = body.clone();
        bad[key] = value;
        assert_eq!(
            test.request("POST", "/api/contact", bad, &[("origin", ORIGIN)])
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        sqlx::query("DELETE FROM auth_attempts")
            .execute(&test.pool)
            .await
            .unwrap();
    }
    for i in 0..4 {
        let mut body = body.clone();
        body["request_id"] = json!(Uuid::new_v4());
        let headers = [
            ("origin", ORIGIN),
            (
                "x-forwarded-for",
                if i % 2 == 0 { "1.1.1.1" } else { "8.8.8.8" },
            ),
        ];
        let status = test.request("POST", "/api/contact", body, &headers).await.0;
        assert_eq!(
            status,
            if i < 3 {
                StatusCode::ACCEPTED
            } else {
                StatusCode::TOO_MANY_REQUESTS
            }
        );
    }
    let _ = test.login("member").await; // Contact spam cannot consume the sign-in budget.
    let raw: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM auth_attempts WHERE key LIKE '%owner%' OR key LIKE '%peer%')",
    )
    .fetch_one(&test.pool)
    .await
    .unwrap();
    assert!(!raw);
    test.finish().await;
}

#[test]
fn public_contact_address_is_explicit_and_validated() {
    let config = || {
        Config::new(
            ORIGIN.into(),
            "http://127.0.0.1:1".into(),
            "x".repeat(40),
            None,
        )
        .unwrap()
    };
    assert!(
        config()
            .with_contact_email(Some("not-an-address".into()))
            .is_err()
    );
    assert_eq!(
        config()
            .with_contact_email(Some("Contact@EXAMPLE.com".into()))
            .unwrap()
            .contact_email
            .as_deref(),
        Some("contact@example.com")
    );
}
