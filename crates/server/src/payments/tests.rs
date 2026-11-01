use super::*;

#[test]
fn provider_defaults_cannot_change_recipients_amounts_or_routing() {
    let request = serde_json::json!({"dry":false,"amount":"10000000","recipient":"treasury.near","refundTo":"customer.near","deadline":"2026-11-01T12:00:00+00:00"});
    let mut echo = request.clone();
    echo["deadline"] = json!("2026-11-01T12:00:00.000Z");
    echo["confidentiality"] = json!("public");
    echo["quoteWaitingTimeMs"] = json!(0);
    echo["insured"] = json!(false);
    echo["appFees"] = json!([{"recipient":"provider.near","fee":1}]);
    assert!(matches_request(&request, &echo));
    assert_eq!(app_fee_bps(&echo["appFees"]), Some(1));
    for (field, value) in [
        ("recipient", json!("someone-else.near")),
        ("refundTo", json!("someone-else.near")),
        ("amount", json!("9000000")),
        ("deadline", json!("2026-11-01T12:00:01Z")),
        ("dry", json!(true)),
        ("confidentiality", json!("shield")),
        ("insured", json!(true)),
        ("customRecipientMsg", json!("execute_something")),
        ("virtualChainRecipient", json!("someone-else.near")),
        ("newRoutingField", json!(false)),
        ("appFees", json!([{"recipient":"provider.near","fee":101}])),
        (
            "appFees",
            json!([{"recipient":"provider.near","fee":60},{"recipient":"another.near","fee":60}]),
        ),
        ("appFees", json!([{"recipient":"provider.near","fee":-1}])),
    ] {
        let mut changed = echo.clone();
        changed[field] = value;
        assert!(!matches_request(&request, &changed), "accepted {field}");
    }
    echo.as_object_mut().unwrap().remove("refundTo");
    assert!(!matches_request(&request, &echo));
}

#[path = "browser_checkout_tests.rs"]
mod browser_checkout;
#[path = "checkout_tests.rs"]
mod checkout;
use axum::{
    Router,
    extract::Query,
    http::StatusCode,
    response::IntoResponse,
    routing::{any, get, post},
};
use serde_json::json;
use sqlx::postgres::PgPoolOptions;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

