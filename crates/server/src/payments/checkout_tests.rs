use super::*;
use crate::{Config, payments::checkout::*};
use patchriot_protocol::website_reviews::CreateWebsiteReview;
use std::sync::atomic::AtomicBool;
use tokio::sync::{Notify, Semaphore};

#[path = "funding_tests.rs"]
mod funding;

fn terms(db: &TestDb) -> (CheckoutTerms, QuoteResponse) {
    let (payment, quote) = db.quote();
    let consent = CreateWebsiteReview {
        request_id: payment.request_id,
        snapshot_sha256: "a".repeat(64),
        device_ids: vec![Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()],
        accepts_operator_access: true,
    };
    (
        CheckoutTerms {
            site_check_id: Uuid::new_v4(),
            consent,
            payment,
        },
        quote,
    )
}

struct AdmissionServer {
    state: AppState,
    reply: Arc<Mutex<(StatusCode, Value)>>,
    calls: Arc<Mutex<Vec<Value>>>,
    pause_next: Arc<AtomicBool>,
    entered: Arc<Notify>,
    release: Arc<Semaphore>,
    task: tokio::task::JoinHandle<()>,
}
impl AdmissionServer {
    async fn new(db: &TestDb, terms: &CheckoutTerms) -> Self {
        let time = date(&terms.payment.quote_request["deadline"]).unwrap();
        let expires = time.timestamp() + i64::from(time.timestamp_subsec_nanos() != 0);
        let reply = Arc::new(Mutex::new((
            StatusCode::OK,
            json!({
                "id":Uuid::new_v4(), "request_id":terms.payment.request_id,
                "scenario":"website_snapshot_v1", "mode":"website_agent", "state":"awaiting_payment",
                "created_at":Utc::now().timestamp(), "deadline_at":expires,
                "evidence_source":"saved website snapshot", "steps":[],
                "website":{"site_check_id":terms.site_check_id,"snapshot_sha256":terms.consent.snapshot_sha256,
                    "reviewers":terms.consent.device_ids.iter().map(|id| json!({
                        "device_id":id,"operator_id":Uuid::new_v4(),"operator_name":"Fixture operator",
                        "device_name":"Fixture device","declared_model":"Fixture model","compute_group":"Fixture host"
                    })).collect::<Vec<_>>()},
                "payment":{"price":{"asset":terms.payment.destination_asset,"amount":terms.payment.required_amount.to_string()},
                    "expires_at":expires,"invoice_id":null,"funded_at":null}
            }),
        )));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let pause_next = Arc::new(AtomicBool::new(false));
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let (output, observed, pause, arrival, gate) = (
            reply.clone(),
            calls.clone(),
            pause_next.clone(),
            entered.clone(),
            release.clone(),
        );
        let pool = db.pool.clone();
        let account = db.account.to_string();
        let app = Router::new().route(&format!("/internal/site-checks/{}/admit-review",terms.site_check_id),post(move |headers:HeaderMap,Json(input):Json<Value>| {
            let (output, observed, pause, arrival, gate, pool, account) = (output.clone(),observed.clone(),pause.clone(),arrival.clone(),gate.clone(),pool.clone(),account.clone());
            async move {
                assert_eq!(headers["authorization"], "Bearer checkout-fixture-internal-service-key");
                assert_eq!(headers["x-patchriot-account"], account);
                assert_eq!(headers["x-patchriot-role"], "member");
                let request:Uuid=serde_json::from_value(input["consent"]["request_id"].clone()).unwrap();
                let saved:bool=sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM checkout_orders WHERE request_id=$1 AND operation_token IS NOT NULL)")
                    .bind(request).fetch_one(&pool).await.unwrap();
                assert!(saved,"order must commit before dispatcher HTTP");
                observed.lock().unwrap().push(input);
                if pause.swap(false,Ordering::SeqCst) {
                    arrival.notify_one();
                    let permit=gate.acquire().await.unwrap(); permit.forget();
                }
                let (status, body)=output.lock().unwrap().clone();
                (status,Json(body))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = Config::new(
            "http://127.0.0.1:7410".into(),
            format!("http://{}", listener.local_addr().unwrap()),
            "checkout-fixture-internal-service-key".into(),
            None,
        )
        .unwrap();
        let state = AppState::new(db.pool.clone(), config).unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            state,
            reply,
            calls,
            pause_next,
            entered,
            release,
            task,
        }
    }
    fn pause(&self) {
        self.pause_next.store(true, Ordering::SeqCst);
    }
    async fn wait(&self) {
        tokio::time::timeout(std::time::Duration::from_secs(3), self.entered.notified())
            .await
            .unwrap();
    }
}
impl Drop for AdmissionServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
async fn saved_checkout_reuses_one_invoice_and_refreshes_admission_without_another_quote() {
    let db = TestDb::new().await;
    let (terms, quote) = terms(&db);
    let dispatcher = AdmissionServer::new(&db, &terms).await;
    let provider = MockProvider::new(json!(quote)).await;
    let first = prepare(&dispatcher.state, &provider.client, &terms)
        .await
        .unwrap();
    let saved:(String,Uuid,Uuid,bool)=sqlx::query_as("SELECT state, review_id, invoice_id, operation_token IS NULL FROM checkout_orders WHERE id=$1")
        .bind(first.order_id).fetch_one(&db.pool).await.unwrap();
    assert_eq!(
        saved,
        (
            "awaiting_payment".into(),
            first.review_id,
            first.invoice_id,
            true
        )
    );
    assert_eq!(
        db.counts().await,
        (0, 0),
        "a prepared checkout cannot fund work"
    );
    let second = resume(
        &dispatcher.state,
        &provider.client,
        db.account,
        terms.payment.request_id,
    )
    .await
    .unwrap();
    assert_eq!(
        (second.order_id, second.review_id, second.invoice_id),
        (first.order_id, first.review_id, first.invoice_id)
    );
    assert_eq!(serde_json::to_value(second.payment).unwrap(), json!(quote));
    assert_eq!(provider.quote_calls.lock().unwrap().len(), 1);
    assert_eq!(
        dispatcher.calls.lock().unwrap().len(),
        2,
        "recheck that the reserved work is still payable"
    );
    assert!(matches!(
        resume(
            &dispatcher.state,
            &provider.client,
            Uuid::new_v4(),
            terms.payment.request_id
        )
        .await,
        Err(CheckoutError::Closed)
    ));
    db.finish().await;
}

#[tokio::test]
async fn simultaneous_checkout_and_changed_terms_never_make_competing_deposit_instructions() {
    let db = TestDb::new().await;
    let (terms, quote) = terms(&db);
    let dispatcher = AdmissionServer::new(&db, &terms).await;
    let provider = MockProvider::new(json!(quote)).await;
    dispatcher.pause();
    let first = prepare(&dispatcher.state, &provider.client, &terms);
    let second = async {
        dispatcher.wait().await;
        assert!(matches!(
            prepare(&dispatcher.state, &provider.client, &terms).await,
            Err(CheckoutError::InProgress)
        ));
        for field in ["price", "refund", "deadline", "snapshot", "devices", "site"] {
            let mut changed = terms.clone();
            match field {
                "price" => {
                    changed.payment.required_amount += 1;
                    changed.payment.quote_request["amount"] =
                        json!(changed.payment.required_amount.to_string());
                }
                "refund" => changed.payment.quote_request["refundTo"] = json!("other.fixture.near"),
                "deadline" => {
                    changed.payment.quote_request["deadline"] =
                        json!((Utc::now() + Duration::minutes(6)).to_rfc3339())
                }
                "snapshot" => changed.consent.snapshot_sha256 = "b".repeat(64),
                "devices" => changed.consent.device_ids.swap(0, 1),
                "site" => changed.site_check_id = Uuid::new_v4(),
                _ => unreachable!(),
            }
            assert!(
                matches!(
                    prepare(&dispatcher.state, &provider.client, &changed).await,
                    Err(CheckoutError::ConflictingTerms)
                ),
                "{field}"
            );
        }
        assert!(provider.quote_calls.lock().unwrap().is_empty());
        dispatcher.release.add_permits(1);
    };
    let (first, ()) = tokio::join!(first, second);
    first.unwrap();
    assert_eq!(provider.quote_calls.lock().unwrap().len(), 1);
    db.finish().await;
}

#[tokio::test]
async fn unavailable_admission_resumes_the_original_saved_request_without_quoting_early() {
    let db = TestDb::new().await;
    let (terms, quote) = terms(&db);
    let dispatcher = AdmissionServer::new(&db, &terms).await;
    let provider = MockProvider::new(json!(quote)).await;
    dispatcher.reply.lock().unwrap().0 = StatusCode::SERVICE_UNAVAILABLE;
    assert!(matches!(
        prepare(&dispatcher.state, &provider.client, &terms).await,
        Err(CheckoutError::AdmissionUnavailable)
    ));
    assert!(provider.quote_calls.lock().unwrap().is_empty());
    dispatcher.reply.lock().unwrap().0 = StatusCode::OK;
    let result = resume(
        &dispatcher.state,
        &provider.client,
        db.account,
        terms.payment.request_id,
    )
    .await
    .unwrap();
    {
        let calls = dispatcher.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0], calls[1]);
    }
    assert_eq!(
        json!(result.review_id),
        dispatcher.reply.lock().unwrap().1["id"]
    );
    db.finish().await;
}

