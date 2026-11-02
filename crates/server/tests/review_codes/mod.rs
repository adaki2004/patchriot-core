use super::*;
use axum::{extract::Path, routing::post};
use patchriot_core::{
    payments::access::ReviewAccess,
    review_codes::{issue, revoke},
};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, Ordering},
};

struct Network {
    origin: String,
    calls: Arc<Mutex<Vec<(Uuid, Uuid, Value)>>>,
    reviews: Arc<Mutex<HashMap<(Uuid, Uuid), Value>>>,
    lose_reply: Arc<AtomicBool>,
    wrong_binding: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Network {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Network {
    async fn new() -> Self {
        Self::for_source(false).await
    }
    async fn for_source(source: bool) -> Self {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let reviews = Arc::new(Mutex::new(HashMap::new()));
        let lose_reply = Arc::new(AtomicBool::new(false));
        let wrong_binding = Arc::new(AtomicBool::new(false));
        let (seen, saved, lost, wrong) = (
            calls.clone(),
            reviews.clone(),
            lose_reply.clone(),
            wrong_binding.clone(),
        );
        let app = Router::new().route(if source { "/internal/sources/{id}/review" } else { "/internal/site-checks/{id}/review" }, post(move |Path(site):Path<Uuid>, headers:HeaderMap, Json(body):Json<Value>| {
            let (seen,saved,lost,wrong)=(seen.clone(),saved.clone(),lost.clone(),wrong.clone());
            async move {
                assert_eq!(headers["x-patchriot-role"],"member");
                assert!(headers["authorization"].to_str().unwrap().starts_with("Bearer test-service-"));
                assert!(headers.get("cookie").is_none());
                let account=Uuid::parse_str(headers["x-patchriot-account"].to_str().unwrap()).unwrap();
                let request=Uuid::parse_str(body["request_id"].as_str().unwrap()).unwrap();
                seen.lock().unwrap().push((account,site,body.clone()));
                tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                let mut reply=saved.lock().unwrap().entry((account,request)).or_insert_with(|| json!({
                    "id":Uuid::new_v4(),"request_id":request,"scenario":"website_snapshot_v1","mode":"website_agent","state":"queued",
                    "created_at":chrono::Utc::now().timestamp(),"deadline_at":chrono::Utc::now().timestamp()+2100,"evidence_source":"test fixture, not a model run","steps":[],
                    "website":{"site_check_id":site,"snapshot_sha256":body["snapshot_sha256"],"reviewers":body["device_ids"].as_array().unwrap().iter().map(|device|json!({"device_id":device,"operator_id":Uuid::new_v4(),"operator_name":"Example operator","device_name":"Example device","declared_model":"fixture","compute_group":"fixture"})).collect::<Vec<_>>()}
                })).clone();
                if source {
                    reply["scenario"]=json!("source_bundle_v1"); reply["mode"]=json!("source_agent");
                    let mut context=reply.as_object_mut().unwrap().remove("website").unwrap();
                    context.as_object_mut().unwrap().remove("site_check_id");context["source_id"]=json!(site);reply["source"]=context;
                }
                if lost.swap(false,Ordering::SeqCst) { return (StatusCode::SERVICE_UNAVAILABLE,Json(json!({"error":"reply_lost_after_creation"}))); }
                if wrong.load(Ordering::SeqCst) { reply[if source {"source"} else {"website"}]["snapshot_sha256"]=json!("b".repeat(64)); }
                (StatusCode::OK,Json(reply))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            origin,
            calls,
            reviews,
            lose_reply,
            wrong_binding,
            task,
        }
    }
}

fn consent() -> Value {
    json!({"request_id":Uuid::new_v4(),"snapshot_sha256":"a".repeat(64),"device_ids":[Uuid::new_v4(),Uuid::new_v4(),Uuid::new_v4()],"accepts_operator_access":true})
}

fn headers<'a>(cookie: &'a str, session: &'a Value) -> [(&'a str, &'a str); 4] {
    [
        ("cookie", cookie),
        ("origin", ORIGIN),
        ("x-csrf-token", session["csrf_token"].as_str().unwrap()),
        ("x-patchriot-role", "admin"),
    ]
}

fn paid() -> ReviewAccess {
    ReviewAccess::configured("paid",Some(br#"{"destination":{"asset_id":"nep141:fixture.usdc","symbol":"USDC","decimals":6,"blockchain":"near"},"amount":"10000000","recipient":"treasury.fixture.near","recipient_type":"INTENTS","inputs":[{"asset_id":"nep141:fixture.usdc","symbol":"USDC","decimals":6,"blockchain":"near"}]}"#),Some("fixture-provider-key")).unwrap()
}

#[tokio::test]
async fn one_code_cannot_sponsor_two_accounts_or_changed_work() {
    let network = Network::new().await;
    let test = TestApp::with_access(&network.origin, ReviewAccess::Coupons).await;
    let issued = issue(&test.pool, "Invited tester").await.unwrap();
    let (a_cookie, a_session) = test.login("member").await;
    let (b_cookie, b_session) = test.login("admin").await;
    let site = Uuid::new_v4();
    let path = format!("/api/site-checks/{site}/review-code");
    let body = json!({"code":issued.code,"consent":consent()});
    let (ha, hb) = (
        headers(&a_cookie, &a_session),
        headers(&b_cookie, &b_session),
    );
    let (a, b) = tokio::join!(
        test.request("POST", &path, body.clone(), &ha),
        test.request("POST", &path, body.clone(), &hb)
    );
    assert_eq!(
        [a.0, b.0].iter().filter(|s| **s == StatusCode::OK).count(),
        1
    );
    assert_eq!(
        [a.0, b.0]
            .iter()
            .filter(|s| **s == StatusCode::BAD_REQUEST)
            .count(),
        1
    );
    let (cookie, session, reply, other_cookie, other_session) = if a.0 == StatusCode::OK {
        (&a_cookie, &a_session, a.2, &b_cookie, &b_session)
    } else {
        (&b_cookie, &b_session, b.2, &a_cookie, &a_session)
    };
    assert_eq!(network.calls.lock().unwrap().len(), 1);
    assert_eq!(network.reviews.lock().unwrap().len(), 1);
    let again = test
        .request("POST", &path, body.clone(), &headers(cookie, session))
        .await;
    assert_eq!(again.0, StatusCode::OK);
    assert_eq!(again.2, reply);
    assert_eq!(
        network.calls.lock().unwrap().len(),
        1,
        "recorded success is read without dispatching again"
    );
    let mut changed = body.clone();
    changed["consent"]["request_id"] = json!(Uuid::new_v4());
    assert_eq!(
        test.request("POST", &path, changed, &headers(cookie, session))
            .await
            .2["error"],
        "review_code_bound"
    );
    assert_eq!(
        test.request(
            "POST",
            &format!("/api/site-checks/{}/review-code", Uuid::new_v4()),
            body.clone(),
            &headers(cookie, session)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let history = test
        .request(
            "GET",
            "/api/review-codes",
            Value::Null,
            &headers(cookie, session),
        )
        .await
        .2;
    assert_eq!(history[0]["review_id"], reply["review_id"]);
    assert_eq!(history[0]["consent"], body["consent"]);
    assert!(!history.to_string().contains(&issued.code));
    assert!(history[0].get("code_hash").is_none());
    assert_eq!(
        test.request(
            "GET",
            "/api/review-codes",
            Value::Null,
            &headers(other_cookie, other_session)
        )
        .await
        .2,
        json!([])
    );
    assert_eq!(
        test.request(
            "POST",
            &format!("/api/review-codes/{}/resume", issued.id),
            json!({}),
            &headers(other_cookie, other_session)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let stored: String = sqlx::query_scalar("SELECT code_hash FROM review_codes WHERE id=$1")
        .bind(issued.id)
        .fetch_one(&test.pool)
        .await
        .unwrap();
    assert_ne!(stored, issued.code);
    assert_eq!(stored.len(), 64);
    let money:i64=sqlx::query_scalar("SELECT (SELECT count(*) FROM payment_invoices) + (SELECT count(*) FROM payment_ledger) + (SELECT count(*) FROM payment_funding_events)").fetch_one(&test.pool).await.unwrap();
    assert_eq!(money, 0, "sponsorship must not manufacture a payment");
    assert!(!revoke(&test.pool, issued.id).await.unwrap());
    test.finish().await;
}

#[tokio::test]
async fn lost_reply_resumes_the_saved_review_without_the_secret_code() {
    let network = Network::new().await;
    network.lose_reply.store(true, Ordering::SeqCst);
    let test = TestApp::with_access(&network.origin, ReviewAccess::Coupons).await;
    let (cookie, session) = test.login("member").await;
    let h = headers(&cookie, &session);
    let issued = issue(&test.pool, "Reply recovery").await.unwrap();
    let site = Uuid::new_v4();
    let selected = consent();
    let path = format!("/api/site-checks/{site}/review-code");
    let response = test
        .request(
            "POST",
            &path,
            json!({"code":issued.code,"consent":selected}),
            &h,
        )
        .await;
    assert_eq!(response.0, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(network.reviews.lock().unwrap().len(), 1);
    let history = test
        .request("GET", "/api/review-codes", Value::Null, &h)
        .await
        .2;
    assert_eq!(history[0]["review_id"], Value::Null);
    assert_eq!(history[0]["consent"], selected);
    assert_eq!(history[0]["last_error"], "dispatcher_unavailable");
    let resume = format!("/api/review-codes/{}/resume", issued.id);
    assert_eq!(
        test.request("POST", &resume, json!({"consent":consent()}), &h)
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let response = test.request("POST", &resume, json!({}), &h).await;
    assert_eq!(response.0, StatusCode::OK, "{}", response.2);
    assert_eq!(network.reviews.lock().unwrap().len(), 1);
    {
        let calls = network.calls.lock().unwrap();
        assert_eq!(calls[0], calls[1]);
    }
    assert_eq!(response.2["request_id"], selected["request_id"]);
    assert_ne!(response.2["review_id"], selected["request_id"]);
    test.finish().await;
}

#[tokio::test]
async fn modes_and_session_checks_cannot_be_bypassed_with_a_code() {
    let network = Network::new().await;
    for access in [
        ReviewAccess::FreePilot,
        ReviewAccess::Closed,
        ReviewAccess::Coupons,
        paid(),
    ] {
        let allowed = matches!(access, ReviewAccess::Coupons | ReviewAccess::Paid(_));
        let coupons = matches!(access, ReviewAccess::Coupons);
        let test = TestApp::with_access(&network.origin, access).await;
        let (cookie, session) = test.login("member").await;
        let h = headers(&cookie, &session);
        let issued = issue(&test.pool, "Mode test").await.unwrap();
        let site = Uuid::new_v4();
        let path = format!("/api/site-checks/{site}/review-code");
        let selected = consent();
        let body = json!({"code":issued.code,"consent":selected});
        assert_eq!(
            test.request("POST", &path, body.clone(), &[("origin", ORIGIN)])
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            test.request(
                "POST",
                &path,
                body.clone(),
                &[("origin", ORIGIN), ("cookie", &cookie)]
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        if coupons {
            assert_eq!(
                test.request("GET", "/api/checkout", Value::Null, &h)
                    .await
                    .2,
                json!({"mode":"coupons","offer":null})
            );
            assert_eq!(
                test.request(
                    "POST",
                    &format!("/api/site-checks/{site}/review"),
                    selected,
                    &h
                )
                .await
                .2["error"],
                "review_code_required"
            );
        }
        let mut malformed = body.clone();
        malformed["consent"]["accepts_operator_access"] = json!(false);
        assert_eq!(
            test.request("POST", &path, malformed, &h).await.0,
            if allowed {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            }
        );
        let owner: Option<Uuid> =
            sqlx::query_scalar("SELECT account_id FROM review_codes WHERE id=$1")
                .bind(issued.id)
                .fetch_one(&test.pool)
                .await
                .unwrap();
        assert!(owner.is_none());
        let response = test.request("POST", &path, body, &h).await;
        assert_eq!(
            response.0,
            if allowed {
                StatusCode::OK
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            },
            "{}",
            response.2
        );
        test.finish().await;
    }
}

#[tokio::test]
async fn expiry_revocation_and_failed_guesses_are_enforced() {
    let network = Network::new().await;
    let test = TestApp::with_access(&network.origin, ReviewAccess::Coupons).await;
    let (cookie, session) = test.login("member").await;
    let h = headers(&cookie, &session);
    let site = Uuid::new_v4();
    let path = format!("/api/site-checks/{site}/review-code");
    let expired = issue(&test.pool, "Expired").await.unwrap();
    sqlx::query("UPDATE review_codes SET expires_at=now()-interval '1 second' WHERE id=$1")
        .bind(expired.id)
        .execute(&test.pool)
        .await
        .unwrap();
    let revoked = issue(&test.pool, "Revoked").await.unwrap();
    assert!(revoke(&test.pool, revoked.id).await.unwrap());
    for code in [expired.code, revoked.code] {
        assert_eq!(
            test.request("POST", &path, json!({"code":code,"consent":consent()}), &h)
                .await
                .2["error"],
            "invalid_or_used_review_code"
        );
    }
    for _ in 2..20 {
        assert_eq!(
            test.request(
                "POST",
                &path,
                json!({"code":"invalid","consent":consent()}),
                &h
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let issued = issue(&test.pool, "After cooldown").await.unwrap();
    let body = json!({"code":issued.code,"consent":consent()});
    assert_eq!(
        test.request("POST", &path, body.clone(), &h).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert!(network.calls.lock().unwrap().is_empty());
    sqlx::query("UPDATE review_code_attempts SET started_at=now()-interval '16 minutes'")
        .execute(&test.pool)
        .await
        .unwrap();
    assert_eq!(
        test.request("POST", &path, body, &h).await.0,
        StatusCode::OK
    );
    test.finish().await;
}

#[tokio::test]
async fn invalid_dispatcher_binding_and_abandoned_claims_never_grant_new_work() {
    let network = Network::new().await;
    network.wrong_binding.store(true, Ordering::SeqCst);
    let test = TestApp::with_access(&network.origin, ReviewAccess::Coupons).await;
    let (cookie, session) = test.login("member").await;
    let h = headers(&cookie, &session);
    let issued = issue(&test.pool, "Bound reply").await.unwrap();
    let site = Uuid::new_v4();
    let result = test
        .request(
            "POST",
            &format!("/api/site-checks/{site}/review-code"),
            json!({"code":issued.code,"consent":consent()}),
            &h,
        )
        .await;
    assert_eq!(result.0, StatusCode::BAD_GATEWAY);
    let resume = format!("/api/review-codes/{}/resume", issued.id);
    sqlx::query("UPDATE review_codes SET operation_token=$2,operation_until=now()+interval '30 seconds' WHERE id=$1").bind(issued.id).bind(Uuid::new_v4()).execute(&test.pool).await.unwrap();
    assert_eq!(
        test.request("POST", &resume, json!({}), &h).await.2["error"],
        "review_code_preparing"
    );
    assert_eq!(network.calls.lock().unwrap().len(), 1);
    sqlx::query("UPDATE review_codes SET operation_until=now()-interval '1 second' WHERE id=$1")
        .bind(issued.id)
        .execute(&test.pool)
        .await
        .unwrap();
    network.wrong_binding.store(false, Ordering::SeqCst);
    assert_eq!(
        test.request("POST", &resume, json!({}), &h).await.0,
        StatusCode::OK
    );
    assert_eq!(network.reviews.lock().unwrap().len(), 1);
    let account = Uuid::parse_str(session["account"]["id"].as_str().unwrap()).unwrap();
    disable_account(&test.pool, account).await.unwrap();
    assert_eq!(
        test.request("POST", &resume, json!({}), &h).await.0,
        StatusCode::UNAUTHORIZED
    );
    test.finish().await;
}

#[tokio::test]
async fn paid_order_request_key_cannot_be_spent_again_with_a_code() {
    let network = Network::new().await;
    let test = TestApp::with_access(&network.origin, paid()).await;
    let (cookie, session) = test.login("member").await;
    let h = headers(&cookie, &session);
    let selected = consent();
    let account = Uuid::parse_str(session["account"]["id"].as_str().unwrap()).unwrap();
    let request = Uuid::parse_str(selected["request_id"].as_str().unwrap()).unwrap();
    sqlx::query("INSERT INTO checkout_orders (id,account_id,request_id,terms,expires_at) VALUES ($1,$2,$3,'{}',now()+interval '5 minutes')")
        .bind(Uuid::new_v4()).bind(account).bind(request).execute(&test.pool).await.unwrap();
    let issued = issue(&test.pool, "Collision").await.unwrap();
    assert_eq!(
        test.request(
            "POST",
            &format!("/api/site-checks/{}/review-code", Uuid::new_v4()),
            json!({"code":issued.code,"consent":selected}),
            &h
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let bound: bool =
        sqlx::query_scalar("SELECT account_id IS NOT NULL FROM review_codes WHERE id=$1")
            .bind(issued.id)
            .fetch_one(&test.pool)
            .await
            .unwrap();
    assert!(!bound);
    assert!(network.calls.lock().unwrap().is_empty());
    test.finish().await;
}

#[tokio::test]
async fn source_coupon_retries_keep_kind_owner_and_material_without_reusing_a_website_reservation()
{
    let network = Network::for_source(true).await;
    let test = TestApp::with_access(&network.origin, ReviewAccess::Coupons).await;
    let issued = issue(&test.pool, "Source tester").await.unwrap();
    let (cookie, session) = test.login("member").await;
    let h = headers(&cookie, &session);
    let source = Uuid::new_v4();
    let body = json!({"code":issued.code,"consent":consent()});
    network.lose_reply.store(true, Ordering::SeqCst);
    assert_eq!(
        test.request(
            "POST",
            &format!("/api/sources/{source}/review-code"),
            body.clone(),
            &h
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let history = test
        .request("GET", "/api/review-codes", Value::Null, &h)
        .await
        .2;
    assert_eq!(history[0]["source_id"], source.to_string());
    assert!(history[0]["site_check_id"].is_null());
    let resumed = test
        .request(
            "POST",
            &format!(
                "/api/review-codes/{}/resume",
                history[0]["id"].as_str().unwrap()
            ),
            json!({}),
            &h,
        )
        .await;
    assert_eq!(resumed.0, StatusCode::OK, "{}", resumed.2);
    assert_eq!(
        test.request(
            "POST",
            &format!("/api/site-checks/{source}/review-code"),
            body.clone(),
            &h
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        test.request(
            "POST",
            &format!("/api/sources/{source}/review-code"),
            body,
            &h
        )
        .await
        .2,
        resumed.2
    );
    test.finish().await;
}
