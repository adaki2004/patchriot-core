use super::*;
use chrono::{Duration, Utc};
use patchriot_core::payments::{
    InvoiceTerms, QuoteResponse, cancellation, checkout::CheckoutTerms, record_quote,
};
use patchriot_protocol::website_reviews::CreateWebsiteReview;

mod desk;

const AMOUNT: i64 = 9_007_199_254_740_993;

async fn seed(test: &TestApp, account: Uuid) -> (Uuid, Uuid, Uuid) {
    let deadline = Utc::now() + Duration::minutes(5);
    let request = Uuid::new_v4();
    let payment = InvoiceTerms {
        account_id: account,
        request_id: request,
        destination_asset: "nep141:fixture.near".into(),
        recipient: "treasury.fixture.near".into(),
        required_amount: AMOUNT,
        quote_request: json!({"dry":false,"swapType":"EXACT_OUTPUT","depositType":"ORIGIN_CHAIN","refundType":"ORIGIN_CHAIN","depositMode":"SIMPLE","recipientType":"INTENTS","destinationAsset":"nep141:fixture.near","originAsset":"nep141:fixture.input.near","recipient":"treasury.fixture.near","refundTo":"private-refund.fixture.near","amount":AMOUNT.to_string(),"deadline":deadline}),
    };
    let quote = QuoteResponse {
        correlation_id: Uuid::new_v4().to_string(),
        quote_request: payment.quote_request.clone(),
        quote: json!({"amountOut":AMOUNT.to_string(),"amountIn":"1000000","depositAddress":format!("private-deposit-{request}.fixture.near"),"deadline":deadline}),
    };
    let invoice = record_quote(&test.pool, &payment, &quote).await.unwrap();
    let terms = CheckoutTerms {
        presentation: None,
        site_check_id: Uuid::new_v4(),
        source_id: None,
        pentest_id: None,
        consent: CreateWebsiteReview {
            review_policy: Default::default(),
            request_id: request,
            snapshot_sha256: "a".repeat(64),
            device_ids: (0..3).map(|_| Uuid::new_v4()).collect(),
            accepts_operator_access: true,
            accepts_provider_access: false,
        },
        payment,
    };
    let (id, review) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO checkout_orders (id,account_id,request_id,terms,expires_at,review_id,invoice_id,state) VALUES ($1,$2,$3,$4,$5,$6,$7,'awaiting_payment')")
        .bind(id).bind(account).bind(request).bind(serde_json::to_value(terms).unwrap())
        .bind(deadline).bind(review).bind(invoice).execute(&test.pool).await.unwrap();
    (id, invoice, review)
}

