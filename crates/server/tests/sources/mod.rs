use super::*;
use axum::routing::post;
use patchriot_protocol::sources::*;

fn upload() -> Value {
    json!({"request_id":Uuid::new_v4(),"title":"Owned code","objective":"Check access rules.","permission_note":"I wrote and own this example.","accepts_private_storage":true,"files":[{"path":"access.py","text":"print('example text, never executed')"}]})
}

#[tokio::test]
async fn source_routes_require_sessions_csrf_and_separate_admin_permission() {
    let test = TestApp::new("http://127.0.0.1:9").await;
    let id = Uuid::new_v4();
    for path in [
        "/api/sources".into(),
        format!("/api/sources/{id}"),
        format!("/api/sources/{id}/evidence"),
        format!("/api/sources/{id}/review-plan"),
    ] {
        assert_eq!(
            test.request("GET", &path, Value::Null, &[]).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    let (cookie, session) = test.login("member").await;
    let h = [
        ("cookie", cookie.as_str()),
        ("origin", ORIGIN),
        ("x-csrf-token", session["csrf_token"].as_str().unwrap()),
    ];
    assert_eq!(
        test.request("POST", "/api/sources", upload(), &h[..2])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        test.request(
            "POST",
            &format!("/api/sources/{id}/delete"),
            json!({}),
            &h[..2]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        test.request(
            "POST",
            &format!("/api/sources/{id}/decision"),
            json!({"approve":true,"note":"I am not staff."}),
            &h
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let mut bad = upload();
    bad["files"][0]["path"] = json!("../access.py");
    assert_eq!(
        test.request("POST", "/api/sources", bad, &h).await.2["error"],
        "invalid_source_path"
    );
    let mut secret = upload();
    secret["files"][0]["text"] = json!(format!("{}{}", "ghp_", "x".repeat(40)));
    assert_eq!(
        test.request("POST", "/api/sources", secret, &h).await.2["error"],
        "source_may_contain_secret"
    );
    let mut large = upload();
    large["files"][0]["text"] = json!("x".repeat(MAX_SOURCE_BODY_BYTES));
    assert_eq!(
        test.request("POST", "/api/sources", large, &h).await.0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        test.request(
            "POST",
            &format!("/api/sources/{id}/admit-review"),
            json!({}),
            &h
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    test.finish().await;
}

#[tokio::test]
async fn source_uploads_keep_text_private_and_download_as_json_attachments() {
    let mut body = upload();
    body["files"] = json!([{"path":"one.ts","text":"x".repeat(12000)},{"path":"two.ts","text":"y".repeat(12000)}]);
    let bundle = serde_json::from_value::<CreateSourceUpload>(body.clone())
        .unwrap()
        .bundle()
        .unwrap();
    let captured = Arc::new(Mutex::new(vec![]));
    let seen = captured.clone();
    let downstream=Router::new().route("/internal/sources",post(move |headers:HeaderMap,Json(input):Json<Value>| {
        let seen=seen.clone();async move { seen.lock().unwrap().push((headers,input));Json(json!({"id":Uuid::new_v4(),"request_id":Uuid::new_v4(),"title":"Owned code","objective":"Check access rules.","permission_note":"I wrote it.","state":"pending_approval","bundle_sha256":"a".repeat(64),"files":[],"created_at":1,"expires_at":2,"decision_note":null,"can_delete":true})) }
    })).route("/internal/sources/{id}/evidence",get(move || {let bundle=bundle.clone();async move {Json(bundle)}}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, downstream).await.unwrap() });
    let test = TestApp::new(&url).await;
    let (cookie, session) = test.login("member").await;
    let h = [
        ("cookie", cookie.as_str()),
        ("origin", ORIGIN),
        ("x-csrf-token", session["csrf_token"].as_str().unwrap()),
        ("x-patchriot-account", "forged"),
        ("x-patchriot-role", "admin"),
    ];
    let response = test.request("POST", "/api/sources", body.clone(), &h).await;
    assert_eq!(response.0, StatusCode::OK, "{}", response.2);
    {
        let observed = captured.lock().unwrap();
        assert_eq!(observed[0].1, body);
        assert_eq!(observed[0].0["x-patchriot-role"], "member");
        assert_eq!(
            observed[0].0["x-patchriot-account"],
            session["account"]["id"].as_str().unwrap()
        );
        assert!(observed[0].0.get("cookie").is_none());
    }
    let id = Uuid::new_v4();
    let response = test
        .request(
            "GET",
            &format!("/api/sources/{id}/evidence"),
            Value::Null,
            &h,
        )
        .await;
    assert_eq!(response.0, StatusCode::OK);
    assert_eq!(
        response.1["content-disposition"],
        format!("attachment; filename=\"patchriot-source-{id}.json\"")
    );
    assert_eq!(response.1["cache-control"], "no-store");
    assert_eq!(
        response.2["files"][0]["text"].as_str().unwrap().len(),
        12000
    );
    test.finish().await;
    server.abort();
}
