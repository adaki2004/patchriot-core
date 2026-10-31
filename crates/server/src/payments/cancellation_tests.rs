use super::*;
use crate::payments::cancellation as cancel;

struct CancellationServer {
    state: AppState,
    posts: Arc<AtomicUsize>,
    unavailable: Arc<AtomicBool>,
    lose_reply: Arc<AtomicBool>,
    wrong_reply: Arc<AtomicBool>,
    pause: Arc<AtomicBool>,
    entered: Arc<Notify>,
    release: Arc<Semaphore>,
    task: tokio::task::JoinHandle<()>,
}
impl CancellationServer {
    async fn new(f: &Fixture) -> Self {
        let posts = Arc::new(AtomicUsize::new(0));
        let unavailable = Arc::new(AtomicBool::new(false));
        let lose_reply = Arc::new(AtomicBool::new(false));
        let wrong_reply = Arc::new(AtomicBool::new(false));
        let pause = Arc::new(AtomicBool::new(false));
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let account = f.db.account.to_string();
        let path = format!("/internal/reviews/{}", f.checkout.review_id);
        let (get_view, get_account, get_unavailable) =
            (f.server.view.clone(), account.clone(), unavailable.clone());
        let (post_view, post_calls, lost, wrong, paused, arrival, gate) = (
            f.server.view.clone(),
            posts.clone(),
            lose_reply.clone(),
            wrong_reply.clone(),
            pause.clone(),
            entered.clone(),
            release.clone(),
        );
        let pool = f.db.pool.clone();
        let order = f.checkout.order_id;
        let app = Router::new()
            .route(&path, get(move |headers: HeaderMap| {
                let (view, account, unavailable) = (get_view.clone(), get_account.clone(), get_unavailable.clone());
                async move {
                    assert_owner(&headers, &account);
                    if unavailable.load(Ordering::SeqCst) {
                        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":"unavailable"})));
                    }
                    (StatusCode::OK, Json(view.lock().unwrap().clone()))
                }
            }))
            .route(&format!("{path}/cancel"), post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let (view, calls, lost, wrong, paused, arrival, gate, account, pool) = (
                    post_view.clone(), post_calls.clone(), lost.clone(), wrong.clone(), paused.clone(), arrival.clone(), gate.clone(), account.clone(), pool.clone(),
                );
                async move {
                    assert_owner(&headers, &account);
                    assert_eq!(body, json!({}));
                    let stopped: bool = sqlx::query_scalar("SELECT cancel_requested_at IS NOT NULL AND state NOT IN ('preparing','awaiting_payment','activated') FROM checkout_orders WHERE id=$1")
                        .bind(order).fetch_one(&pool).await.unwrap();
                    assert!(stopped, "local checkout must close before cancellation HTTP");
                    calls.fetch_add(1, Ordering::SeqCst);
                    let mut reply = {
                        let mut saved = view.lock().unwrap();
                        if ["awaiting_payment","queued","running"].contains(&saved["state"].as_str().unwrap()) {
                            saved["state"] = json!("cancelled");
                        }
                        saved.clone()
                    };
                    if paused.swap(false, Ordering::SeqCst) {
                        arrival.notify_one();
                        let permit = gate.acquire().await.unwrap(); permit.forget();
                    }
                    if lost.load(Ordering::SeqCst) {
                        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":"lost_reply"})));
                    }
                    if wrong.load(Ordering::SeqCst) { reply["id"] = json!(Uuid::new_v4()); }
                    (StatusCode::OK, Json(reply))
                }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = Config::new(
            "http://127.0.0.1:7410".into(),
            format!("http://{}", listener.local_addr().unwrap()),
            "funding-fixture-internal-service-key".into(),
            None,
        )
        .unwrap();
        let state = AppState::new(f.db.pool.clone(), config).unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            state,
            posts,
            unavailable,
            lose_reply,
            wrong_reply,
            pause,
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
impl Drop for CancellationServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn request(f: &Fixture) -> cancel::CancellationStatus {
    cancel::request(&f.db.pool, f.db.account, f.checkout.order_id)
        .await
        .unwrap()
}
async fn due(f: &Fixture) {
    sqlx::query("UPDATE checkout_orders SET cancel_next_attempt_at=now()-interval '1 second', operation_until=CASE WHEN operation_token IS NULL THEN NULL ELSE now()-interval '1 second' END WHERE id=$1 AND cancel_confirmed_at IS NULL")
        .bind(f.checkout.order_id).execute(&f.db.pool).await.unwrap();
}

#[tokio::test]
async fn cancellation_is_owner_bound_idempotent_and_does_not_credit_or_refund() {
    let f = Fixture::new(false).await;
    let server = CancellationServer::new(&f).await;
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id,display_name,role) VALUES ($1,'Other customer','admin')")
        .bind(other)
        .execute(&f.db.pool)
        .await
        .unwrap();
    assert!(matches!(
        cancel::request(&f.db.pool, other, f.checkout.order_id).await,
        Err(CheckoutError::Closed)
    ));
    assert!(matches!(
        cancel::status(&f.db.pool, other, f.checkout.order_id).await,
        Err(CheckoutError::Closed)
    ));
    let first = request(&f).await;
    assert!(first.requested_at.is_some() && first.confirmed_at.is_none());
    assert_eq!(request(&f).await.requested_at, first.requested_at);
    assert_eq!(f.order().await.0, "cancelled");
    let result = cancel::deliver_once(&server.state).await.unwrap();
    assert_eq!((result.checked, result.confirmed), (1, 1));
    let confirmed = request(&f).await;
    assert_eq!(confirmed.review_state.as_deref(), Some("cancelled"));
    assert!(confirmed.confirmed_at.is_some() && !confirmed.requires_attention);
    assert_eq!(
        cancel::deliver_once(&server.state).await.unwrap().checked,
        0
    );
    assert_eq!(request(&f).await.confirmed_at, confirmed.confirmed_at);
    assert_eq!(server.posts.load(Ordering::SeqCst), 1);
    assert_eq!(f.db.counts().await, (0, 0));
    f.db.finish().await;
}

#[tokio::test]
async fn lost_cancellation_reply_is_recovered_without_repeating_the_action() {
    let f = Fixture::new(false).await;
    let server = CancellationServer::new(&f).await;
    request(&f).await;
    server.lose_reply.store(true, Ordering::SeqCst);
    assert_eq!(
        cancel::deliver_once(&server.state).await.unwrap().retrying,
        1
    );
    assert!(request(&f).await.confirmed_at.is_none());
    assert_eq!(
        cancel::deliver_once(&server.state).await.unwrap().checked,
        0,
        "back off between attempts"
    );
    due(&f).await;
    assert_eq!(
        cancel::deliver_once(&server.state).await.unwrap().confirmed,
        1
    );
    assert_eq!(server.posts.load(Ordering::SeqCst), 1);
    assert_eq!(f.db.counts().await, (0, 0));
    f.db.finish().await;
}

#[tokio::test]
async fn cancellation_stops_new_activation_while_later_money_remains_recorded() {
    let f = Fixture::new(false).await;
    let server = CancellationServer::new(&f).await;
    request(&f).await;
    f.provider.set(status(&f.quote, "SUCCESS"));
    reconcile_once(&f.db.pool, &f.provider.client)
        .await
        .unwrap();
    assert_eq!(deliver_once(&f.server.state).await.unwrap().needs_review, 1);
    assert_eq!(f.server.activations.load(Ordering::SeqCst), 0);
    assert_eq!(f.db.counts().await, (1, 1));
    assert_eq!(
        cancel::deliver_once(&server.state).await.unwrap().confirmed,
        1
    );
    assert!(
        request(&f).await.requires_attention,
        "settled money still needs a separate refund decision"
    );
    assert_eq!(f.db.counts().await, (1, 1));
    f.db.finish().await;
}

#[tokio::test]
async fn cancellation_after_funding_was_authorized_records_and_stops_the_started_work() {
    let f = Fixture::new(true).await;
    let server = CancellationServer::new(&f).await;
    f.server.pause_post.store(true, Ordering::SeqCst);
    let funding = deliver_once(&f.server.state);
    let interrupt = async {
        f.server.wait().await;
        request(&f).await;
        f.server.release.add_permits(1);
    };
    let (result, ()) = tokio::join!(funding, interrupt);
    assert_eq!(
        result.unwrap().delivered,
        1,
        "retain the actual activation fact"
    );
    assert_eq!(f.order().await.0, "needs_review");
    assert_eq!(
        cancel::deliver_once(&server.state).await.unwrap().confirmed,
        1
    );
    assert_eq!(f.server.view.lock().unwrap()["state"], "cancelled");
    assert_eq!(f.server.activations.load(Ordering::SeqCst), 1);
    assert_eq!(f.db.counts().await, (1, 1));
    f.db.finish().await;
}

#[tokio::test]
async fn an_existing_cancellation_still_finishes_after_account_disable() {
    let f = Fixture::new(false).await;
    let server = CancellationServer::new(&f).await;
    request(&f).await;
    crate::disable_account(&f.db.pool, f.db.account)
        .await
        .unwrap();
    assert!(matches!(
        cancel::request(&f.db.pool, f.db.account, f.checkout.order_id).await,
        Err(CheckoutError::AccountUnavailable)
    ));
    assert!(
        cancel::status(&f.db.pool, f.db.account, f.checkout.order_id)
            .await
            .is_err()
    );
    assert_eq!(
        cancel::deliver_once(&server.state).await.unwrap().confirmed,
        1
    );
    assert_eq!(server.posts.load(Ordering::SeqCst), 1);
    f.db.finish().await;
}

#[tokio::test]
async fn stopping_an_already_funded_review_still_requires_a_separate_money_decision() {
    let f = Fixture::new(true).await;
    let server = CancellationServer::new(&f).await;
    assert_eq!(deliver_once(&f.server.state).await.unwrap().delivered, 1);
    request(&f).await;
    assert_eq!(
        cancel::deliver_once(&server.state).await.unwrap().confirmed,
        1
    );
    let result = request(&f).await;
    assert_eq!(result.review_state.as_deref(), Some("cancelled"));
    assert!(result.confirmed_at.is_some() && result.requires_attention);
    assert_eq!(
        f.db.counts().await,
        (1, 1),
        "cancellation never returns or erases recorded money"
    );
    f.db.finish().await;
}

#[tokio::test]
async fn uncertain_receipts_and_finished_reviews_need_attention_not_a_fake_cancellation() {
    for problem in [
        "wrong_snapshot",
        "wrong_invoice",
        "wrong_reply",
        "already_finished",
    ] {
        let f = Fixture::new(false).await;
        let server = CancellationServer::new(&f).await;
        request(&f).await;
        match problem {
            "wrong_snapshot" => {
                f.server.view.lock().unwrap()["website"]["snapshot_sha256"] = json!("b".repeat(64))
            }
            "wrong_invoice" => {
                let mut view = f.server.view.lock().unwrap();
                view["payment"]["invoice_id"] = json!(Uuid::new_v4());
                view["payment"]["funded_at"] = json!(Utc::now().timestamp());
            }
            "wrong_reply" => server.wrong_reply.store(true, Ordering::SeqCst),
            "already_finished" => f.server.view.lock().unwrap()["state"] = json!("completed"),
            _ => unreachable!(),
        }
        assert_eq!(
            cancel::deliver_once(&server.state)
                .await
                .unwrap()
                .needs_review,
            1,
            "{problem}"
        );
        let value = request(&f).await;
        assert!(value.requires_attention);
        if problem == "already_finished" {
            assert!(value.confirmed_at.is_some());
            assert_eq!(value.review_state.as_deref(), Some("completed"));
        } else {
            assert!(value.confirmed_at.is_none());
        }
        assert_eq!(
            server.posts.load(Ordering::SeqCst),
            usize::from(problem == "wrong_reply")
        );
        assert_eq!(
            cancel::deliver_once(&server.state).await.unwrap().checked,
            0
        );
        assert_eq!(f.db.counts().await, (0, 0));
        f.db.finish().await;
    }
}

#[tokio::test]
async fn unavailable_dispatcher_retries_but_cannot_silently_exceed_the_confirmation_window() {
    let f = Fixture::new(false).await;
    let server = CancellationServer::new(&f).await;
    request(&f).await;
    server.unavailable.store(true, Ordering::SeqCst);
    assert_eq!(
        cancel::deliver_once(&server.state).await.unwrap().retrying,
        1
    );
    assert_eq!(
        cancel::deliver_once(&server.state).await.unwrap().checked,
        0
    );
    sqlx::query(
        "UPDATE checkout_orders SET cancel_requested_at=now()-interval '25 hours' WHERE id=$1",
    )
    .bind(f.checkout.order_id)
    .execute(&f.db.pool)
    .await
    .unwrap();
    due(&f).await;
    assert_eq!(
        cancel::deliver_once(&server.state)
            .await
            .unwrap()
            .needs_review,
        1
    );
    let value = request(&f).await;
    assert!(value.confirmed_at.is_none() && value.requires_attention);
    assert_eq!(
        f.order().await.1.as_deref(),
        Some("cancellation_confirmation_window_elapsed")
    );
    assert_eq!(server.posts.load(Ordering::SeqCst), 0);
    assert_eq!(
        cancel::deliver_once(&server.state).await.unwrap().checked,
        0
    );
    f.db.finish().await;
}

#[tokio::test]
async fn concurrent_cancellation_workers_and_stale_replies_cannot_clear_a_new_claim() {
    let f = Fixture::new(false).await;
    let server = CancellationServer::new(&f).await;
    request(&f).await;
    server.pause.store(true, Ordering::SeqCst);
    let first = cancel::deliver_once(&server.state);
    let replace = async {
        server.wait().await;
        assert_eq!(
            cancel::deliver_once(&server.state).await.unwrap().checked,
            0
        );
        sqlx::query("UPDATE checkout_orders SET operation_token=gen_random_uuid() WHERE id=$1")
            .bind(f.checkout.order_id)
            .execute(&f.db.pool)
            .await
            .unwrap();
        server.release.add_permits(1);
    };
    let (result, ()) = tokio::join!(first, replace);
    assert_eq!(result.unwrap().confirmed, 0);
    let claimed:bool=sqlx::query_scalar("SELECT operation_token IS NOT NULL AND cancel_confirmed_at IS NULL FROM checkout_orders WHERE id=$1")
        .bind(f.checkout.order_id).fetch_one(&f.db.pool).await.unwrap();
    assert!(claimed);
    due(&f).await;
    assert_eq!(
        cancel::deliver_once(&server.state).await.unwrap().confirmed,
        1
    );
    assert_eq!(server.posts.load(Ordering::SeqCst), 1);
    f.db.finish().await;
}

#[tokio::test]
async fn admission_in_flight_is_not_reported_as_cancelled_before_the_review_is_known() {
    let db = TestDb::new().await;
    let (terms, quote) = terms(&db);
    let dispatcher = AdmissionServer::new(&db, &terms).await;
    let provider = MockProvider::new(json!(quote)).await;
    dispatcher.pause();
    let preparing = prepare(&dispatcher.state, &provider.client, &terms);
    let attempt = async {
        dispatcher.wait().await;
        let order: Uuid = sqlx::query_scalar("SELECT id FROM checkout_orders WHERE account_id=$1")
            .bind(db.account)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert!(matches!(
            cancel::request(&db.pool, db.account, order).await,
            Err(CheckoutError::InProgress)
        ));
        assert!(
            cancel::status(&db.pool, db.account, order)
                .await
                .unwrap()
                .requested_at
                .is_none()
        );
        dispatcher.release.add_permits(1);
    };
    let (result, ()) = tokio::join!(preparing, attempt);
    let prepared = result.unwrap();
    assert!(
        cancel::request(&db.pool, db.account, prepared.order_id)
            .await
            .unwrap()
            .requested_at
            .is_some()
    );
    db.finish().await;
}
