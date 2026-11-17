use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use disc_api::{migration::Migrator, router, AppState};
use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
use sea_orm_migration::MigratorTrait;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(format!("/api{path}"));
    if let Some(token) = token {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    let body = match body {
        Some(value) => {
            request = request.header("Content-Type", "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

#[tokio::test]
#[ignore = "Requires TEST_DATABASE_URL pointing to a PostgreSQL test database"]
async fn accounts_invites_channels_and_authorization() {
    let db = Database::connect(std::env::var("TEST_DATABASE_URL").expect("Set TEST_DATABASE_URL"))
        .await
        .unwrap();
    Migrator::up(&db, None).await.unwrap();
    // Migrations are repeatable and do not destroy existing data.
    Migrator::up(&db, None).await.unwrap();
    let app = router(
        AppState::new(db.clone(), "https://discvoice.example".into()),
        vec![],
    );
    let suffix = Uuid::new_v4().simple().to_string();
    let email = format!("owner-{suffix}@example.com");
    let password = "uma-senha-de-teste";
    assert_eq!(
        call(&app, "GET", "/servers", None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/auth/register",
            None,
            Some(json!({"email": "invalido", "password": password}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/auth/register",
            None,
            Some(json!({"email": email, "password": "curta"}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );

    let (status, owner) = call(
        &app,
        "POST",
        "/auth/register",
        None,
        Some(json!({"email": format!(" {} ", email.to_uppercase()), "password": password})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{owner}");
    assert_eq!(owner["user"]["email"], email);
    assert!(owner["user"].get("password_hash").is_none());
    let token = owner["token"].as_str().unwrap();
    let owner_id = Uuid::parse_str(owner["user"]["id"].as_str().unwrap()).unwrap();
    let row = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT password_hash FROM users WHERE id = $1",
            [owner_id.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    let hash: String = row.try_get("", "password_hash").unwrap();
    assert!(hash.starts_with("$argon2id$"));
    assert!(!hash.contains(password));
    let session = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT token_hash FROM sessions WHERE user_id = $1",
            [owner_id.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_ne!(session.try_get::<String>("", "token_hash").unwrap(), token);

    assert_eq!(
        call(
            &app,
            "POST",
            "/auth/register",
            None,
            Some(json!({"email": email.to_uppercase(), "password": password}))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/auth/login",
            None,
            Some(json!({"email": email, "password": "senha-errada"}))
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, login) = call(
        &app,
        "POST",
        "/auth/login",
        None,
        Some(json!({"email": email, "password": password})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(login["token"], token);
    assert_eq!(
        call(&app, "GET", "/me", Some(token), None).await.1["email"],
        email
    );
    assert_eq!(
        call(&app, "GET", "/me", Some(&"0".repeat(64)), None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/servers",
            Some(token),
            Some(json!({"name": "   "}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );

    let (status, created) = call(
        &app,
        "POST",
        "/servers",
        Some(token),
        Some(json!({"name": " Amigos "})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["server"]["name"], "Amigos");
    let server_id = created["server"]["id"].as_str().unwrap();
    let code = created["code"].as_str().unwrap();
    assert_eq!(
        created["url"],
        format!("https://discvoice.example/?invite={code}")
    );
    let channels_path = format!("/servers/{server_id}/channels");
    let invite_path = format!("/invites/{code}");
    let server_invite_path = format!("/servers/{server_id}/invite");
    assert_eq!(
        call(&app, "GET", "/servers", Some(token), None)
            .await
            .1
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        call(&app, "GET", &channels_path, Some(token), None).await.1,
        json!([])
    );
    assert_eq!(
        call(&app, "GET", &server_invite_path, Some(token), None)
            .await
            .1,
        created
    );

    let (status, guest) = call(
        &app,
        "POST",
        "/auth/register",
        None,
        Some(json!({"email": format!("guest-{suffix}@example.com"), "password": password})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let guest_token = guest["token"].as_str().unwrap();
    let guest_id = Uuid::parse_str(guest["user"]["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        call(&app, "GET", "/servers", Some(guest_token), None)
            .await
            .1,
        json!([])
    );
    assert_eq!(
        call(&app, "GET", &channels_path, Some(guest_token), None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &channels_path,
            Some(guest_token),
            Some(json!({"name": "geral"}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&app, "GET", &server_invite_path, Some(guest_token), None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/invites/invalido/join",
            Some(guest_token),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/invites/{}/join", Uuid::new_v4()),
            Some(guest_token),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, "GET", &invite_path, Some(guest_token), None)
            .await
            .1["server"]["name"],
        "Amigos"
    );
    for _ in 0..2 {
        assert_eq!(
            call(
                &app,
                "POST",
                &format!("{invite_path}/join"),
                Some(guest_token),
                None
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    assert_eq!(
        call(&app, "GET", "/servers", Some(guest_token), None)
            .await
            .1
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let (status, channel) = call(
        &app,
        "POST",
        &channels_path,
        Some(guest_token),
        Some(json!({"name": " Geral "})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{channel}");
    assert_eq!(channel["name"], "geral");
    assert_eq!(channel["serverId"], server_id);
    assert_eq!(
        call(
            &app,
            "POST",
            &channels_path,
            Some(token),
            Some(json!({"name": "GERAL"}))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &channels_path,
            Some(token),
            Some(json!({"name": "canal inválido"}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(&app, "GET", &channels_path, Some(token), None).await.1,
        json!([channel])
    );

    let other = call(
        &app,
        "POST",
        "/servers",
        Some(token),
        Some(json!({"name": "Outro"})),
    )
    .await
    .1;
    let other_id = other["server"]["id"].as_str().unwrap();
    let other_channels = format!("/servers/{other_id}/channels");
    assert_eq!(
        call(
            &app,
            "POST",
            &other_channels,
            Some(token),
            Some(json!({"name": "geral"}))
        )
        .await
        .0,
        StatusCode::CREATED
    );
    assert_eq!(
        call(&app, "GET", &other_channels, Some(guest_token), None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );

    assert_eq!(
        call(&app, "POST", "/auth/logout", Some(token), None)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(&app, "GET", "/me", Some(token), None).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&app, "GET", "/me", login["token"].as_str(), None)
            .await
            .0,
        StatusCode::OK
    );
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1",
        [guest_id.into()],
    ))
    .await
    .unwrap();
    assert_eq!(
        call(&app, "GET", "/me", Some(guest_token), None).await.0,
        StatusCode::UNAUTHORIZED
    );

    // Remove only this test's records, never reset the supplied database.
    for id in [server_id, other_id] {
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "DELETE FROM servers WHERE id = $1",
            [Uuid::parse_str(id).unwrap().into()],
        ))
        .await
        .unwrap();
    }
    for id in [owner_id, guest_id] {
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "DELETE FROM users WHERE id = $1",
            [id.into()],
        ))
        .await
        .unwrap();
    }
}
