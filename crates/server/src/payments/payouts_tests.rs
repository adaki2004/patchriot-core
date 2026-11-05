use super::*;
use crate::{
    Config,
    payments::{earnings::tests::fund_and_earn, tests::TestDb},
};
use alloy_primitives::Address;
use axum::{
    Router,
    routing::{get, post},
};
use secp256k1::SecretKey;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
};

const DEPOSIT: &str = "0x1111111111111111111111111111111111111111";

struct Network {
    service: Arc<PayoutService>,
    key_path: std::path::PathBuf,
    status: Arc<Mutex<Value>>,
    balance: Arc<AtomicI64>,
    mined: Arc<AtomicBool>,
    finalized: Arc<AtomicBool>,
    lost: Arc<AtomicBool>,
    sends: Arc<Mutex<Vec<String>>>,
    calls: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl Network {
    async fn start() -> Self {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).unwrap();
        let key = SecretKey::from_byte_array(bytes).unwrap();
        let treasury = format!("{:#x}", Address::from_secp256k1_secret_key(&key));
        let path =
            std::env::temp_dir().join(format!("patchriot-payout-fixture-{}", Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        options
            .open(&path)
            .unwrap()
            .write_all(hex::encode(bytes).as_bytes())
            .unwrap();
        let status = Arc::new(Mutex::new(Value::Null));
        let output = status.clone();
        let balance = Arc::new(AtomicI64::new(20_000_000));
        let b = balance.clone();
        let mined = Arc::new(AtomicBool::new(false));
        let m = mined.clone();
        let finalized = Arc::new(AtomicBool::new(false));
        let f = finalized.clone();
        let lost = Arc::new(AtomicBool::new(false));
        let l = lost.clone();
        let sends = Arc::new(Mutex::new(Vec::new()));
        let s = sends.clone();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls2 = calls.clone();
        let sender = treasury.clone();
        let app=Router::new().route("/v0/status",get(move || {let o=output.clone();async move {Json(o.lock().unwrap().clone())}}))
            .route("/rpc",post(move |Json(input):Json<Value>|{
                let (b,m,f,l,s,calls,sender)=(b.clone(),m.clone(),f.clone(),l.clone(),s.clone(),calls2.clone(),sender.clone());
                async move {
                    calls.fetch_add(1,Ordering::SeqCst);
                    let method=input["method"].as_str().unwrap();
                    let result=match method {
                        "eth_chainId"=>json!("0x2105"),
                        "eth_getTransactionCount"=>json!("0x0"),
                        "eth_getBalance"=>json!("0x1c6bf52634000"),
                        "eth_gasPrice"=>json!("0xf4240"),
                        "eth_estimateGas"=>json!("0xea60"),
                        "eth_call"=>if input["params"][0]["data"].as_str().unwrap().starts_with("0x70a08231") {json!(format!("0x{:064x}",b.load(Ordering::SeqCst)))} else {json!(format!("0x{:064x}",1))},
                        "eth_getBlockByNumber"=>json!({"number":if input["params"][0]=="finalized" && !f.load(Ordering::SeqCst) {"0x64"} else {"0xc8"},"hash":format!("0x{}","a".repeat(64))}),
                        "eth_getTransactionReceipt"=>if m.load(Ordering::SeqCst) {
                            json!({"status":"0x1","transactionHash":input["params"][0],"blockNumber":"0xc8","blockHash":format!("0x{}","a".repeat(64)),"logs":[{"address":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",format!("0x{:0>64}",&sender[2..]),format!("0x{:0>64}",&DEPOSIT[2..])],"data":format!("0x{:064x}",10_000_000)}]})
                        } else {Value::Null},
                        "eth_sendRawTransaction"=>{
                            let raw=input["params"][0].as_str().unwrap();s.lock().unwrap().push(raw.to_owned());
                            if l.swap(false,Ordering::SeqCst) {return (StatusCode::SERVICE_UNAVAILABLE,Json(json!({"unavailable":true})))}
                            json!(format!("{:#x}",alloy_primitives::keccak256(hex::decode(&raw[2..]).unwrap())))
                        },
                        _=>panic!("unexpected RPC {method}"),
                    };(StatusCode::OK,Json(json!({"jsonrpc":"2.0","id":1,"result":result})))
                }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let service = Arc::new(PayoutService {
            config: TreasuryConfig {
                recipient: treasury,
                rpc_url: format!("{origin}/rpc"),
                buffer_amount: "1000000".into(),
                maximum_claim: "100000000".into(),
                maximum_gas_wei: "1000000000000".into(),
            },
            provider: OneClick::with_origin(&origin, "fixture-only").unwrap(),
        });
        Self {
            service,
            key_path: path,
            status,
            balance,
            mined,
            finalized,
            lost,
            sends,
            calls,
            task,
        }
    }
    fn state(&self, db: &TestDb) -> AppState {
        AppState::new(
            db.pool.clone(),
            Config::new(
                "https://payout.fixture.example".into(),
                "http://127.0.0.1:1".into(),
                "payout-fixture-internal-key-not-a-secret".into(),
                None,
            )
            .unwrap(),
        )
        .unwrap()
        .with_payouts(self.service.clone())
    }
    async fn queued(&self, db: &TestDb) -> Claim {
        let input = input();
        let c = reserve(&db.pool, db.account, &input, &self.service.config)
            .await
            .unwrap_or_else(|_| panic!("fixture claim must reserve"));
        let quote = json!({"amountIn":c.amount.to_string(),"amountOut":"9950000","minAmountOut":"9850000","depositAddress":DEPOSIT,"deadline":c.expires_at});
        *self.status.lock().unwrap() = json!({"quoteResponse":{"quoteRequest":request(&c),"quote":quote},"status":"PENDING_DEPOSIT","updatedAt":Utc::now(),"swapDetails":{}});
        sqlx::query("UPDATE operator_claims SET state='queued',quote=$2,quote_request=$3,deposit_address=$4 WHERE id=$1").bind(c.id).bind(quote).bind(request(&c)).bind(DEPOSIT).execute(&db.pool).await.unwrap();
        sqlx::query_as("SELECT * FROM operator_claims WHERE id=$1")
            .bind(c.id)
            .fetch_one(&db.pool)
            .await
            .unwrap()
    }
}
impl Drop for Network {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_file(&self.key_path);
    }
}
fn input() -> CreateClaim {
    CreateClaim {
        id: Uuid::new_v4(),
        amount: MINIMUM_CLAIM.to_string(),
        destination_asset: destinations()[2].asset_id.clone(),
        recipient: bs58::encode([9; 32]).into_string(),
    }
}

#[tokio::test]
async fn claims_enforce_threshold_ownership_idempotency_and_concurrent_reservations() {
    let db = TestDb::new().await;
    let network = Network::start().await;
    fund_and_earn(&db, 10_000_000).await;
    let i = input();
    assert!(
        reserve(&db.pool, db.account, &i, &network.service.config)
            .await
            .is_err()
    );
    fund_and_earn(&db, 10_000_000).await;
    let j = input();
    let (a, b) = tokio::join!(
        reserve(&db.pool, db.account, &i, &network.service.config),
        reserve(&db.pool, db.account, &j, &network.service.config)
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let accepted = if a.is_ok() { &i } else { &j };
    assert!(
        reserve(&db.pool, db.account, accepted, &network.service.config)
            .await
            .is_ok()
    );
    let balance = balance(&db.pool, db.account).await.unwrap();
    assert_eq!(balance.available, "8000000");
    assert_eq!(balance.reserved, "10000000");
    let stranger = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts(id,display_name,role) VALUES($1,'Other operator','member')")
        .bind(stranger)
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(
        reserve(&db.pool, stranger, accepted, &network.service.config)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE operator_claims SET amount=10000001")
            .execute(&db.pool)
            .await
            .is_err()
    );
    db.finish().await;
}

#[tokio::test]
async fn treasury_shortfall_does_not_sign_or_send() {
    let db = TestDb::new().await;
    let network = Network::start().await;
    fund_and_earn(&db, 20_000_000).await;
    network.queued(&db).await;
    network.balance.store(18_000_000, Ordering::SeqCst);
    let result = chain::run_once(&network.state(&db), &network.key_path)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(result).unwrap()["status"],
        "treasury_coverage_insufficient"
    );
    assert!(network.sends.lock().unwrap().is_empty());
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM payout_transactions")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    let sufficient: bool = sqlx::query_scalar("SELECT sufficient FROM treasury_observations")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert!(!sufficient);
    db.finish().await;
}

#[tokio::test]
async fn saved_signature_survives_timeout_retries_and_finality_before_paying_once() {
    let db = TestDb::new().await;
    let network = Network::start().await;
    fund_and_earn(&db, 20_000_000).await;
    let claim = network.queued(&db).await;
    let state = network.state(&db);
    let (a, b) = tokio::join!(
        chain::run_once(&state, &network.key_path),
        chain::run_once(&state, &network.key_path)
    );
    assert!(
        a.is_ok() && b.is_ok(),
        "concurrent payout errors: {:?}, {:?}",
        a.as_ref().err(),
        b.as_ref().err()
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM payout_transactions")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
    assert!(
        sqlx::query("UPDATE operator_claims SET state='cancelled' WHERE id=$1")
            .bind(claim.id)
            .execute(&db.pool)
            .await
            .is_err()
    );
    network.lost.store(true, Ordering::SeqCst);
    chain::run_once(&state, &network.key_path).await.unwrap();
    chain::run_once(&state, &network.key_path).await.unwrap();
    let raws = network.sends.lock().unwrap().clone();
    assert!(raws.len() >= 2);
    assert!(raws.iter().all(|r| r == &raws[0]));
    let hash: String = sqlx::query_scalar("SELECT tx_hash FROM payout_transactions")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    network.mined.store(true, Ordering::SeqCst);
    let pending = chain::run_once(&state, &network.key_path).await.unwrap();
    assert_eq!(
        serde_json::to_value(pending).unwrap()["status"],
        "awaiting_finality"
    );
    {
        let mut body = network.status.lock().unwrap();
        body["status"] = json!("SUCCESS");
        body["swapDetails"] = json!({"amountOut":"9950000","originChainTxHashes":[{"hash":hash}],"destinationChainTxHashes":[{"hash":"fixture-destination-transaction"}]});
    }
    network.finalized.store(true, Ordering::SeqCst);
    let (a, b) = tokio::join!(
        chain::run_once(&state, &network.key_path),
        chain::run_once(&state, &network.key_path)
    );
    assert!(
        a.is_ok() && b.is_ok(),
        "concurrent payout errors: {:?}, {:?}",
        a.as_ref().err(),
        b.as_ref().err()
    );
    let paid: bool = sqlx::query_scalar("SELECT state='paid' FROM operator_claims WHERE id=$1")
        .bind(claim.id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert!(paid);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM payout_receipts")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
    let b = balance(&db.pool, db.account).await.unwrap();
    assert_eq!(b.available, "8000000");
    assert_eq!(b.reserved, "0");
    assert_eq!(b.paid, "10000000");
    let mut conn = db.pool.acquire().await.unwrap();
    assert_eq!(liabilities(&mut conn).await.unwrap(), 8_000_000);
    drop(conn);
    assert!(
        sqlx::query("UPDATE operator_claims SET state='cancelled'")
            .execute(&db.pool)
            .await
            .is_err()
    );
    assert!(network.calls.load(Ordering::SeqCst) > 0);
    db.finish().await;
}

#[tokio::test]
async fn unmatched_success_keeps_the_reservation_and_signing_lane_for_review() {
    let db = TestDb::new().await;
    let network = Network::start().await;
    fund_and_earn(&db, 20_000_000).await;
    let claim = network.queued(&db).await;
    let state = network.state(&db);
    chain::run_once(&state, &network.key_path).await.unwrap();
    network.mined.store(true, Ordering::SeqCst);
    network.finalized.store(true, Ordering::SeqCst);
    {
        let mut body = network.status.lock().unwrap();
        body["status"] = json!("SUCCESS");
        body["swapDetails"] = json!({"amountOut":"9950000","originChainTxHashes":[{"hash":format!("0x{}","b".repeat(64))}],"destinationChainTxHashes":[{"hash":"fixture-destination"}]});
    }
    let progress = chain::run_once(&state, &network.key_path).await.unwrap();
    assert_eq!(
        serde_json::to_value(progress).unwrap()["status"],
        "payout_evidence_mismatch"
    );
    let lane: Option<Uuid> = sqlx::query_scalar("SELECT claim_id FROM treasury_lane")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(lane, Some(claim.id));
    let b = balance(&db.pool, db.account).await.unwrap();
    assert_eq!(
        (b.available.as_str(), b.reserved.as_str(), b.paid.as_str()),
        ("8000000", "10000000", "0")
    );
    let progress = chain::run_once(&state, &network.key_path).await.unwrap();
    assert_eq!(
        serde_json::to_value(progress).unwrap()["status"],
        "needs_review"
    );
    assert!(network.sends.lock().unwrap().is_empty());
    db.finish().await;
}

#[test]
fn payout_quotes_cannot_change_destination_refund_amount_or_enable_other_routes() {
    let c = Claim {
        id: Uuid::new_v4(),
        operator_id: Uuid::new_v4(),
        amount: 10_000_000,
        destination_asset: destinations()[2].asset_id.clone(),
        recipient: bs58::encode([9; 32]).into_string(),
        treasury: DEPOSIT.into(),
        state: "preparing".into(),
        quote_request: None,
        quote: None,
        deposit_address: None,
        expires_at: Utc::now() + Duration::minutes(5),
        created_at: Utc::now(),
        last_error: None,
    };
    let q = QuoteResponse {
        correlation_id: Uuid::new_v4().to_string(),
        quote_request: request(&c),
        quote: json!({"amountIn":"10000000","amountOut":"9950000","minAmountOut":"9850000","deadline":c.expires_at,"depositAddress":"0x2222222222222222222222222222222222222222"}),
    };
    assert!(valid_quote(&c, &q));
    for field in [
        "recipient",
        "refundTo",
        "amount",
        "destinationAsset",
        "originAsset",
        "swapType",
    ] {
        let mut changed = q.clone();
        changed.quote_request[field] = json!("changed");
        assert!(!valid_quote(&c, &changed), "{field}");
    }
    let mut cheap = q;
    cheap.quote["minAmountOut"] = json!("8900000");
    assert!(!valid_quote(&c, &cheap));
}

async fn http(
    app: &Router,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Value,
) -> (StatusCode, HeaderMap, Value) {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    for (k, v) in headers {
        request = request.header(*k, *v)
    }
    let response = app
        .clone()
        .oneshot(
            request
                .body(if body.is_null() {
                    Body::empty()
                } else {
                    Body::from(body.to_string())
                })
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        headers,
        serde_json::from_slice(&body).unwrap_or(Value::Null),
    )
}
async fn session(app: &Router, db: &TestDb, account: Uuid) -> (String, String) {
    let code = crate::invite_account(&db.pool, account).await.unwrap();
    let (status, headers, _) = http(
        app,
        "POST",
        "/api/auth/redeem",
        &[("origin", "https://payout.fixture.example")],
        json!({"code":code}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let cookie = headers["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let (_, _, body) = http(
        app,
        "GET",
        "/api/session",
        &[("cookie", &cookie)],
        Value::Null,
    )
    .await;
    (cookie, body["csrf_token"].as_str().unwrap().to_owned())
}

#[tokio::test]
async fn withdrawal_routes_require_owner_origin_csrf_and_hide_other_balances() {
    let db = TestDb::new().await;
    let network = Network::start().await;
    fund_and_earn(&db, 20_000_000).await;
    let claim = network.queued(&db).await;
    let app = crate::router(network.state(&db));
    let (cookie, csrf) = session(&app, &db, db.account).await;
    for path in ["/api/earnings", "/api/withdrawals", "/api/admin/treasury"] {
        assert_eq!(
            http(&app, "GET", path, &[], Value::Null).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    let path = format!("/api/withdrawals/{}/cancel", claim.id);
    assert_eq!(
        http(
            &app,
            "POST",
            &path,
            &[
                ("cookie", &cookie),
                ("origin", "https://payout.fixture.example")
            ],
            json!({})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        http(
            &app,
            "POST",
            &path,
            &[
                ("cookie", &cookie),
                ("origin", "https://other.fixture.example"),
                ("x-csrf-token", &csrf)
            ],
            json!({})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (_, _, body) = http(
        &app,
        "GET",
        "/api/withdrawals",
        &[("cookie", &cookie)],
        Value::Null,
    )
    .await;
    assert_eq!(body["balance"]["available"], "8000000");
    assert_eq!(body["claims"].as_array().unwrap().len(), 1);
    assert!(!body.to_string().contains("signed_bytes") && !body.to_string().contains("rpc_url"));
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts(id,display_name,role) VALUES($1,'Other','member')")
        .bind(other)
        .execute(&db.pool)
        .await
        .unwrap();
    let (other_cookie, other_csrf) = session(&app, &db, other).await;
    let (_, _, body) = http(
        &app,
        "GET",
        "/api/withdrawals",
        &[("cookie", &other_cookie)],
        Value::Null,
    )
    .await;
    assert_eq!(body["balance"]["available"], "0");
    assert!(body["claims"].as_array().unwrap().is_empty());
    assert_eq!(
        http(
            &app,
            "POST",
            &path,
            &[
                ("cookie", &other_cookie),
                ("origin", "https://payout.fixture.example"),
                ("x-csrf-token", &other_csrf)
            ],
            json!({})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        http(
            &app,
            "GET",
            "/api/admin/treasury",
            &[("cookie", &cookie)],
            Value::Null
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        http(
            &app,
            "POST",
            &path,
            &[
                ("cookie", &cookie),
                ("origin", "https://payout.fixture.example"),
                ("x-csrf-token", &csrf)
            ],
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        balance(&db.pool, db.account).await.unwrap().available,
        "18000000"
    );
    assert_eq!(network.calls.load(Ordering::SeqCst), 0);
    sqlx::query("UPDATE accounts SET role='admin' WHERE id=$1")
        .bind(other)
        .execute(&db.pool)
        .await
        .unwrap();
    let (status, _, body) = http(
        &app,
        "GET",
        "/api/admin/treasury",
        &[("cookie", &other_cookie)],
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["platform_revenue"], "2000000");
    assert_eq!(body["liabilities"], "18000000");
    assert_eq!(body["work"].as_array().unwrap().len(), 3);
    assert_eq!(body["work"][0]["amount"], "6000000");
    assert_eq!(body["work"][0]["operator_id"], db.account.to_string());
    assert!(!body.to_string().contains("snapshot_sha256"));
    db.finish().await;
}

#[tokio::test]
async fn disabled_account_releases_only_unsigned_requests() {
    let db = TestDb::new().await;
    let network = Network::start().await;
    fund_and_earn(&db, 20_000_000).await;
    let c = network.queued(&db).await;
    let state = network.state(&db);
    sqlx::query("UPDATE accounts SET disabled=true WHERE id=$1")
        .bind(db.account)
        .execute(&db.pool)
        .await
        .unwrap();
    chain::run_once(&state, &network.key_path).await.unwrap();
    assert_eq!(
        balance(&db.pool, db.account).await.unwrap().available,
        "18000000"
    );
    sqlx::query("UPDATE accounts SET disabled=false WHERE id=$1")
        .bind(db.account)
        .execute(&db.pool)
        .await
        .unwrap();
    // The cancelled quote's deposit address cannot be assigned to another claim.
    assert!(
        reserve(
            &db.pool,
            db.account,
            &CreateClaim {
                id: c.id,
                recipient: DEPOSIT.into(),
                ..input()
            },
            &network.service.config
        )
        .await
        .is_err()
    );
    db.finish().await;
}