#[tokio::test]
async fn order_history_is_owner_only_bounded_and_has_no_deposit_instructions() {
    // No dispatcher/provider listener: status must come from local saved facts.
    let test = TestApp::new("http://127.0.0.1:1").await;
    let (cookie, session) = test.login("member").await;
    let account = session["account"]["id"].as_str().unwrap().parse().unwrap();
    let (old, invoice, _) = seed(&test, account).await;
    sqlx::query(
        "UPDATE payment_invoices SET state = 'settled', received_amount = $1 WHERE id = $2",
    )
    .bind(AMOUNT)
    .bind(invoice)
    .execute(&test.pool)
    .await
    .unwrap();
    for _ in 0..50 {
        seed(&test, account).await;
    }
    let (code, _, body) = test
        .request("GET", "/api/orders", Value::Null, &[("cookie", &cookie)])
        .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(body.as_array().unwrap().len(), 50);
    assert!(
        body.as_array()
            .unwrap()
            .iter()
            .all(|row| row["id"] != old.to_string())
    );
    let path = format!("/api/orders/{old}");
    let (code, _, body) = test
        .request("GET", &path, Value::Null, &[("cookie", &cookie)])
        .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(body["price"]["amount"], AMOUNT.to_string());
    assert_eq!(body["payment"]["received_amount"], AMOUNT.to_string());
    assert_eq!(body["state"], "awaiting_payment"); // Settlement is not activation.
    assert_eq!(body["cancellation"], Value::Null);
    for hidden in [
        "depositAddress",
        "private-deposit",
        "private-refund",
        "treasury.fixture",
        "quote_request",
        "operation_token",
        "snapshot_sha256",
    ] {
        assert!(!body.to_string().contains(hidden));
    }
    let (other, other_session) = test.login("admin").await;
    let spoof = [
        ("cookie", other.as_str()),
        (
            "x-patchriot-account",
            session["account"]["id"].as_str().unwrap(),
        ),
        ("x-patchriot-role", "admin"),
    ];
    assert_eq!(
        test.request("GET", "/api/orders", Value::Null, &spoof)
            .await
            .2,
        json!([])
    );
    assert_eq!(
        test.request("GET", &path, Value::Null, &spoof).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        test.request(
            "POST",
            &format!("{path}/cancel"),
            json!({}),
            &[
                ("cookie", &other),
                ("origin", ORIGIN),
                (
                    "x-csrf-token",
                    other_session["csrf_token"].as_str().unwrap()
                )
            ]
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    for url in ["/api/orders", &path] {
        assert_eq!(
            test.request("GET", url, Value::Null, &[]).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        test.request("POST", "/api/orders", json!({}), &[("cookie", &cookie)])
            .await
            .0,
        StatusCode::METHOD_NOT_ALLOWED
    );
    test.finish().await;
}

#[tokio::test]
async fn browser_cancellation_is_csrf_protected_and_does_not_claim_a_stop_or_refund() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let (cookie, session) = test.login("member").await;
    let account = session["account"]["id"].as_str().unwrap().parse().unwrap();
    let (id, invoice, _) = seed(&test, account).await;
    let path = format!("/api/orders/{id}/cancel");
    let csrf = session["csrf_token"].as_str().unwrap();
    let headers = [
        ("cookie", cookie.as_str()),
        ("origin", ORIGIN),
        ("x-csrf-token", csrf),
    ];
    assert_eq!(
        test.request(
            "POST",
            &path,
            json!({}),
            &[("cookie", &cookie), ("origin", ORIGIN)]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        test.request(
            "POST",
            &path,
            json!({}),
            &[
                ("cookie", &cookie),
                ("origin", "https://elsewhere.example"),
                ("x-csrf-token", csrf)
            ]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        test.request("POST", &path, json!({}), &[("origin", ORIGIN)])
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        test.request("POST", &path, json!({"refund":true}), &headers)
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let (code, _, first) = test.request("POST", &path, json!({}), &headers).await;
    assert_eq!(code, StatusCode::OK);
    assert!(first["cancellation"]["requested_at"].is_string());
    assert_eq!(first["cancellation"]["confirmed_at"], Value::Null);
    assert_eq!(first["can_cancel"], false);
    let token = Uuid::new_v4();
    sqlx::query("UPDATE checkout_orders SET operation_token = $1, operation_until = now() + interval '30 seconds' WHERE id = $2")
        .bind(token).bind(id).execute(&test.pool).await.unwrap();
    assert_eq!(
        test.request("POST", &path, json!({}), &headers).await.2,
        first
    );
    let saved: Uuid =
        sqlx::query_scalar("SELECT operation_token FROM checkout_orders WHERE id = $1")
            .bind(id)
            .fetch_one(&test.pool)
            .await
            .unwrap();
    assert_eq!(saved, token);

    // Simulate an acknowledged stop and a real recorded credit, not a refund.
    sqlx::query("UPDATE checkout_orders SET cancel_confirmed_at = now(), cancel_review_state = 'cancelled', cancel_next_attempt_at = NULL WHERE id = $1")
        .bind(id).execute(&test.pool).await.unwrap();
    sqlx::query("INSERT INTO payment_ledger (id,invoice_id,account_id,asset,amount,debit,credit) VALUES ($1,$2,$3,'nep141:fixture.near',$4,'treasury_asset','customer_funds')")
        .bind(Uuid::new_v4()).bind(invoice).bind(account).bind(AMOUNT).execute(&test.pool).await.unwrap();
    let (_, _, confirmed) = test
        .request(
            "GET",
            &format!("/api/orders/{id}"),
            Value::Null,
            &[("cookie", &cookie)],
        )
        .await;
    assert_eq!(confirmed["cancellation"]["review_state"], "cancelled");
    assert_eq!(confirmed["requires_attention"], true);
    assert_eq!(
        confirmed["requires_attention"],
        cancellation::status(&test.pool, account, id)
            .await
            .unwrap()
            .requires_attention
    );
    assert_eq!(
        test.request("GET", "/api/payments", Value::Null, &[("cookie", &cookie)])
            .await
            .2["totals"][0]["amount"],
        AMOUNT.to_string()
    );
    test.finish().await;
}

#[tokio::test]
async fn unadmitted_and_disabled_orders_cannot_be_cancelled_through_the_browser() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let (cookie, session) = test.login("member").await;
    let account = session["account"]["id"].as_str().unwrap().parse().unwrap();
    let (id, _, _) = seed(&test, account).await;
    sqlx::query("UPDATE checkout_orders SET state = 'preparing', review_id = NULL, invoice_id = NULL WHERE id = $1")
        .bind(id).execute(&test.pool).await.unwrap();
    let path = format!("/api/orders/{id}");
    let headers = [
        ("cookie", cookie.as_str()),
        ("origin", ORIGIN),
        ("x-csrf-token", session["csrf_token"].as_str().unwrap()),
    ];
    assert_eq!(
        test.request("GET", &path, Value::Null, &headers).await.2["can_cancel"],
        false
    );
    let (code, _, body) = test
        .request("POST", &format!("{path}/cancel"), json!({}), &headers)
        .await;
    assert_eq!(code, StatusCode::CONFLICT);
    assert_eq!(body["error"], "checkout_preparing");
    disable_account(&test.pool, account).await.unwrap();
    assert_eq!(
        test.request("GET", &path, Value::Null, &headers).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        test.request("POST", &format!("{path}/cancel"), json!({}), &headers)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    test.finish().await;
}

#[tokio::test]
async fn order_status_preserves_finished_work_and_flags_held_or_unconfirmed_funds() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let (cookie, session) = test.login("member").await;
    let account = session["account"]["id"].as_str().unwrap().parse().unwrap();
    let (id, invoice, _) = seed(&test, account).await;
    let path = format!("/api/orders/{id}");
    sqlx::query("UPDATE payment_invoices SET state = 'held', received_amount = $1 WHERE id = $2")
        .bind(AMOUNT)
        .bind(invoice)
        .execute(&test.pool)
        .await
        .unwrap();
    let (_, _, body) = test
        .request("GET", &path, Value::Null, &[("cookie", &cookie)])
        .await;
    assert_eq!(body["requires_attention"], true);
    assert_eq!(body["payment"]["state"], "held");
    cancellation::request(&test.pool, account, id)
        .await
        .unwrap();
    sqlx::query("UPDATE checkout_orders SET state = 'needs_review', cancel_confirmed_at = now(), cancel_review_state = 'completed', cancel_next_attempt_at = NULL WHERE id = $1")
        .bind(id).execute(&test.pool).await.unwrap();
    let (_, _, body) = test
        .request("GET", &path, Value::Null, &[("cookie", &cookie)])
        .await;
    assert_eq!(body["cancellation"]["review_state"], "completed");
    assert_eq!(body["requires_attention"], true);
    assert_eq!(body["payment"]["received_amount"], AMOUNT.to_string());
    test.finish().await;
}