#[tokio::test]
async fn conflicting_admission_is_closed_before_the_provider_is_contacted() {
    for field in ["price", "snapshot", "devices", "expiry", "funded", "mode"] {
        let db = TestDb::new().await;
        let (terms, quote) = terms(&db);
        let dispatcher = AdmissionServer::new(&db, &terms).await;
        let provider = MockProvider::new(json!(quote)).await;
        {
            let mut reply = dispatcher.reply.lock().unwrap();
            let body = &mut reply.1;
            match field {
                "price" => body["payment"]["price"]["amount"] = json!("1"),
                "snapshot" => body["website"]["snapshot_sha256"] = json!("b".repeat(64)),
                "devices" => body["website"]["reviewers"]
                    .as_array_mut()
                    .unwrap()
                    .swap(0, 1),
                "expiry" => body["payment"]["expires_at"] = json!(1),
                "funded" => body["payment"]["invoice_id"] = json!(Uuid::new_v4()),
                "mode" => body["mode"] = json!("fixture"),
                _ => unreachable!(),
            }
        }
        assert!(
            matches!(
                prepare(&dispatcher.state, &provider.client, &terms).await,
                Err(CheckoutError::InvalidAdmission)
            ),
            "{field}"
        );
        assert!(matches!(
            prepare(&dispatcher.state, &provider.client, &terms).await,
            Err(CheckoutError::Closed)
        ));
        assert!(provider.quote_calls.lock().unwrap().is_empty());
        db.finish().await;
    }
}

