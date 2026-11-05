use super::*;
use patchriot_core::{bootstrap_admin, payments::access::ReviewAccess};
use sha2::{Digest, Sha256};

// The production hasher permits two operations across all requests. Keep
// unrelated password scenarios serial; race tests below deliberately overlap.
static PASSWORD_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn write_headers<'a>(cookie: &'a str, session: &'a Value) -> [(&'a str, &'a str); 3] {
    [
        ("cookie", cookie),
        ("origin", ORIGIN),
        ("x-csrf-token", session["csrf_token"].as_str().unwrap()),
    ]
}

fn password() -> String {
    format!("test-{}", Uuid::new_v4())
}

#[tokio::test]
async fn real_login_form_and_protected_account_work_without_javascript() {
    let _serial = PASSWORD_TESTS.lock().await;
    let test = TestApp::new("http://127.0.0.1:1").await;
    let (owner, owner_session) = test.login("admin").await;
    let grant = test.request("POST", "/api/admin/accounts", json!({
        "display_name":"HTTP login fixture", "email":"login@example.com", "with_coupon":false
    }), &write_headers(&owner, &owner_session)).await;
    assert_eq!(grant.0, StatusCode::OK);
    let secret = password();
    let activation = test
        .request(
            "POST",
            "/api/auth/activate",
            json!({
                "code":grant.2["invitation"], "username":"http_fixture", "password":secret
            }),
            &[("origin", ORIGIN)],
        )
        .await;
    assert_eq!(activation.0, StatusCode::OK);
    let page = test.request("GET", "/login", Value::Null, &[]).await;
    assert_eq!(page.0, StatusCode::OK);
    let html = page.2["text"].as_str().unwrap();
    assert_eq!(html.matches("<form ").count(), 1);
    assert!(html.contains("method=\"post\" action=\"/login\""));
    assert!(html.contains("name=\"username\"") && html.contains("name=\"password\""));
    assert!(!html.contains("<script"));
    assert_eq!(
        test.request("GET", "/account", Value::Null, &[]).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        test.request("GET", "/api/account", Value::Null, &[])
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    // The public session probe stays compatible: it returns 200 with no account.
    assert_eq!(
        test.request("GET", "/api/session", Value::Null, &[])
            .await
            .2["account"],
        Value::Null
    );
    let encoded = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("username", "http_fixture")
        .append_pair("password", &secret)
        .finish();
    for (origin, expected) in [
        ("https://foreign.example", StatusCode::FORBIDDEN),
        (ORIGIN, StatusCode::SEE_OTHER),
    ] {
        let reply = test
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/login")
                    .header("origin", origin)
                    .header("content-type", "application/x-www-form-urlencoded")
                    .body(Body::from(encoded.clone()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(reply.status(), expected);
        if expected == StatusCode::SEE_OTHER {
            assert_eq!(reply.headers()["location"], "/account");
            let cookie = reply.headers()["set-cookie"]
                .to_str()
                .unwrap()
                .split(';')
                .next()
                .unwrap();
            let account = test
                .request("GET", "/api/account", Value::Null, &[("cookie", cookie)])
                .await;
            assert_eq!(account.0, StatusCode::OK);
            assert_eq!(account.2["account"]["role"], "member");
            assert_eq!(account.2["account"]["id"], grant.2["account_id"]);
            assert!(!account.2.to_string().contains(&secret));
            let entry = test
                .request("GET", "/account", Value::Null, &[("cookie", cookie)])
                .await;
            assert_eq!(entry.0, StatusCode::SEE_OTHER);
            assert_eq!(entry.1["location"], "/#/account");
            disable_account(
                &test.pool,
                Uuid::parse_str(grant.2["account_id"].as_str().unwrap()).unwrap(),
            )
            .await
            .unwrap();
            assert_eq!(
                test.request("GET", "/api/account", Value::Null, &[("cookie", cookie)])
                    .await
                    .0,
                StatusCode::UNAUTHORIZED
            );
        }
    }
    test.finish().await;
}

async fn session(test: &TestApp, headers: HeaderMap) -> (String, Value) {
    let set = headers["set-cookie"].to_str().unwrap();
    for attr in [
        "__Host-patchriot_session=",
        "HttpOnly",
        "SameSite=Lax",
        "Path=/",
        "Secure",
    ] {
        assert!(set.contains(attr));
    }
    let cookie = set.split(';').next().unwrap().to_string();
    let view = test
        .request("GET", "/api/session", Value::Null, &[("cookie", &cookie)])
        .await
        .2;
    (cookie, view)
}

#[tokio::test]
async fn approved_member_sets_password_then_logs_in_without_another_invite() {
    let _serial = PASSWORD_TESTS.lock().await;
    let test = TestApp::with_access("http://127.0.0.1:1", ReviewAccess::Coupons).await;
    let owner_password = password();
    let owner = bootstrap_admin(&test.pool, "example_owner", owner_password.clone(), None)
        .await
        .unwrap();
    let login = test
        .request(
            "POST",
            "/api/auth/login",
            json!({"username":"EXAMPLE_OWNER","password":owner_password}),
            &[("origin", ORIGIN)],
        )
        .await;
    assert_eq!(login.0, StatusCode::OK, "{}", login.2);
    let (admin_cookie, admin_session) = session(&test, login.1).await;
    assert_eq!(admin_session["account"]["id"], owner.to_string());
    assert_eq!(admin_session["account"]["auth_method"], "password");
    let admin = write_headers(&admin_cookie, &admin_session);
    let request = json!({"display_name":"First judge","email":"Judge@Example.com","note":"I would like to review my own project."});
    for _ in 0..2 {
        assert_eq!(
            test.request(
                "POST",
                "/api/access-requests",
                request.clone(),
                &[("origin", ORIGIN)]
            )
            .await
            .0,
            StatusCode::ACCEPTED
        );
    }
    assert_eq!(
        test.request("GET", "/api/admin/access", Value::Null, &[])
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let desk = test
        .request("GET", "/api/admin/access", Value::Null, &admin)
        .await
        .2;
    assert_eq!(desk["requests"].as_array().unwrap().len(), 1);
    assert_eq!(
        desk["accounts"].as_array().unwrap().len(),
        1,
        "requesting access does not create an account"
    );
    let path = format!(
        "/api/admin/access/{}/decision",
        desk["requests"][0]["id"].as_str().unwrap()
    );
    let grant = test
        .request(
            "POST",
            &path,
            json!({"decision":"approve","with_coupon":true}),
            &admin,
        )
        .await;
    assert_eq!(grant.0, StatusCode::OK, "{}", grant.2);
    let grant = grant.2;
    let invite = grant["invitation"].as_str().unwrap();
    assert_eq!(
        test.request(
            "POST",
            "/api/auth/redeem",
            json!({"code":invite}),
            &[("origin", ORIGIN)]
        )
        .await
        .0,
        StatusCode::BAD_REQUEST,
        "setup invitations cannot bypass password setup"
    );
    let member_password = password();
    let activation = json!({"code":invite,"username":"judge_one","password":member_password});
    let activated = test
        .request(
            "POST",
            "/api/auth/activate",
            activation.clone(),
            &[("origin", ORIGIN)],
        )
        .await;
    assert_eq!(activated.0, StatusCode::OK, "{}", activated.2);
    let (member_cookie, member_session) = session(&test, activated.1).await;
    let member = write_headers(&member_cookie, &member_session);
    assert_eq!(member_session["account"]["role"], "member");
    assert_eq!(member_session["account"]["id"], grant["account_id"]);
    assert_eq!(
        test.request(
            "POST",
            "/api/auth/activate",
            activation,
            &[("origin", ORIGIN)]
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        test.request("GET", "/api/admin/access", Value::Null, &member)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        test.request("POST", "/api/auth/logout", json!({}), &member)
            .await
            .0,
        StatusCode::OK
    );
    let saved: String = sqlx::query_scalar(
        "SELECT password_hash FROM account_credentials WHERE username = 'judge_one'",
    )
    .fetch_one(&test.pool)
    .await
    .unwrap();
    assert!(saved.starts_with("$argon2id$v=19$"));
    assert!(!saved.contains(&member_password));
    let bad = test
        .request(
            "POST",
            "/api/auth/login",
            json!({"username":"judge_one","password":password()}),
            &[("origin", ORIGIN)],
        )
        .await;
    let unknown = test
        .request(
            "POST",
            "/api/auth/login",
            json!({"username":"unknown_account","password":password()}),
            &[("origin", ORIGIN)],
        )
        .await;
    assert_eq!(bad.0, StatusCode::UNAUTHORIZED);
    assert_eq!(bad.2, unknown.2);
    let login = test
        .request(
            "POST",
            "/api/auth/login",
            json!({"username":"judge_one","password":member_password}),
            &[("origin", ORIGIN)],
        )
        .await;
    assert_eq!(login.0, StatusCode::OK);
    let (cookie, _) = session(&test, login.1).await;

    // Even an administrator holding someone else's coupon cannot consume it.
    let redemption = json!({"code":grant["coupon"]["code"],"consent":{"request_id":Uuid::new_v4(),"snapshot_sha256":"a".repeat(64),"device_ids":[Uuid::new_v4(),Uuid::new_v4(),Uuid::new_v4()],"accepts_operator_access":true}});
    let reply = test
        .request(
            "POST",
            &format!("/api/site-checks/{}/review-code", Uuid::new_v4()),
            redemption,
            &admin,
        )
        .await;
    assert_eq!(reply.2["error"], "invalid_or_used_review_code");
    let stored: (Option<Uuid>, Option<Uuid>) =
        sqlx::query_as("SELECT issued_to,account_id FROM review_codes WHERE id = $1")
            .bind(Uuid::parse_str(grant["coupon"]["id"].as_str().unwrap()).unwrap())
            .fetch_one(&test.pool)
            .await
            .unwrap();
    assert_eq!(
        stored.0.unwrap().to_string(),
        grant["account_id"].as_str().unwrap()
    );
    assert!(stored.1.is_none());
    let desk = test
        .request("GET", "/api/admin/access", Value::Null, &admin)
        .await
        .2;
    assert!(!desk.to_string().contains(invite));
    assert!(!desk.to_string().contains(&saved));
    assert!(
        !desk
            .to_string()
            .contains(grant["coupon"]["code"].as_str().unwrap())
    );
    let account = grant["account_id"].as_str().unwrap();
    assert_eq!(
        test.request(
            "POST",
            &format!("/api/admin/accounts/{account}/disable"),
            json!({}),
            &admin
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(
        test.request("GET", "/api/session", Value::Null, &[("cookie", &cookie)])
            .await
            .2["account"]
            .is_null()
    );
    let disabled = test
        .request(
            "POST",
            "/api/auth/login",
            json!({"username":"judge_one","password":member_password}),
            &[("origin", ORIGIN)],
        )
        .await;
    assert_eq!(disabled.2, bad.2);
    test.finish().await;
}

#[tokio::test]
async fn lost_approval_reply_is_recoverable_without_creating_another_account_or_coupon() {
    let _serial = PASSWORD_TESTS.lock().await;
    let test = TestApp::new("http://127.0.0.1:1").await;
    let (cookie, view) = test.login("admin").await;
    let headers = write_headers(&cookie, &view);
    test.request("POST", "/api/access-requests", json!({"display_name":"Second judge","email":"second@example.com","note":"Check an owned website."}), &[("origin", ORIGIN)]).await;
    let desk = test
        .request("GET", "/api/admin/access", Value::Null, &headers)
        .await
        .2;
    let path = format!(
        "/api/admin/access/{}/decision",
        desk["requests"][0]["id"].as_str().unwrap()
    );
    let (a, b) = tokio::join!(
        test.request(
            "POST",
            &path,
            json!({"decision":"approve","with_coupon":true}),
            &headers
        ),
        test.request(
            "POST",
            &path,
            json!({"decision":"approve","with_coupon":true}),
            &headers
        )
    );
    assert_eq!(
        [a.0, b.0].iter().filter(|s| **s == StatusCode::OK).count(),
        1
    );
    assert_eq!(
        [a.0, b.0]
            .iter()
            .filter(|s| **s == StatusCode::CONFLICT)
            .count(),
        1
    );
    let grant = if a.0 == StatusCode::OK { a.2 } else { b.2 };
    let account = grant["account_id"].as_str().unwrap();
    let renewal = test
        .request(
            "POST",
            &format!("/api/admin/accounts/{account}/invite"),
            json!({}),
            &headers,
        )
        .await;
    assert_eq!(renewal.0, StatusCode::OK);
    assert!(renewal.2["coupon"].is_null());
    let mut activation =
        json!({"code":grant["invitation"],"username":"second_judge","password":password()});
    assert_eq!(
        test.request(
            "POST",
            "/api/auth/activate",
            activation.clone(),
            &[("origin", ORIGIN)]
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    activation["code"] = renewal.2["invitation"].clone();
    let active = test
        .request(
            "POST",
            "/api/auth/activate",
            activation.clone(),
            &[("origin", ORIGIN)],
        )
        .await;
    assert_eq!(active.0, StatusCode::OK);
    let (old_cookie, _) = session(&test, active.1).await;
    let renewal = test
        .request(
            "POST",
            &format!("/api/admin/accounts/{account}/invite"),
            json!({}),
            &headers,
        )
        .await
        .2;
    activation["code"] = renewal["invitation"].clone();
    activation["password"] = json!(password());
    let (a, b) = tokio::join!(
        test.request(
            "POST",
            "/api/auth/activate",
            activation.clone(),
            &[("origin", ORIGIN)]
        ),
        test.request(
            "POST",
            "/api/auth/activate",
            activation,
            &[("origin", ORIGIN)]
        )
    );
    assert_eq!(
        [a.0, b.0].iter().filter(|s| **s == StatusCode::OK).count(),
        1
    );
    assert_eq!(
        [a.0, b.0]
            .iter()
            .filter(|s| **s == StatusCode::BAD_REQUEST)
            .count(),
        1
    );
    assert!(
        test.request(
            "GET",
            "/api/session",
            Value::Null,
            &[("cookie", &old_cookie)]
        )
        .await
        .2["account"]
            .is_null()
    );
    let replacement = test
        .request(
            "POST",
            &format!("/api/admin/accounts/{account}/coupon"),
            json!({}),
            &headers,
        )
        .await;
    assert_eq!(replacement.0, StatusCode::OK);
    let unused: i64 = sqlx::query_scalar("SELECT count(*) FROM review_codes WHERE issued_to = $1 AND revoked_at IS NULL AND account_id IS NULL").bind(Uuid::parse_str(account).unwrap()).fetch_one(&test.pool).await.unwrap();
    assert_eq!(unused, 1);
    let accounts: i64 = sqlx::query_scalar("SELECT count(*) FROM accounts")
        .fetch_one(&test.pool)
        .await
        .unwrap();
    assert_eq!(accounts, 2);
    let audit: i64 = sqlx::query_scalar("SELECT count(*) FROM account_access_log")
        .fetch_one(&test.pool)
        .await
        .unwrap();
    assert_eq!(audit, 4);
    test.finish().await;
}

#[tokio::test]
async fn access_writes_require_admin_csrf_and_origin_and_cannot_disable_an_admin() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let (cookie, view) = test.login("admin").await;
    let headers = write_headers(&cookie, &view);
    let (member_cookie, member) = test.login("member").await;
    let body = json!({"display_name":"Third judge","email":"third@example.com","with_coupon":true});
    for rejected in [
        vec![],
        vec![("cookie", cookie.as_str()), ("origin", ORIGIN)],
        write_headers(&member_cookie, &member).to_vec(),
    ] {
        assert!(
            !test
                .request("POST", "/api/admin/accounts", body.clone(), &rejected)
                .await
                .0
                .is_success()
        );
    }
    let mut privileged = body.clone();
    privileged["role"] = json!("admin");
    assert_eq!(
        test.request("POST", "/api/admin/accounts", privileged, &headers)
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let created = test
        .request("POST", "/api/admin/accounts", body.clone(), &headers)
        .await;
    assert_eq!(created.0, StatusCode::OK);
    assert_eq!(
        test.request("POST", "/api/admin/accounts", body, &headers)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let owner = view["account"]["id"].as_str().unwrap();
    for action in ["disable", "invite", "coupon"] {
        assert_eq!(
            test.request(
                "POST",
                &format!("/api/admin/accounts/{owner}/{action}"),
                json!({}),
                &headers
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        test.request("GET", "/api/admin/access", Value::Null, &headers)
            .await
            .0,
        StatusCode::OK
    );
    test.finish().await;
}

#[tokio::test]
async fn public_access_limits_ignore_forged_forwarding_headers_and_never_create_accounts() {
    let test = TestApp::new("http://127.0.0.1:1").await;
    let input =
        json!({"display_name":"Applicant","email":"one@example.com","note":"Check owned code."});
    assert_eq!(
        test.request(
            "POST",
            "/api/access-requests",
            input.clone(),
            &[("origin", "https://wrong.example")]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for i in 0..6 {
        let ip = format!("198.51.100.{}", i + 1);
        let result = test
            .request(
                "POST",
                "/api/access-requests",
                input.clone(),
                &[("origin", ORIGIN), ("x-forwarded-for", &ip)],
            )
            .await;
        assert_eq!(
            result.0,
            if i < 5 {
                StatusCode::ACCEPTED
            } else {
                StatusCode::TOO_MANY_REQUESTS
            }
        );
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM accounts")
        .fetch_one(&test.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let hash = hex::encode(Sha256::digest(b"username:example_owner"));
    sqlx::query("INSERT INTO auth_attempts (key,started_at,attempts) VALUES ($1,now(),10)")
        .bind(hash)
        .execute(&test.pool)
        .await
        .unwrap();
    assert_eq!(
        test.request(
            "POST",
            "/api/auth/login",
            json!({"username":"example_owner","password":password()}),
            &[("origin", ORIGIN)]
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    test.finish().await;
}

#[tokio::test]
async fn invalid_passwords_and_taken_usernames_do_not_consume_an_activation() {
    let _serial = PASSWORD_TESTS.lock().await;
    let test = TestApp::new("http://127.0.0.1:1").await;
    let (cookie, view) = test.login("admin").await;
    let headers = write_headers(&cookie, &view);
    bootstrap_admin(&test.pool, "taken_name", password(), None)
        .await
        .unwrap();
    let grant = test
        .request(
            "POST",
            "/api/admin/accounts",
            json!({"display_name":"Fourth judge","email":"fourth@example.com","with_coupon":false}),
            &headers,
        )
        .await
        .2;
    let mut input = json!({"code":grant["invitation"],"username":"fresh_name","password":"short"});
    assert_eq!(
        test.request(
            "POST",
            "/api/auth/activate",
            input.clone(),
            &[("origin", ORIGIN)]
        )
        .await
        .2["error"],
        "invalid_password"
    );
    input["password"] = json!(password());
    input["username"] = json!("taken_name");
    assert_eq!(
        test.request(
            "POST",
            "/api/auth/activate",
            input.clone(),
            &[("origin", ORIGIN)]
        )
        .await
        .2["error"],
        "username_unavailable"
    );
    input["username"] = json!("fresh_name");
    assert_eq!(
        test.request(
            "POST",
            "/api/auth/activate",
            input.clone(),
            &[("origin", ORIGIN)]
        )
        .await
        .0,
        StatusCode::OK
    );
    let grant = test
        .request(
            "POST",
            &format!(
                "/api/admin/accounts/{}/invite",
                grant["account_id"].as_str().unwrap()
            ),
            json!({}),
            &headers,
        )
        .await
        .2;
    input["code"] = grant["invitation"].clone();
    sqlx::query(
        "UPDATE invites SET expires_at = now() - interval '1 second' WHERE redeemed_at IS NULL",
    )
    .execute(&test.pool)
    .await
    .unwrap();
    assert_eq!(
        test.request("POST", "/api/auth/activate", input, &[("origin", ORIGIN)])
            .await
            .2["error"],
        "invalid_or_expired_invite"
    );
    test.finish().await;
}