struct TestDb {
    pool: PgPool,
    admin: PgPool,
    schema: String,
    account: Uuid,
}
impl TestDb {
    async fn new() -> Self {
        let url = std::env::var("PATCHRIOT_TEST_DATABASE_URL")
            .expect("set PATCHRIOT_TEST_DATABASE_URL to a local test PostgreSQL database");
        let admin = PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let schema = format!("test_payment_{}", Uuid::new_v4().simple());
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
        let account = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO accounts (id, display_name, role) VALUES ($1,'Fixture customer','member')",
        )
        .bind(account)
        .execute(&pool)
        .await
        .unwrap();
        Self {
            pool,
            admin,
            schema,
            account,
        }
    }
    fn quote(&self) -> (InvoiceTerms, QuoteResponse) {
        let deadline = (Utc::now() + Duration::minutes(5)).to_rfc3339();
        let request = json!({
            "dry":false, "swapType":"EXACT_OUTPUT", "depositType":"ORIGIN_CHAIN",
            "refundType":"ORIGIN_CHAIN", "depositMode":"SIMPLE", "recipientType":"INTENTS",
            "destinationAsset":"nep141:fixture.usdc.near", "originAsset":"nep141:fixture.input.near",
            "recipient":"treasury.fixture.near", "refundTo":"customer.fixture.near",
            "amount":"1000000", "deadline":deadline, "slippageTolerance":100
        });
        let response = QuoteResponse {
            correlation_id: Uuid::new_v4().to_string(),
            quote_request: request.clone(),
            quote: json!({"amountIn":"2000000", "amountOut":"1000000", "depositAddress":format!("deposit-{}.fixture.near", Uuid::new_v4()), "deadline":deadline}),
        };
        let terms = InvoiceTerms {
            account_id: self.account,
            request_id: Uuid::new_v4(),
            destination_asset: "nep141:fixture.usdc.near".into(),
            recipient: "treasury.fixture.near".into(),
            required_amount: 1_000_000,
            quote_request: request,
        };
        (terms, response)
    }
    async fn invoice(&self) -> (Uuid, QuoteResponse) {
        let (terms, quote) = self.quote();
        (
            record_quote(&self.pool, &terms, &quote).await.unwrap(),
            quote,
        )
    }
    async fn due(&self, id: Uuid) {
        sqlx::query(
            "UPDATE payment_invoices SET next_check_at = now() - interval '1 second' WHERE id = $1",
        )
        .bind(id)
        .execute(&self.pool)
        .await
        .unwrap();
    }
    async fn state(&self, id: Uuid) -> (String, Option<String>) {
        sqlx::query_as("SELECT state, reason FROM payment_invoices WHERE id = $1")
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
    async fn counts(&self) -> (i64, i64) {
        sqlx::query_as("SELECT (SELECT count(*) FROM payment_ledger), (SELECT count(*) FROM payment_funding_events)")
            .fetch_one(&self.pool).await.unwrap()
    }
    async fn finish(self) {
        self.pool.close().await;
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

fn status(quote: &QuoteResponse, state: &str) -> Value {
    json!({
        "correlationId":Uuid::new_v4(), "quoteResponse":quote, "status":state, "updatedAt":Utc::now(),
        "swapDetails":{"amountOut":"1000000", "intentHashes":["fixture-intent"], "nearTxHashes":["fixture-transaction"]}
    })
}
type ObservedRequest = (HashMap<String, String>, bool);
struct MockProvider {
    client: OneClick,
    body: Arc<Mutex<(StatusCode, String)>>,
    calls: Arc<Mutex<Vec<ObservedRequest>>>,
    quote_calls: Arc<Mutex<Vec<(Value, bool)>>>,
    redirected_calls: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl MockProvider {
    async fn new(body: Value) -> Self {
        let body = Arc::new(Mutex::new((StatusCode::OK, body.to_string())));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let output = body.clone();
        let requests = calls.clone();
        let quote_calls = Arc::new(Mutex::new(Vec::new()));
        let quote_requests = quote_calls.clone();
        let quote_output = body.clone();
        let redirected_calls = Arc::new(AtomicUsize::new(0));
        let unexpected = redirected_calls.clone();
        let app = Router::new()
            .route(
                "/v0/status",
                get(
                    move |Query(query): Query<HashMap<String, String>>, headers: HeaderMap| {
                        let output = output.clone();
                        let requests = requests.clone();
                        async move {
                            requests.lock().unwrap().push((
                                query,
                                headers
                                    .get("x-api-key")
                                    .is_some_and(|h| h == "fixture-only"),
                            ));
                            let (code, body) = output.lock().unwrap().clone();
                            (
                                code,
                                [
                                    ("content-type", "application/json"),
                                    ("location", "/unexpected"),
                                ],
                                body,
                            )
                                .into_response()
                        }
                    },
                ),
            )
            .route(
                "/v0/quote",
                post(move |headers: HeaderMap, Json(input): Json<Value>| {
                    let output = quote_output.clone();
                    let requests = quote_requests.clone();
                    async move {
                        requests.lock().unwrap().push((
                            input,
                            headers
                                .get("x-api-key")
                                .is_some_and(|h| h == "fixture-only"),
                        ));
                        let (code, body) = output.lock().unwrap().clone();
                        (
                            code,
                            [
                                ("content-type", "application/json"),
                                ("location", "/unexpected"),
                            ],
                            body,
                        )
                    }
                }),
            )
            .route(
                "/unexpected",
                any(move || {
                    unexpected.fetch_add(1, Ordering::SeqCst);
                    async { StatusCode::OK }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = OneClick::with_origin(
            &format!("http://{}", listener.local_addr().unwrap()),
            "fixture-only",
        )
        .unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            client,
            body,
            calls,
            quote_calls,
            redirected_calls,
            task,
        }
    }
    fn set(&self, value: Value) {
        *self.body.lock().unwrap() = (StatusCode::OK, value.to_string());
    }
}
impl Drop for MockProvider {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
async fn fetched_quote_is_bound_saved_and_reconciled_without_double_credit() {
    let db = TestDb::new().await;
    let (terms, expected) = db.quote();
    let provider = MockProvider::new(json!(expected)).await;
    let quote = provider.client.quote(&terms).await.unwrap();
    assert_eq!(
        provider.quote_calls.lock().unwrap().as_slice(),
        &[(terms.quote_request.clone(), true)]
    );
    let id = record_quote(&db.pool, &terms, &quote).await.unwrap();
    assert_eq!(record_quote(&db.pool, &terms, &quote).await.unwrap(), id);
    assert_eq!(db.counts().await, (0, 0), "a quote is not a payment");
    provider.set(status(&quote, "SUCCESS"));
    reconcile_once(&db.pool, &provider.client).await.unwrap();
    assert_eq!(db.state(id).await.0, "settled");
    assert_eq!(db.counts().await, (1, 1));
    db.due(id).await;
    assert_eq!(
        reconcile_once(&db.pool, &provider.client)
            .await
            .unwrap()
            .checked,
        0
    );
    assert_eq!(db.counts().await, (1, 1));
    assert_eq!(provider.redirected_calls.load(Ordering::SeqCst), 0);
    db.finish().await;
}

#[tokio::test]
async fn invalid_quote_terms_never_reach_the_provider() {
    let db = TestDb::new().await;
    let provider = MockProvider::new(json!({})).await;
    for (field, value) in [
        ("dry", json!(true)),
        ("swapType", json!("EXACT_INPUT")),
        ("recipient", json!("other.fixture.near")),
        ("destinationAsset", json!("nep141:other.fixture.near")),
        ("amount", json!("1")),
        ("originAsset", json!("")),
        ("refundTo", json!("")),
        ("deadline", json!(Utc::now() - Duration::seconds(1))),
        ("deadline", json!(Utc::now() + Duration::hours(2))),
        ("customRecipientMsg", json!("unsupported call")),
        ("sessionId", json!("x".repeat(16 * 1024))),
    ] {
        let (mut terms, _) = db.quote();
        terms.quote_request[field] = value;
        assert!(
            matches!(
                provider.client.quote(&terms).await,
                Err(PaymentError::InvalidQuote)
            ),
            "accepted changed {field}"
        );
    }
    assert!(provider.quote_calls.lock().unwrap().is_empty());
    assert_eq!(db.counts().await, (0, 0));
    db.finish().await;
}

#[tokio::test]
async fn quote_response_cannot_change_payment_or_refund_terms() {
    let db = TestDb::new().await;
    let (terms, expected) = db.quote();
    let provider = MockProvider::new(json!(expected)).await;
    for (pointer, value) in [
        ("/quoteRequest/recipient", json!("other.fixture.near")),
        ("/quoteRequest/refundTo", json!("other.fixture.near")),
        (
            "/quoteRequest/originAsset",
            json!("nep141:other.fixture.near"),
        ),
        ("/quoteRequest/amount", json!("1")),
        ("/quote/amountOut", json!("999999")),
        ("/quote/amountIn", json!("0")),
        ("/quote/depositAddress", json!("")),
        ("/quote/deadline", json!(Utc::now() - Duration::seconds(1))),
        ("/quote/deadline", json!(Utc::now() + Duration::minutes(10))),
        ("/correlationId", json!("")),
    ] {
        let mut response = json!(expected);
        *response.pointer_mut(pointer).unwrap() = value;
        provider.set(response);
        assert!(
            matches!(
                provider.client.quote(&terms).await,
                Err(PaymentError::InvalidQuote)
            ),
            "accepted changed {pointer}"
        );
    }
    assert_eq!(db.counts().await, (0, 0));
    db.finish().await;
}

#[tokio::test]
async fn quote_http_errors_and_redirects_do_not_retry_or_forward_credentials() {
    let db = TestDb::new().await;
    let (terms, quote) = db.quote();
    let provider = MockProvider::new(json!(quote)).await;
    for code in [
        StatusCode::TEMPORARY_REDIRECT,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::INTERNAL_SERVER_ERROR,
    ] {
        *provider.body.lock().unwrap() = (code, json!(quote).to_string());
        let before = provider.quote_calls.lock().unwrap().len();
        assert!(matches!(
            provider.client.quote(&terms).await,
            Err(PaymentError::ProviderUnavailable)
        ));
        assert_eq!(provider.quote_calls.lock().unwrap().len(), before + 1);
        assert_eq!(provider.redirected_calls.load(Ordering::SeqCst), 0);
    }
    for body in [
        "private provider error".into(),
        "x".repeat(RESPONSE_LIMIT + 1),
        "{}".into(),
    ] {
        *provider.body.lock().unwrap() = (StatusCode::OK, body);
        assert!(matches!(
            provider.client.quote(&terms).await,
            Err(PaymentError::InvalidResponse)
        ));
    }
    assert_eq!(db.counts().await, (0, 0));
    db.finish().await;
}

#[test]
fn amounts_and_credentials_do_not_accept_ambiguous_values() {
    for value in [
        json!(1),
        json!(-1),
        json!(1.0),
        json!("1.0"),
        json!("1e6"),
        json!("01"),
        json!("+1"),
        json!(" 1"),
        json!("-1"),
        json!("9223372036854775808"),
        Value::Null,
    ] {
        assert!(atom_amount(&value).is_none(), "accepted {value}");
    }
    assert_eq!(atom_amount(&json!("0")), Some(0));
    assert!(positive_input_amount(&json!("1000000000000000000000000")));
    assert!(!positive_input_amount(&json!("1e24")));
    assert!(!positive_input_amount(&json!("0")));
    assert_eq!(atom_amount(&json!(i64::MAX.to_string())), Some(i64::MAX));
    for key in ["", " ", "newline\nkey", " leading"] {
        assert!(OneClick::new(key).is_err());
    }
}

#[tokio::test]
async fn quotes_are_bound_idempotent_and_cannot_be_reassigned() {
    let db = TestDb::new().await;
    let (terms, quote) = db.quote();
    let (first, second) = tokio::join!(
        record_quote(&db.pool, &terms, &quote),
        record_quote(&db.pool, &terms, &quote)
    );
    assert_eq!(first.unwrap(), second.unwrap());
    let mut changed = quote.clone();
    changed.quote["depositAddress"] = json!("other.fixture.near");
    assert!(matches!(
        record_quote(&db.pool, &terms, &changed).await,
        Err(PaymentError::ConflictingInvoice)
    ));
    let (mut other, _) = db.quote();
    other.quote_request = terms.quote_request.clone();
    assert!(matches!(
        record_quote(&db.pool, &other, &quote).await,
        Err(PaymentError::ConflictingInvoice)
    ));
    for (field, value) in [
        ("dry", json!(true)),
        ("swapType", json!("ANY_INPUT")),
        ("recipient", json!("attacker.fixture.near")),
        ("amount", json!("999999")),
        ("depositMode", json!("MEMO")),
        ("customRecipientMsg", json!("anything")),
    ] {
        let mut invalid = quote.clone();
        invalid.quote_request[field] = value;
        assert!(matches!(
            record_quote(&db.pool, &terms, &invalid).await,
            Err(PaymentError::InvalidQuote)
        ));
    }
    let mut expired = quote.clone();
    expired.quote["deadline"] = json!(Utc::now() - Duration::seconds(1));
    assert!(matches!(
        record_quote(&db.pool, &terms, &expired).await,
        Err(PaymentError::InvalidQuote)
    ));
    sqlx::query("UPDATE accounts SET disabled = true WHERE id = $1")
        .bind(db.account)
        .execute(&db.pool)
        .await
        .unwrap();
    let (terms, quote) = db.quote();
    assert!(record_quote(&db.pool, &terms, &quote).await.is_err());
    assert_eq!(db.counts().await, (0, 0));
    db.finish().await;
}

#[tokio::test]
async fn concurrent_pollers_credit_once_and_the_saved_result_survives_another_poll() {
    let db = TestDb::new().await;
    let (terms, mut quote) = db.quote();
    quote.quote["depositMemo"] = json!("memo+42");
    let id = record_quote(&db.pool, &terms, &quote).await.unwrap();
    let provider = MockProvider::new(status(&quote, "SUCCESS")).await;
    let (a, b) = tokio::join!(
        reconcile_once(&db.pool, &provider.client),
        reconcile_once(&db.pool, &provider.client)
    );
    assert_eq!(a.unwrap().checked + b.unwrap().checked, 1);
    assert_eq!(db.counts().await, (1, 1));
    assert_eq!(db.state(id).await, ("settled".into(), None));
    {
        let calls = provider.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].0["depositAddress"],
            quote.quote["depositAddress"].as_str().unwrap()
        );
        assert_eq!(calls[0].0["depositMemo"], "memo+42");
        assert!(calls[0].1);
    }
    db.due(id).await;
    let restarted = OneClick::with_origin(&provider.client.origin, "fixture-only").unwrap();
    assert_eq!(
        reconcile_once(&db.pool, &restarted).await.unwrap().checked,
        0
    );
    assert!(
        sqlx::query("UPDATE payment_ledger SET amount = 1")
            .execute(&db.pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM payment_ledger")
            .execute(&db.pool)
            .await
            .is_err()
    );
    let transfer: (String, String, i64) =
        sqlx::query_as("SELECT debit, credit, amount FROM payment_ledger")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        transfer,
        ("treasury_asset".into(), "customer_funds".into(), 1_000_000)
    );
    db.finish().await;
}

#[tokio::test]
async fn pending_partial_failed_and_refunded_statuses_never_credit_money() {
    let db = TestDb::new().await;
    let (id, quote) = db.invoice().await;
    let provider = MockProvider::new(status(&quote, "PENDING_DEPOSIT")).await;
    for (upstream, expected) in [
        ("PENDING_DEPOSIT", "pending"),
        ("KNOWN_DEPOSIT_TX", "pending"),
        ("INCOMPLETE_DEPOSIT", "incomplete"),
        ("PROCESSING", "processing"),
        ("FAILED", "failed"),
        ("REFUNDED", "refunded"),
    ] {
        provider.set(status(&quote, upstream));
        db.due(id).await;
        reconcile_once(&db.pool, &provider.client).await.unwrap();
        assert_eq!(db.state(id).await.0, expected);
        assert_eq!(db.counts().await, (0, 0));
    }
    // Even a contradictory intermediate state must not erase the refund report.
    provider.set(status(&quote, "PROCESSING"));
    db.due(id).await;
    reconcile_once(&db.pool, &provider.client).await.unwrap();
    provider.set(status(&quote, "SUCCESS"));
    db.due(id).await;
    reconcile_once(&db.pool, &provider.client).await.unwrap();
    assert_eq!(
        db.state(id).await,
        (
            "held".into(),
            Some("settlement_after_terminal_report".into())
        )
    );
    assert_eq!(db.counts().await, (1, 0));
    db.finish().await;
}

#[tokio::test]
async fn success_must_match_the_saved_destination_amount_quote_and_settlement_evidence() {
    let db = TestDb::new().await;
    let provider = MockProvider::new(Value::Null).await;
    for (pointer, value, reason, credit) in [
        (
            "/quoteResponse/quoteRequest/recipient",
            json!("attacker.fixture.near"),
            "quote_binding_mismatch",
            false,
        ),
        (
            "/quoteResponse/quoteRequest/destinationAsset",
            json!("nep141:wrong.near"),
            "quote_binding_mismatch",
            false,
        ),
        (
            "/quoteResponse/quoteRequest/refundTo",
            json!("wrong.fixture.near"),
            "quote_binding_mismatch",
            false,
        ),
        (
            "/quoteResponse/quote/depositAddress",
            json!("replayed.fixture.near"),
            "quote_binding_mismatch",
            false,
        ),
        (
            "/quoteResponse/correlationId",
            json!("wrong-correlation"),
            "quote_binding_mismatch",
            false,
        ),
        (
            "/swapDetails/amountOut",
            json!("999999"),
            "settlement_amount_mismatch",
            true,
        ),
        (
            "/swapDetails/amountOut",
            json!("1000001"),
            "settlement_amount_mismatch",
            true,
        ),
        (
            "/swapDetails/amountOut",
            json!("1e6"),
            "incomplete_settlement_evidence",
            false,
        ),
        (
            "/swapDetails/amountOut",
            json!("0"),
            "incomplete_settlement_evidence",
            false,
        ),
        (
            "/swapDetails/nearTxHashes",
            json!([]),
            "incomplete_settlement_evidence",
            false,
        ),
        (
            "/status",
            json!("UNRECOGNIZED"),
            "unsupported_provider_status",
            false,
        ),
        (
            "/updatedAt",
            json!(Utc::now() + Duration::hours(1)),
            "provider_clock_invalid",
            false,
        ),
        (
            "/updatedAt",
            json!(Utc::now() - Duration::hours(1)),
            "provider_clock_invalid",
            false,
        ),
    ] {
        let (id, quote) = db.invoice().await;
        let mut payload = status(&quote, "SUCCESS");
        *payload.pointer_mut(pointer).unwrap() = value;
        provider.set(payload);
        reconcile_once(&db.pool, &provider.client).await.unwrap();
        let (state, why) = db.state(id).await;
        assert_eq!(
            state,
            if credit { "held" } else { "needs_review" },
            "{pointer}"
        );
        assert_eq!(why.as_deref(), Some(reason), "{pointer}");
    }
    assert_eq!(db.counts().await, (2, 0));
    db.finish().await;
}

#[tokio::test]
async fn destination_chain_receipts_need_destination_transaction_evidence() {
    let db = TestDb::new().await;
    let provider = MockProvider::new(Value::Null).await;
    for valid in [false, true] {
        let (mut terms, mut quote) = db.quote();
        terms.quote_request["recipientType"] = json!("DESTINATION_CHAIN");
        quote.quote_request = terms.quote_request.clone();
        let id = record_quote(&db.pool, &terms, &quote).await.unwrap();
        let mut payload = status(&quote, "SUCCESS");
        if valid {
            payload["swapDetails"]["destinationChainTxHashes"] =
                json!([{"hash":"fixture-destination-tx"}]);
        }
        provider.set(payload);
        reconcile_once(&db.pool, &provider.client).await.unwrap();
        assert_eq!(
            db.state(id).await.0,
            if valid { "settled" } else { "needs_review" }
        );
    }
    assert_eq!(db.counts().await, (1, 1));
    db.finish().await;
}

#[tokio::test]
async fn expiry_keeps_watching_and_late_money_is_recorded_without_starting_work() {
    let db = TestDb::new().await;
    let (mut terms, mut quote) = db.quote();
    let deadline = Utc::now() + Duration::seconds(2);
    quote.quote["deadline"] = json!(deadline);
    quote.quote_request["deadline"] = json!(deadline);
    terms.quote_request = quote.quote_request.clone();
    let id = record_quote(&db.pool, &terms, &quote).await.unwrap();
    let provider = MockProvider::new(status(&quote, "PENDING_DEPOSIT")).await;
    tokio::time::sleep(std::time::Duration::from_millis(2050)).await;
    reconcile_once(&db.pool, &provider.client).await.unwrap();
    assert_eq!(db.state(id).await.0, "expired");
    assert_eq!(db.counts().await, (0, 0));
    provider.set(status(&quote, "SUCCESS"));
    db.due(id).await;
    reconcile_once(&db.pool, &provider.client).await.unwrap();
    assert_eq!(
        db.state(id).await,
        ("held".into(), Some("settlement_after_deadline".into()))
    );
    assert_eq!(db.counts().await, (1, 0));
    db.finish().await;
}

#[tokio::test]
async fn provider_errors_are_retryable_bounded_and_do_not_become_a_failed_payment() {
    let db = TestDb::new().await;
    let (id, quote) = db.invoice().await;
    let provider = MockProvider::new(Value::Null).await;
    for (code, body) in [
        (StatusCode::NOT_FOUND, "{}".into()),
        (StatusCode::UNAUTHORIZED, "{}".into()),
        (StatusCode::TOO_MANY_REQUESTS, "{}".into()),
        (StatusCode::FOUND, "{}".into()),
        (StatusCode::OK, "broken json".into()),
        (StatusCode::OK, " ".repeat(RESPONSE_LIMIT + 1)),
    ] {
        *provider.body.lock().unwrap() = (code, body);
        db.due(id).await;
        let result = reconcile_once(&db.pool, &provider.client).await.unwrap();
        assert_eq!(result.checked, 1);
        assert_eq!(result.unavailable, 1);
        assert_eq!(db.state(id).await.0, "pending");
        assert_eq!(db.counts().await, (0, 0));
        assert_eq!(
            reconcile_once(&db.pool, &provider.client)
                .await
                .unwrap()
                .checked,
            0
        );
    }
    provider.set(status(&quote, "SUCCESS"));
    db.due(id).await;
    reconcile_once(&db.pool, &provider.client).await.unwrap();
    assert_eq!(db.counts().await, (1, 1));
    db.finish().await;
}

#[tokio::test]
async fn stale_provider_replies_and_old_worker_claims_cannot_replace_newer_state() {
    let db = TestDb::new().await;
    let (id, quote) = db.invoice().await;
    let mut current = status(&quote, "PROCESSING");
    current["updatedAt"] = json!(Utc::now() + Duration::seconds(2));
    let provider = MockProvider::new(current).await;
    reconcile_once(&db.pool, &provider.client).await.unwrap();
    provider.set(status(&quote, "SUCCESS"));
    db.due(id).await;
    reconcile_once(&db.pool, &provider.client).await.unwrap();
    assert_eq!(db.state(id).await.0, "processing");
    assert_eq!(db.counts().await, (0, 0));
    let old = Uuid::new_v4();
    let new = Uuid::new_v4();
    sqlx::query("UPDATE payment_invoices SET poll_token = $2 WHERE id = $1")
        .bind(id)
        .bind(new)
        .execute(&db.pool)
        .await
        .unwrap();
    apply_status(
        &db.pool,
        id,
        old,
        serde_json::from_value(status(&quote, "SUCCESS")).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(db.counts().await, (0, 0));
    let token: Option<Uuid> =
        sqlx::query_scalar("SELECT poll_token FROM payment_invoices WHERE id = $1")
            .bind(id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(token, Some(new));
    db.finish().await;
}

#[tokio::test]
async fn an_outbox_failure_rolls_back_the_ledger_and_a_retry_finishes_once() {
    let db = TestDb::new().await;
    let (id, quote) = db.invoice().await;
    let provider = MockProvider::new(status(&quote, "SUCCESS")).await;
    sqlx::query(
        "ALTER TABLE payment_funding_events ADD CONSTRAINT fixture_fail CHECK (amount < 0)",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    assert!(reconcile_once(&db.pool, &provider.client).await.is_err());
    assert_eq!(db.counts().await, (0, 0));
    assert_eq!(db.state(id).await.0, "pending");
    sqlx::query("ALTER TABLE payment_funding_events DROP CONSTRAINT fixture_fail")
        .execute(&db.pool)
        .await
        .unwrap();
    // Simulate restart after the abandoned 30-second claim expires.
    sqlx::query("UPDATE payment_invoices SET poll_until = now()-interval '1 second' WHERE id = $1")
        .bind(id)
        .execute(&db.pool)
        .await
        .unwrap();
    reconcile_once(&db.pool, &provider.client).await.unwrap();
    assert_eq!(db.counts().await, (1, 1));
    db.finish().await;
}

#[tokio::test]
async fn abandoned_quotes_reach_manual_review_instead_of_polling_forever() {
    let db = TestDb::new().await;
    let (id, quote) = db.invoice().await;
    let provider = MockProvider::new(status(&quote, "SUCCESS")).await;
    sqlx::query("UPDATE payment_invoices SET deadline = now()-interval '8 days', watch_until = now()-interval '1 second' WHERE id = $1")
        .bind(id).execute(&db.pool).await.unwrap();
    reconcile_once(&db.pool, &provider.client).await.unwrap();
    assert_eq!(
        db.state(id).await,
        (
            "needs_review".into(),
            Some("reconciliation_window_elapsed".into())
        )
    );
    assert_eq!(provider.calls.lock().unwrap().len(), 0);
    assert_eq!(db.counts().await, (0, 0));
    db.finish().await;
}
