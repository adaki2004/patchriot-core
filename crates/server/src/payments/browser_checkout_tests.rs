use super::*;
use crate::{Config, invite_account, router};
use access::*;
use axum::{
    body::Body,
    extract::Path,
    http::{HeaderMap, Request},
};
use http_body_util::BodyExt;
use std::sync::atomic::AtomicBool;
use tower::ServiceExt;

const ORIGIN: &str = "https://checkout.fixture.example";
const SERVICE_KEY: &str = "checkout-fixture-internal-service-key";

#[tokio::test]
async fn source_checkout_uses_the_same_price_but_cannot_be_rebound_to_a_website() {
    let db = TestDb::new().await;
    let network = Network::start().await;
    let policy = policy();
    let browser = Browser::new(&db, &network, network.access(&policy)).await;
    let id = Uuid::new_v4();
    let body = input(&policy);
    let (status, quote) = browser
        .call("POST", &format!("/api/sources/{id}/checkout"), body.clone())
        .await;
    assert_eq!(status, StatusCode::OK, "{quote}");
    assert_eq!(quote["output"]["amount"], policy.amount);
    assert_eq!(network.count("quote"), 1);
    let saved: Value = sqlx::query_scalar("SELECT terms FROM checkout_orders WHERE account_id=$1")
        .bind(db.account)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(saved["source_id"], id.to_string());
    assert!(saved.get("site_check_id").is_none());
    assert_eq!(
        browser
            .call("POST", &format!("/api/site-checks/{id}/checkout"), body)
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(network.count("quote"), 1);
    db.finish().await;
}

fn policy() -> CheckoutPolicy {
    CheckoutPolicy {
        destination: PaymentToken {
            asset_id: "nep141:fixture.usdc.near".into(),
            symbol: "USDC".into(),
            decimals: 6,
            blockchain: Blockchain::Near,
        },
        amount: "1000000".into(),
        recipient: "treasury.fixture.near".into(),
        recipient_type: RecipientType::Intents,
        inputs: vec![
            PaymentToken {
                asset_id: "nep141:fixture.input.near".into(),
                symbol: "NEAR".into(),
                decimals: 24,
                blockchain: Blockchain::Near,
            },
            PaymentToken {
                asset_id: "nep141:base-fixture.usdc.near".into(),
                symbol: "USDC".into(),
                decimals: 6,
                blockchain: Blockchain::Base,
            },
        ],
    }
}

fn input(policy: &CheckoutPolicy) -> Value {
    json!({"consent":{"request_id":Uuid::new_v4(),"snapshot_sha256":"a".repeat(64),"device_ids":[Uuid::new_v4(),Uuid::new_v4(),Uuid::new_v4()],"accepts_operator_access":true},"offer_id":policy.id().unwrap(),"origin_asset":policy.inputs[0].asset_id,"refund_address":"customer.fixture.near"})
}

struct Network {
    origin: String,
    calls: Arc<Mutex<Vec<(String, Value, String)>>>,
    deny_admission: Arc<AtomicBool>,
    bad_address: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Network {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Network {
    async fn start() -> Self {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let deny_admission = Arc::new(AtomicBool::new(false));
        let bad_address = Arc::new(AtomicBool::new(false));
        let (admissions, quotes, denied, bad) = (
            calls.clone(),
            calls.clone(),
            deny_admission.clone(),
            bad_address.clone(),
        );
        let app = Router::new()
            .route("/internal/{kind}/{site}/admit-review", post(move |Path((kind,site)):Path<(String,Uuid)>, headers:HeaderMap, Json(body):Json<Value>| {
                let (calls,denied)=(admissions.clone(),denied.clone());
                async move {
                    assert_eq!(headers["authorization"], format!("Bearer {SERVICE_KEY}"));
                    assert_eq!(headers["x-patchriot-role"], "member");
                    calls.lock().unwrap().push(("admission".into(), body.clone(), headers["x-patchriot-account"].to_str().unwrap().into()));
                    if denied.load(Ordering::SeqCst) { return (StatusCode::FORBIDDEN, Json(json!({"error":"scope_not_owned"}))); }
                    let consent=&body["consent"];
                    // The real dispatcher assigns a review ID distinct from the
                    // caller's retry key. Keep it stable across fixture retries.
                    let review_id=Uuid::from_u128(Uuid::parse_str(consent["request_id"].as_str().unwrap()).unwrap().as_u128() ^ 1);
                    let mut reply=json!({
                        "id":review_id,"request_id":consent["request_id"],"scenario":"website_snapshot_v1","mode":"website_agent","state":"awaiting_payment",
                        "created_at":Utc::now().timestamp(),"deadline_at":body["payment_expires_at"],"steps":[],"evidence_source":"synthetic fixture",
                        "website":{"site_check_id":site,"snapshot_sha256":consent["snapshot_sha256"],"reviewers":consent["device_ids"].as_array().unwrap().iter().map(|id|json!({"device_id":id,"operator_id":Uuid::new_v4(),"operator_name":"Fixture operator","device_name":"Fixture device","declared_model":"fixture-model","compute_group":"fixture-host"})).collect::<Vec<_>>()},
                        "payment":{"price":body["price"],"expires_at":body["payment_expires_at"],"invoice_id":null,"funded_at":null}
                    });
                    if kind == "sources" {
                        reply["scenario"]=json!("source_bundle_v1");reply["mode"]=json!("source_agent");
                        let mut context=reply.as_object_mut().unwrap().remove("website").unwrap();
                        context.as_object_mut().unwrap().remove("site_check_id");context["source_id"]=json!(site);reply["source"]=context;
                    } else { assert_eq!(kind,"site-checks"); }
                    (StatusCode::OK,Json(reply))
                }
            }))
            .route("/v0/quote", post(move |headers:HeaderMap,Json(body):Json<Value>| {
                let (calls,bad)=(quotes.clone(),bad.clone());
                async move {
                    assert_eq!(headers["x-api-key"], "fixture-provider-key");
                    let mut calls=calls.lock().unwrap();
                    assert_eq!(calls.last().unwrap().0, "admission");
                    calls.push(("quote".into(),body.clone(),String::new()));
                    Json(json!({"correlationId":Uuid::new_v4(),"quoteRequest":body,"quote":{
                        "amountOut":body["amount"],"amountIn":"1000000000000000000000000",
                        "depositAddress":if bad.load(Ordering::SeqCst) {"invalid/address".into()} else {format!("deposit-{}.near",Uuid::new_v4())},
                        "deadline":body["deadline"],"unexpectedProviderField":"must not reach the browser"
                    }}))
                }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            origin,
            calls,
            deny_admission,
            bad_address,
            task,
        }
    }
    fn access(&self, policy: &CheckoutPolicy) -> ReviewAccess {
        let bytes = serde_json::to_vec(policy).unwrap();
        let mut access =
            ReviewAccess::configured("paid", Some(&bytes), Some("fixture-provider-key")).unwrap();
        if let ReviewAccess::Paid(service) = &mut access {
            Arc::get_mut(service).unwrap().provider =
                OneClick::with_origin(&self.origin, "fixture-provider-key").unwrap();
        }
        access
    }
    fn count(&self, kind: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, _, _)| k == kind)
            .count()
    }
}

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    headers: &[(&str, &str)],
) -> (StatusCode, HeaderMap, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    for (key, value) in headers {
        request = request.header(*key, *value);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    assert_eq!(headers["cache-control"], "no-store");
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, headers, body)
}

struct Browser {
    app: Router,
    cookie: String,
    csrf: String,
}
impl Browser {
    async fn new(db: &TestDb, network: &Network, access: ReviewAccess) -> Self {
        Self::for_account(db, network, access, db.account).await
    }
    async fn for_account(
        db: &TestDb,
        network: &Network,
        access: ReviewAccess,
        account: Uuid,
    ) -> Self {
        let state = AppState::new(
            db.pool.clone(),
            Config::new(
                ORIGIN.into(),
                network.origin.clone(),
                SERVICE_KEY.into(),
                None,
            )
            .unwrap(),
        )
        .unwrap()
        .with_review_access(access);
        let app = router(state);
        let invite = invite_account(&db.pool, account).await.unwrap();
        let (code, headers, _) = request(
            &app,
            "POST",
            "/api/auth/redeem",
            json!({"code":invite}),
            &[("origin", ORIGIN)],
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        let cookie = headers["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let (_, _, session) = request(
            &app,
            "GET",
            "/api/session",
            Value::Null,
            &[("cookie", &cookie)],
        )
        .await;
        Self {
            app,
            cookie,
            csrf: session["csrf_token"].as_str().unwrap().into(),
        }
    }
    async fn call(&self, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
        let (code, _, body) = request(
            &self.app,
            method,
            path,
            body,
            &[
                ("cookie", &self.cookie),
                ("origin", ORIGIN),
                ("x-csrf-token", &self.csrf),
            ],
        )
        .await;
        (code, body)
    }
}

async fn age(db: &TestDb) {
    sqlx::query("UPDATE checkout_orders SET updated_at=now()-interval '11 seconds'")
        .execute(&db.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_sponsored_request_cannot_also_prepare_a_paid_order() {
    let db = TestDb::new().await;
    let network = Network::start().await;
    let policy = policy();
    let browser = Browser::new(&db, &network, network.access(&policy)).await;
    let body = input(&policy);
    let site = Uuid::new_v4();
    let issued = crate::review_codes::issue(&db.pool, "Sponsored request fixture")
        .await
        .unwrap();
    // Reserve through the real session route. This fixture lacks /review, so
    // admission is unconfirmed; its saved key must still be excluded from payment.
    let (status, _) = browser
        .call(
            "POST",
            &format!("/api/site-checks/{site}/review-code"),
            json!({"code":issued.code,"consent":body["consent"]}),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, reply) = browser
        .call("POST", &format!("/api/site-checks/{site}/checkout"), body)
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{reply}");
    assert_eq!(reply["error"], "request_conflict");
    assert_eq!(network.count("admission"), 0);
    assert_eq!(network.count("quote"), 0);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM checkout_orders")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    db.finish().await;
}

#[test]
fn paid_policy_is_explicit_and_rejects_ambiguous_metadata_or_addresses() {
    let valid = serde_json::to_value(policy()).unwrap();
    for mode in ["pilot", "closed"] {
        assert!(ReviewAccess::configured(mode, None, None).is_ok());
    }
    assert!(ReviewAccess::configured("paidd", None, None).is_err());
    assert!(ReviewAccess::configured("paid", None, Some("fixture-key")).is_err());
    assert!(
        ReviewAccess::configured("paid", Some(&serde_json::to_vec(&valid).unwrap()), None).is_err()
    );
    assert!(ReviewAccess::configured("pilot", Some(b"{}"), None).is_err());
    for (pointer, value) in [
        ("/amount", json!("0")),
        ("/amount", json!("01")),
        ("/amount", json!("9223372036854775808")),
        ("/recipient", json!("recipient..near")),
        ("/recipient_type", json!("UNSUPPORTED")),
        ("/destination/decimals", json!(31)),
        ("/destination/blockchain", json!("unsupported")),
        ("/inputs", json!([])),
        ("/inputs", json!([valid["inputs"][0], valid["inputs"][0]])),
        ("/inputs/0/symbol", json!("<script>")),
    ] {
        let mut invalid = valid.clone();
        *invalid.pointer_mut(pointer).unwrap() = value;
        assert!(
            ReviewAccess::configured(
                "paid",
                Some(&serde_json::to_vec(&invalid).unwrap()),
                Some("fixture-key")
            )
            .is_err(),
            "{pointer}"
        );
    }
    for address in [
        "0x",
        "0x0000000000000000000000000000000000000000",
        "0x111111111111111111111111111111111111111g",
        "near-account.near",
    ] {
        assert!(!Blockchain::Base.accepts_address(address));
    }
    assert!(Blockchain::Base.accepts_address("0x1111111111111111111111111111111111111111"));
    assert!(!Blockchain::Near.accepts_address("Account.NEAR"));
    assert!(!Blockchain::Near.accepts_address("a..near"));
}

#[tokio::test]
async fn browser_quote_uses_server_price_and_saves_before_showing_exact_deposit_details() {
    let db = TestDb::new().await;
    let network = Network::start().await;
    let policy = policy();
    let browser = Browser::new(&db, &network, network.access(&policy)).await;
    let (_, settings) = browser.call("GET", "/api/checkout", Value::Null).await;
    assert_eq!(settings["mode"], "paid");
    assert_eq!(settings["offer"]["price"]["amount"], "1000000");
    assert!(!settings.to_string().contains("fixture-provider-key"));
    assert_eq!(
        browser.call("GET", "/api/payments", Value::Null).await.1["checkout_enabled"],
        true
    );
    let body = input(&policy);
    let site = Uuid::new_v4();
    let path = format!("/api/site-checks/{site}/checkout");
    let (status, quote) = browser.call("POST", &path, body.clone()).await;
    assert_eq!(status, StatusCode::OK, "{quote}");
    assert_eq!(quote["request_id"], body["consent"]["request_id"]);
    assert_ne!(quote["review_id"], quote["request_id"]);
    assert_eq!(quote["input"]["amount"], "1000000000000000000000000");
    assert_eq!(quote["output"]["amount"], "1000000");
    assert_eq!(quote["input"]["token"]["decimals"], 24);
    assert_eq!(quote["refund_address"], body["refund_address"]);
    assert!(quote.get("quoteRequest").is_none());
    assert!(!quote.to_string().contains("unexpectedProviderField"));
    assert_eq!(network.count("quote"), 1);
    let saved: (Uuid, Uuid, Value) =
        sqlx::query_as("SELECT id,invoice_id,terms FROM checkout_orders")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(json!(saved.0), quote["order_id"]);
    assert_eq!(json!(saved.1), quote["invoice_id"]);
    assert_eq!(saved.2["payment"]["account_id"], json!(db.account));
    assert_eq!(saved.2["payment"]["recipient"], policy.recipient);
    assert_eq!(network.calls.lock().unwrap()[0].2, db.account.to_string());
    assert_eq!(db.counts().await, (0, 0)); // A quote is not a funded job.
    assert_eq!(
        browser.call("POST", &path, body.clone()).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    age(&db).await;
    assert_eq!(browser.call("POST", &path, body).await.1, quote);
    assert_eq!(network.count("quote"), 1);
    db.finish().await;
}

#[tokio::test]
async fn quote_creation_requires_owner_session_csrf_and_cannot_bypass_paid_admission() {
    let db = TestDb::new().await;
    let network = Network::start().await;
    let policy = policy();
    let browser = Browser::new(&db, &network, network.access(&policy)).await;
    let body = input(&policy);
    let site = Uuid::new_v4();
    let path = format!("/api/site-checks/{site}/checkout");
    assert_eq!(
        request(&browser.app, "GET", "/api/checkout", Value::Null, &[])
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &browser.app,
            "POST",
            &path,
            body.clone(),
            &[("origin", ORIGIN)]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &browser.app,
            "POST",
            &path,
            body.clone(),
            &[("origin", ORIGIN), ("cookie", &browser.cookie)]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for field in ["price", "recipient", "account_id", "payment"] {
        let mut changed = body.clone();
        changed[field] = json!("caller supplied");
        assert_eq!(
            browser.call("POST", &path, changed).await.0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    assert_eq!(
        browser
            .call(
                "POST",
                &format!("/api/site-checks/{site}/review"),
                body["consent"].clone()
            )
            .await
            .0,
        StatusCode::PAYMENT_REQUIRED
    );
    network.deny_admission.store(true, Ordering::SeqCst);
    assert_eq!(
        browser.call("POST", &path, body).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(network.count("quote"), 0);
    db.finish().await;
}

#[tokio::test]
async fn existing_quote_retries_preserve_terms_across_config_changes_and_reject_changed_consent() {
    let db = TestDb::new().await;
    let network = Network::start().await;
    let policy = policy();
    let browser = Browser::new(&db, &network, network.access(&policy)).await;
    let body = input(&policy);
    let path = format!("/api/site-checks/{}/checkout", Uuid::new_v4());
    let (code, first) = browser.call("POST", &path, body.clone()).await;
    assert_eq!(code, StatusCode::OK);
    age(&db).await;
    for (pointer, value) in [
        ("/refund_address", json!("another.near")),
        ("/offer_id", json!("b".repeat(64))),
        ("/origin_asset", json!(policy.inputs[1].asset_id)),
        ("/consent/snapshot_sha256", json!("b".repeat(64))),
        ("/consent/accepts_operator_access", json!(false)),
    ] {
        let mut changed = body.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        assert_eq!(
            browser.call("POST", &path, changed).await.0,
            StatusCode::CONFLICT
        );
    }
    let mut changed = policy.clone();
    changed.amount = "2000000".into();
    changed.recipient = "new-treasury.near".into();
    changed.inputs[0].decimals = 18;
    let changed_browser = Browser::new(&db, &network, network.access(&changed)).await;
    let resume = format!("/api/orders/{}/quote", first["order_id"].as_str().unwrap());
    let (code, second) = changed_browser.call("POST", &resume, json!({})).await;
    assert_eq!(code, StatusCode::OK, "{second}");
    assert_eq!(first, second);
    assert_eq!(network.count("quote"), 1);
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts(id,display_name,role) VALUES($1,'Other payer','admin')")
        .bind(other)
        .execute(&db.pool)
        .await
        .unwrap();
    let outsider = Browser::for_account(&db, &network, network.access(&changed), other).await;
    assert_eq!(
        outsider.call("POST", &resume, json!({})).await.0,
        StatusCode::NOT_FOUND
    );
    sqlx::query("UPDATE checkout_orders SET expires_at=now()-interval '1 second'")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        changed_browser.call("POST", &resume, json!({})).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(network.count("quote"), 1);
    db.finish().await;
}

#[tokio::test]
async fn invalid_payment_details_or_wrong_network_deposit_never_return_instructions() {
    let db = TestDb::new().await;
    let network = Network::start().await;
    let policy = policy();
    let browser = Browser::new(&db, &network, network.access(&policy)).await;
    let body = input(&policy);
    let path = format!("/api/site-checks/{}/checkout", Uuid::new_v4());
    for (field, value, code) in [
        ("origin_asset", json!("unlisted"), StatusCode::BAD_REQUEST),
        (
            "refund_address",
            json!("bad/address"),
            StatusCode::BAD_REQUEST,
        ),
        ("offer_id", json!("old-offer"), StatusCode::CONFLICT),
    ] {
        let mut invalid = body.clone();
        invalid[field] = value;
        assert_eq!(browser.call("POST", &path, invalid).await.0, code);
    }
    assert_eq!(network.count("admission"), 0);
    network.bad_address.store(true, Ordering::SeqCst);
    let (code, reply) = browser.call("POST", &path, body).await;
    assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
    assert!(reply.get("deposit_address").is_none());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM payment_invoices")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(db.counts().await, (0, 0));
    db.finish().await;
}

#[tokio::test]
async fn concurrent_browser_quotes_and_new_request_ids_are_bounded() {
    let db = TestDb::new().await;
    let network = Network::start().await;
    let policy = policy();
    let browser = Browser::new(&db, &network, network.access(&policy)).await;
    let body = input(&policy);
    let path = format!("/api/site-checks/{}/checkout", Uuid::new_v4());
    let (one, two) = tokio::join!(
        browser.call("POST", &path, body.clone()),
        browser.call("POST", &path, body)
    );
    let codes = [one.0, two.0];
    assert!(codes.contains(&StatusCode::OK));
    assert!(codes.contains(&StatusCode::TOO_MANY_REQUESTS));
    assert_eq!(network.count("quote"), 1);
    network.deny_admission.store(true, Ordering::SeqCst);
    for _ in 0..4 {
        assert_eq!(
            browser.call("POST", &path, input(&policy)).await.0,
            StatusCode::CONFLICT
        );
    }
    assert_eq!(
        browser.call("POST", &path, input(&policy)).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(network.count("admission"), 5);
    db.finish().await;
}

#[tokio::test]
async fn closed_mode_stops_both_entrypoints_but_preserves_existing_order_reads() {
    let db = TestDb::new().await;
    let network = Network::start().await;
    let policy = policy();
    let browser = Browser::new(&db, &network, network.access(&policy)).await;
    let body = input(&policy);
    let site = Uuid::new_v4();
    let path = format!("/api/site-checks/{site}/checkout");
    let (_, quote) = browser.call("POST", &path, body.clone()).await;
    let closed = Browser::new(&db, &network, ReviewAccess::Closed).await;
    assert_eq!(
        closed.call("GET", "/api/checkout", Value::Null).await.1,
        json!({"mode":"closed","offer":null})
    );
    assert_eq!(
        closed.call("POST", &path, body.clone()).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        closed
            .call(
                "POST",
                &format!("/api/site-checks/{site}/review"),
                body["consent"].clone()
            )
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        closed
            .call(
                "POST",
                &format!("/api/orders/{}/quote", quote["order_id"].as_str().unwrap()),
                json!({})
            )
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        closed
            .call("GET", "/api/orders", Value::Null)
            .await
            .1
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(network.count("quote"), 1);
    db.finish().await;
}
