use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    routing::post,
    Form, Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use disc_api::{
    google::{GoogleConfig, OAuthClient},
    klipy::KlipyConfig,
    migration::Migrator,
    router,
    turn::CloudflareTurnConfig,
    AppState,
};
use futures_util::{SinkExt, StreamExt};
use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
use sea_orm_migration::MigratorTrait;
use serde_json::{json, Value};
use std::collections::HashMap;
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

/// A fake Google token endpoint. The code carries the claims as
/// `sub|email|name|verified`; any other code is rejected like an invalid one.
async fn fake_google() -> GoogleConfig {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let token = post(|Form(form): Form<HashMap<String, String>>| async move {
        let parts: Vec<_> = form["code"].split('|').collect();
        let secret = match form["client_id"].as_str() {
            "desktop-client" => "desktop-secret",
            _ => "web-secret",
        };
        if parts.len() != 4
            || form["client_secret"] != secret
            || form["code_verifier"].len() < 43
            || form["grant_type"] != "authorization_code"
        {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "invalid_grant" })),
            );
        }
        let claims = json!({
            "iss": "https://accounts.google.com",
            "aud": form["client_id"],
            "exp": 4_102_444_800i64,
            "sub": parts[0],
            "email": parts[1],
            "name": parts[2],
            "email_verified": parts[3] == "true",
            "picture": format!("https://lh3.googleusercontent.com/a/{}=s96-c", parts[0]),
        });
        let id_token = format!("e30.{}.sig", URL_SAFE_NO_PAD.encode(claims.to_string()));
        (StatusCode::OK, Json(json!({ "id_token": id_token })))
    });
    tokio::spawn(async move {
        axum::serve(listener, Router::new().route("/token", token))
            .await
            .unwrap();
    });
    let client = |name: &str| OAuthClient {
        id: format!("{name}-client"),
        secret: format!("{name}-secret"),
    };
    GoogleConfig {
        desktop: Some(client("desktop")),
        web: Some(client("web")),
        token_url: format!("http://{address}/token"),
    }
}

fn google_code(sub: &str, email: &str, name: &str, verified: bool) -> String {
    format!("{sub}|{email}|{name}|{verified}")
}

async fn google(app: &Router, code: &str, redirect: &str, platform: &str) -> (StatusCode, Value) {
    call(
        app,
        "POST",
        "/auth/google",
        None,
        Some(json!({
            "code": code,
            "codeVerifier": "v".repeat(43),
            "redirectUri": redirect,
            "platform": platform,
        })),
    )
    .await
}

