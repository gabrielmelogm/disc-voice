use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use disc_api::{migration::Migrator, router, AppState};
use futures_util::{SinkExt, StreamExt};
use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
use sea_orm_migration::MigratorTrait;
use serde_json::{json, Value};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use tower::ServiceExt;
use uuid::Uuid;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

async fn event(socket: &mut Socket, kind: &str) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let frame = socket.next().await.expect("socket open").unwrap();
            if let Message::Text(text) = frame {
                let value: Value = serde_json::from_str(&text).unwrap();
                if value["type"] == kind {
                    return value;
                }
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("Timed out waiting for {kind}"))
}

async fn emit(socket: &mut Socket, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

async fn socket(url: &str, token: &str) -> (Socket, String) {
    let (mut socket, _) = connect_async(url).await.unwrap();
    emit(
        &mut socket,
        json!({ "type": "authenticate", "token": token }),
    )
    .await;
    let peer = event(&mut socket, "ready").await["peerId"]
        .as_str()
        .unwrap()
        .to_owned();
    (socket, peer)
}

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
            Some(json!({"email": email, "password": "curta", "name": "Dono"}))
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
            Some(json!({"email": email, "password": password, "name": "   "}))
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
        Some(json!({"email": format!(" {} ", email.to_uppercase()), "password": password, "name": "  Dono   do Servidor "})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{owner}");
    assert_eq!(owner["user"]["email"], email);
    assert_eq!(owner["user"]["name"], "Dono do Servidor");
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
            Some(json!({"email": email.to_uppercase(), "password": password, "name": "Outro"}))
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
        Some(json!({"email": format!("guest-{suffix}@example.com"), "password": password, "name": "Convidado"})),
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
    assert_eq!(channel["type"], "text");
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

    // Messages are persisted, idempotent and paginated in stable channel order.
    let message_path = format!("/channels/{}/messages", channel["id"].as_str().unwrap());
    let payload = json!({ "clientId": Uuid::new_v4(), "content": "Olá, comunidade!" });
    let (first, duplicate) = tokio::join!(
        call(
            &app,
            "POST",
            &message_path,
            Some(token),
            Some(payload.clone())
        ),
        call(
            &app,
            "POST",
            &message_path,
            Some(token),
            Some(payload.clone())
        )
    );
    assert_eq!(first.0, StatusCode::OK);
    assert_eq!(first.1, duplicate.1);
    assert_eq!(first.1["author"]["id"], owner_id.to_string());
    assert_eq!(
        call(
            &app,
            "POST",
            &message_path,
            Some(token),
            Some(json!({
                "clientId": payload["clientId"], "content": "Outro conteúdo"
            }))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let second = call(
        &app,
        "POST",
        &message_path,
        Some(guest_token),
        Some(json!({
            "clientId": Uuid::new_v4(), "content": "Olá!"
        })),
    )
    .await
    .1;
    let page = call(
        &app,
        "GET",
        &format!("{message_path}?limit=1"),
        Some(token),
        None,
    )
    .await
    .1;
    assert_eq!(page["messages"], json!([second]));
    assert_eq!(page["hasMore"], true);
    let before = call(
        &app,
        "GET",
        &format!("{message_path}?before={}", second["id"].as_str().unwrap()),
        Some(token),
        None,
    )
    .await
    .1;
    assert_eq!(before["messages"], json!([first.1]));
    let after = call(
        &app,
        "GET",
        &format!("{message_path}?after={}", first.1["id"].as_str().unwrap()),
        Some(token),
        None,
    )
    .await
    .1;
    assert_eq!(after["messages"], json!([second]));
    assert_eq!(
        call(
            &app,
            "POST",
            &message_path,
            Some(token),
            Some(json!({
                "clientId": Uuid::new_v4(), "content": "  "
            }))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let mut outsider = call(&app, "GET", &other_channels, Some(token), None)
        .await
        .1;
    let outsider_channel = outsider[0]["id"].take();
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/channels/{}/messages", outsider_channel.as_str().unwrap()),
            Some(guest_token),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let voice = call(
        &app,
        "POST",
        &channels_path,
        Some(token),
        Some(json!({ "name": "conversa", "type": "voice" })),
    )
    .await
    .1;
    let voice2 = call(
        &app,
        "POST",
        &channels_path,
        Some(token),
        Some(json!({ "name": "outra-conversa", "type": "voice" })),
    )
    .await
    .1;
    let private_voice = call(
        &app,
        "POST",
        &other_channels,
        Some(token),
        Some(json!({ "name": "privado", "type": "voice" })),
    )
    .await
    .1;
    assert_eq!(voice["type"], "voice");
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/channels/{}/messages", voice["id"].as_str().unwrap()),
            Some(token),
            Some(payload)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &channels_path,
            Some(token),
            Some(json!({ "name": "invalido", "type": "invalid" }))
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );

    // Exercise real upgrades and sockets, not only the in-memory hub.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/api/realtime", listener.local_addr().unwrap());
    let live_app = app.clone();
    let live = tokio::spawn(async move {
        axum::serve(listener, live_app).await.unwrap();
    });
    let (mut owner_ws, owner_peer) = socket(&url, token).await;
    let (mut guest_ws, guest_peer) = socket(&url, guest_token).await;
    emit(
        &mut owner_ws,
        json!({ "type": "server.watch", "serverId": server_id }),
    )
    .await;
    assert_eq!(
        event(&mut owner_ws, "server.snapshot").await["serverId"],
        server_id
    );
    let third = call(
        &app,
        "POST",
        &message_path,
        Some(guest_token),
        Some(json!({ "clientId": Uuid::new_v4(), "content": "Ao vivo" })),
    )
    .await
    .1;
    assert_eq!(
        event(&mut owner_ws, "message.created").await["message"],
        third
    );
    let join = |id: &Value| json!({ "type": "voice.join", "channelId": id, "muted": false, "deafened": false });
    emit(&mut guest_ws, join(&private_voice["id"])).await;
    assert_eq!(
        event(&mut guest_ws, "error").await["operation"],
        "voice.join"
    );
    emit(&mut owner_ws, join(&channel["id"])).await;
    assert_eq!(
        event(&mut owner_ws, "error").await["operation"],
        "voice.join"
    );
    emit(&mut owner_ws, join(&voice["id"])).await;
    assert_eq!(
        event(&mut owner_ws, "voice.joined").await["participants"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    emit(&mut guest_ws, join(&voice["id"])).await;
    assert_eq!(
        event(&mut guest_ws, "voice.joined").await["participants"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    emit(&mut owner_ws, json!({ "type": "voice.signal", "peerId": guest_peer, "data": { "description": { "type": "offer", "sdp": "test" } } })).await;
    assert_eq!(
        event(&mut guest_ws, "voice.signal").await["peerId"],
        owner_peer
    );
    emit(
        &mut guest_ws,
        json!({ "type": "voice.state", "muted": false, "deafened": false, "screen": true, "camera": true }),
    )
    .await;
    loop {
        let state = event(&mut owner_ws, "voice.participants").await;
        if state["participants"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["peerId"] == guest_peer && p["screen"] == true && p["camera"] == true)
        {
            break;
        }
    }
    // Older clients omit screen/camera: it means not sharing.
    emit(
        &mut guest_ws,
        json!({ "type": "voice.state", "muted": true, "deafened": true }),
    )
    .await;
    loop {
        let state = event(&mut owner_ws, "voice.participants").await;
        if state["participants"].as_array().unwrap().iter().any(|p| {
            p["peerId"] == guest_peer
                && p["muted"] == true
                && p["deafened"] == true
                && p["screen"] == false
                && p["camera"] == false
        }) {
            break;
        }
    }
    emit(&mut guest_ws, join(&voice2["id"])).await;
    event(&mut guest_ws, "voice.joined").await;
    emit(
        &mut owner_ws,
        json!({ "type": "voice.signal", "peerId": guest_peer, "data": {} }),
    )
    .await;
    assert_eq!(
        event(&mut owner_ws, "error").await["operation"],
        "voice.signal"
    );
    let (mut replacement, _) = socket(&url, guest_token).await;
    emit(&mut replacement, join(&voice["id"])).await;
    event(&mut replacement, "voice.joined").await;
    assert_eq!(
        event(&mut guest_ws, "voice.left").await["reason"],
        "replaced"
    );
    replacement.close(None).await.unwrap();
    loop {
        let state = event(&mut owner_ws, "voice.participants").await;
        if state["channelId"] == voice["id"] && state["participants"].as_array().unwrap().len() == 1
        {
            break;
        }
    }

    assert_eq!(
        call(&app, "POST", "/auth/logout", Some(token), None)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    event(&mut owner_ws, "session.expired").await;
    guest_ws.close(None).await.unwrap();
    live.abort();
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

async fn register(app: &Router, name: &str) -> (String, String) {
    let email = format!(
        "{}-{}@example.com",
        name.to_lowercase(),
        Uuid::new_v4().simple()
    );
    let (status, body) = call(
        app,
        "POST",
        "/auth/register",
        None,
        Some(json!({ "email": email, "password": "uma-senha-de-teste", "name": name })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    (
        body["token"].as_str().unwrap().to_owned(),
        body["user"]["id"].as_str().unwrap().to_owned(),
    )
}

#[tokio::test]
#[ignore = "Requires TEST_DATABASE_URL pointing to a PostgreSQL test database"]
async fn profile_editing_and_global_search() {
    let db = Database::connect(std::env::var("TEST_DATABASE_URL").expect("Set TEST_DATABASE_URL"))
        .await
        .unwrap();
    Migrator::up(&db, None).await.unwrap();
    let app = router(
        AppState::new(db.clone(), "https://discvoice.example".into()),
        vec![],
    );
    let tag = Uuid::new_v4().simple().to_string()[..10].to_owned();
    let (owner, owner_id) = register(&app, "Dona").await;
    let (guest, guest_id) = register(&app, &format!("Convidada{tag}")).await;
    let (outsider, outsider_id) = register(&app, &format!("Estranha{tag}")).await;

    // New accounts start with an empty profile.
    let me = call(&app, "GET", "/me", Some(&guest), None).await.1;
    assert_eq!(
        (&me["pronouns"], &me["bio"], &me["banner"]),
        (&json!(""), &json!(""), &json!("brand"))
    );
    for invalid in [
        json!({ "name": "   " }),
        json!({ "name": "a".repeat(33) }),
        json!({ "pronouns": "a".repeat(41) }),
        json!({ "bio": "a".repeat(191) }),
        json!({ "banner": "#ff0000" }),
    ] {
        assert_eq!(
            call(&app, "PATCH", "/me", Some(&guest), Some(invalid))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }

    let created = call(
        &app,
        "POST",
        "/servers",
        Some(&owner),
        Some(json!({ "name": format!("Busca {tag}") })),
    )
    .await
    .1;
    let server_id = created["server"]["id"].as_str().unwrap().to_owned();
    let code = created["code"].as_str().unwrap();
    call(
        &app,
        "POST",
        &format!("/invites/{code}/join"),
        Some(&guest),
        None,
    )
    .await;
    let channels = format!("/servers/{server_id}/channels");
    let text = call(
        &app,
        "POST",
        &channels,
        Some(&owner),
        Some(json!({ "name": format!("anuncios-{tag}") })),
    )
    .await
    .1;
    let voice = call(
        &app,
        "POST",
        &channels,
        Some(&owner),
        Some(json!({ "name": format!("sala-{tag}"), "type": "voice" })),
    )
    .await
    .1;
    let messages = format!("/channels/{}/messages", text["id"].as_str().unwrap());
    for content in [
        format!("Reunião {tag} amanhã"),
        "Sem relação".into(),
        format!("Outra reunião {tag}"),
    ] {
        call(
            &app,
            "POST",
            &messages,
            Some(&guest),
            Some(json!({ "clientId": Uuid::new_v4(), "content": content })),
        )
        .await;
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/api/realtime", listener.local_addr().unwrap());
    let live_app = app.clone();
    let live = tokio::spawn(async move {
        axum::serve(listener, live_app).await.unwrap();
    });
    let (mut owner_ws, _) = socket(&url, &owner).await;
    let (mut guest_ws, _) = socket(&url, &guest).await;
    let (mut outsider_ws, _) = socket(&url, &outsider).await;
    emit(
        &mut owner_ws,
        json!({ "type": "server.watch", "serverId": server_id }),
    )
    .await;
    event(&mut owner_ws, "server.snapshot").await;
    emit(&mut guest_ws, json!({ "type": "voice.join", "channelId": voice["id"], "muted": false, "deafened": false })).await;
    event(&mut guest_ws, "voice.joined").await;

    let (status, updated) = call(
        &app,
        "PATCH",
        "/me",
        Some(&guest),
        Some(json!({ "name": " Nova  Convidada ", "pronouns": "ela/dela", "bio": "Oi!\nTudo bem?", "banner": "green" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["name"], "Nova Convidada");
    assert_eq!(updated["bio"], "Oi!\nTudo bem?");
    // Omitted fields stay as they are.
    let partial = call(
        &app,
        "PATCH",
        "/me",
        Some(&guest),
        Some(json!({ "pronouns": "" })),
    )
    .await
    .1;
    assert_eq!(
        (&partial["name"], &partial["banner"]),
        (&updated["name"], &json!("green"))
    );

    // Members of shared servers and the user's own devices hear about it.
    assert_eq!(event(&mut owner_ws, "user.updated").await["user"], updated);
    assert_eq!(event(&mut guest_ws, "user.updated").await["user"], updated);
    loop {
        let state = event(&mut owner_ws, "voice.participants").await;
        if state["participants"][0]["user"]["name"] == "Nova Convidada" {
            break;
        }
    }
    // Messages carry the current name.
    let page = call(&app, "GET", &messages, Some(&owner), None).await.1;
    assert_eq!(page["messages"][0]["author"]["name"], "Nova Convidada");

    // Search: channels, people and messages from the user's servers only.
    let found = call(
        &app,
        "GET",
        &format!("/search?q=reuni%C3%A3o%20{tag}"),
        Some(&owner),
        None,
    )
    .await;
    assert_eq!(found.0, StatusCode::OK, "{}", found.1);
    let hits = found.1["messages"].as_array().unwrap();
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0]["content"], format!("Outra reunião {tag}"));
    assert_eq!(hits[0]["channelId"], text["id"]);
    assert_eq!(hits[0]["serverId"], server_id.as_str());
    assert_eq!(hits[0]["author"]["name"], "Nova Convidada");
    assert!(found.1["nextCursor"].is_null());
    // Prefixes match while typing.
    let prefix = call(
        &app,
        "GET",
        &format!("/search?q=reun%20{}", &tag[..5]),
        Some(&owner),
        None,
    )
    .await
    .1;
    assert_eq!(prefix["messages"].as_array().unwrap().len(), 2);
    let named = call(&app, "GET", &format!("/search?q={tag}"), Some(&owner), None)
        .await
        .1;
    let names: Vec<_> = named["channels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].clone())
        .collect();
    assert_eq!(
        names,
        [
            // Earlier matches in the name rank first.
            json!(format!("sala-{tag}")),
            json!(format!("anuncios-{tag}"))
        ]
    );
    assert_eq!(named["channels"][0]["serverName"], format!("Busca {tag}"));
    let people = call(&app, "GET", "/search?q=nova%20conv", Some(&owner), None)
        .await
        .1;
    assert!(people["people"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["id"] == guest_id.as_str()));
    let strangers = call(
        &app,
        "GET",
        &format!("/search?q=Estranha{tag}"),
        Some(&owner),
        None,
    )
    .await
    .1;
    assert_eq!(strangers["people"], json!([]));
    let hidden = call(
        &app,
        "GET",
        &format!("/search?q={tag}"),
        Some(&outsider),
        None,
    )
    .await
    .1;
    assert_eq!(
        (&hidden["channels"], &hidden["messages"], &hidden["people"]),
        (&json!([]), &json!([]), &json!([]))
    );
    // Paging returns only older messages, without channels or people.
    let older = call(
        &app,
        "GET",
        &format!("/search?q={tag}&before={}", hits[0]["id"].as_str().unwrap()),
        Some(&owner),
        None,
    )
    .await
    .1;
    assert_eq!(older["messages"].as_array().unwrap().len(), 1);
    assert_eq!(older["channels"], json!([]));
    for query in ["", "%20%20", &"a".repeat(101)] {
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("/search?q={query}"),
                Some(&owner),
                None
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    // Wildcards are matched literally.
    assert_eq!(
        call(&app, "GET", "/search?q=%25", Some(&owner), None)
            .await
            .1["channels"],
        json!([])
    );

    // Outsiders share no server: they get no profile update.
    let nothing = tokio::time::timeout(std::time::Duration::from_millis(300), async {
        loop {
            if let Some(Ok(Message::Text(text))) = outsider_ws.next().await {
                if text.contains("user.updated") {
                    return;
                }
            }
        }
    })
    .await;
    assert!(nothing.is_err());

    live.abort();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM servers WHERE id = $1",
        [Uuid::parse_str(&server_id).unwrap().into()],
    ))
    .await
    .unwrap();
    for id in [owner_id, guest_id, outsider_id] {
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "DELETE FROM users WHERE id = $1",
            [Uuid::parse_str(&id).unwrap().into()],
        ))
        .await
        .unwrap();
    }
}
