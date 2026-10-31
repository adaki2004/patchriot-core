use super::*;

#[tokio::test]
async fn browser_cannot_set_a_review_price_or_confirm_its_own_payment() {
    let test = TestApp::new("http://127.0.0.1:9").await;
    let (cookie, session) = test.login("member").await;
    let headers = [
        ("cookie", cookie.as_str()),
        ("origin", ORIGIN),
        ("x-csrf-token", session["csrf_token"].as_str().unwrap()),
        ("x-patchriot-role", "admin"),
    ];
    let id = Uuid::new_v4();
    let consent = json!({"request_id":Uuid::new_v4(), "snapshot_sha256":"1".repeat(64), "device_ids":[Uuid::new_v4(),Uuid::new_v4(),Uuid::new_v4()], "accepts_operator_access":true});
    for (field, value) in [
        (
            "price",
            json!({"asset":"nep141:fixture-usdc", "amount":"1"}),
        ),
        ("invoice_id", json!(Uuid::new_v4())),
        ("payment", json!({"funded":true})),
    ] {
        let mut forged = consent.clone();
        forged[field] = value;
        let response = test
            .request(
                "POST",
                &format!("/api/site-checks/{id}/review"),
                forged,
                &headers,
            )
            .await;
        assert_eq!(
            response.0,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}",
            response.2
        );
    }
    for path in [
        format!("/api/site-checks/{id}/admit-review"),
        format!("/api/reviews/{id}/fund"),
    ] {
        let response = test.request("POST", &path, json!({}), &headers).await;
        assert_eq!(response.0, StatusCode::NOT_FOUND, "{}", response.2);
    }
    test.finish().await;
}

#[tokio::test]
async fn site_routes_require_sessions_csrf_and_admin_decisions() {
    let test = TestApp::new("http://127.0.0.1:9").await;
    let id = Uuid::new_v4();
    for path in [
        "/api/site-checks".into(),
        format!("/api/site-checks/{id}"),
        format!("/api/site-checks/{id}/evidence"),
        format!("/api/site-checks/{id}/review-plan"),
        format!("/api/site-checks/{id}/compare/{}", Uuid::new_v4()),
    ] {
        assert_eq!(
            test.request("GET", &path, Value::Null, &[]).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    let (cookie, session) = test.login("member").await;
    assert_eq!(test.request("POST", &format!("/api/site-checks/{id}/review"), json!({"request_id":Uuid::new_v4(),"snapshot_sha256":"1".repeat(64),"device_ids":[],"accepts_operator_access":true}), &[("cookie",&cookie),("origin",ORIGIN)]).await.0, StatusCode::FORBIDDEN);
    let body = json!({"request_id":Uuid::new_v4(),"scope":{"homepage":"https://example.com/","script_origins":[]},"authorized":true,"authority_note":"I operate this owned fixture."});
    assert_eq!(
        test.request(
            "POST",
            "/api/site-checks",
            body,
            &[("cookie", &cookie), ("origin", ORIGIN)]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        test.request(
            "POST",
            &format!("/api/site-checks/{id}/cancel"),
            json!({}),
            &[("cookie", &cookie), ("origin", ORIGIN)]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let result=test.request("POST",&format!("/api/site-checks/{id}/decision"),json!({"action":"approve","scope_sha256":"0".repeat(64),"reason":"Authority verified for test fixture."}),&[("cookie",&cookie),("origin",ORIGIN),("x-csrf-token",session["csrf_token"].as_str().unwrap()),("x-patchriot-role","admin")]).await;
    assert_eq!(result.0, StatusCode::FORBIDDEN);
    test.finish().await;
}

#[tokio::test]
async fn website_download_uses_session_identity_and_is_an_attachment_with_a_separate_size_bound() {
    let captured = Arc::new(Mutex::new(Vec::<HeaderMap>::new()));
    let headers = captured.clone();
    let large = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let too_large = large.clone();
    let downstream=Router::new().route("/internal/site-checks/{id}/evidence",get(move |request_headers:HeaderMap| {
        let headers=headers.clone(); let too_large=too_large.clone();
        async move {
            headers.lock().unwrap().push(request_headers);
            let text="x".repeat(if too_large.load(std::sync::atomic::Ordering::SeqCst) { 6*1024*1024 } else { 300*1024 });
            Json(json!({"schema_version":1,"scope":{"homepage":"https://example.com/","script_origins":[]},"homepage":{"kind":"homepage","url":"https://example.com/","sha256":"0".repeat(64),"bytes":text.len(),"content_type":"text/html","headers":{},"text":text,"collected_at":1,"connected_ip":null},"resources":[],"scripts":[],"script_limit_reached":false,"requests_made":1,"captured_response_bytes":text.len(),"started_at":1,"finished_at":2}))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, downstream).await.unwrap() });
    let test = TestApp::new(&url).await;
    let (cookie, session) = test.login("member").await;
    let id = Uuid::new_v4();
    let path = format!("/api/site-checks/{id}/evidence");
    let response = test
        .request(
            "GET",
            &path,
            Value::Null,
            &[
                ("cookie", &cookie),
                ("x-patchriot-account", "forged"),
                ("x-patchriot-role", "admin"),
            ],
        )
        .await;
    assert_eq!(response.0, StatusCode::OK, "{}", response.2);
    assert_eq!(
        response.1["content-disposition"],
        format!("attachment; filename=\"patchriot-site-{id}.json\"")
    );
    assert_eq!(
        response.1["content-type"],
        "application/json; charset=utf-8"
    );
    assert_eq!(
        response.2["homepage"]["text"].as_str().unwrap().len(),
        300 * 1024
    );
    let observed = captured.lock().unwrap()[0].clone();
    assert_eq!(observed["x-patchriot-role"], "member");
    assert_eq!(
        observed["x-patchriot-account"],
        session["account"]["id"].as_str().unwrap()
    );
    assert!(observed.get("cookie").is_none());
    large.store(true, std::sync::atomic::Ordering::SeqCst);
    let response = test
        .request("GET", &path, Value::Null, &[("cookie", &cookie)])
        .await;
    assert_eq!(response.0, StatusCode::BAD_GATEWAY);
    assert_eq!(response.2["error"], "dispatcher_response_too_large");
    test.finish().await;
    server.abort();
}
