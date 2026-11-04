use super::*;
use crate::payments::tests::TestDb;
use serde_json::json;

pub(in crate::payments) async fn fund_and_earn(db: &TestDb, amount: i64) {
    let (candidate, view) = completed(db, amount).await;
    allocate(&db.pool, &candidate, &view).await.unwrap();
}

async fn completed(db: &TestDb, amount: i64) -> (Candidate, ReviewView) {
    let (mut payment, mut quote) = db.quote();
    payment.required_amount = amount;
    payment.destination_asset = SETTLEMENT_ASSET.into();
    payment.quote_request["amount"] = json!(amount.to_string());
    payment.quote_request["destinationAsset"] = json!(SETTLEMENT_ASSET);
    quote.quote_request = payment.quote_request.clone();
    quote.quote["amountOut"] = json!(amount.to_string());
    let invoice_id = record_quote(&db.pool, &payment, &quote).await.unwrap();
    let token = Uuid::new_v4();
    sqlx::query("UPDATE payment_invoices SET poll_token=$2 WHERE id=$1")
        .bind(invoice_id)
        .bind(token)
        .execute(&db.pool)
        .await
        .unwrap();
    let status = serde_json::from_value(json!({"quoteResponse":quote,"status":"SUCCESS","updatedAt":Utc::now(),"swapDetails":{"amountOut":amount.to_string(),"intentHashes":["fixture-intent"],"nearTxHashes":["fixture-tx"]}})).unwrap();
    apply_status(&db.pool, invoice_id, token, status)
        .await
        .unwrap();
    sqlx::query("UPDATE payment_funding_events SET delivery_state='delivered',consumed_at=now() WHERE invoice_id=$1").bind(invoice_id).execute(&db.pool).await.unwrap();
    let devices = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
    let site = Uuid::new_v4();
    let expires = date(&payment.quote_request["deadline"]).unwrap();
    let terms = checkout::CheckoutTerms {
        site_check_id: site,
        source_id: None,
        pentest_id: None,
        presentation: None,
        consent: patchriot_protocol::website_reviews::CreateWebsiteReview {
            request_id: payment.request_id,
            snapshot_sha256: "a".repeat(64),
            device_ids: devices.to_vec(),
            accepts_operator_access: true,
            accepts_provider_access: false,
        },
        payment,
    };
    let review_id = Uuid::new_v4();
    let result = json!({"kind":"website_agent_v1","execution":{"state":"completed","declared_model":"fixture","model":"fixture","model_digest":"b".repeat(64),"image_digest":format!("sha256:{}","c".repeat(64)),"duration_ms":1234,"inference_calls":1,"terminal_calls":1,"cleanup_confirmed":true},"snapshot_sha256":"a".repeat(64),"inspected_snapshot_sha256":"a".repeat(64),"assessment":{"summary":"Bounded fixture report","findings":[],"limitations":["Fixture only"]},"raw_summary":""});
    let view: ReviewView = serde_json::from_value(json!({
        "id":review_id,"request_id":terms.payment.request_id,"scenario":"website_snapshot_v1","mode":"website_agent","state":"completed","created_at":Utc::now().timestamp(),"deadline_at":Utc::now().timestamp()+600,"evidence_source":"Fixture",
        "website":{"site_check_id":site,"snapshot_sha256":"a".repeat(64),"reviewers":devices.iter().map(|device|json!({"device_id":device,"operator_id":db.account,"operator_name":"Fixture operator","device_name":"Fixture relay","declared_model":"fixture","compute_group":"one-host"})).collect::<Vec<_>>()},
        "payment":{"price":{"asset":SETTLEMENT_ASSET,"amount":amount.to_string()},"expires_at":expires.timestamp(),"invoice_id":invoice_id,"funded_at":Utc::now().timestamp()},
        "steps":(["investigator","reproducer","challenger"].iter().enumerate().map(|(i,role)|json!({"role":role,"state":"completed","attempts":1,"device_id":devices[i],"operator_id":db.account,"compute_group":"one-host","result":result,"evidence_complete":true})).collect::<Vec<_>>())
    })).unwrap();
    let saved = serde_json::to_value(&terms).unwrap();
    sqlx::query("INSERT INTO checkout_orders(id,account_id,request_id,terms,expires_at,review_id,invoice_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,'activated')")
        .bind(Uuid::new_v4()).bind(db.account).bind(terms.payment.request_id).bind(&saved).bind(expires).bind(review_id).bind(invoice_id).execute(&db.pool).await.unwrap();
    (
        Candidate {
            invoice_id,
            account_id: db.account,
            review_id,
            terms: saved,
            expires_at: expires,
            asset: SETTLEMENT_ASSET.into(),
            amount,
        },
        view,
    )
}

