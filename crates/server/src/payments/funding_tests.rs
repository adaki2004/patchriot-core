use super::*;
use crate::payments::funding::deliver_once;

#[path = "cancellation_tests.rs"]
mod cancellation;

struct FundingServer {
    state: AppState,
    view: Arc<Mutex<Value>>,
    reads: Arc<AtomicUsize>,
    posts: Arc<Mutex<Vec<Value>>>,
    activations: Arc<AtomicUsize>,
    reject_post: Arc<AtomicBool>,
    lose_reply: Arc<AtomicBool>,
    wrong_reply: Arc<AtomicBool>,
    pause_get: Arc<AtomicBool>,
    pause_post: Arc<AtomicBool>,
    entered: Arc<Notify>,
    release: Arc<Semaphore>,
    task: tokio::task::JoinHandle<()>,
}
impl FundingServer {
    async fn new(db: &TestDb, initial: Value) -> Self {
        let view = Arc::new(Mutex::new(initial));
        let reads = Arc::new(AtomicUsize::new(0));
        let posts = Arc::new(Mutex::new(Vec::new()));
        let activations = Arc::new(AtomicUsize::new(0));
        let reject_post = Arc::new(AtomicBool::new(false));
        let lose_reply = Arc::new(AtomicBool::new(false));
        let wrong_reply = Arc::new(AtomicBool::new(false));
        let pause_get = Arc::new(AtomicBool::new(false));
        let pause_post = Arc::new(AtomicBool::new(false));
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let account = db.account.to_string();
        let path = format!(
            "/internal/reviews/{}",
            view.lock().unwrap()["id"].as_str().unwrap()
        );
        let (get_view, get_reads, get_pause, get_entered, get_release, get_account) = (
            view.clone(),
            reads.clone(),
            pause_get.clone(),
            entered.clone(),
            release.clone(),
            account.clone(),
        );
        let (
            post_view,
            post_calls,
            post_activations,
            post_reject,
            post_lost,
            post_wrong,
            post_pause,
            post_entered,
            post_release,
        ) = (
            view.clone(),
            posts.clone(),
            activations.clone(),
            reject_post.clone(),
            lose_reply.clone(),
            wrong_reply.clone(),
            pause_post.clone(),
            entered.clone(),
            release.clone(),
        );
        let app = Router::new()
            .route(
                &path,
                get(move |headers: HeaderMap| {
                    let (view, reads, pause, entered, release, account) = (
                        get_view.clone(),
                        get_reads.clone(),
                        get_pause.clone(),
                        get_entered.clone(),
                        get_release.clone(),
                        get_account.clone(),
                    );
                    async move {
                        assert_owner(&headers, &account);
                        reads.fetch_add(1, Ordering::SeqCst);
                        if pause.swap(false, Ordering::SeqCst) {
                            entered.notify_one();
                            let permit = release.acquire().await.unwrap();
                            permit.forget();
                        }
                        Json(view.lock().unwrap().clone())
                    }
                }),
            )
            .route(
                &format!("{path}/fund"),
                post(move |headers: HeaderMap, Json(body): Json<Value>| {
                    let (
                        view,
                        calls,
                        activations,
                        reject,
                        lost,
                        wrong,
                        pause,
                        entered,
                        release,
                        account,
                    ) = (
                        post_view.clone(),
                        post_calls.clone(),
                        post_activations.clone(),
                        post_reject.clone(),
                        post_lost.clone(),
                        post_wrong.clone(),
                        post_pause.clone(),
                        post_entered.clone(),
                        post_release.clone(),
                        account.clone(),
                    );
                    async move {
                        assert_owner(&headers, &account);
                        calls.lock().unwrap().push(body.clone());
                        if pause.swap(false, Ordering::SeqCst) {
                            entered.notify_one();
                            let permit = release.acquire().await.unwrap();
                            permit.forget();
                        }
                        if reject.load(Ordering::SeqCst) {
                            return (
                                StatusCode::CONFLICT,
                                Json(json!({"error":"selected_device_unavailable"})),
                            );
                        }
                        let mut saved = view.lock().unwrap();
                        assert_eq!(body["request_id"], saved["request_id"]);
                        assert_eq!(body["price"], saved["payment"]["price"]);
                        if saved["payment"]["invoice_id"].is_null() {
                            saved["payment"]["invoice_id"] = body["invoice_id"].clone();
                            saved["payment"]["funded_at"] = json!(Utc::now().timestamp());
                            saved["state"] = json!("queued");
                            activations.fetch_add(1, Ordering::SeqCst);
                        } else {
                            assert_eq!(body["invoice_id"], saved["payment"]["invoice_id"]);
                        }
                        if lost.load(Ordering::SeqCst) {
                            return (
                                StatusCode::SERVICE_UNAVAILABLE,
                                Json(json!({"error":"lost_reply"})),
                            );
                        }
                        let mut reply = saved.clone();
                        if wrong.load(Ordering::SeqCst) {
                            reply["payment"]["invoice_id"] = json!(Uuid::new_v4());
                        }
                        (StatusCode::OK, Json(reply))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = Config::new(
            "http://127.0.0.1:7410".into(),
            format!("http://{}", listener.local_addr().unwrap()),
            "funding-fixture-internal-service-key".into(),
            None,
        )
        .unwrap();
        let state = AppState::new(db.pool.clone(), config).unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            state,
            view,
            reads,
            posts,
            activations,
            reject_post,
            lose_reply,
            wrong_reply,
            pause_get,
            pause_post,
            entered,
            release,
            task,
        }
    }
    async fn wait(&self) {
        tokio::time::timeout(std::time::Duration::from_secs(3), self.entered.notified())
            .await
            .unwrap();
    }
}
fn assert_owner(headers: &HeaderMap, account: &str) {
    assert_eq!(
        headers["authorization"],
        "Bearer funding-fixture-internal-service-key"
    );
    assert_eq!(headers["x-patchriot-account"], account);
    assert_eq!(headers["x-patchriot-role"], "member");
}
impl Drop for FundingServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct Fixture {
    db: TestDb,
    checkout: CheckoutQuote,
    server: FundingServer,
    provider: MockProvider,
    quote: QuoteResponse,
}
impl Fixture {
    async fn new(settle: bool) -> Self {
        let db = TestDb::new().await;
        let (terms, quote) = terms(&db);
        let admission = AdmissionServer::new(&db, &terms).await;
        let provider = MockProvider::new(json!(quote)).await;
        let checkout = prepare(&admission.state, &provider.client, &terms)
            .await
            .unwrap();
        let initial = admission.reply.lock().unwrap().1.clone();
        let server = FundingServer::new(&db, initial).await;
        if settle {
            provider.set(status(&quote, "SUCCESS"));
            reconcile_once(&db.pool, &provider.client).await.unwrap();
        }
        Self {
            db,
            checkout,
            server,
            provider,
            quote,
        }
    }
    async fn due(&self) {
        sqlx::query("UPDATE payment_funding_events SET next_delivery_at=now()-interval '1 second', delivery_until=CASE WHEN delivery_token IS NULL THEN NULL ELSE now()-interval '1 second' END WHERE invoice_id=$1")
            .bind(self.checkout.invoice_id).execute(&self.db.pool).await.unwrap();
    }
    async fn event(&self) -> (String, bool, Option<String>) {
        sqlx::query_as("SELECT delivery_state, consumed_at IS NOT NULL, delivery_error FROM payment_funding_events WHERE invoice_id=$1")
            .bind(self.checkout.invoice_id).fetch_one(&self.db.pool).await.unwrap()
    }
    async fn order(&self) -> (String, Option<String>) {
        sqlx::query_as("SELECT state,last_error FROM checkout_orders WHERE id=$1")
            .bind(self.checkout.order_id)
            .fetch_one(&self.db.pool)
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn settlement_activates_its_saved_review_once_without_a_second_credit() {
    let f = Fixture::new(false).await;
    assert_eq!(deliver_once(&f.server.state).await.unwrap().checked, 0);
    assert_eq!(f.server.reads.load(Ordering::SeqCst), 0);
    f.provider.set(status(&f.quote, "SUCCESS"));
    reconcile_once(&f.db.pool, &f.provider.client)
        .await
        .unwrap();
    let result = deliver_once(&f.server.state).await.unwrap();
    assert_eq!(
        (result.checked, result.delivered, result.needs_review),
        (1, 1, 0)
    );
    assert_eq!(f.event().await, ("delivered".into(), true, None));
    assert_eq!(f.order().await, ("activated".into(), None));
    assert_eq!(f.db.counts().await, (1, 1));
    f.due().await;
    assert_eq!(deliver_once(&f.server.state).await.unwrap().checked, 0);
    assert_eq!(f.server.activations.load(Ordering::SeqCst), 1);
    assert_eq!(f.server.posts.lock().unwrap().len(), 1);
    assert_eq!(f.db.counts().await, (1, 1));
    f.db.finish().await;
}

#[tokio::test]
async fn continuous_worker_accepts_provider_defaults_and_restarts_without_double_credit() {
    let db = TestDb::new().await;
    let (terms, mut quote) = terms(&db);
    quote.quote_request["confidentiality"] = json!("public");
    quote.quote_request["quoteWaitingTimeMs"] = json!(0);
    quote.quote_request["insured"] = json!(false);
    quote.quote_request["appFees"] = json!([{"recipient":"fixture-provider.near","fee":1}]);
    quote.quote_request["deadline"] = json!(
        date(&terms.payment.quote_request["deadline"])
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    );
    let admission = AdmissionServer::new(&db, &terms).await;
    let provider = MockProvider::new(json!(quote)).await;
    let checkout = prepare(&admission.state, &provider.client, &terms)
        .await
        .unwrap();
    let initial = admission.reply.lock().unwrap().1.clone();
    let server = FundingServer::new(&db, initial).await;
    provider.set(status(&quote, "PENDING_DEPOSIT"));
    let pending = crate::payments::worker::tick(&server.state, &provider.client).await;
    assert_eq!(
        serde_json::to_value(pending).unwrap()["funding"]["delivered"],
        0
    );
    assert_eq!(db.counts().await, (0, 0));
    db.due(checkout.invoice_id).await;
    provider.set(status(&quote, "SUCCESS"));
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let run = crate::payments::worker::run(&server.state, &provider.client, async {
        let _ = stopped.await;
    });
    let observe = async {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let ready: bool = sqlx::query_scalar(
                    "SELECT state = 'activated' FROM checkout_orders WHERE id = $1",
                )
                .bind(checkout.order_id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
                if ready {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        stop.send(()).unwrap();
    };
    tokio::join!(run, observe);
    let again = crate::payments::worker::tick(&server.state, &provider.client).await;
    assert_eq!(
        serde_json::to_value(again).unwrap()["funding"]["delivered"],
        0
    );
    assert_eq!(db.counts().await, (1, 1));
    assert_eq!(server.activations.load(Ordering::SeqCst), 1);
    db.finish().await;
}

#[tokio::test]
async fn an_event_without_a_recorded_settlement_cannot_start_work() {
    let f = Fixture::new(false).await;
    sqlx::query("INSERT INTO payment_funding_events (invoice_id, account_id, request_id, asset, amount) SELECT id, account_id, request_id, asset, required_amount FROM payment_invoices WHERE id=$1")
        .bind(f.checkout.invoice_id).execute(&f.db.pool).await.unwrap();
    // Even an accidentally advanced invoice still needs the immutable ledger.
    sqlx::query("UPDATE payment_invoices SET state='settled' WHERE id=$1")
        .bind(f.checkout.invoice_id)
        .execute(&f.db.pool)
        .await
        .unwrap();
    assert_eq!(deliver_once(&f.server.state).await.unwrap().needs_review, 1);
    assert_eq!(f.server.reads.load(Ordering::SeqCst), 0);
    assert!(f.server.posts.lock().unwrap().is_empty());
    assert_eq!(f.db.counts().await, (0, 1));
    f.db.finish().await;
}

#[tokio::test]
async fn unknown_remote_state_or_elapsed_confirmation_window_requires_review() {
    for reason in ["unknown_state", "watch_elapsed"] {
        let f = Fixture::new(true).await;
        if reason == "unknown_state" {
            let mut view = f.server.view.lock().unwrap();
            view["state"] = json!("unsupported_state");
            view["payment"]["invoice_id"] = json!(f.checkout.invoice_id);
            view["payment"]["funded_at"] = json!(Utc::now().timestamp());
        } else {
            sqlx::query("UPDATE payment_invoices SET deadline=now()-interval '2 days', watch_until=now()-interval '1 second' WHERE id=$1")
                .bind(f.checkout.invoice_id).execute(&f.db.pool).await.unwrap();
        }
        assert_eq!(deliver_once(&f.server.state).await.unwrap().needs_review, 1);
        assert!(!f.event().await.1);
        assert!(f.server.posts.lock().unwrap().is_empty());
        f.db.finish().await;
    }
}

#[tokio::test]
async fn mismatched_event_order_or_invoice_cannot_activate_work() {
    for mutation in [
        "UPDATE payment_funding_events SET amount=amount+1 WHERE invoice_id=$1",
        "UPDATE payment_funding_events SET request_id=gen_random_uuid() WHERE invoice_id=$1",
        "UPDATE checkout_orders SET terms=jsonb_set(terms,'{payment,recipient}','\"changed.fixture.near\"') WHERE invoice_id=$1",
        "UPDATE payment_invoices SET state='held' WHERE id=$1",
        "DELETE FROM checkout_orders WHERE invoice_id=$1",
    ] {
        let f = Fixture::new(true).await;
        sqlx::query(mutation)
            .bind(f.checkout.invoice_id)
            .execute(&f.db.pool)
            .await
            .unwrap();
        let result = deliver_once(&f.server.state).await.unwrap();
        assert_eq!(result.needs_review, 1);
        assert_eq!(f.event().await.0, "needs_review");
        assert_eq!(f.server.reads.load(Ordering::SeqCst), 0);
        assert!(f.server.posts.lock().unwrap().is_empty());
        assert_eq!(f.db.counts().await, (1, 1));
        f.db.finish().await;
    }
}

#[tokio::test]
async fn a_lost_activation_reply_is_recovered_even_after_account_disable_or_review_cancellation() {
    for terminal in ["completed", "cancelled"] {
        let f = Fixture::new(true).await;
        f.server.lose_reply.store(true, Ordering::SeqCst);
        assert_eq!(deliver_once(&f.server.state).await.unwrap().retrying, 1);
        assert_eq!(f.order().await.0, "awaiting_payment");
        f.server.view.lock().unwrap()["state"] = json!(terminal);
        crate::disable_account(&f.db.pool, f.db.account)
            .await
            .unwrap();
        f.due().await;
        assert_eq!(deliver_once(&f.server.state).await.unwrap().delivered, 1);
        assert_eq!(f.event().await, ("delivered".into(), true, None));
        assert_eq!(f.server.posts.lock().unwrap().len(), 1);
        assert_eq!(f.server.activations.load(Ordering::SeqCst), 1);
        assert_eq!(f.db.counts().await, (1, 1));
        f.db.finish().await;
    }
}

#[tokio::test]
async fn a_temporarily_unavailable_selected_device_can_resume_without_duplicate_activation() {
    let f = Fixture::new(true).await;
    f.server.reject_post.store(true, Ordering::SeqCst);
    assert_eq!(deliver_once(&f.server.state).await.unwrap().retrying, 1);
    assert_eq!(f.server.activations.load(Ordering::SeqCst), 0);
    assert_eq!(f.event().await.0, "pending");
    f.server.reject_post.store(false, Ordering::SeqCst);
    f.due().await;
    assert_eq!(deliver_once(&f.server.state).await.unwrap().delivered, 1);
    assert_eq!(f.server.activations.load(Ordering::SeqCst), 1);
    assert_eq!(f.server.posts.lock().unwrap().len(), 2);
    f.db.finish().await;
}

#[tokio::test]
async fn closed_review_expired_order_or_disabled_account_keeps_funds_for_review() {
    for reason in ["remote_cancel", "local_cancel", "expired", "disabled"] {
        let f = Fixture::new(true).await;
        match reason {
            "remote_cancel" => f.server.view.lock().unwrap()["state"] = json!("cancelled"),
            "local_cancel" => {
                sqlx::query("UPDATE checkout_orders SET state='cancelled' WHERE id=$1")
                    .bind(f.checkout.order_id)
                    .execute(&f.db.pool)
                    .await
                    .unwrap();
            }
            "expired" => {
                sqlx::query(
                    "UPDATE checkout_orders SET expires_at=now()-interval '1 second' WHERE id=$1",
                )
                .bind(f.checkout.order_id)
                .execute(&f.db.pool)
                .await
                .unwrap();
            }
            "disabled" => {
                crate::disable_account(&f.db.pool, f.db.account)
                    .await
                    .unwrap();
            }
            _ => unreachable!(),
        }
        assert_eq!(
            deliver_once(&f.server.state).await.unwrap().needs_review,
            1,
            "{reason}"
        );
        assert!(!f.event().await.1);
        assert_eq!(f.order().await.0, "needs_review");
        assert!(f.server.posts.lock().unwrap().is_empty());
        assert_eq!(f.db.counts().await, (1, 1));
        f.db.finish().await;
    }
}

#[tokio::test]
async fn concurrent_delivery_and_late_stale_replies_cannot_consume_another_workers_claim() {
    let f = Fixture::new(true).await;
    f.server.pause_post.store(true, Ordering::SeqCst);
    let first = deliver_once(&f.server.state);
    let interrupt = async {
        f.server.wait().await;
        assert_eq!(deliver_once(&f.server.state).await.unwrap().checked, 0);
        sqlx::query("UPDATE payment_funding_events SET delivery_token=gen_random_uuid() WHERE invoice_id=$1").bind(f.checkout.invoice_id).execute(&f.db.pool).await.unwrap();
        f.server.release.add_permits(1);
    };
    let (result, ()) = tokio::join!(first, interrupt);
    assert_eq!(result.unwrap().delivered, 0);
    assert_eq!(f.event().await.0, "pending");
    let claimed: bool = sqlx::query_scalar(
        "SELECT delivery_token IS NOT NULL FROM payment_funding_events WHERE invoice_id=$1",
    )
    .bind(f.checkout.invoice_id)
    .fetch_one(&f.db.pool)
    .await
    .unwrap();
    assert!(claimed);
    f.due().await;
    assert_eq!(deliver_once(&f.server.state).await.unwrap().delivered, 1);
    assert_eq!(f.server.posts.lock().unwrap().len(), 1);
    assert_eq!(f.server.activations.load(Ordering::SeqCst), 1);
    f.db.finish().await;
}

#[tokio::test]
async fn account_disable_between_status_read_and_post_cannot_start_work() {
    let f = Fixture::new(true).await;
    f.server.pause_get.store(true, Ordering::SeqCst);
    let delivery = deliver_once(&f.server.state);
    let interrupt = async {
        f.server.wait().await;
        crate::disable_account(&f.db.pool, f.db.account)
            .await
            .unwrap();
        f.server.release.add_permits(1);
    };
    let (result, ()) = tokio::join!(delivery, interrupt);
    assert_eq!(result.unwrap().needs_review, 1);
    assert!(f.server.posts.lock().unwrap().is_empty());
    assert_eq!(
        f.event().await.2.as_deref(),
        Some("funding_account_disabled")
    );
    f.db.finish().await;
}

#[tokio::test]
async fn activation_acknowledgment_and_order_state_commit_together_after_storage_failure() {
    let f = Fixture::new(true).await;
    sqlx::query("ALTER TABLE payment_funding_events ADD CONSTRAINT fixture_no_consume CHECK (consumed_at IS NULL)").execute(&f.db.pool).await.unwrap();
    assert!(matches!(
        deliver_once(&f.server.state).await,
        Err(PaymentError::Database)
    ));
    assert_eq!(f.event().await.0, "pending");
    assert_eq!(f.order().await.0, "awaiting_payment");
    sqlx::query("ALTER TABLE payment_funding_events DROP CONSTRAINT fixture_no_consume")
        .execute(&f.db.pool)
        .await
        .unwrap();
    f.due().await;
    assert_eq!(deliver_once(&f.server.state).await.unwrap().delivered, 1);
    assert_eq!(f.order().await.0, "activated");
    assert_eq!(f.server.posts.lock().unwrap().len(), 1);
    assert_eq!(f.db.counts().await, (1, 1));
    f.db.finish().await;
}

#[tokio::test]
async fn a_wrong_activation_receipt_is_not_treated_as_confirmed_or_refundable() {
    let f = Fixture::new(true).await;
    f.server.wrong_reply.store(true, Ordering::SeqCst);
    assert_eq!(deliver_once(&f.server.state).await.unwrap().needs_review, 1);
    assert_eq!(
        f.event().await,
        (
            "needs_review".into(),
            false,
            Some("funding_acknowledgment_mismatch".into())
        )
    );
    assert_eq!(f.order().await.0, "needs_review");
    assert_eq!(
        f.server.activations.load(Ordering::SeqCst),
        1,
        "a rejected reply does not prove work never started"
    );
    assert_eq!(f.db.counts().await, (1, 1));
    f.db.finish().await;
}

#[tokio::test]
async fn a_checkout_closed_during_activation_is_flagged_without_hiding_started_work() {
    let f = Fixture::new(true).await;
    f.server.pause_post.store(true, Ordering::SeqCst);
    let delivery = deliver_once(&f.server.state);
    let close = async {
        f.server.wait().await;
        sqlx::query("UPDATE checkout_orders SET state='cancelled' WHERE id=$1")
            .bind(f.checkout.order_id)
            .execute(&f.db.pool)
            .await
            .unwrap();
        f.server.release.add_permits(1);
    };
    let (result, ()) = tokio::join!(delivery, close);
    assert_eq!(result.unwrap().delivered, 1);
    assert_eq!(f.event().await.0, "delivered");
    assert_eq!(
        f.order().await,
        (
            "needs_review".into(),
            Some("funded_after_checkout_closed".into())
        )
    );
    assert_eq!(f.server.activations.load(Ordering::SeqCst), 1);
    f.db.finish().await;
}
