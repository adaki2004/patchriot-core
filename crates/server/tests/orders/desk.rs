use super::*;

const PATH: &str = "/api/admin/payments";

#[tokio::test]
async fn payment_desk_requires_current_admin_access_and_keeps_disabled_customer_records() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let (member, customer) = test.login("member").await;
    let account: Uuid = customer["account"]["id"].as_str().unwrap().parse().unwrap();
    let (_, invoice, _) = seed(&test, account).await;
    let (admin, administrator) = test.login("admin").await;
    assert_eq!(
        test.request("GET", PATH, Value::Null, &[]).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        test.request(
            "GET",
            PATH,
            Value::Null,
            &[("cookie", &member), ("x-patchriot-role", "admin")]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    disable_account(&test.pool, account).await.unwrap();
    let (status, _, rows) = test
        .request("GET", PATH, Value::Null, &[("cookie", &admin)])
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["invoice_id"], json!(invoice));
    assert_eq!(rows[0]["account_disabled"], true);
    assert_eq!(rows[0]["required_amount"], AMOUNT.to_string());
    assert_eq!(rows[0]["ledger_amount"], Value::Null);
    assert_eq!(rows[0]["requires_attention"], false);
    assert_eq!(rows[0]["payment_confirmed"], false);
    assert!(
        rows[0]["deposit_address"]
            .as_str()
            .unwrap()
            .starts_with("private-deposit-")
    );
    assert_eq!(rows[0]["recipient"], "treasury.fixture.near");
    assert_eq!(rows[0]["recipient_type"], "INTENTS");
    for field in [
        "refund_address",
        "quote",
        "quote_request",
        "terms",
        "correlation_id",
    ] {
        assert!(rows[0].get(field).is_none(), "{field}");
    }
    assert!(!rows.to_string().contains("private-refund"));
    assert_eq!(
        test.request(
            "POST",
            PATH,
            json!({"refund":true}),
            &[("cookie", &admin), ("origin", ORIGIN)]
        )
        .await
        .0,
        StatusCode::METHOD_NOT_ALLOWED
    );
    let admin_id: Uuid = administrator["account"]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    sqlx::query("UPDATE accounts SET role='member' WHERE id=$1")
        .bind(admin_id)
        .execute(&test.pool)
        .await
        .unwrap();
    assert_eq!(
        test.request("GET", PATH, Value::Null, &[("cookie", &admin)])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    disable_account(&test.pool, admin_id).await.unwrap();
    assert_eq!(
        test.request("GET", PATH, Value::Null, &[("cookie", &admin)])
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    test.finish().await;
}

async fn settle(test: &TestApp, account: Uuid, order: Uuid, invoice: Uuid) {
    sqlx::query("UPDATE payment_invoices SET state='settled',received_amount=$2 WHERE id=$1")
        .bind(invoice)
        .bind(AMOUNT)
        .execute(&test.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO payment_ledger(id,invoice_id,account_id,asset,amount,debit,credit) VALUES($1,$2,$3,'nep141:fixture.near',$4,'treasury_asset','customer_funds')").bind(Uuid::new_v4()).bind(invoice).bind(account).bind(AMOUNT).execute(&test.pool).await.unwrap();
    sqlx::query("INSERT INTO payment_funding_events(invoice_id,account_id,request_id,asset,amount,delivery_state,consumed_at) SELECT id,account_id,request_id,asset,required_amount,'delivered',now() FROM payment_invoices WHERE id=$1").bind(invoice).execute(&test.pool).await.unwrap();
    sqlx::query("UPDATE checkout_orders SET state='activated' WHERE id=$1")
        .bind(order)
        .execute(&test.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn payment_desk_distinguishes_recorded_funds_from_delivery_and_cancelled_work() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let (cookie, session) = test.login("admin").await;
    let account: Uuid = session["account"]["id"].as_str().unwrap().parse().unwrap();
    let (order, invoice, _) = seed(&test, account).await;
    settle(&test, account, order, invoice).await;
    let (_, _, rows) = test
        .request("GET", PATH, Value::Null, &[("cookie", &cookie)])
        .await;
    assert_eq!(rows[0]["requires_attention"], false);
    assert_eq!(rows[0]["ledger_amount"], AMOUNT.to_string());
    assert_eq!(rows[0]["funding_state"], "delivered");
    assert_eq!(rows[0]["order_state"], "activated");
    assert_eq!(rows[0]["order_id"], json!(order));
    assert_eq!(rows[0]["payment_confirmed"], true);
    sqlx::query("UPDATE payment_funding_events SET earnings_error='completed_work_requires_review' WHERE invoice_id=$1")
        .bind(invoice).execute(&test.pool).await.unwrap();
    let (_, _, rows) = test
        .request("GET", PATH, Value::Null, &[("cookie", &cookie)])
        .await;
    assert_eq!(rows[0]["requires_attention"], true);
    assert_eq!(rows[0]["earnings_error"], "completed_work_requires_review");
    assert_eq!(rows[0]["ledger_amount"], AMOUNT.to_string());
    sqlx::query("UPDATE payment_funding_events SET earnings_error=NULL WHERE invoice_id=$1")
        .bind(invoice)
        .execute(&test.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE checkout_orders SET state='cancelled',cancel_requested_at=now(),cancel_confirmed_at=now(),cancel_review_state='cancelled' WHERE id=$1").bind(order).execute(&test.pool).await.unwrap();
    let (_, _, rows) = test
        .request("GET", PATH, Value::Null, &[("cookie", &cookie)])
        .await;
    assert_eq!(rows[0]["requires_attention"], true);
    assert_eq!(rows[0]["payment_state"], "settled");
    assert_eq!(rows[0]["ledger_amount"], AMOUNT.to_string());
    assert_eq!(rows[0]["cancel_review_state"], "cancelled");
    assert_eq!(rows[0]["payment_confirmed"], true);
    assert!(rows[0].get("refunded_amount").is_none());
    let (_, broken, _) = seed(&test, account).await;
    sqlx::query("UPDATE payment_invoices SET state='settled',received_amount=$2 WHERE id=$1")
        .bind(broken)
        .bind(AMOUNT)
        .execute(&test.pool)
        .await
        .unwrap();
    let (_, _, rows) = test
        .request("GET", PATH, Value::Null, &[("cookie", &cookie)])
        .await;
    assert_eq!(rows[0]["invoice_id"], json!(broken));
    assert_eq!(rows[0]["requires_attention"], true);
    assert_eq!(rows[0]["ledger_amount"], Value::Null);
    assert_eq!(rows[0]["payment_confirmed"], false);
    test.finish().await;
}

#[tokio::test]
async fn payment_desk_is_bounded_and_provider_errors_are_visible_without_network_calls() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let (cookie, session) = test.login("admin").await;
    let account: Uuid = session["account"]["id"].as_str().unwrap().parse().unwrap();
    let (_, old, _) = seed(&test, account).await;
    let mut latest = old;
    for _ in 0..50 {
        latest = seed(&test, account).await.1;
    }
    sqlx::query("UPDATE payment_invoices SET poll_error='provider_unavailable' WHERE id=$1")
        .bind(latest)
        .execute(&test.pool)
        .await
        .unwrap();
    let (status, _, rows) = test
        .request("GET", PATH, Value::Null, &[("cookie", &cookie)])
        .await;
    assert_eq!(status, StatusCode::OK);
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 50);
    assert_eq!(rows[0]["invoice_id"], json!(latest));
    assert_eq!(rows[0]["poll_error"], "provider_unavailable");
    assert_eq!(rows[0]["requires_attention"], true);
    assert!(!rows.iter().any(|row| row["invoice_id"] == json!(old)));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM payment_ledger")
            .fetch_one(&test.pool)
            .await
            .unwrap(),
        0
    );
    test.finish().await;
}