async fn google_desktop(app: &Router, code: &str) -> (StatusCode, Value) {
    google(app, code, "http://127.0.0.1:53124", "desktop").await
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
        AppState::new(
            db.clone(),
            "https://discvoice.example".into(),
            fake_google().await,
        ),
        vec![],
    );
    let suffix = Uuid::new_v4().simple().to_string();
    let email = format!("owner-{suffix}@example.com");
    assert_eq!(
        call(&app, "GET", "/servers", None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    // Password accounts no longer exist.
    assert_eq!(
        call(
            &app,
            "POST",
            "/auth/register",
            None,
            Some(json!({"email": email, "password": "uma-senha-de-teste"}))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let config = call(&app, "GET", "/auth/google/config", None, None).await.1;
    assert_eq!(config["desktopClientId"], "desktop-client");
    assert_eq!(config["webClientId"], "web-client");
    let sub = format!("sub-{suffix}");
    for (redirect, platform) in [
        ("http://evil.example:9999", "desktop"),
        ("https://evil.example/", "web"),
    ] {
        assert_eq!(
            google(
                &app,
                &google_code(&sub, &email, "Dono", true),
                redirect,
                platform
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        google_desktop(&app, &google_code(&sub, &email, "Dono", false))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        google_desktop(&app, "rejeitado").await.0,
        StatusCode::UNAUTHORIZED
    );

    let (status, owner) = google_desktop(
        &app,
        &google_code(&sub, &email.to_uppercase(), "  Dono   do Servidor ", true),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{owner}");
    assert_eq!(owner["user"]["email"], email);
    assert_eq!(owner["user"]["name"], "Dono do Servidor");
    assert_eq!(
        owner["user"]["avatar"],
        format!("https://lh3.googleusercontent.com/a/{sub}=s256-c")
    );
    assert!(owner["user"].get("google_sub").is_none());
    let token = owner["token"].as_str().unwrap();
    let owner_id = Uuid::parse_str(owner["user"]["id"].as_str().unwrap()).unwrap();
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

    // Another Google account with the same e-mail can't take this one over.
    assert_eq!(
        google_desktop(
            &app,
            &google_code(&format!("x{sub}"), &email, "Outro", true)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    // Signing in again, from the browser, reuses the account (the name is kept).
    let (status, login) = google(
        &app,
        &google_code(&sub, &email, "Novo Nome", true),
        "https://discvoice.example/auth/google/callback",
        "web",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{login}");
    assert_eq!(login["user"]["id"], owner["user"]["id"]);
    assert_eq!(login["user"]["name"], "Dono do Servidor");
    assert_ne!(login["token"], token);
    // Accounts created before Google Sign-In are linked by e-mail.
    let legacy_email = format!("legacy-{suffix}@example.com");
    let legacy_id = Uuid::new_v4();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, 'Antiga', 'x')",
        [legacy_id.into(), legacy_email.clone().into()],
    ))
    .await
    .unwrap();
    let linked = google_desktop(
        &app,
        &google_code(&format!("legacy-{sub}"), &legacy_email, "Nova", true),
    )
    .await
    .1;
    assert_eq!(linked["user"]["id"], legacy_id.to_string());
    assert_eq!(linked["user"]["name"], "Antiga");
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

    let (status, guest) = google_desktop(
        &app,
        &google_code(
            &format!("guest-{suffix}"),
            &format!("guest-{suffix}@example.com"),
            "Convidado",
            true,
        ),
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
    // Voice rooms have their own chat, readable by members who join later.
    let room_path = format!("/channels/{}/messages", voice["id"].as_str().unwrap());
    let (status, room_message) = call(
        &app,
        "POST",
        &room_path,
        Some(token),
        Some(json!({ "clientId": Uuid::new_v4(), "content": "Link da reunião" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(room_message["channelId"], voice["id"]);
    let (status, room_page) = call(&app, "GET", &room_path, Some(guest_token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(room_page["messages"], json!([room_message]));
    // The client id still belongs to the text channel message.
    assert_eq!(
        call(&app, "POST", &room_path, Some(token), Some(payload))
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
    // Another device of the owner, with no server open: it still hears about arrivals.
    let (mut owner_idle, _) = socket(&url, token).await;
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
    // With no server open, members still get it, named for a notification.
    let elsewhere = event(&mut owner_idle, "message.created").await;
    assert_eq!(elsewhere["message"], third);
    assert_eq!(elsewhere["serverId"], server_id);
    assert_eq!(elsewhere["channelName"], channel["name"]);
    assert_eq!(elsewhere["channelType"], "text");
    assert!(elsewhere["serverName"].is_string());
    // Room chat messages arrive live too, marked as coming from a voice room.
    let live_room = call(
        &app,
        "POST",
        &room_path,
        Some(guest_token),
        Some(json!({ "clientId": Uuid::new_v4(), "content": "Sem microfone hoje" })),
    )
    .await
    .1;
    let room_event = event(&mut owner_ws, "message.created").await;
    assert_eq!(room_event["message"], live_room);
    assert_eq!(room_event["channelType"], "voice");
    assert_eq!(
        event(&mut owner_idle, "message.created").await["channelType"],
        "voice"
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
    // The owner's own arrival comes first (the page skips its own).
    let own = event(&mut owner_idle, "voice.member.joined").await;
    assert_ne!(own["user"]["id"], guest["user"]["id"]);
    let arrival = event(&mut owner_idle, "voice.member.joined").await;
    assert_eq!(arrival["user"]["id"], guest["user"]["id"]);
    assert_eq!(arrival["serverId"], server_id);
    assert_eq!(arrival["channelId"], voice["id"]);
    assert_eq!(arrival["channelName"], voice["name"]);
    assert!(arrival["serverName"].is_string());
    owner_idle.close(None).await.unwrap();
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
    // Using a session pushes its expiry forward, so active users stay signed in.
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE sessions SET expires_at = now() + interval '1 day' WHERE user_id = $1",
        [guest_id.into()],
    ))
    .await
    .unwrap();
    assert_eq!(
        call(&app, "GET", "/me", Some(guest_token), None).await.0,
        StatusCode::OK
    );
    let renewed = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT bool_and(expires_at > now() + interval '29 days') AS renewed FROM sessions WHERE user_id = $1",
            [guest_id.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert!(renewed.try_get::<bool>("", "renewed").unwrap());
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
    for id in [owner_id, guest_id, legacy_id] {
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "DELETE FROM users WHERE id = $1",
            [id.into()],
        ))
        .await
        .unwrap();
    }
}

/// A fake Discord API: one guild (700) with a readable channel (500) holding
/// `messages`, a hidden one (501) and a voice channel (502). OAuth codes are
/// `install:<guild>`, `account:<id>:<username>` or
/// `login:<id>:<username>:<email>:<verified>`.
#[derive(Clone, Default)]
struct FakeDiscord {
    messages: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    throttled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

const BOT: &str = "Bot test-bot-token";
const CALLBACK: &str = "https://discvoice.example/api/discord/callback";

/// Bytes of the fake attachment served by [`fake_discord`].
const PICTURE: &[u8] = b"\x89PNG\r\n\x1a\nfake-picture-bytes";

/// `BASE` in attachment URLs becomes the fake server's address.
fn discord_message(id: u64, kind: u64, author: &str) -> Value {
    let content = if id == 1003 {
        "<@11> veja <#500>".to_owned()
    } else {
        format!("Mensagem {id}")
    };
    json!({
        "id": id.to_string(), "type": kind, "content": content,
        "timestamp": format!("2024-05-01T12:{:02}:{:02}+00:00", (id / 60) % 60, id % 60),
        "author": { "id": author, "username": format!("user{author}"), "global_name": format!("Pessoa {author}") },
        "mentions": if id == 1003 { json!([{ "id": "11", "username": "user11", "global_name": "Pessoa 11" }]) } else { json!([]) },
        "attachments": if id == 1005 {
            json!([{ "id": "77", "filename": "mapa.png", "url": "BASE/attachments/500/77/mapa.png", "size": PICTURE.len(), "content_type": "image/png", "width": 64, "height": 32 }])
        } else { json!([]) },
    })
}

/// A request with custom headers, returning the raw response.
async fn raw(
    app: &Router,
    path: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let mut request = Request::builder().uri(path);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, 1024 * 1024).await.unwrap().to_vec();
    (parts.status, parts.headers, bytes)
}

async fn fake_discord(fake: FakeDiscord) -> disc_api::discord::DiscordConfig {
    use axum::{
        extract::{Path, Query},
        http::HeaderMap,
        routing::get,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let base = format!("http://{address}");
    let bot = |headers: &HeaderMap| headers.get("authorization").is_some_and(|v| v == BOT);
    let forbidden = || {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "message": "401: Unauthorized", "code": 0 })),
        )
    };
    let token = post(|Form(form): Form<HashMap<String, String>>| async move {
        let invalid = || {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "invalid_grant" })),
            )
        };
        if form["client_id"] != "discord-client" || form["client_secret"] != "discord-secret" {
            return invalid();
        }
        // A refresh token is `refresh|<access token>`.
        if form["grant_type"] == "refresh_token" {
            return match form["refresh_token"].strip_prefix("refresh|") {
                Some(access) => (
                    StatusCode::OK,
                    Json(json!({
                        "access_token": access, "token_type": "Bearer",
                        "refresh_token": form["refresh_token"], "expires_in": 604800,
                    })),
                ),
                None => invalid(),
            };
        }
        if form["redirect_uri"] != CALLBACK || form["grant_type"] != "authorization_code" {
            return invalid();
        }
        let code = &form["code"];
        let guild = code
            .strip_prefix("install:")
            .map(|id| json!({ "id": id, "name": "Comunidade Discord", "icon": "abc" }));
        (
            StatusCode::OK,
            Json(json!({
                "access_token": code, "token_type": "Bearer", "guild": guild,
                "refresh_token": format!("refresh|{code}"), "expires_in": 604800,
            })),
        )
    });
    let me = get(move |headers: HeaderMap| async move {
        if bot(&headers) {
            return (
                StatusCode::OK,
                Json(json!({ "id": "999", "username": "discvoice" })),
            );
        }
        let auth = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        if let Some(parts) = auth
            .strip_prefix("Bearer login:")
            .map(|s| s.split(':').collect::<Vec<_>>())
            .filter(|p| p.len() == 4)
        {
            return (
                StatusCode::OK,
                Json(json!({
                    "id": parts[0], "username": parts[1], "global_name": "Bia Discord",
                    "avatar": "face", "email": parts[2], "verified": parts[3] == "true",
                })),
            );
        }
        match auth
            .strip_prefix("Bearer account:")
            .map(|s| s.split(':').collect::<Vec<_>>())
        {
            Some(parts) if parts.len() == 2 => (
                StatusCode::OK,
                Json(
                    json!({ "id": parts[0], "username": parts[1], "global_name": "Nome Discord", "avatar": "def" }),
                ),
            ),
            _ => forbidden(),
        }
    });
    // The bot is in guild 700. Users own 700, manage 800 and are only a
    // member of 900.
    let my_guilds = get(move |headers: HeaderMap| async move {
        if bot(&headers) {
            return (
                StatusCode::OK,
                Json(json!([{ "id": "700", "name": "Comunidade Discord" }])),
            );
        }
        let auth = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        if !auth.starts_with("Bearer login:") && !auth.starts_with("Bearer account:") {
            return forbidden();
        }
        (
            StatusCode::OK,
            Json(json!([
                { "id": "700", "name": "Comunidade Discord", "icon": "abc", "owner": true, "permissions": "0" },
                { "id": "800", "name": "Outro Servidor", "icon": null, "owner": false, "permissions": (1u64 << 5).to_string() },
                { "id": "900", "name": "Só Membro", "icon": null, "owner": false, "permissions": (1u64 << 10).to_string() },
            ])),
        )
    });
    let app_info = get(move |headers: HeaderMap| async move {
        if !bot(&headers) {
            return forbidden();
        }
        // Presence and Message Content intents enabled.
        (
            StatusCode::OK,
            Json(json!({ "id": "1", "flags": (1 << 12) | (1 << 18) })),
        )
    });
    let guild = get(
        move |headers: HeaderMap, Path(id): Path<String>| async move {
            if !bot(&headers) {
                return forbidden();
            }
            let read = (1u64 << 10) | (1u64 << 16);
            (
                StatusCode::OK,
                Json(
                    json!({ "id": id, "owner_id": "1", "roles": [{ "id": id, "permissions": read.to_string() }] }),
                ),
            )
        },
    );
    let member = get(move |headers: HeaderMap| async move {
        if !bot(&headers) {
            return forbidden();
        }
        (StatusCode::OK, Json(json!({ "roles": [] })))
    });
    let channels = get(
        move |headers: HeaderMap, Path(id): Path<String>| async move {
            if !bot(&headers) {
                return forbidden();
            }
            // Guild 800 has the same channels, with ids prefixed by 8.
            let p = if id == "800" { "8" } else { "" };
            (
                StatusCode::OK,
                Json(json!([
                    { "id": format!("{p}502"), "type": 2, "name": "Voz", "position": 0, "guild_id": id },
                    { "id": format!("{p}501"), "type": 0, "name": "secreto", "parent_id": format!("{p}400"), "position": 1, "guild_id": id,
                      "permission_overwrites": [{ "id": id, "type": 0, "allow": "0", "deny": (1u64 << 10).to_string() }] },
                    { "id": format!("{p}500"), "type": 0, "name": "Geral", "parent_id": format!("{p}400"), "position": 0, "guild_id": id, "permission_overwrites": [] },
                    { "id": format!("{p}400"), "type": 4, "name": "Texto", "position": 0, "guild_id": id },
                ])),
            )
        },
    );
    let channel = get(
        move |headers: HeaderMap, Path(id): Path<String>| async move {
            if !bot(&headers) {
                return forbidden();
            }
            let (guild, local) = match id.strip_prefix('8').filter(|rest| rest.len() == 3) {
                Some(rest) => ("800", rest),
                None => ("700", id.as_str()),
            };
            let kind = if local == "502" { 2 } else { 0 };
            (
                StatusCode::OK,
                Json(
                    json!({ "id": id, "type": kind, "guild_id": guild, "name": if local == "500" { "Geral" } else { "secreto" } }),
                ),
            )
        },
    );
    let history_fake = fake.clone();
    let history_base = base.clone();
    let history = get(
        move |headers: HeaderMap,
              Path(id): Path<String>,
              Query(query): Query<HashMap<String, String>>| {
            let fake = history_fake.clone();
            let base = history_base.clone();
            async move {
                use axum::response::IntoResponse;
                if !bot(&headers) {
                    return forbidden().into_response();
                }
                if id == "501" {
                    return (
                        StatusCode::FORBIDDEN,
                        Json(json!({ "message": "Missing Access", "code": 50001 })),
                    )
                        .into_response();
                }
                // The first request is rate limited.
                if !fake
                    .throttled
                    .swap(true, std::sync::atomic::Ordering::SeqCst)
                {
                    return (
                        StatusCode::TOO_MANY_REQUESTS,
                        Json(json!({ "message": "You are being rate limited.", "retry_after": 0.01, "global": false })),
                    )
                        .into_response();
                }
                let after: u64 = query["after"].parse().unwrap();
                let limit: usize = query["limit"].parse().unwrap();
                let mut page: Vec<Value> = fake
                    .messages
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|m| m["id"].as_str().unwrap().parse::<u64>().unwrap() > after)
                    .take(limit)
                    .cloned()
                    .collect();
                // Discord lists newest first.
                page.reverse();
                let page: Value =
                    serde_json::from_str(&Value::Array(page).to_string().replace("BASE", &base))
                        .unwrap();
                (
                    [
                        ("x-ratelimit-remaining", "0"),
                        ("x-ratelimit-reset-after", "0.01"),
                    ],
                    Json(page),
                )
                    .into_response()
            }
        },
    );
    let attachment = get(|| async { ([("content-type", "image/png")], PICTURE) });
    let app_rpc = get(|Path(id): Path<String>| async move {
        Json(json!({ "id": id, "name": "Minecraft", "icon": "iconhash" }))
    });
    tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/oauth2/token", token)
                .route("/users/@me", me)
                .route("/users/@me/guilds", my_guilds)
                .route("/applications/@me", app_info)
                .route("/applications/{id}/rpc", app_rpc)
                .route("/guilds/{id}", guild)
                .route("/guilds/{id}/members/{member}", member)
                .route("/guilds/{id}/channels", channels)
                .route("/channels/{id}", channel)
                .route("/channels/{id}/messages", history)
                .route("/attachments/{channel}/{id}/{name}", attachment),
        )
        .await
        .unwrap();
    });
    disc_api::discord::DiscordConfig {
        client_id: "discord-client".into(),
        client_secret: "discord-secret".into(),
        bot_token: "test-bot-token".into(),
        api_url: base,
        authorize_url: "https://discord.example/oauth2/authorize".into(),
    }
}

async fn html(app: &Router, path: &str) -> String {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api{path}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    String::from_utf8(
        to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap()
}

/// Finishes an OAuth flow: reads `state` from the authorize URL and follows
/// Discord's redirect with `code`.
async fn authorize(app: &Router, url: &str, code: &str) -> String {
    let url = reqwest::Url::parse(url).unwrap();
    let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(params["redirect_uri"], CALLBACK);
    html(
        app,
        &format!("/discord/callback?code={code}&state={}", params["state"]),
    )
    .await
}

async fn wait_import(
    app: &Router,
    token: &str,
    server: &str,
    done: impl Fn(&Value) -> bool,
) -> Value {
    for _ in 0..200 {
        let view = call(
            app,
            "GET",
            &format!("/servers/{server}/discord"),
            Some(token),
            None,
        )
        .await
        .1;
        if done(&view) {
            return view;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("A importação não terminou a tempo");
}

fn import_of<'a>(view: &'a Value, discord_channel: &str) -> &'a Value {
    view["imports"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["discordChannelId"] == discord_channel)
        .unwrap()
}

#[tokio::test]
#[ignore = "Requires TEST_DATABASE_URL pointing to a PostgreSQL test database"]
async fn discord_import_and_activity() {
    let db = Database::connect(std::env::var("TEST_DATABASE_URL").expect("Set TEST_DATABASE_URL"))
        .await
        .unwrap();
    Migrator::up(&db, None).await.unwrap();
    let fake = FakeDiscord::default();
    {
        let mut messages = fake.messages.lock().unwrap();
        for id in 1000..1250u64 {
            // A system message (member joined) in the middle is skipped.
            let kind = if id == 1010 { 7 } else { 0 };
            messages.push(discord_message(
                id,
                kind,
                if id % 2 == 0 { "10" } else { "11" },
            ));
        }
    }
    let state = AppState::new(
        db.clone(),
        "https://discvoice.example".into(),
        fake_google().await,
    )
    .with_discord(fake_discord(fake.clone()).await)
    .with_uploads(std::env::temp_dir().join(format!("disc-voice-test-{}", Uuid::new_v4())));
    disc_api::discord::spawn_worker(&state);
    let app = router(state.clone(), vec![]);
    let (owner, owner_id) = register(&app, "Dona").await;
    let (member, member_id) = register(&app, "Membro").await;
    let created = call(
        &app,
        "POST",
        "/servers",
        Some(&owner),
        Some(json!({ "name": "Importados" })),
    )
    .await
    .1;
    let server_id = created["server"]["id"].as_str().unwrap().to_owned();
    call(
        &app,
        "POST",
        &format!("/invites/{}/join", created["code"].as_str().unwrap()),
        Some(&member),
        None,
    )
    .await;
    let base = format!("/servers/{server_id}/discord");

    let status = call(&app, "GET", "/discord", Some(&member), None).await.1;
    assert_eq!(
        (&status["enabled"], &status["account"]),
        (&json!(true), &Value::Null)
    );

    // Only the owner connects Discord servers, by installing the bot.
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{base}/install"),
            Some(&member),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&app, "GET", &base, Some(&member), None).await.0,
        StatusCode::FORBIDDEN
    );
    let install = call(&app, "POST", &format!("{base}/install"), Some(&owner), None)
        .await
        .1;
    let url = install["url"].as_str().unwrap();
    assert!(
        url.contains("scope=bot+identify") && url.contains("permissions=66560"),
        "{url}"
    );
    let page = authorize(&app, url, "install:700").await;
    assert!(page.contains("Tudo certo"), "{page}");
    // A state works once.
    assert!(authorize(&app, url, "install:700")
        .await
        .contains("expirou"));

    let view = call(&app, "GET", &base, Some(&owner), None).await.1;
    assert_eq!(view["messageContent"], true);
    let guild = &view["guilds"][0];
    assert_eq!(
        (&guild["id"], &guild["name"], &guild["available"]),
        (&json!("700"), &json!("Comunidade Discord"), &json!(true))
    );
    let channels: Vec<_> = guild["channels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["id"].clone(),
                c["readable"].clone(),
                c["category"].clone(),
            )
        })
        .collect();
    assert_eq!(
        channels,
        [
            (json!("500"), json!(true), json!("Texto")),
            (json!("501"), json!(false), json!("Texto"))
        ]
    );

    // Importing: only text channels of the connected guild, once each.
    let imports = format!("{base}/imports");
    for (guild, channel, expected) in [
        ("701", "500", StatusCode::NOT_FOUND),
        ("700", "502", StatusCode::BAD_REQUEST),
        ("700", "../x", StatusCode::BAD_REQUEST),
    ] {
        assert_eq!(
            call(
                &app,
                "POST",
                &imports,
                Some(&owner),
                Some(json!({ "guildId": guild, "channelId": channel }))
            )
            .await
            .0,
            expected
        );
    }
    assert_eq!(
        call(
            &app,
            "POST",
            &imports,
            Some(&member),
            Some(json!({ "guildId": "700", "channelId": "500" }))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, import) = call(
        &app,
        "POST",
        &imports,
        Some(&owner),
        Some(json!({ "guildId": "700", "channelId": "500" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{import}");
    assert_eq!(
        call(
            &app,
            "POST",
            &imports,
            Some(&owner),
            Some(json!({ "guildId": "700", "channelId": "500" }))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let hidden = call(
        &app,
        "POST",
        &imports,
        Some(&owner),
        Some(json!({ "guildId": "700", "channelId": "501" })),
    )
    .await
    .1;
    let mirror = import["channelId"].as_str().unwrap().to_owned();

    // The backlog arrives in pages, past a rate limit, once.
    let view = wait_import(&app, &owner, &server_id, |v| {
        import_of(v, "500")["status"] == "idle" && import_of(v, "501")["status"] == "error"
    })
    .await;
    let done = import_of(&view, "500");
    assert_eq!(
        (&done["phase"], &done["imported"]),
        (&json!("done"), &json!(249))
    );
    // Missing permissions are reported and not retried on their own.
    assert!(import_of(&view, "501")["error"]
        .as_str()
        .unwrap()
        .contains("Ler histórico"));
    assert_eq!(
        view["guilds"][0]["channels"][0]["import"]["channelId"],
        mirror.as_str()
    );

    let listed = call(
        &app,
        "GET",
        &format!("/servers/{server_id}/channels"),
        Some(&member),
        None,
    )
    .await
    .1;
    let channel = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == mirror.as_str())
        .unwrap();
    assert_eq!(
        (&channel["name"], &channel["source"], &channel["readOnly"]),
        (&json!("geral"), &json!("discord"), &json!(false))
    );
    // The unfinished import keeps its channel closed to new messages.
    assert!(listed
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["id"] == hidden["channelId"]
            && c["name"] == "secreto"
            && c["readOnly"] == true));
    let hidden_messages = format!(
        "/channels/{}/messages",
        hidden["channelId"].as_str().unwrap()
    );
    let (status, refused) = call(
        &app,
        "POST",
        &hidden_messages,
        Some(&owner),
        Some(json!({ "clientId": Uuid::new_v4(), "content": "cedo demais" })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(refused["error"]
        .as_str()
        .unwrap()
        .contains("sendo importado"));
    // Its owner can give up on the rest; then it is a regular channel.
    let finish = format!(
        "/discord/imports/{}/finish",
        hidden["channelId"].as_str().unwrap()
    );
    assert_eq!(
        call(&app, "POST", &finish, Some(&member), None).await.0,
        StatusCode::FORBIDDEN
    );
    let finished = call(&app, "POST", &finish, Some(&owner), None).await.1;
    assert_eq!(
        (&finished["phase"], &finished["status"]),
        (&json!("done"), &json!("idle"))
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &hidden_messages,
            Some(&owner),
            Some(json!({ "clientId": Uuid::new_v4(), "content": "agora sim" }))
        )
        .await
        .0,
        StatusCode::OK
    );

    // Text and voice channels may share a name, but not two of the same type.
    let channels_path = format!("/servers/{server_id}/channels");
    assert_eq!(
        call(
            &app,
            "POST",
            &channels_path,
            Some(&owner),
            Some(json!({ "name": "geral", "type": "voice" }))
        )
        .await
        .0,
        StatusCode::CREATED
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &channels_path,
            Some(&owner),
            Some(json!({ "name": "geral", "type": "text" }))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );

    // Members read the history in Discord order.
    let messages = format!("/channels/{mirror}/messages");
    let latest = call(
        &app,
        "GET",
        &format!("{messages}?limit=100"),
        Some(&member),
        None,
    )
    .await
    .1;
    let contents: Vec<_> = latest["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["content"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(contents.first().unwrap(), "Mensagem 1150");
    assert_eq!(contents.last().unwrap(), "Mensagem 1249");
    assert_eq!(latest["hasMore"], true);
    let oldest = call(
        &app,
        "GET",
        &format!("{messages}?after=0&limit=10"),
        Some(&member),
        None,
    )
    .await
    .1;
    let first = &oldest["messages"][0];
    assert_eq!(
        (&first["content"], &first["discordId"]),
        (&json!("Mensagem 1000"), &json!("1000"))
    );
    assert_eq!(first["author"]["name"], "Pessoa 10");
    assert_eq!(first["author"]["discord"], "user10");
    assert_eq!(first["createdAt"], "2024-05-01T12:16:40Z");
    let attachment = oldest["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["discordId"] == "1005")
        .unwrap();
    assert_eq!(attachment["attachments"][0]["filename"], "mapa.png");
    assert_eq!(attachment["attachments"][0]["size"], PICTURE.len());
    assert!(oldest["messages"]
        .as_array()
        .unwrap()
        .iter()
        .all(|m| m["discordId"] != "1010"));
    // Mentions by id read as names.
    let mention = oldest["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["discordId"] == "1003")
        .unwrap();
    assert_eq!(mention["content"], "@Pessoa 11 veja #Geral");

    // Media is copied to the API, since Discord's links expire, and served
    // inline with range support but without running anything.
    let file = attachment["attachments"][0]["url"].as_str().unwrap();
    assert!(
        file.starts_with("/api/files/") && file.ends_with("/mapa.png"),
        "{file}"
    );
    assert!(attachment["attachments"][0].get("unavailable").is_none());
    let (status, headers, body) = raw(&app, file, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, PICTURE);
    assert_eq!(headers["content-type"], "image/png");
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert!(headers["content-disposition"]
        .to_str()
        .unwrap()
        .starts_with("inline"));
    assert!(headers["content-security-policy"]
        .to_str()
        .unwrap()
        .contains("sandbox"));
    let (status, _, body) = raw(&app, file, &[("range", "bytes=0-3")]).await;
    assert_eq!(
        (status, body.as_slice()),
        (StatusCode::PARTIAL_CONTENT, &PICTURE[..4])
    );
    assert_eq!(
        raw(&app, &format!("/api/files/{}/x.png", Uuid::new_v4()), &[])
            .await
            .0,
        StatusCode::NOT_FOUND
    );

    // The import ran once: later Discord messages are not brought over, and
    // the channel now takes messages sent in Disc Voice.
    {
        let mut stored = fake.messages.lock().unwrap();
        for id in 1250..1253 {
            stored.push(discord_message(id, 0, "11"));
        }
    }
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/discord/imports/{mirror}/retry"),
            Some(&owner),
            None
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (status, local) = call(
        &app,
        "POST",
        &messages,
        Some(&member),
        Some(json!({ "clientId": Uuid::new_v4(), "content": "Agora pelo Disc Voice" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{local}");
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let view = call(&app, "GET", &base, Some(&owner), None).await.1;
    assert_eq!(import_of(&view, "500")["imported"], 249);
    let stored = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT count(*) AS n, count(DISTINCT discord_id) AS d FROM messages WHERE channel_id = $1",
            [Uuid::parse_str(&mirror).unwrap().into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.try_get::<i64>("", "n").unwrap(), 250);
    assert_eq!(stored.try_get::<i64>("", "d").unwrap(), 249);
    let after = call(
        &app,
        "GET",
        &format!("{messages}?limit=2"),
        Some(&member),
        None,
    )
    .await
    .1;
    assert_eq!(after["messages"][0]["content"], "Mensagem 1249");
    assert_eq!(after["messages"][1]["content"], "Agora pelo Disc Voice");

    // Imported messages are searchable.
    let found = call(
        &app,
        "GET",
        "/search?q=Mensagem%201249",
        Some(&member),
        None,
    )
    .await
    .1;
    assert_eq!(found["messages"][0]["channelId"], mirror.as_str());
    assert_eq!(found["messages"][0]["author"]["name"], "Pessoa 11");

    // Linking a Discord account: imported messages show the Disc Voice user,
    // and the Discord presence becomes the user's activity.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ws_url = format!("ws://{}/api/realtime", listener.local_addr().unwrap());
    let live_app = app.clone();
    let live = tokio::spawn(async move {
        axum::serve(listener, live_app).await.unwrap();
    });
    let (mut owner_ws, _) = socket(&ws_url, &owner).await;
    let (mut member_ws, _) = socket(&ws_url, &member).await;
    let link = call(&app, "POST", "/discord/link", Some(&owner), None)
        .await
        .1;
    assert!(link["url"].as_str().unwrap().contains("scope=identify"));
    let page = authorize(&app, link["url"].as_str().unwrap(), "account:10:ana").await;
    assert!(page.contains("@ana"), "{page}");
    assert_eq!(
        event(&mut owner_ws, "discord.updated").await["serverId"],
        Value::Null
    );
    let status = call(&app, "GET", "/discord", Some(&owner), None).await.1;
    assert_eq!(status["account"]["username"], "ana");
    assert_eq!(status["account"]["shareActivity"], true);
    assert_eq!(status["account"]["presenceSeen"], false);
    assert_eq!(status["clientId"], "discord-client");
    // The same Discord account can't be linked twice.
    let taken = call(&app, "POST", "/discord/link", Some(&member), None)
        .await
        .1;
    assert!(
        authorize(&app, taken["url"].as_str().unwrap(), "account:10:ana")
            .await
            .contains("outro usuário")
    );
    let oldest = call(
        &app,
        "GET",
        &format!("{messages}?after=0&limit=2"),
        Some(&member),
        None,
    )
    .await
    .1;
    assert_eq!(oldest["messages"][0]["author"]["id"], owner_id.as_str());
    assert_eq!(oldest["messages"][1]["author"]["name"], "Pessoa 11");

    disc_api::discord::dispatch(
        &state,
        "PRESENCE_UPDATE",
        &json!({ "user": { "id": "10" }, "guild_id": "700", "status": "online",
                 "activities": [{ "type": 0, "name": "Minecraft", "details": "Sobrevivência" }] }),
    )
    .await;
    let update = event(&mut member_ws, "activity.updated").await;
    assert_eq!(update["userId"], owner_id.as_str());
    assert_eq!(update["activity"]["name"], "Minecraft");
    assert_eq!(update["activity"]["kind"], "playing");
    assert_eq!(update["activity"]["source"], "discord");
    let activities = call(&app, "GET", "/activities", Some(&member), None)
        .await
        .1;
    assert_eq!(activities[owner_id.as_str()]["name"], "Minecraft");
    assert_eq!(
        call(&app, "GET", "/discord", Some(&owner), None).await.1["account"]["presenceSeen"],
        true
    );
    // A detected game without its own images shows the app icon.
    disc_api::discord::dispatch(
        &state,
        "PRESENCE_UPDATE",
        &json!({ "user": { "id": "10" }, "status": "online",
                 "activities": [{ "type": 0, "name": "Minecraft", "details": "Sobrevivência", "application_id": "321" }] }),
    )
    .await;
    assert_eq!(
        event(&mut member_ws, "activity.updated").await["activity"]["image"],
        "https://cdn.discordapp.com/app-icons/321/iconhash.png?size=160"
    );
    // Unlinked Discord users never show up.
    disc_api::discord::dispatch(
        &state,
        "PRESENCE_UPDATE",
        &json!({ "user": { "id": "11" }, "status": "online", "activities": [{ "type": 0, "name": "Tetris" }] }),
    )
    .await;
    assert_eq!(
        call(&app, "GET", "/activities", Some(&member), None)
            .await
            .1
            .as_object()
            .unwrap()
            .len(),
        1
    );

    // Turning sharing off hides it; turning it back on restores it.
    assert_eq!(
        call(
            &app,
            "PATCH",
            "/discord/account",
            Some(&owner),
            Some(json!({ "shareActivity": false }))
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        event(&mut member_ws, "activity.updated").await["activity"],
        Value::Null
    );
    assert_eq!(
        call(&app, "GET", "/activities", Some(&member), None)
            .await
            .1,
        json!({})
    );
    call(
        &app,
        "PATCH",
        "/discord/account",
        Some(&owner),
        Some(json!({ "shareActivity": true })),
    )
    .await;
    assert_eq!(
        event(&mut member_ws, "activity.updated").await["activity"]["name"],
        "Minecraft"
    );
    // Going offline on Discord clears it.
    disc_api::discord::dispatch(
        &state,
        "PRESENCE_UPDATE",
        &json!({ "user": { "id": "10" }, "status": "offline", "activities": [] }),
    )
    .await;
    assert_eq!(
        event(&mut member_ws, "activity.updated").await["activity"],
        Value::Null
    );
    assert_eq!(
        call(&app, "DELETE", "/discord/account", Some(&owner), None)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(&app, "GET", "/discord", Some(&owner), None).await.1["account"],
        Value::Null
    );

    // Removing the bot afterwards doesn't affect finished imports.
    disc_api::discord::dispatch(&state, "GUILD_DELETE", &json!({ "id": "700" })).await;
    let view = call(&app, "GET", &base, Some(&owner), None).await.1;
    assert_eq!(import_of(&view, "500")["error"], Value::Null);
    // Disconnecting the guild keeps the imported channels and messages.
    assert_eq!(
        call(
            &app,
            "DELETE",
            &format!("{base}/guilds/700"),
            Some(&owner),
            None
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let view = call(&app, "GET", &base, Some(&owner), None).await.1;
    assert_eq!(
        (&view["guilds"], &view["imports"]),
        (&json!([]), &json!([]))
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("{messages}?limit=1"),
            Some(&member),
            None
        )
        .await
        .1["messages"][0]["content"],
        "Agora pelo Disc Voice"
    );

    owner_ws.close(None).await.unwrap();
    member_ws.close(None).await.unwrap();
    live.abort();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM servers WHERE id = $1",
        [Uuid::parse_str(&server_id).unwrap().into()],
    ))
    .await
    .unwrap();
    for id in [owner_id, member_id] {
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "DELETE FROM users WHERE id = $1",
            [Uuid::parse_str(&id).unwrap().into()],
        ))
        .await
        .unwrap();
    }
}

const LOGIN_STATE: &str = "desktop-state-0123456789";

/// Signs in with Discord from the desktop app: starts the flow, follows
/// Discord's redirect with `code` and returns where the browser is sent.
async fn discord_redirect(app: &Router, code: &str) -> reqwest::Url {
    let (status, start) = call(
        app,
        "POST",
        "/auth/discord/start",
        None,
        Some(json!({ "platform": "desktop", "port": 53124, "state": LOGIN_STATE })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{start}");
    let url = reqwest::Url::parse(start["url"].as_str().unwrap()).unwrap();
    let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(params["scope"], "identify email guilds");
    assert_eq!(params["redirect_uri"], CALLBACK);
    let (status, headers, _) = raw(
        app,
        &format!(
            "/api/discord/callback?code={code}&state={}",
            params["state"]
        ),
        &[],
    )
    .await;
    assert!(status.is_redirection(), "{status}");
    reqwest::Url::parse(headers["location"].to_str().unwrap()).unwrap()
}

async fn discord_login(app: &Router, code: &str) -> (StatusCode, Value) {
    let location = discord_redirect(app, code).await;
    assert_eq!(
        location.origin().ascii_serialization(),
        "http://127.0.0.1:53124"
    );
    let params: HashMap<_, _> = location.query_pairs().into_owned().collect();
    assert_eq!(params["state"], LOGIN_STATE);
    let Some(ticket) = params.get("ticket") else {
        return (StatusCode::BAD_REQUEST, json!({ "error": params["error"] }));
    };
    let result = call(
        app,
        "POST",
        "/auth/discord",
        None,
        Some(json!({ "ticket": ticket })),
    )
    .await;
    // A ticket signs in once.
    assert_eq!(
        call(
            app,
            "POST",
            "/auth/discord",
            None,
            Some(json!({ "ticket": ticket }))
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    result
}

#[tokio::test]
#[ignore = "Requires TEST_DATABASE_URL pointing to a PostgreSQL test database"]
async fn discord_login_consent_and_guild_import() {
    let db = Database::connect(std::env::var("TEST_DATABASE_URL").expect("Set TEST_DATABASE_URL"))
        .await
        .unwrap();
    Migrator::up(&db, None).await.unwrap();
    let state = AppState::new(
        db.clone(),
        "https://discvoice.example".into(),
        fake_google().await,
    )
    .with_discord(fake_discord(FakeDiscord::default()).await);
    let app = router(state, vec![]);
    let suffix = Uuid::new_v4().as_u128() % 1_000_000_000;
    let (bia_discord, cai_discord) = (format!("31{suffix}"), format!("32{suffix}"));
    let bia_email = format!("bia-{suffix}@example.com");

    assert_eq!(
        call(&app, "GET", "/auth/discord/config", None, None)
            .await
            .1,
        json!({ "enabled": true })
    );
    // The desktop must say where it waits, on a non-privileged port.
    for body in [
        json!({ "platform": "desktop" }),
        json!({ "platform": "desktop", "port": 80, "state": LOGIN_STATE }),
        json!({ "platform": "desktop", "port": 53124, "state": "x" }),
    ] {
        assert_eq!(
            call(&app, "POST", "/auth/discord/start", None, Some(body))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }

    // An unverified Discord e-mail can't sign in.
    let (status, body) =
        discord_login(&app, &format!("login:{bia_discord}:bia:{bia_email}:false")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("e-mail"), "{body}");

    // The first sign-in creates the account, linked to Discord, without its
    // photo or activity until the user answers.
    let code = format!("login:{bia_discord}:bia:{bia_email}:true");
    let (status, first) = discord_login(&app, &code).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["discordConsent"], true);
    assert_eq!(first["user"]["name"], "Bia Discord");
    assert_eq!(first["user"]["avatar"], Value::Null);
    let bia = first["token"].as_str().unwrap().to_owned();
    let bia_id = first["user"]["id"].as_str().unwrap().to_owned();
    let status = call(&app, "GET", "/discord", Some(&bia), None).await.1;
    assert_eq!(status["account"]["username"], "bia");
    assert_eq!(status["account"]["shareActivity"], false);
    assert_eq!(status["account"]["consentPending"], true);
    assert_eq!(status["account"]["canListGuilds"], true);

    // Signing in again finds the same account, still waiting for the answer.
    let (_, again) = discord_login(&app, &code).await;
    assert_eq!(again["user"]["id"], bia_id.as_str());
    assert_eq!(again["discordConsent"], true);

    // Yes to the photo and the activity.
    assert_eq!(
        call(
            &app,
            "POST",
            "/discord/consent",
            Some(&bia),
            Some(json!({ "useAvatar": true, "shareActivity": true }))
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let me = call(&app, "GET", "/me", Some(&bia), None).await.1;
    assert_eq!(
        me["avatar"],
        format!("https://cdn.discordapp.com/avatars/{bia_discord}/face.png?size=128")
    );
    assert_eq!(me["avatarSource"], "discord");
    let status = call(&app, "GET", "/discord", Some(&bia), None).await.1;
    assert_eq!(
        (
            &status["account"]["consentPending"],
            &status["account"]["shareActivity"],
            &status["account"]["useAvatar"]
        ),
        (&json!(false), &json!(true), &json!(true))
    );
    assert_eq!(discord_login(&app, &code).await.1["discordConsent"], false);

    // A Google sign-in with the same e-mail joins the account and keeps the
    // Discord photo.
    let (status, google_body) = google_desktop(
        &app,
        &google_code(&format!("sub-{suffix}"), &bia_email, "Bia Google", true),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{google_body}");
    assert_eq!(google_body["user"]["id"], bia_id.as_str());
    assert_eq!(google_body["user"]["avatarSource"], "discord");
    // The photo setting can be turned off from the settings.
    call(
        &app,
        "PATCH",
        "/discord/account",
        Some(&bia),
        Some(json!({ "useAvatar": false })),
    )
    .await;
    let me = call(&app, "GET", "/me", Some(&bia), None).await.1;
    assert_eq!(
        (&me["avatar"], &me["avatarSource"]),
        (&Value::Null, &Value::Null)
    );

    // A Google account signs in with Discord through its verified e-mail.
    let (google_token, google_id) = register(&app, "Cai").await;
    let cai_email = call(&app, "GET", "/me", Some(&google_token), None).await.1["email"]
        .as_str()
        .unwrap()
        .to_owned();
    let (status, cai) =
        discord_login(&app, &format!("login:{cai_discord}:cai:{cai_email}:true")).await;
    assert_eq!(status, StatusCode::OK, "{cai}");
    assert_eq!(cai["user"]["id"], google_id.as_str());
    let cai = cai["token"].as_str().unwrap().to_owned();
    // ...but an e-mail already tied to another Discord account is refused.
    let (status, taken) =
        discord_login(&app, &format!("login:33{suffix}:outra:{bia_email}:true")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        taken["error"].as_str().unwrap().contains("outra conta"),
        "{taken}"
    );

    // Only the Discord servers the user manages are offered.
    let guilds = call(&app, "GET", "/discord/guilds", Some(&bia), None)
        .await
        .1;
    let listed: Vec<_> = guilds
        .as_array()
        .unwrap()
        .iter()
        .map(|g| {
            (
                g["id"].clone(),
                g["botInstalled"].clone(),
                g["importedServerId"].clone(),
            )
        })
        .collect();
    assert_eq!(
        listed,
        [
            (json!("700"), json!(true), Value::Null),
            (json!("800"), json!(false), Value::Null)
        ]
    );
    assert_eq!(
        guilds[0]["icon"],
        "https://cdn.discordapp.com/icons/700/abc.png?size=128"
    );
    assert_eq!(
        call(&app, "POST", "/discord/guilds/900/import", Some(&bia), None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );

    // With the bot already there, the server comes with its channels, in
    // Discord's order (voice outside categories first).
    let (status, imported) =
        call(&app, "POST", "/discord/guilds/700/import", Some(&bia), None).await;
    assert_eq!(status, StatusCode::CREATED, "{imported}");
    assert_eq!(imported["installUrl"], Value::Null);
    assert_eq!(imported["channels"], 3);
    let server = &imported["server"]["server"];
    assert_eq!(server["name"], "Comunidade Discord");
    assert_eq!(
        server["icon"],
        "https://cdn.discordapp.com/icons/700/abc.png?size=128"
    );
    let server_id = server["id"].as_str().unwrap().to_owned();
    let channels = call(
        &app,
        "GET",
        &format!("/servers/{server_id}/channels"),
        Some(&bia),
        None,
    )
    .await
    .1;
    let names: Vec<_> = channels
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            format!(
                "{}:{}",
                c["type"].as_str().unwrap(),
                c["name"].as_str().unwrap()
            )
        })
        .collect();
    assert_eq!(names, ["voice:voz", "text:geral", "text:secreto"]);
    // The Discord server is connected: history can be imported channel by channel.
    let view = call(
        &app,
        "GET",
        &format!("/servers/{server_id}/discord"),
        Some(&bia),
        None,
    )
    .await
    .1;
    assert_eq!(view["guilds"][0]["id"], "700");
    assert_eq!(
        call(&app, "POST", "/discord/guilds/700/import", Some(&bia), None)
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(&app, "GET", "/discord/guilds", Some(&bia), None)
            .await
            .1[0]["importedServerId"],
        server_id.as_str()
    );

    // An expired token is refreshed.
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE discord_accounts SET token_expires_at = now() - interval '1 hour' WHERE user_id = $1",
        [Uuid::parse_str(&bia_id).unwrap().into()],
    ))
    .await
    .unwrap();
    assert_eq!(
        call(&app, "GET", "/discord/guilds", Some(&bia), None)
            .await
            .0,
        StatusCode::OK
    );

    // Without the bot, the server is created right away and the bot is
    // installed in that Discord server, which then brings the channels.
    let (status, pending) =
        call(&app, "POST", "/discord/guilds/800/import", Some(&cai), None).await;
    assert_eq!(status, StatusCode::CREATED, "{pending}");
    let other_id = pending["server"]["server"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(pending["server"]["server"]["icon"], Value::Null);
    let install = pending["installUrl"].as_str().unwrap();
    assert!(
        install.contains("guild_id=800") && install.contains("disable_guild_select=true"),
        "{install}"
    );
    // The bot must land in that same Discord server.
    assert!(authorize(&app, install, "install:801")
        .await
        .contains("outro servidor"));
    let (_, retry) = call(&app, "POST", "/discord/guilds/800/import", Some(&cai), None).await;
    let retry_id = retry["server"]["server"]["id"].as_str().unwrap().to_owned();
    let page = authorize(&app, retry["installUrl"].as_str().unwrap(), "install:800").await;
    assert!(page.contains("importado com 3 canais"), "{page}");
    let channels = call(
        &app,
        "GET",
        &format!("/servers/{retry_id}/channels"),
        Some(&cai),
        None,
    )
    .await
    .1;
    assert_eq!(channels.as_array().unwrap().len(), 3);

    // Importing a channel's history goes into the empty channel of the same
    // name the server import created...
    let geral = |channels: &Value| {
        channels
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "geral" && c["type"] == "text")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let bia_channels = call(
        &app,
        "GET",
        &format!("/servers/{server_id}/channels"),
        Some(&bia),
        None,
    )
    .await
    .1;
    let bia_geral = geral(&bia_channels);
    let view = call(
        &app,
        "GET",
        &format!("/servers/{server_id}/discord"),
        Some(&bia),
        None,
    )
    .await
    .1;
    assert_eq!(view["guilds"][0]["channels"][0]["target"], "geral");
    let (status, history) = call(
        &app,
        "POST",
        &format!("/servers/{server_id}/discord/imports"),
        Some(&bia),
        Some(json!({ "guildId": "700", "channelId": "500" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{history}");
    assert_eq!(history["channelId"], bia_geral.as_str());
    let after = call(
        &app,
        "GET",
        &format!("/servers/{server_id}/channels"),
        Some(&bia),
        None,
    )
    .await
    .1;
    assert_eq!(after.as_array().unwrap().len(), 3);
    let matched = after
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == bia_geral.as_str())
        .unwrap();
    assert_eq!(
        (&matched["source"], &matched["readOnly"]),
        (&json!("discord"), &json!(true))
    );
    // It is locked while the history comes in.
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/channels/{bia_geral}/messages"),
            Some(&bia),
            Some(json!({ "clientId": Uuid::new_v4(), "content": "oi" }))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );

    // ...but not into one that already has messages: those would come first.
    let cai_geral = geral(&channels);
    let (status, _) = call(
        &app,
        "POST",
        &format!("/channels/{cai_geral}/messages"),
        Some(&cai),
        Some(json!({ "clientId": Uuid::new_v4(), "content": "Já conversamos aqui" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, history) = call(
        &app,
        "POST",
        &format!("/servers/{retry_id}/discord/imports"),
        Some(&cai),
        Some(json!({ "guildId": "800", "channelId": "8500" })),
    )
    .await;
    assert_ne!(history["channelId"], cai_geral.as_str());
    let names: Vec<_> = call(
        &app,
        "GET",
        &format!("/servers/{retry_id}/channels"),
        Some(&cai),
        None,
    )
    .await
    .1
    .as_array()
    .unwrap()
    .iter()
    .map(|c| c["name"].as_str().unwrap().to_owned())
    .collect();
    assert!(names.contains(&"geral-discord".to_owned()), "{names:?}");

    for id in [server_id, other_id, retry_id] {
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "DELETE FROM servers WHERE id = $1",
            [Uuid::parse_str(&id).unwrap().into()],
        ))
        .await
        .unwrap();
    }
    for id in [bia_id, google_id] {
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "DELETE FROM users WHERE id = $1",
            [Uuid::parse_str(&id).unwrap().into()],
        ))
        .await
        .unwrap();
    }
}

async fn register(app: &Router, name: &str) -> (String, String) {
    let id = Uuid::new_v4().simple();
    let email = format!("{}-{id}@example.com", name.to_lowercase());
    let (status, body) =
        google_desktop(app, &google_code(&format!("sub-{id}"), &email, name, true)).await;
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
        AppState::new(
            db.clone(),
            "https://discvoice.example".into(),
            fake_google().await,
        ),
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

fn unread(reads: &Value, channel: &str) -> (i64, String) {
    let read = reads
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["channelId"] == channel)
        .unwrap_or_else(|| panic!("no read state for {channel}: {reads}"));
    (
        read["unread"].as_i64().unwrap(),
        read["lastReadId"].as_str().unwrap().to_owned(),
    )
}

#[tokio::test]
#[ignore = "Requires TEST_DATABASE_URL pointing to a PostgreSQL test database"]
async fn direct_messages_read_state_and_typing() {
    let db = Database::connect(std::env::var("TEST_DATABASE_URL").expect("Set TEST_DATABASE_URL"))
        .await
        .unwrap();
    Migrator::up(&db, None).await.unwrap();
    let app = router(
        AppState::new(
            db.clone(),
            "https://discvoice.example".into(),
            fake_google().await,
        ),
        vec![],
    );
    let tag = Uuid::new_v4().simple().to_string()[..10].to_owned();
    let (owner, owner_id) = register(&app, "Elisa Prado").await;
    let (guest, guest_id) = register(&app, "Convidada").await;
    let (outsider, outsider_id) = register(&app, "Estranha").await;
    let created = call(
        &app,
        "POST",
        "/servers",
        Some(&owner),
        Some(json!({ "name": format!("Leitura {tag}") })),
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
    let text = call(
        &app,
        "POST",
        &format!("/servers/{server_id}/channels"),
        Some(&owner),
        Some(json!({ "name": "geral" })),
    )
    .await
    .1;
    let text_id = text["id"].as_str().unwrap().to_owned();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/api/realtime", listener.local_addr().unwrap());
    let live_app = app.clone();
    let live = tokio::spawn(async move {
        axum::serve(listener, live_app).await.unwrap();
    });
    let (mut owner_ws, _) = socket(&url, &owner).await;
    let (mut guest_ws, _) = socket(&url, &guest).await;
    let (mut guest_laptop, _) = socket(&url, &guest).await;
    let (mut outsider_ws, _) = socket(&url, &outsider).await;

    // Conversations are only with people of a shared server, never with oneself.
    let dms = |token: &str, user: &str| {
        let (app, token, user) = (app.clone(), token.to_owned(), user.to_owned());
        async move {
            call(
                &app,
                "POST",
                "/dms",
                Some(&token),
                Some(json!({ "userId": user })),
            )
            .await
        }
    };
    assert_eq!(dms(&outsider, &owner_id).await.0, StatusCode::FORBIDDEN);
    assert_eq!(dms(&owner, &owner_id).await.0, StatusCode::BAD_REQUEST);
    let (status, opened) = dms(&owner, &guest_id).await;
    assert_eq!(status, StatusCode::CREATED, "{opened}");
    assert_eq!(opened["user"]["id"], guest_id);
    assert_eq!(opened["channel"]["type"], "dm");
    assert_eq!(opened["channel"]["serverId"], Value::Null);
    let dm_id = opened["channel"]["id"].as_str().unwrap().to_owned();
    // The other person learns about it, named after who started it.
    let announced = event(&mut guest_ws, "dm.created").await;
    assert_eq!(announced["conversation"]["user"]["id"], owner_id);
    // Opening it again, from either side, finds the same conversation.
    let again = dms(&owner, &guest_id).await;
    assert_eq!(
        (again.0, &again.1["channel"]["id"]),
        (StatusCode::OK, &json!(dm_id))
    );
    let back = dms(&guest, &owner_id).await;
    assert_eq!(
        (back.0, &back.1["channel"]["id"]),
        (StatusCode::OK, &json!(dm_id))
    );
    let listed = call(&app, "GET", "/dms", Some(&guest), None).await.1;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["user"]["id"], owner_id);

    // Only the two people can read or write it.
    let dm_messages = format!("/channels/{dm_id}/messages");
    assert_eq!(
        call(&app, "GET", &dm_messages, Some(&outsider), None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (status, private) = call(
        &app,
        "POST",
        &dm_messages,
        Some(&owner),
        Some(json!({ "clientId": Uuid::new_v4(), "content": format!("Segredo {tag}") })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{private}");
    assert_eq!(
        event(&mut guest_ws, "message.created").await["message"]["id"],
        private["id"]
    );
    assert_eq!(
        event(&mut guest_laptop, "message.created").await["message"]["id"],
        private["id"]
    );
    // Private messages never show up in search, not even for the participants.
    let found = call(
        &app,
        "GET",
        &format!("/search?q=Segredo%20{tag}"),
        Some(&guest),
        None,
    )
    .await
    .1;
    assert!(found["messages"].as_array().unwrap().is_empty(), "{found}");

    // Unread counts: other people's messages after the marker.
    let first = call(
        &app,
        "POST",
        &format!("/channels/{text_id}/messages"),
        Some(&owner),
        Some(json!({ "clientId": Uuid::new_v4(), "content": "Oi" })),
    )
    .await
    .1;
    let reads = call(&app, "GET", "/reads", Some(&guest), None).await.1;
    assert_eq!(unread(&reads, &dm_id).0, 1);
    assert_eq!(unread(&reads, &text_id), (1, "0".into()));
    let mine = call(&app, "GET", "/reads", Some(&owner), None).await.1;
    assert_eq!(unread(&mine, &dm_id).0, 0);
    assert_eq!(unread(&mine, &text_id).0, 0);
    let outsiders = call(&app, "GET", "/reads", Some(&outsider), None).await.1;
    assert!(outsiders
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["channelId"] != dm_id && r["channelId"] != text_id));

    // Reading on one device clears the badge on the others.
    let mark = |channel: &str, message: &Value, token: &str| {
        let (app, path, token) = (
            app.clone(),
            format!("/channels/{channel}/read"),
            token.to_owned(),
        );
        let body = json!({ "messageId": message });
        async move { call(&app, "POST", &path, Some(&token), Some(body)).await }
    };
    let (status, marked) = mark(&dm_id, &private["id"], &guest).await;
    assert_eq!(status, StatusCode::OK, "{marked}");
    let synced = event(&mut guest_laptop, "read.updated").await;
    assert_eq!(
        (&synced["channelId"], &synced["lastReadId"]),
        (&json!(dm_id), &private["id"])
    );
    // A message of another channel, or someone else's conversation, is refused.
    assert_eq!(
        mark(&dm_id, &first["id"], &guest).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        mark(&dm_id, &private["id"], &outsider).await.0,
        StatusCode::FORBIDDEN
    );
    let second = call(
        &app,
        "POST",
        &format!("/channels/{text_id}/messages"),
        Some(&owner),
        Some(json!({ "clientId": Uuid::new_v4(), "content": "Tudo bem?" })),
    )
    .await
    .1;
    assert_eq!(
        mark(&text_id, &second["id"], &guest).await.0,
        StatusCode::OK
    );
    // An older device catching up never moves the marker back.
    let (_, kept) = mark(&text_id, &first["id"], &guest).await;
    assert_eq!(kept["lastReadId"], second["id"]);
    let reads = call(&app, "GET", "/reads", Some(&guest), None).await.1;
    assert_eq!(
        unread(&reads, &dm_id),
        (0, private["id"].as_str().unwrap().into())
    );
    assert_eq!(
        unread(&reads, &text_id),
        (0, second["id"].as_str().unwrap().into())
    );

    // Typing reaches whoever can see the channel.
    for ws in [&mut owner_ws, &mut guest_ws] {
        emit(ws, json!({ "type": "server.watch", "serverId": server_id })).await;
        event(ws, "server.snapshot").await;
    }
    emit(
        &mut guest_ws,
        json!({ "type": "typing.start", "channelId": text_id }),
    )
    .await;
    let typing = event(&mut owner_ws, "typing").await;
    assert_eq!(
        (&typing["channelId"], &typing["user"]["id"]),
        (&json!(text_id), &json!(guest_id))
    );
    emit(
        &mut owner_ws,
        json!({ "type": "typing.start", "channelId": dm_id }),
    )
    .await;
    let typing = event(&mut guest_laptop, "typing").await;
    assert_eq!(
        (&typing["channelId"], &typing["user"]["name"]),
        (&json!(dm_id), &json!("Elisa Prado"))
    );
    emit(
        &mut outsider_ws,
        json!({ "type": "typing.start", "channelId": dm_id }),
    )
    .await;
    assert_eq!(
        event(&mut outsider_ws, "error").await["operation"],
        "typing.start"
    );

    live.abort();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM channels WHERE id = $1",
        [Uuid::parse_str(&dm_id).unwrap().into()],
    ))
    .await
    .unwrap();
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

/// Waits for the next presence update about this user.
async fn presence_of(socket: &mut Socket, user: &str) -> Value {
    loop {
        let presence = event(socket, "presence.updated").await;
        if presence["userId"] == user {
            return presence["status"].clone();
        }
    }
}

#[tokio::test]
#[ignore = "Requires TEST_DATABASE_URL pointing to a PostgreSQL test database"]
async fn server_members_roles_and_presence() {
    let db = Database::connect(std::env::var("TEST_DATABASE_URL").expect("Set TEST_DATABASE_URL"))
        .await
        .unwrap();
    Migrator::up(&db, None).await.unwrap();
    let app = router(
        AppState::new(
            db.clone(),
            "https://discvoice.example".into(),
            fake_google().await,
        ),
        vec![],
    );
    let (ana, ana_id) = register(&app, "Ana").await;
    let (bia, bia_id) = register(&app, "Bia").await;
    let (caio, caio_id) = register(&app, "Caio").await;
    let (status, created) = call(
        &app,
        "POST",
        "/servers",
        Some(&ana),
        Some(json!({ "name": "Estúdio" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let server_id = created["server"]["id"].as_str().unwrap().to_owned();
    let code = created["code"].as_str().unwrap().to_owned();
    let members_path = format!("/servers/{server_id}/members");

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/api/realtime", listener.local_addr().unwrap());
    let live_app = app.clone();
    let live = tokio::spawn(async move {
        axum::serve(listener, live_app).await.unwrap();
    });
    let (mut ana_ws, _) = socket(&url, &ana).await;
    emit(
        &mut ana_ws,
        json!({ "type": "server.watch", "serverId": server_id }),
    )
    .await;
    event(&mut ana_ws, "server.snapshot").await;

    // Joining shows the newcomer to whoever has the server open.
    let joined = call(
        &app,
        "POST",
        &format!("/invites/{code}/join"),
        Some(&bia),
        None,
    )
    .await;
    assert_eq!(joined.0, StatusCode::OK);
    let newcomer = event(&mut ana_ws, "member.joined").await;
    assert_eq!(newcomer["serverId"], server_id);
    assert_eq!(newcomer["member"]["user"]["id"], bia_id);
    assert_eq!(newcomer["member"]["role"], "member");
    assert_eq!(newcomer["member"]["status"], "offline");

    // Members only; everyone with their role and presence, by name.
    assert_eq!(
        call(&app, "GET", &members_path, Some(&caio), None).await.0,
        StatusCode::FORBIDDEN
    );
    let (status, members) = call(&app, "GET", &members_path, Some(&bia), None).await;
    assert_eq!(status, StatusCode::OK, "{members}");
    let summary: Vec<_> = members
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["user"]["id"].clone(),
                m["role"].clone(),
                m["status"].clone(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            (json!(ana_id), json!("owner"), json!("online")),
            (json!(bia_id), json!("member"), json!("offline")),
        ]
    );
    assert!(members[0]["joinedAt"].is_string());

    // Server members see each other connect, change status and leave, live.
    let (mut bia_ws, _) = socket(&url, &bia).await;
    assert_eq!(presence_of(&mut ana_ws, &bia_id).await, "online");
    assert_eq!(presence_of(&mut bia_ws, &bia_id).await, "online");
    emit(
        &mut bia_ws,
        json!({ "type": "presence.set", "status": "dnd" }),
    )
    .await;
    assert_eq!(presence_of(&mut ana_ws, &bia_id).await, "dnd");
    // Their own other devices hear it too.
    assert_eq!(presence_of(&mut bia_ws, &bia_id).await, "dnd");
    let members = call(&app, "GET", &members_path, Some(&ana), None).await.1;
    assert_eq!(members[1]["status"], "dnd");
    emit(
        &mut bia_ws,
        json!({ "type": "presence.set", "status": "offline" }),
    )
    .await;
    assert_eq!(
        event(&mut bia_ws, "error").await["operation"],
        "presence.set"
    );
    // A shared server shows the presence on the profile, too.
    let profile = call(
        &app,
        "GET",
        &format!("/users/{bia_id}/profile"),
        Some(&ana),
        None,
    )
    .await
    .1;
    assert_eq!(profile["status"], "dnd");

    // Only the owner changes roles, and never their own.
    let role = |token: &str, user: &str, role: &str| {
        let (app, token, path) = (
            app.clone(),
            token.to_owned(),
            format!("{members_path}/{user}"),
        );
        let body = json!({ "role": role });
        async move { call(&app, "PATCH", &path, Some(&token), Some(body)).await }
    };
    assert_eq!(
        role(&bia, &bia_id, "moderator").await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        role(&ana, &ana_id, "member").await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        role(&ana, &bia_id, "owner").await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        role(&ana, &caio_id, "moderator").await.0,
        StatusCode::NOT_FOUND
    );
    let (status, promoted) = role(&ana, &bia_id, "moderator").await;
    assert_eq!(status, StatusCode::OK, "{promoted}");
    assert_eq!(promoted["role"], "moderator");
    assert_eq!(promoted["status"], "dnd");
    let updated = event(&mut ana_ws, "member.updated").await;
    assert_eq!(
        (&updated["member"]["user"]["id"], &updated["member"]["role"]),
        (&json!(bia_id), &json!("moderator"))
    );
    let members = call(&app, "GET", &members_path, Some(&ana), None).await.1;
    assert_eq!(members[1]["role"], "moderator");

    bia_ws.close(None).await.unwrap();
    assert_eq!(presence_of(&mut ana_ws, &bia_id).await, "offline");

    live.abort();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM servers WHERE id = $1",
        [Uuid::parse_str(&server_id).unwrap().into()],
    ))
    .await
    .unwrap();
    for id in [ana_id, bia_id, caio_id] {
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "DELETE FROM users WHERE id = $1",
            [Uuid::parse_str(&id).unwrap().into()],
        ))
        .await
        .unwrap();
    }
}

#[tokio::test]
#[ignore = "Requires TEST_DATABASE_URL pointing to a PostgreSQL test database"]
async fn friends_presence_and_profiles() {
    let db = Database::connect(std::env::var("TEST_DATABASE_URL").expect("Set TEST_DATABASE_URL"))
        .await
        .unwrap();
    Migrator::up(&db, None).await.unwrap();
    let app = router(
        AppState::new(
            db.clone(),
            "https://discvoice.example".into(),
            fake_google().await,
        ),
        vec![],
    );
    let (ana, ana_id) = register(&app, "Ana").await;
    let (bia, bia_id) = register(&app, "Bia").await;
    let (caio, caio_id) = register(&app, "Caio").await;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/api/realtime", listener.local_addr().unwrap());
    let live_app = app.clone();
    let live = tokio::spawn(async move {
        axum::serve(listener, live_app).await.unwrap();
    });
    let (mut ana_ws, _) = socket(&url, &ana).await;
    let (mut bia_ws, _) = socket(&url, &bia).await;

    // Without a shared server or a friendship, there is no conversation.
    let open_dm = call(
        &app,
        "POST",
        "/dms",
        Some(&ana),
        Some(json!({ "userId": bia_id })),
    )
    .await;
    assert_eq!(open_dm.0, StatusCode::FORBIDDEN);
    // Nor a profile to look at.
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/users/{bia_id}/profile"),
            Some(&ana),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    let ask = |token: &str, user: &str| {
        let (app, token, user) = (app.clone(), token.to_owned(), user.to_owned());
        async move {
            call(
                &app,
                "POST",
                "/friends/requests",
                Some(&token),
                Some(json!({ "userId": user })),
            )
            .await
        }
    };
    assert_eq!(ask(&ana, &ana_id).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(
        ask(&ana, &Uuid::new_v4().to_string()).await.0,
        StatusCode::NOT_FOUND
    );
    let (status, sent) = ask(&ana, &bia_id).await;
    assert_eq!(
        (status, &sent["status"]),
        (StatusCode::OK, &json!("outgoing"))
    );
    event(&mut bia_ws, "friends.changed").await;
    // Asking twice changes nothing.
    assert_eq!(ask(&ana, &bia_id).await.1["status"], "outgoing");
    let bias = call(&app, "GET", "/friends", Some(&bia), None).await.1;
    assert_eq!(bias["incoming"][0]["user"]["id"], ana_id);
    assert!(bias["friends"].as_array().unwrap().is_empty());
    let anas = call(&app, "GET", "/friends", Some(&ana), None).await.1;
    assert_eq!(anas["outgoing"][0]["user"]["id"], bia_id);
    // Requests can be seen by the person they were sent to, and only accepted by them.
    let profile = call(
        &app,
        "GET",
        &format!("/users/{ana_id}/profile"),
        Some(&bia),
        None,
    )
    .await
    .1;
    assert_eq!(profile["friendship"], "incoming");
    assert_eq!(profile["status"], Value::Null);
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/friends/requests/{bia_id}/accept"),
            Some(&ana),
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
            &format!("/friends/requests/{ana_id}/accept"),
            Some(&caio),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    let (status, accepted) = call(
        &app,
        "POST",
        &format!("/friends/requests/{ana_id}/accept"),
        Some(&bia),
        None,
    )
    .await;
    assert_eq!(
        (status, &accepted["status"]),
        (StatusCode::OK, &json!("friends"))
    );
    // New friends see each other's presence at once.
    loop {
        let presence = event(&mut ana_ws, "presence.updated").await;
        if presence["userId"] == bia_id {
            assert_eq!(presence["status"], "online");
            break;
        }
    }
    let anas = call(&app, "GET", "/friends", Some(&ana), None).await.1;
    assert_eq!(anas["friends"][0]["user"]["id"], bia_id);
    assert_eq!(anas["friends"][0]["status"], "online");
    assert!(anas["outgoing"].as_array().unwrap().is_empty());
    assert_eq!(ask(&ana, &bia_id).await.0, StatusCode::CONFLICT);

    // Closing the app tells friends; opening it again too.
    bia_ws.close(None).await.unwrap();
    let presence = event(&mut ana_ws, "presence.updated").await;
    assert_eq!(
        (&presence["userId"], &presence["status"]),
        (&json!(bia_id), &json!("offline"))
    );
    let (_bia_back, _) = socket(&url, &bia).await;
    let presence = event(&mut ana_ws, "presence.updated").await;
    assert_eq!(
        (&presence["userId"], &presence["status"]),
        (&json!(bia_id), &json!("online"))
    );

    // Friends can talk without sharing a server; the list previews the latest message.
    let (status, opened) = call(
        &app,
        "POST",
        "/dms",
        Some(&ana),
        Some(json!({ "userId": bia_id })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{opened}");
    let dm_id = opened["channel"]["id"].as_str().unwrap().to_owned();
    assert_eq!(opened["lastMessage"], Value::Null);
    for content in ["Oi!", "Tudo bem?"] {
        call(
            &app,
            "POST",
            &format!("/channels/{dm_id}/messages"),
            Some(&ana),
            Some(json!({ "clientId": Uuid::new_v4(), "content": content })),
        )
        .await;
    }
    let listed = call(&app, "GET", "/dms", Some(&bia), None).await.1;
    assert_eq!(listed[0]["lastMessage"]["content"], "Tudo bem?");
    assert_eq!(listed[0]["lastMessage"]["authorId"], ana_id);
    assert_eq!(listed[0]["lastMessageId"], listed[0]["lastMessage"]["id"]);

    let profile = call(
        &app,
        "GET",
        &format!("/users/{bia_id}/profile"),
        Some(&ana),
        None,
    )
    .await
    .1;
    assert_eq!(profile["user"]["name"], "Bia");
    assert_eq!(profile["friendship"], "friends");
    assert_eq!(profile["status"], "online");
    assert!(profile["memberSince"].is_string());
    assert!(profile["mutualServers"].as_array().unwrap().is_empty());
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/users/{ana_id}/profile"),
            Some(&caio),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    // Removing a friend: either side, once. The conversation stays readable.
    assert_eq!(
        call(
            &app,
            "DELETE",
            &format!("/friends/{ana_id}"),
            Some(&bia),
            None
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    event(&mut ana_ws, "friends.changed").await;
    assert_eq!(
        call(
            &app,
            "DELETE",
            &format!("/friends/{bia_id}"),
            Some(&ana),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let anas = call(&app, "GET", "/friends", Some(&ana), None).await.1;
    assert!(anas["friends"].as_array().unwrap().is_empty());
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/channels/{dm_id}/messages"),
            Some(&bia),
            None
        )
        .await
        .0,
        StatusCode::OK
    );

    // Two people asking each other become friends.
    assert_eq!(ask(&caio, &ana_id).await.1["status"], "outgoing");
    assert_eq!(ask(&ana, &caio_id).await.1["status"], "friends");
    // Declining is removing a pending request.
    assert_eq!(ask(&bia, &caio_id).await.1["status"], "outgoing");
    assert_eq!(
        call(
            &app,
            "DELETE",
            &format!("/friends/{bia_id}"),
            Some(&caio),
            None
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let caios = call(&app, "GET", "/friends", Some(&caio), None).await.1;
    assert_eq!(caios["friends"][0]["user"]["id"], ana_id);
    assert!(caios["incoming"].as_array().unwrap().is_empty());

    live.abort();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM channels WHERE id = $1",
        [Uuid::parse_str(&dm_id).unwrap().into()],
    ))
    .await
    .unwrap();
    for id in [ana_id, bia_id, caio_id] {
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "DELETE FROM users WHERE id = $1",
            [Uuid::parse_str(&id).unwrap().into()],
        ))
        .await
        .unwrap();
    }
}

/// A fake Cloudflare Realtime API that hands out one TURN credential.
async fn fake_cloudflare_turn() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let generate = post(|headers: axum::http::HeaderMap| async move {
        if headers["authorization"] != "Bearer cf-token" {
            return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "auth" })));
        }
        (
            StatusCode::CREATED,
            Json(json!({ "iceServers": [
                { "urls": ["stun:stun.cloudflare.com:3478"] },
                { "urls": [
                    "turn:turn.cloudflare.com:3478?transport=udp",
                    "turns:turn.cloudflare.com:443?transport=tcp"
                  ],
                  "username": "cf-user", "credential": "cf-credential" }
            ]})),
        )
    });
    tokio::spawn(async move {
        let app = Router::new().route(
            "/v1/turn/keys/cf-key/credentials/generate-ice-servers",
            generate,
        );
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{address}/v1")
}

#[tokio::test]
#[ignore = "Requires TEST_DATABASE_URL pointing to a PostgreSQL test database"]
async fn voice_config_uses_cloudflare_turn_and_falls_back() {
    let db = Database::connect(std::env::var("TEST_DATABASE_URL").expect("Set TEST_DATABASE_URL"))
        .await
        .unwrap();
    Migrator::up(&db, None).await.unwrap();
    let state = |api_url: String| {
        let db = db.clone();
        async move {
            AppState::new(db, "https://discvoice.example".into(), fake_google().await)
                .with_cloudflare_turn(CloudflareTurnConfig {
                    key_id: "cf-key".into(),
                    api_token: "cf-token".into(),
                    api_url,
                })
        }
    };
    let app = router(state(fake_cloudflare_turn().await).await, vec![]);
    let (token, user_id) = register(&app, "Turn").await;

    let (status, body) = call(&app, "GET", "/voice/config", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    let servers = body["iceServers"].as_array().unwrap();
    assert_eq!(servers.len(), 2);
    assert_eq!(servers[1]["username"], "cf-user");
    assert_eq!(servers[1]["credential"], "cf-credential");
    assert_eq!(
        servers[1]["urls"][1],
        "turns:turn.cloudflare.com:443?transport=tcp"
    );
    assert!(!body.to_string().contains("cf-token"));

    // Cloudflare unreachable: joining a call still works with the own STUN.
    let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead_url = format!("http://{}/v1", closed.local_addr().unwrap());
    drop(closed);
    let broken = router(state(dead_url).await, vec![]);
    let (status, body) = call(&broken, "GET", "/voice/config", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["iceServers"][0]["urls"]
        .as_str()
        .unwrap()
        .starts_with("stun:"));
    assert!(!body.to_string().contains("cloudflare"));

    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM users WHERE id = $1",
        [Uuid::parse_str(&user_id).unwrap().into()],
    ))
    .await
    .unwrap();
}

/// A fake Klipy API with one GIF, checking the key in the path.
async fn fake_klipy() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let rendition = |name: &str| json!({ "url": format!("https://static.klipy.com/ii/abc/{name}"), "width": 320, "height": 240, "size": 1 });
    let body = json!({ "result": true, "data": {
        "data": [{ "id": 7, "slug": "oi-7", "title": "Oi", "type": "gif", "file": {
            "md": { "gif": rendition("md.gif"), "webp": rendition("md.webp"), "jpg": rendition("md.jpg") },
            "sm": { "webp": rendition("sm.webp") }
        } }],
        "current_page": 1, "per_page": 24, "has_next": false
    }});
    let page = axum::routing::get(move || {
        let body = body.clone();
        async move { Json(body) }
    });
    tokio::spawn(async move {
        let app = Router::new()
            .route("/api/v1/klipy-key/gifs/trending", page.clone())
            .route("/api/v1/klipy-key/gifs/search", page)
            .route(
                "/api/v1/limited/gifs/trending",
                axum::routing::get(|| async { StatusCode::TOO_MANY_REQUESTS }),
            );
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{address}")
}

#[tokio::test]
#[ignore = "Requires TEST_DATABASE_URL pointing to a PostgreSQL test database"]
async fn gifs_from_klipy_in_messages_and_profiles() {
    let db = Database::connect(std::env::var("TEST_DATABASE_URL").expect("Set TEST_DATABASE_URL"))
        .await
        .unwrap();
    Migrator::up(&db, None).await.unwrap();
    let klipy = fake_klipy().await;
    let state = |api_key: &str| {
        let (db, api_key, api_url) = (db.clone(), api_key.to_owned(), klipy.clone());
        async move {
            AppState::new(db, "https://discvoice.example".into(), fake_google().await)
                .with_klipy(KlipyConfig { api_key, api_url })
        }
    };
    let app = router(state("klipy-key").await, vec![]);
    let (token, user_id) = register(&app, "Gif").await;

    // Without the key configured, the picker says so.
    let plain = router(
        AppState::new(
            db.clone(),
            "https://discvoice.example".into(),
            fake_google().await,
        ),
        vec![],
    );
    assert_eq!(
        call(&plain, "GET", "/gifs", Some(&token), None).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        call(&app, "GET", "/gifs", None, None).await.0,
        StatusCode::UNAUTHORIZED
    );

    let (status, page) = call(&app, "GET", "/gifs?q=oi", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let gif = &page["results"][0];
    assert_eq!(gif["url"], "https://static.klipy.com/ii/abc/md.webp");
    assert_eq!(gif["still"], "https://static.klipy.com/ii/abc/md.jpg");
    assert_eq!(page["hasNext"], false);
    assert!(!page.to_string().contains("klipy-key"));

    let limited = router(state("limited").await, vec![]);
    let (status, body) = call(&limited, "GET", "/gifs", Some(&token), None).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(body["error"].as_str().unwrap().contains("GIF"));

    // A GIF message, with no text.
    let server = call(
        &app,
        "POST",
        "/servers",
        Some(&token),
        Some(json!({ "name": "Gifs" })),
    )
    .await
    .1;
    let server_id = server["server"]["id"].as_str().unwrap().to_owned();
    let channel = call(
        &app,
        "POST",
        &format!("/servers/{server_id}/channels"),
        Some(&token),
        Some(json!({ "name": "geral" })),
    )
    .await
    .1;
    let path = format!("/channels/{}/messages", channel["id"].as_str().unwrap());
    let choice = json!({ "slug": "oi-7", "title": "Oi", "url": gif["url"], "still": gif["still"], "width": 320, "height": 240 });
    let client_id = Uuid::new_v4();
    let (status, sent) = call(
        &app,
        "POST",
        &path,
        Some(&token),
        Some(json!({ "clientId": client_id, "content": "", "gif": choice })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    let attachment = &sent["attachments"][0];
    assert_eq!(attachment["provider"], "klipy");
    assert_eq!(attachment["url"], "https://static.klipy.com/ii/abc/md.webp");
    assert_eq!(attachment["contentType"], "image/webp");
    assert_eq!(
        attachment["still"],
        "https://static.klipy.com/ii/abc/md.jpg"
    );
    let history = call(&app, "GET", &path, Some(&token), None).await.1;
    assert_eq!(history["messages"][0]["attachments"][0]["id"], "klipy:oi-7");
    // Retrying the same send is idempotent; a different GIF under the same id is not.
    assert_eq!(
        call(
            &app,
            "POST",
            &path,
            Some(&token),
            Some(json!({ "clientId": client_id, "gif": choice }))
        )
        .await
        .0,
        StatusCode::OK
    );
    let other = json!({ "url": "https://static.klipy.com/ii/abc/other.gif" });
    assert_eq!(
        call(
            &app,
            "POST",
            &path,
            Some(&token),
            Some(json!({ "clientId": client_id, "gif": other }))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    // Only Klipy's CDN, and something must be sent.
    for invalid in [
        json!({ "clientId": Uuid::new_v4(), "gif": { "url": "https://evil.example/x.gif" } }),
        json!({ "clientId": Uuid::new_v4(), "gif": { "url": "http://static.klipy.com/x.gif" } }),
        json!({ "clientId": Uuid::new_v4(), "content": "  " }),
    ] {
        assert_eq!(
            call(&app, "POST", &path, Some(&token), Some(invalid))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }

    // GIF avatar and banner, then removed.
    let (status, me) = call(
        &app,
        "PATCH",
        "/me",
        Some(&token),
        Some(json!({ "avatarGif": choice, "bannerGif": choice })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{me}");
    assert_eq!(me["avatar"], "https://static.klipy.com/ii/abc/md.webp");
    assert_eq!(me["avatarSource"], "gif");
    assert_eq!(me["avatarStill"], "https://static.klipy.com/ii/abc/md.jpg");
    assert_eq!(me["bannerGif"], "https://static.klipy.com/ii/abc/md.webp");
    assert_eq!(me["banner"], "brand");
    assert_eq!(
        call(
            &app,
            "PATCH",
            "/me",
            Some(&token),
            Some(json!({ "bannerGif": { "url": "https://evil.example/b.gif" } }))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    // Another field alone leaves the GIFs as they are.
    let me = call(
        &app,
        "PATCH",
        "/me",
        Some(&token),
        Some(json!({ "bio": "gifs!" })),
    )
    .await
    .1;
    assert_eq!(me["avatarSource"], "gif");
    let me = call(
        &app,
        "PATCH",
        "/me",
        Some(&token),
        Some(json!({ "avatarGif": null, "bannerGif": null })),
    )
    .await
    .1;
    assert_eq!(me["avatar"], Value::Null);
    assert_eq!(me["avatarSource"], Value::Null);
    assert!(me.get("avatarStill").is_none() && me.get("bannerGif").is_none());

    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM servers WHERE id = $1",
        [Uuid::parse_str(&server_id).unwrap().into()],
    ))
    .await
    .unwrap();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM users WHERE id = $1",
        [Uuid::parse_str(&user_id).unwrap().into()],
    ))
    .await
    .unwrap();
}