#[tokio::test]
async fn deleted_findings_preserve_earned_work_but_not_an_unverified_receipt() {
    use patchriot_protocol::reports::{ReportRetention, WorkReceipt};
    let db = TestDb::new().await;
    let (c, mut view) = completed(&db, 10_000_000).await;
    let before = serde_json::to_value(credits(&view, c.amount).unwrap()).unwrap();
    for step in &mut view.steps {
        step.receipt = WorkReceipt::from_result(step.result.as_ref().unwrap());
        step.result = None;
    }
    assert!(
        credits(&view, c.amount).is_err(),
        "missing evidence before deletion must not fall back silently"
    );
    view.retention = Some(ReportRetention {
        first_downloaded_at: 1,
        expires_at: 43201,
        content_deleted: true,
    });
    assert_eq!(
        serde_json::to_value(credits(&view, c.amount).unwrap()).unwrap(),
        before
    );
    let original = serde_json::to_value(&view).unwrap();
    for (pointer, value) in [
        ("/steps/0/receipt/binding_sha256", json!("f".repeat(64))),
        ("/steps/0/receipt/mode", json!("pentest_agent")),
        ("/steps/0/receipt/state", json!("failed")),
        ("/steps/0/receipt/cleanup_confirmed", json!(false)),
        ("/steps/0/evidence_complete", json!(false)),
        ("/steps/0/operator_id", json!(Uuid::new_v4())),
        ("/steps/0/receipt", Value::Null),
    ] {
        let mut bad = original.clone();
        *bad.pointer_mut(pointer).unwrap() = value;
        assert!(
            credits(&serde_json::from_value(bad).unwrap(), c.amount).is_err(),
            "{pointer}"
        );
    }
    assert!(allocate(&db.pool, &c, &view).await.unwrap());
    assert!(!allocate(&db.pool, &c, &view).await.unwrap());
    let paid: i64 = sqlx::query_scalar("SELECT sum(amount)::bigint FROM operator_earnings")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(paid, 9_000_000);
    db.finish().await;
}