#[tokio::test]
async fn a_saved_quote_is_not_shown_after_expiry_cancellation_or_payment_started() {
    for reason in ["expiry", "cancelled", "processing", "review_changed"] {
        let db = TestDb::new().await;
        let (terms, quote) = terms(&db);
        let dispatcher = AdmissionServer::new(&db, &terms).await;
        let provider = MockProvider::new(json!(quote)).await;
        let saved = prepare(&dispatcher.state, &provider.client, &terms)
            .await
            .unwrap();
        match reason {
            "expiry" => {
                sqlx::query(
                    "UPDATE payment_invoices SET deadline=now()-interval '1 second' WHERE id=$1",
                )
                .bind(saved.invoice_id)
                .execute(&db.pool)
                .await
                .unwrap();
            }
            "cancelled" => dispatcher.reply.lock().unwrap().1["state"] = json!("cancelled"),
            "processing" => {
                sqlx::query("UPDATE payment_invoices SET state='processing' WHERE id=$1")
                    .bind(saved.invoice_id)
                    .execute(&db.pool)
                    .await
                    .unwrap();
            }
            "review_changed" => dispatcher.reply.lock().unwrap().1["id"] = json!(Uuid::new_v4()),
            _ => unreachable!(),
        }
        assert!(
            prepare(&dispatcher.state, &provider.client, &terms)
                .await
                .is_err(),
            "{reason}"
        );
        assert_eq!(provider.quote_calls.lock().unwrap().len(), 1);
        db.finish().await;
    }
}

#[tokio::test]
async fn rejected_provider_quote_and_failed_attachment_leave_no_partial_invoice() {
    let db = TestDb::new().await;
    let (terms, quote) = terms(&db);
    let dispatcher = AdmissionServer::new(&db, &terms).await;
    let mut bad = quote.clone();
    bad.quote["amountOut"] = json!("1");
    let provider = MockProvider::new(json!(bad)).await;
    assert!(matches!(
        prepare(&dispatcher.state, &provider.client, &terms).await,
        Err(CheckoutError::Payment(PaymentError::InvalidQuote))
    ));
    provider.set(json!(quote));
    // Simulate a storage failure after record_quote_in inserted the invoice.
    sqlx::query(
        "ALTER TABLE checkout_orders ADD CONSTRAINT fixture_no_invoice CHECK (invoice_id IS NULL)",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    assert!(matches!(
        prepare(&dispatcher.state, &provider.client, &terms).await,
        Err(CheckoutError::Database)
    ));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM payment_invoices")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "invoice and order attachment must roll back together"
    );
    sqlx::query("ALTER TABLE checkout_orders DROP CONSTRAINT fixture_no_invoice")
        .execute(&db.pool)
        .await
        .unwrap();
    let saved = resume(
        &dispatcher.state,
        &provider.client,
        db.account,
        terms.payment.request_id,
    )
    .await
    .unwrap();
    assert_eq!(serde_json::to_value(saved.payment).unwrap(), json!(quote));
    db.finish().await;
}

