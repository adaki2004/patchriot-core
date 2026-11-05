use super::*;
use crate::{Config, payments::tests::TestDb};
use axum::{
    Router,
    body::Body,
    http::Request,
    routing::{get, post},
};
use http_body_util::BodyExt;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tower::ServiceExt;

const ORIGIN: &str = "https://credits.fixture.example";

struct Fixture {
    state: AppState,
    headers: HeaderMap,
    target: Arc<Mutex<Value>>,
    review: Arc<Mutex<Option<Value>>>,
    lose_fund_reply: Arc<AtomicBool>,
    reject_admission: Arc<AtomicBool>,
    block_funding: Arc<AtomicBool>,
    funds: Arc<AtomicUsize>,
    quotes: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fixture {
    async fn new(db: &TestDb) -> Self {
        let target = Arc::new(Mutex::new(
            json!({"id":Uuid::new_v4(),"request_id":Uuid::new_v4(),"scope":{"origins":["https://owned.example"],"objective":"Owned fixture","methods":["GET","HEAD","OPTIONS"]},"scope_sha256":"a".repeat(64),"permission_note":"Owned fixture","state":"approved","created_at":Utc::now().timestamp(),"expires_at":Utc::now().timestamp()+86400,"decision_note":null,"can_start":true,"is_requester":true,"ownership_verified":true}),
        ));
        let review = Arc::new(Mutex::new(None::<Value>));
        let lose = Arc::new(AtomicBool::new(false));
        let deny = Arc::new(AtomicBool::new(false));
        let block_funding = Arc::new(AtomicBool::new(false));
        let block = block_funding.clone();
        let funds = Arc::new(AtomicUsize::new(0));
        let quotes = Arc::new(AtomicUsize::new(0));
        let (t, r, d, f, l, q) = (
            target.clone(),
            review.clone(),
            deny.clone(),
            funds.clone(),
            lose.clone(),
            quotes.clone(),
        );
        let read = r.clone();
        let cancel = r.clone();
        let funded = r.clone();
        let app=Router::new()
            .route("/internal/pentests/{id}",get(move ||{let t=t.clone();async move{Json(t.lock().unwrap().clone())}}))
            .route("/internal/pentests/{id}/admit-review",post(move |Path(id):Path<Uuid>,Json(body):Json<Value>|{let(r,d)=(r.clone(),d.clone());async move{
                if d.load(Ordering::SeqCst){return (StatusCode::CONFLICT,Json(json!({"error":"unavailable"})));}
                let mut saved=r.lock().unwrap();
                let view=saved.get_or_insert_with(||json!({"id":Uuid::new_v4(),"request_id":body["consent"]["request_id"],"scenario":"live_http_v1","mode":"pentest_agent","state":"awaiting_payment","created_at":Utc::now().timestamp(),"deadline_at":Utc::now().timestamp()+600,"evidence_source":"owned fixture","steps":[],
                    "pentest":{"pentest_id":id,"scope_sha256":body["consent"]["snapshot_sha256"],"scope":{"origins":["https://owned.example"],"objective":"Owned fixture","methods":["GET","HEAD","OPTIONS"]},"provider":"fixture","reviewers":body["consent"]["device_ids"].as_array().unwrap().iter().map(|id|json!({"device_id":id,"operator_id":Uuid::new_v4(),"operator_name":"Fixture","device_name":"Fixture","declared_model":"Fixture","compute_group":"fixture"})).collect::<Vec<_>>()},
                    "payment":{"price":body["price"],"expires_at":body["payment_expires_at"],"invoice_id":null,"funded_at":null}}));
                (StatusCode::OK,Json(view.clone()))
            }}))
            .route("/internal/reviews/{id}",get(move ||{let r=read.clone();async move{Json(r.lock().unwrap().clone().unwrap())}}))
            .route("/internal/reviews/{id}/fund",post(move |Json(body):Json<Value>|{let(r,f,l,block)=(funded.clone(),f.clone(),l.clone(),block.clone());async move{
                f.fetch_add(1,Ordering::SeqCst);
                if block.load(Ordering::SeqCst) {return(StatusCode::SERVICE_UNAVAILABLE,Json(json!({"error":"unavailable_before_funding"})));}
                let mut saved=r.lock().unwrap(); let v=saved.as_mut().unwrap();
                if v["state"]=="cancelled" {return (StatusCode::CONFLICT,Json(json!({"error":"closed"})));}
                v["payment"]["invoice_id"]=body["invoice_id"].clone();v["payment"]["funded_at"]=json!(Utc::now().timestamp());v["state"]=json!("queued");
                if l.swap(false,Ordering::SeqCst) {return(StatusCode::SERVICE_UNAVAILABLE,Json(json!({"error":"reply_lost_after_commit"})));}
                (StatusCode::OK,Json(v.clone()))
            }}))
            .route("/internal/reviews/{id}/cancel",post(move ||{let r=cancel.clone();async move{let mut saved=r.lock().unwrap();let v=saved.as_mut().unwrap();v["state"]=json!("cancelled");Json(v.clone())}}))
            .route("/v0/quote",post(move |Json(body):Json<Value>|{let q=q.clone();async move{q.fetch_add(1,Ordering::SeqCst);Json(json!({"correlationId":Uuid::new_v4(),"quoteRequest":body,"quote":{"amountOut":body["amount"],"amountIn":"5500000","depositAddress":format!("deposit-{}.near",Uuid::new_v4()),"deadline":body["deadline"]}}))}}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let remote = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let state = AppState::new(
            db.pool.clone(),
            Config::new(
                ORIGIN.into(),
                remote.clone(),
                "credits-fixture-internal-service-key".into(),
                None,
            )
            .unwrap(),
        )
        .unwrap()
        .with_review_access(access::ReviewAccess::Paid(Arc::new(
            access::CheckoutService {
                policy: access::CheckoutPolicy {
                    destination: access::PaymentToken {
                        asset_id: earnings::SETTLEMENT_ASSET.into(),
                        symbol: "USDC".into(),
                        decimals: 6,
                        blockchain: access::Blockchain::Base,
                    },
                    amount: "10000000".into(),
                    recipient: "treasury.fixture.near".into(),
                    recipient_type: access::RecipientType::Intents,
                    inputs: vec![access::PaymentToken {
                        asset_id: "nep141:wrap.near".into(),
                        symbol: "NEAR".into(),
                        decimals: 24,
                        blockchain: access::Blockchain::Near,
                    }],
                },
                provider: OneClick::with_origin(&remote, "fixture-key").unwrap(),
            },
        )));
        let mut tx = db.pool.begin().await.unwrap();
        let bearer = auth::new_session(&mut tx, db.account).await.ok().unwrap();
        tx.commit().await.unwrap();
        let csrf: String =
            sqlx::query_scalar("SELECT csrf_token FROM sessions WHERE account_id=$1")
                .bind(db.account)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("origin", ORIGIN.parse().unwrap());
        headers.insert(
            "cookie",
            format!("{}={bearer}", state.config.cookie_name())
                .parse()
                .unwrap(),
        );
        headers.insert("x-csrf-token", csrf.parse().unwrap());
        Self {
            state,
            headers,
            target,
            review,
            lose_fund_reply: lose,
            reject_admission: deny,
            block_funding,
            funds,
            quotes,
            task,
        }
    }
    fn id(&self) -> Uuid {
        serde_json::from_value(self.target.lock().unwrap()["id"].clone()).unwrap()
    }
    fn input(&self) -> Value {
        json!({"amount_cents":199,"consent":{"request_id":Uuid::new_v4(),"scope_sha256":"a".repeat(64),"device_ids":[Uuid::new_v4(),Uuid::new_v4(),Uuid::new_v4()],"accepts_operator_access":true,"accepts_provider_access":true}})
    }
    async fn call(&self, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        *req.headers_mut().unwrap() = self.headers.clone();
        req = req.header("content-type", "application/json");
        let res = crate::router(self.state.clone())
            .oneshot(req.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
    async fn topup(&self, cents: i64) -> Value {
        let offer = service(&self.state).ok().unwrap().policy.id().unwrap();
        let body = json!({"request_id":Uuid::new_v4(),"amount_cents":cents,"offer_id":offer,"origin_asset":"nep141:wrap.near","refund_address":"refund.fixture.near"});
        let (s, quote) = self.call("POST", "/api/credits/topups", body.clone()).await;
        assert_eq!(s, StatusCode::OK, "{quote}");
        let (s, retry) = self.call("POST", "/api/credits/topups", body).await;
        assert_eq!(s, StatusCode::OK, "{retry}");
        assert_eq!(quote, retry);
        quote
    }
    async fn settle(&self, quote: &Value, amount: i64) {
        let id: Uuid = serde_json::from_value(quote["invoice_id"].clone()).unwrap();
        let invoice: Invoice = sqlx::query_as("SELECT * FROM payment_invoices WHERE id=$1")
            .bind(id)
            .fetch_one(&self.state.pool)
            .await
            .unwrap();
        let claim = Uuid::new_v4();
        sqlx::query("UPDATE payment_invoices SET poll_token=$2 WHERE id=$1")
            .bind(id)
            .bind(claim)
            .execute(&self.state.pool)
            .await
            .unwrap();
        let status:ProviderStatus=serde_json::from_value(json!({"status":"SUCCESS","quoteResponse":{"correlationId":invoice.correlation_id,"quoteRequest":invoice.quote_request,"quote":invoice.quote},"updatedAt":Utc::now(),"swapDetails":{"amountOut":amount.to_string(),"intentHashes":["fixture"],"nearTxHashes":["fixture"]}})).unwrap();
        apply_status(&self.state.pool, id, claim, status)
            .await
            .unwrap();
    }
    async fn due(&self) {
        sqlx::query("UPDATE credit_purchases SET next_check_at=now()-interval '1 second'")
            .execute(&self.state.pool)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn credits_require_exact_settlement_and_never_emit_review_funding_for_topups() {
    let db = TestDb::new().await;
    let f = Fixture::new(&db).await;
    let quote = f.topup(500).await;
    assert_eq!(f.quotes.load(Ordering::SeqCst), 1);
    assert_eq!(available(&db.pool, db.account).await.unwrap(), 0);
    f.settle(&quote, 5_000_000).await;
    f.settle(&quote, 5_000_000).await;
    assert_eq!(available(&db.pool, db.account).await.unwrap(), 500);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM payment_funding_events")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    let bad = f.topup(200).await;
    f.settle(&bad, 1_999_999).await;
    assert_eq!(available(&db.pool, db.account).await.unwrap(), 500);
    assert!(
        sqlx::query("UPDATE credit_ledger SET amount_cents=amount_cents+1")
            .execute(&db.pool)
            .await
            .is_err()
    );
    let id: Uuid = serde_json::from_value(bad["order_id"].clone()).unwrap();
    assert!(sqlx::query("INSERT INTO credit_ledger(id,account_id,kind,amount_cents,topup_id) VALUES($1,$2,'topup',200,$3)").bind(Uuid::new_v4()).bind(db.account).bind(id).execute(&db.pool).await.is_err());
    db.finish().await;
}

#[tokio::test]
async fn credit_reservation_is_idempotent_and_recovers_a_lost_funding_reply() {
    let db = TestDb::new().await;
    let f = Fixture::new(&db).await;
    let q = f.topup(200).await;
    f.settle(&q, 2_000_000).await;
    let input = f.input();
    let path = format!("/api/pentests/{}/credits", f.id());
    let (a, b) = tokio::join!(
        f.call("POST", &path, input.clone()),
        f.call("POST", &path, input.clone())
    );
    assert_eq!(a.0, StatusCode::OK, "{}", a.1);
    assert_eq!(b.0, StatusCode::OK, "{}", b.1);
    assert_eq!(a.1["id"], b.1["id"]);
    assert_eq!(available(&db.pool, db.account).await.unwrap(), 1);
    f.lose_fund_reply.store(true, Ordering::SeqCst);
    process_once(&f.state).await.unwrap();
    let saved: String = sqlx::query_scalar("SELECT state FROM credit_purchases")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(saved, "funding");
    f.due().await;
    process_once(&f.state).await.unwrap();
    assert_eq!(
        f.funds.load(Ordering::SeqCst),
        1,
        "do not send funding twice after its lost reply"
    );
    assert_eq!(available(&db.pool, db.account).await.unwrap(), 1);
    assert_eq!(f.call("POST", &path, input).await.0, StatusCode::OK);
    let mut changed = f.input();
    changed["amount_cents"] = json!(1);
    assert_eq!(f.call("POST", &path, changed).await.0, StatusCode::CONFLICT);
    assert!(
        sqlx::query("UPDATE credit_purchases SET state='released'")
            .execute(&db.pool)
            .await
            .is_err()
    );
    db.finish().await;
}

#[tokio::test]
async fn refused_work_returns_reserved_credit_once() {
    let db = TestDb::new().await;
    let f = Fixture::new(&db).await;
    let q = f.topup(200).await;
    f.settle(&q, 2_000_000).await;
    let (s, v) = f
        .call(
            "POST",
            &format!("/api/pentests/{}/credits", f.id()),
            f.input(),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    f.reject_admission.store(true, Ordering::SeqCst);
    process_once(&f.state).await.unwrap();
    f.due().await;
    process_once(&f.state).await.unwrap();
    assert_eq!(available(&db.pool, db.account).await.unwrap(), 200);
    assert_eq!(f.funds.load(Ordering::SeqCst), 0);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM credit_ledger WHERE kind='release'")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
    db.finish().await;
}

#[tokio::test]
async fn balance_and_deposits_are_private_and_write_routes_require_csrf() {
    let db = TestDb::new().await;
    let mut f = Fixture::new(&db).await;
    let q = f.topup(200).await;
    f.settle(&q, 2_000_000).await;
    let (s, v) = f.call("GET", "/api/credits", Value::Null).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["available_cents"], 200);
    assert_eq!(v["prices"]["grey"], 499);
    f.headers.remove("x-csrf-token");
    assert_eq!(
        f.call(
            "POST",
            &format!("/api/pentests/{}/credits", f.id()),
            f.input()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    f.headers.remove("cookie");
    assert_eq!(
        f.call("GET", "/api/credits", Value::Null).await.0,
        StatusCode::UNAUTHORIZED
    );
    db.finish().await;
}

#[tokio::test]
async fn simultaneous_different_tests_cannot_spend_the_same_balance() {
    let db = TestDb::new().await;
    let first = Fixture::new(&db).await;
    let second = Fixture::new(&db).await;
    let quote = first.topup(200).await;
    first.settle(&quote, 2_000_000).await;
    let a = format!("/api/pentests/{}/credits", first.id());
    let b = format!("/api/pentests/{}/credits", second.id());
    let (a, b) = tokio::join!(
        first.call("POST", &a, first.input()),
        second.call("POST", &b, second.input())
    );
    assert_eq!(
        usize::from(a.0 == StatusCode::OK) + usize::from(b.0 == StatusCode::OK),
        1,
        "{a:?} {b:?}"
    );
    assert_eq!(available(&db.pool, db.account).await.unwrap(), 1);
    db.finish().await;
}

#[tokio::test]
async fn grey_box_price_is_read_from_saved_scope_not_the_browser() {
    let db = TestDb::new().await;
    let f = Fixture::new(&db).await;
    let quote = f.topup(500).await;
    f.settle(&quote, 5_000_000).await;
    f.target.lock().unwrap()["scope"]["authentication"] = json!("bearer");
    let (s, body) = f
        .call(
            "GET",
            &format!("/api/pentests/{}/credit-offer", f.id()),
            Value::Null,
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{body}");
    assert_eq!(body["amount_cents"], 499);
    let mut input = f.input();
    let path = format!("/api/pentests/{}/credits", f.id());
    assert_eq!(
        f.call("POST", &path, input.clone()).await.0,
        StatusCode::CONFLICT
    );
    input["amount_cents"] = json!(499);
    assert_eq!(f.call("POST", &path, input).await.0, StatusCode::OK);
    assert_eq!(available(&db.pool, db.account).await.unwrap(), 1);
    db.finish().await;
}

#[tokio::test]
async fn credit_paid_completed_roles_keep_the_existing_backed_ninety_ten_split() {
    let db = TestDb::new().await;
    let f = Fixture::new(&db).await;
    let q = f.topup(200).await;
    f.settle(&q, 2_000_000).await;
    assert_eq!(
        f.call(
            "POST",
            &format!("/api/pentests/{}/credits", f.id()),
            f.input()
        )
        .await
        .0,
        StatusCode::OK
    );
    process_once(&f.state).await.unwrap();
    {
        let mut saved = f.review.lock().unwrap();
        let view = saved.as_mut().unwrap();
        view["state"] = json!("completed");
        view["retention"] = json!({"first_downloaded_at":1,"expires_at":2,"content_deleted":true});
        let reviewers = view["pentest"]["reviewers"].as_array_mut().unwrap();
        for person in reviewers.iter_mut() {
            person["operator_id"] = json!(db.account);
        }
        view["steps"]=json!(reviewers.iter().zip(["investigator","reproducer","challenger"]).map(|(p,role)|json!({"role":role,"state":"completed","attempts":1,"device_id":p["device_id"],"operator_id":db.account,"compute_group":"fixture","result":null,"evidence_complete":true,"receipt":{"mode":"pentest_agent","binding_sha256":"a".repeat(64),"state":"completed","model":"fixture","duration_ms":1000,"inference_calls":1,"terminal_calls":0,"http_requests":1,"cleanup_confirmed":true}})).collect::<Vec<_>>());
    }
    f.due().await;
    process_once(&f.state).await.unwrap();
    f.due().await;
    process_once(&f.state).await.unwrap();
    let allocation: (String, i64, i64, i64) = sqlx::query_as(
        "SELECT funding_kind,gross_amount,platform_amount,operator_amount FROM earning_allocations",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        allocation,
        ("credits".into(), 1_990_000, 199_000, 1_791_000)
    );
    let total: i64 = sqlx::query_scalar("SELECT sum(amount)::bigint FROM operator_earnings")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(total, 1_791_000);
    {
        let mut conn = db.pool.acquire().await.unwrap();
        assert_eq!(
            super::super::payouts::liabilities(&mut conn).await.unwrap(),
            1_801_000,
            "operator debt plus the unspent customer cent remains backed"
        );
    }
    assert_eq!(available(&db.pool, db.account).await.unwrap(), 1);
    assert!(
        sqlx::query("UPDATE credit_purchases SET state='released'")
            .execute(&db.pool)
            .await
            .is_err()
    );
    db.finish().await;
}

#[tokio::test]
async fn an_unknown_funding_reply_does_not_refund_until_remote_cancellation_confirms() {
    let db = TestDb::new().await;
    let f = Fixture::new(&db).await;
    let q = f.topup(200).await;
    f.settle(&q, 2_000_000).await;
    f.block_funding.store(true, Ordering::SeqCst);
    assert_eq!(
        f.call(
            "POST",
            &format!("/api/pentests/{}/credits", f.id()),
            f.input()
        )
        .await
        .0,
        StatusCode::OK
    );
    process_once(&f.state).await.unwrap();
    assert_eq!(
        available(&db.pool, db.account).await.unwrap(),
        1,
        "a transport failure cannot release credit"
    );
    f.review.lock().unwrap().as_mut().unwrap()["state"] = json!("expired");
    f.due().await;
    process_once(&f.state).await.unwrap();
    assert_eq!(available(&db.pool, db.account).await.unwrap(), 200);
    f.due().await;
    process_once(&f.state).await.unwrap();
    assert_eq!(available(&db.pool, db.account).await.unwrap(), 200);
    db.finish().await;
}

#[tokio::test]
async fn account_isolation_and_admin_desk_distinguish_topups_from_work() {
    let db = TestDb::new().await;
    let mut f = Fixture::new(&db).await;
    let q = f.topup(200).await;
    f.settle(&q, 2_000_000).await;
    let (_, purchase) = f
        .call(
            "POST",
            &format!("/api/pentests/{}/credits", f.id()),
            f.input(),
        )
        .await;
    assert_eq!(
        f.call("GET", "/api/admin/credit-purchases", Value::Null)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE accounts SET role='admin' WHERE id=$1")
        .bind(db.account)
        .execute(&db.pool)
        .await
        .unwrap();
    let (status, desk) = f.call("GET", "/api/admin/payments", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(desk[0]["credit_topup_id"], q["order_id"]);
    assert_eq!(desk[0]["payment_confirmed"], true);
    assert_eq!(desk[0]["requires_attention"], false);
    let (_, rows) = f
        .call("GET", "/api/admin/credit-purchases", Value::Null)
        .await;
    assert_eq!(rows[0]["id"], purchase["id"]);
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts(id,display_name,role) VALUES($1,'Other customer','member')")
        .bind(other)
        .execute(&db.pool)
        .await
        .unwrap();
    let mut tx = db.pool.begin().await.unwrap();
    let bearer = auth::new_session(&mut tx, other).await.ok().unwrap();
    tx.commit().await.unwrap();
    let csrf: String = sqlx::query_scalar("SELECT csrf_token FROM sessions WHERE account_id=$1")
        .bind(other)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    f.headers.insert(
        "cookie",
        format!("{}={bearer}", f.state.config.cookie_name())
            .parse()
            .unwrap(),
    );
    f.headers.insert("x-csrf-token", csrf.parse().unwrap());
    let (_, balance) = f.call("GET", "/api/credits", Value::Null).await;
    assert_eq!(balance["available_cents"], 0);
    assert_eq!(balance["history"], json!([]));
    assert_eq!(
        f.call(
            "GET",
            &format!(
                "/api/credits/purchases/{}",
                purchase["id"].as_str().unwrap()
            ),
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.call(
            "POST",
            &format!(
                "/api/credits/topups/{}/quote",
                q["order_id"].as_str().unwrap()
            ),
            json!({})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.call("GET", "/api/admin/credit-purchases", Value::Null)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    db.finish().await;
}

#[tokio::test]
async fn cancellation_before_admission_returns_credit_without_starting_work() {
    let db = TestDb::new().await;
    let f = Fixture::new(&db).await;
    let q = f.topup(200).await;
    f.settle(&q, 2_000_000).await;
    let (_, p) = f
        .call(
            "POST",
            &format!("/api/pentests/{}/credits", f.id()),
            f.input(),
        )
        .await;
    let path = format!(
        "/api/credits/purchases/{}/cancel",
        p["id"].as_str().unwrap()
    );
    let (status, pending) = f.call("POST", &path, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(pending["cancel_requested_at"].is_string());
    assert_eq!(available(&db.pool, db.account).await.unwrap(), 1);
    process_once(&f.state).await.unwrap();
    assert_eq!(available(&db.pool, db.account).await.unwrap(), 200);
    assert_eq!(f.funds.load(Ordering::SeqCst), 0);
    assert!(f.review.lock().unwrap().is_none());
    assert_eq!(f.call("POST", &path, json!({})).await.0, StatusCode::OK);
    db.finish().await;
}

#[tokio::test]
async fn cancellation_resolves_uncertain_funding_without_returning_already_spent_credit() {
    for funding_arrived in [false, true] {
        let db = TestDb::new().await;
        let f = Fixture::new(&db).await;
        let q = f.topup(200).await;
        f.settle(&q, 2_000_000).await;
        f.block_funding.store(!funding_arrived, Ordering::SeqCst);
        f.lose_fund_reply.store(funding_arrived, Ordering::SeqCst);
        let (_, p) = f
            .call(
                "POST",
                &format!("/api/pentests/{}/credits", f.id()),
                f.input(),
            )
            .await;
        process_once(&f.state).await.unwrap();
        let path = format!(
            "/api/credits/purchases/{}/cancel",
            p["id"].as_str().unwrap()
        );
        assert_eq!(f.call("POST", &path, json!({})).await.0, StatusCode::OK);
        process_once(&f.state).await.unwrap();
        assert_eq!(
            f.review.lock().unwrap().as_ref().unwrap()["state"],
            "cancelled"
        );
        assert_eq!(
            available(&db.pool, db.account).await.unwrap(),
            if funding_arrived { 1 } else { 200 }
        );
        let saved: String = sqlx::query_scalar("SELECT state FROM credit_purchases")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(
            saved,
            if funding_arrived {
                "needs_review"
            } else {
                "released"
            }
        );
        db.finish().await;
    }
}