#[tokio::test]
async fn concurrent_allocation_credits_roles_once_and_balances_receipt() {
    let db = TestDb::new().await;
    let (c, view) = completed(&db, 10_000_000).await;
    let (a, b) = tokio::join!(allocate(&db.pool, &c, &view), allocate(&db.pool, &c, &view));
    assert_eq!(usize::from(a.unwrap()) + usize::from(b.unwrap()), 1);
    let amounts: (i64, i64, i64) = sqlx::query_as(
        "SELECT gross_amount,platform_amount,operator_amount FROM earning_allocations",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(amounts, (10_000_000, 1_000_000, 9_000_000));
    let roles: (i64,i64,i64) = sqlx::query_as("SELECT count(*),sum(amount)::bigint,sum(reported_duration_ms)::bigint FROM operator_earnings WHERE operator_id=$1").bind(db.account).fetch_one(&db.pool).await.unwrap();
    assert_eq!(roles, (3, 9_000_000, 3702));
    assert!(
        sqlx::query("UPDATE operator_earnings SET amount=amount+1")
            .execute(&db.pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM earning_allocations")
            .execute(&db.pool)
            .await
            .is_err()
    );
    db.finish().await;
}

#[tokio::test]
async fn incomplete_changed_or_unfunded_work_cannot_create_earnings() {
    let db = TestDb::new().await;
    let (c, view) = completed(&db, 10_000_000).await;
    for (pointer, value) in [
        ("/id", json!(Uuid::new_v4())),
        ("/request_id", json!(Uuid::new_v4())),
        ("/state", json!("needs_review")),
        ("/payment/invoice_id", json!(Uuid::new_v4())),
        ("/payment/funded_at", Value::Null),
        ("/steps/1/evidence_complete", json!(false)),
        ("/steps/2/operator_id", json!(Uuid::new_v4())),
        ("/steps/1/device_id", json!(Uuid::new_v4())),
        ("/steps/0/state", json!("failed")),
        ("/steps/1/role", json!("investigator")),
        ("/steps/0/result/snapshot_sha256", json!("d".repeat(64))),
        ("/steps/0/result/execution/cleanup_confirmed", json!(false)),
    ] {
        let mut bad = serde_json::to_value(&view).unwrap();
        *bad.pointer_mut(pointer).unwrap() = value;
        assert!(
            allocate(&db.pool, &c, &serde_json::from_value(bad).unwrap())
                .await
                .is_err(),
            "{pointer}"
        );
    }
    sqlx::query("UPDATE payment_funding_events SET delivery_state='pending',consumed_at=NULL")
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(allocate(&db.pool, &c, &view).await.is_err());
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM operator_earnings")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    db.finish().await;
}

#[tokio::test]
async fn fractional_split_preserves_every_unit_and_duration_does_not_set_pay() {
    let db = TestDb::new().await;
    let (c, mut view) = completed(&db, 10_000_002).await;
    if let Some(WorkResult::Website(r)) = &mut view.steps[2].result {
        r.execution.duration_ms = 1;
    }
    let shares = credits(&view, c.amount).unwrap();
    assert_eq!(
        shares.iter().map(|r| r.amount).collect::<Vec<_>>(),
        vec![3_000_001, 3_000_001, 3_000_000]
    );
    allocate(&db.pool, &c, &view).await.unwrap();
    let sum: i64 = sqlx::query_scalar("SELECT sum(amount)::bigint FROM operator_earnings")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(sum + c.amount / 10, c.amount);
    db.finish().await;
}

#[tokio::test]
async fn database_rejects_partial_or_unbacked_allocation() {
    let db = TestDb::new().await;
    let (c, _) = completed(&db, 10_000_000).await;
    let mut tx = db.pool.begin().await.unwrap();
    sqlx::query("INSERT INTO earning_allocations(invoice_id,review_id,asset,gross_amount,platform_amount,operator_amount,result_hash,policy) VALUES($1,$2,$3,10000000,1000000,9000000,$4,'three_roles_90_10_v1')")
        .bind(c.invoice_id).bind(c.review_id).bind(SETTLEMENT_ASSET).bind("a".repeat(64)).execute(&mut *tx).await.unwrap();
    assert!(tx.commit().await.is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM earning_allocations")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    db.finish().await;
}

#[tokio::test]
async fn live_work_allocates_once_with_http_counts_and_keeps_incomplete_work_unpaid() {
    use patchriot_protocol::pentests::{LiveScope, PentestContext, PentestResult};
    let db = TestDb::new().await;
    let (mut candidate, mut view) = completed(&db, 10_000_000).await;
    let scope: LiveScope = serde_json::from_value(json!({"origins":["https://example.com"],"profile":"web_baseline_v1","tools":["artex_engine_v1"],"methods":["GET","HEAD","OPTIONS"]})).unwrap();
    let scope = scope.normalized().unwrap();
    let hash = scope.hash().unwrap();
    let website = view.website.take().unwrap();
    candidate
        .terms
        .as_object_mut()
        .unwrap()
        .remove("site_check_id");
    candidate.terms["pentest_id"] = json!(website.site_check_id);
    candidate.terms["consent"]["snapshot_sha256"] = json!(hash);
    candidate.terms["consent"]["accepts_provider_access"] = json!(true);
    view.mode = "pentest_agent".into();
    view.scenario = patchriot_protocol::FixtureScenario::LiveHttpV1;
    view.pentest = Some(PentestContext {
        pentest_id: website.site_check_id,
        scope: scope.clone(),
        scope_sha256: hash.clone(),
        reviewers: website.reviewers,
        provider: "abliteration.ai".into(),
    });
    let result: PentestResult=serde_json::from_value(json!({"kind":"pentest_agent_v1","scope_sha256":hash,
        "execution":{"state":"completed","provider":"abliteration.ai","model":"abliterated-model-large-v2","image_digest":format!("sha256:{}","c".repeat(64)),"duration_ms":1000,"inference_calls":12,"http_requests":1,"cost_upper_microusd":10,"cleanup_confirmed":true},
        "assessment":{"summary":"Owned fixture inspected","findings":[],"limitations":["One fixture request"]},
        "evidence":[{"id":1,"method":"GET","url":"https://example.com/","request_headers":{},"status":200,"headers":{},"body_excerpt":"fixture","body_sha256":"d".repeat(64),"truncated":false,"error":null,"observed_at":Utc::now().timestamp()}],"raw_summary":""})).unwrap();
    assert!(!result.evidence_complete(&scope));
    assert!(result.evidence_complete_for_role(&scope, ReviewRole::Reproducer));
    for step in &mut view.steps {
        step.result = Some(WorkResult::Pentest(result.clone()));
    }
    if let Some(WorkResult::Pentest(scout)) = &mut view.steps[0].result {
        scout.tool_runs.push(serde_json::from_value(json!({"tool":"artex-engine","version":"owned-test","arguments":["/opt/artex/artex","https://example.com"],"started_at":1,"duration_ms":1,"exit_code":0,"failure":null,"evidence_ids":[1],"output_sha256":format!("{:x}",Sha256::digest(b"")),"output_excerpt":"","output_truncated":false})).unwrap());
    }
    let mut incomplete = view.clone();
    incomplete.steps[0].evidence_complete = Some(false);
    assert!(allocate(&db.pool, &candidate, &incomplete).await.is_err());
    assert!(allocate(&db.pool, &candidate, &view).await.unwrap());
    assert!(!allocate(&db.pool, &candidate, &view).await.unwrap());
    let totals:(i64,i64,i64,i64)=sqlx::query_as("SELECT sum(amount)::bigint,sum(inference_calls)::bigint,sum(terminal_calls)::bigint,sum(http_requests)::bigint FROM operator_earnings")
        .fetch_one(&db.pool).await.unwrap();
    assert_eq!(totals, (9_000_000, 36, 0, 3));
    db.finish().await;
}