#[tokio::test]
async fn lost_claim_or_disabled_account_blocks_quote_after_admission_reply() {
    for mutation in ["expired_claim", "replaced_claim", "disabled"] {
        let db = TestDb::new().await;
        let (terms, quote) = terms(&db);
        let dispatcher = AdmissionServer::new(&db, &terms).await;
        let provider = MockProvider::new(json!(quote)).await;
        dispatcher.pause();
        let operation = prepare(&dispatcher.state, &provider.client, &terms);
        let interrupt = async {
            dispatcher.wait().await;
            let sql = match mutation {
                "expired_claim" => {
                    "UPDATE checkout_orders SET operation_until=now()-interval '1 second' WHERE account_id=$1"
                }
                "replaced_claim" => {
                    "UPDATE checkout_orders SET operation_token=gen_random_uuid(), operation_until=now()+interval '30 seconds' WHERE account_id=$1"
                }
                "disabled" => "UPDATE accounts SET disabled=true WHERE id=$1",
                _ => unreachable!(),
            };
            sqlx::query(sql)
                .bind(db.account)
                .execute(&db.pool)
                .await
                .unwrap();
            dispatcher.release.add_permits(1);
        };
        let (result, ()) = tokio::join!(operation, interrupt);
        assert!(
            matches!(
                result,
                Err(CheckoutError::StaleOperation | CheckoutError::AccountUnavailable)
            ),
            "{mutation}"
        );
        assert!(provider.quote_calls.lock().unwrap().is_empty());
        if mutation == "replaced_claim" {
            let retained: bool = sqlx::query_scalar(
                "SELECT operation_token IS NOT NULL FROM checkout_orders WHERE account_id=$1",
            )
            .bind(db.account)
            .fetch_one(&db.pool)
            .await
            .unwrap();
            assert!(
                retained,
                "an older operation must not clear its replacement's claim"
            );
        }
        db.finish().await;
    }
}

#[tokio::test]
async fn late_provider_reply_cannot_publish_after_account_disable_claim_expiry_or_cancellation() {
    for mutation in ["disabled", "expired_claim", "cancellation"] {
        let db = TestDb::new().await;
        let (terms, quote) = terms(&db);
        let dispatcher = AdmissionServer::new(&db, &terms).await;
        let pool = db.pool.clone();
        let account = db.account;
        let app=Router::new().route("/v0/quote",post(move || {
            let pool=pool.clone();let quote=quote.clone();
            async move {
                let bound:bool=sqlx::query_scalar("SELECT review_id IS NOT NULL FROM checkout_orders WHERE account_id=$1").bind(account).fetch_one(&pool).await.unwrap();
                assert!(bound,"review binding must commit before quote HTTP");
                if mutation=="cancellation" {
                    let order:Uuid=sqlx::query_scalar("SELECT id FROM checkout_orders WHERE account_id=$1").bind(account).fetch_one(&pool).await.unwrap();
                    crate::payments::cancellation::request(&pool,account,order).await.unwrap();
                } else {
                    let sql=if mutation=="disabled" {"UPDATE accounts SET disabled=true WHERE id=$1"} else {"UPDATE checkout_orders SET operation_until=now()-interval '1 second' WHERE account_id=$1"};
                    sqlx::query(sql).bind(account).execute(&pool).await.unwrap();
                }
                Json(quote)
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let provider = OneClick::with_origin(
            &format!("http://{}", listener.local_addr().unwrap()),
            "fixture-only",
        )
        .unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        assert!(
            matches!(
                prepare(&dispatcher.state, &provider, &terms).await,
                Err(CheckoutError::AccountUnavailable | CheckoutError::StaleOperation)
            ),
            "{mutation}"
        );
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM payment_invoices")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        if mutation == "cancellation" {
            let stopped:bool=sqlx::query_scalar("SELECT state='cancelled' AND cancel_requested_at IS NOT NULL AND invoice_id IS NULL FROM checkout_orders WHERE account_id=$1").bind(account).fetch_one(&db.pool).await.unwrap();
            assert!(
                stopped,
                "a late quote reply cannot reopen checkout or publish an invoice"
            );
        }
        task.abort();
        db.finish().await;
    }
}
