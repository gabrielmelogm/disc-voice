use super::*;
use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    http::HeaderMap,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex, time::Instant};
use tokio::{
    sync::broadcast,
    time::{interval, timeout, Duration as Timeout},
};

#[derive(Clone)]
struct Event {
    recipients: Vec<Uuid>,
    payload: Value,
    close: bool,
}

struct Client {
    user: UserView,
    session: String,
    watching: Option<Uuid>,
    voice: Option<Voice>,
}

#[derive(Clone)]
struct Voice {
    channel: Uuid,
    server: Uuid,
    muted: bool,
    deafened: bool,
    /// Sharing the screen: the video arrives over the peer connections.
    screen: bool,
}

pub(crate) struct Hub {
    clients: Mutex<HashMap<Uuid, Client>>,
    events: broadcast::Sender<Event>,
    capacity: usize,
}

impl Hub {
    pub(crate) fn new() -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
            events: broadcast::channel(512).0,
            capacity: std::env::var("VOICE_CHANNEL_CAPACITY")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(8)
                .clamp(2, 32),
        }
    }

    fn emit(&self, recipients: Vec<Uuid>, payload: Value, close: bool) {
        let _ = self.events.send(Event {
            recipients,
            payload,
            close,
        });
    }

    fn direct(&self, id: Uuid, payload: Value) {
        self.emit(vec![id], payload, false);
    }

    fn audience(clients: &HashMap<Uuid, Client>, server: Uuid) -> Vec<Uuid> {
        clients
            .iter()
            .filter(|(_, c)| {
                c.watching == Some(server) || c.voice.as_ref().is_some_and(|v| v.server == server)
            })
            .map(|(id, _)| *id)
            .collect()
    }

    fn participants(clients: &HashMap<Uuid, Client>, channel: Uuid) -> Vec<Value> {
        let mut members: Vec<_> = clients.iter().filter_map(|(id, c)| {
            let voice = c.voice.as_ref().filter(|v| v.channel == channel)?;
            Some(json!({ "peerId": id, "user": c.user, "muted": voice.muted, "deafened": voice.deafened, "screen": voice.screen }))
        }).collect();
        members.sort_by_key(|m| m["peerId"].as_str().unwrap_or_default().to_owned());
        members
    }

    fn changed(&self, clients: &HashMap<Uuid, Client>, voice: &Voice) {
        self.emit(
            Self::audience(clients, voice.server),
            json!({
                "type": "voice.participants", "serverId": voice.server, "channelId": voice.channel,
                "participants": Self::participants(clients, voice.channel)
            }),
            false,
        );
    }

    pub(crate) fn publish_server(&self, server: Uuid, payload: Value) {
        let clients = self.clients.lock().unwrap();
        self.emit(Self::audience(&clients, server), payload, false);
    }

    pub(crate) fn revoke(&self, hash: &str) {
        let mut clients = self.clients.lock().unwrap();
        let ids: Vec<_> = clients
            .iter()
            .filter(|(_, c)| c.session == hash)
            .map(|(id, _)| *id)
            .collect();
        for id in &ids {
            if let Some(client) = clients.remove(id) {
                if let Some(voice) = client.voice {
                    self.changed(&clients, &voice);
                }
            }
        }
        self.emit(ids, json!({ "type": "session.expired" }), true);
    }

    fn disconnect(&self, id: Uuid) {
        let mut clients = self.clients.lock().unwrap();
        if let Some(client) = clients.remove(&id) {
            if let Some(voice) = client.voice {
                self.changed(&clients, &voice);
            }
        }
    }

    fn watch(&self, id: Uuid, server: Option<Uuid>) {
        let mut clients = self.clients.lock().unwrap();
        let Some(client) = clients.get_mut(&id) else {
            return;
        };
        client.watching = server;
        let mut channels = HashMap::new();
        for client in clients.values() {
            if let Some(voice) = &client.voice {
                if Some(voice.server) == server {
                    channels
                        .entry(voice.channel)
                        .or_insert_with(|| Self::participants(&clients, voice.channel));
                }
            }
        }
        self.direct(
            id,
            json!({ "type": "server.snapshot", "serverId": server, "channels": channels }),
        );
    }

    fn join(
        &self,
        id: Uuid,
        channel: channel::Model,
        muted: bool,
        deafened: bool,
    ) -> ApiResult<()> {
        let mut clients = self.clients.lock().unwrap();
        let user = clients.get(&id).ok_or_else(ApiError::unauthorized)?.user.id;
        let others = clients
            .values()
            .filter(|c| {
                c.user.id != user && c.voice.as_ref().is_some_and(|v| v.channel == channel.id)
            })
            .count();
        if others >= self.capacity {
            return Err(ApiError::bad("Este canal de voz está cheio."));
        }
        // One active voice membership per account, including other tabs/devices.
        let old: Vec<_> = clients
            .iter_mut()
            .filter(|(_, c)| c.user.id == user)
            .filter_map(|(peer, c)| c.voice.take().map(|voice| (*peer, voice)))
            .collect();
        for (peer, voice) in old {
            self.direct(
                peer,
                json!({ "type": "voice.left", "channelId": voice.channel, "reason": "replaced" }),
            );
            self.changed(&clients, &voice);
        }
        let voice = Voice {
            channel: channel.id,
            server: channel.server_id,
            muted,
            deafened,
            screen: false,
        };
        clients.get_mut(&id).unwrap().voice = Some(voice.clone());
        self.direct(
            id,
            json!({
                "type": "voice.joined", "channelId": channel.id, "peerId": id,
                "participants": Self::participants(&clients, channel.id)
            }),
        );
        self.changed(&clients, &voice);
        Ok(())
    }

    fn leave(&self, id: Uuid) {
        let mut clients = self.clients.lock().unwrap();
        if let Some(voice) = clients.get_mut(&id).and_then(|c| c.voice.take()) {
            self.direct(
                id,
                json!({ "type": "voice.left", "channelId": voice.channel, "reason": "left" }),
            );
            self.changed(&clients, &voice);
        }
    }

    fn update(&self, id: Uuid, muted: bool, deafened: bool, screen: bool) {
        let mut clients = self.clients.lock().unwrap();
        if let Some(voice) = clients.get_mut(&id).and_then(|c| c.voice.as_mut()) {
            voice.muted = muted;
            voice.deafened = deafened;
            voice.screen = screen;
            let voice = voice.clone();
            self.changed(&clients, &voice);
        }
    }

    fn signal(&self, id: Uuid, target: Uuid, data: Value) -> ApiResult<()> {
        let clients = self.clients.lock().unwrap();
        let source = clients.get(&id).and_then(|c| c.voice.as_ref());
        let destination = clients.get(&target).and_then(|c| c.voice.as_ref());
        match (source, destination) {
            (Some(a), Some(b)) if id != target && a.channel == b.channel => {
                self.direct(target, json!({ "type": "voice.signal", "peerId": id, "channelId": a.channel, "data": data }));
                Ok(())
            }
            _ => Err(ApiError::bad("Participante indisponível neste canal.")),
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Command {
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "server.watch", rename_all = "camelCase")]
    Watch { server_id: Option<Uuid> },
    #[serde(rename = "voice.join", rename_all = "camelCase")]
    Join {
        channel_id: Uuid,
        muted: bool,
        deafened: bool,
    },
    #[serde(rename = "voice.leave")]
    Leave,
    #[serde(rename = "voice.state")]
    VoiceState {
        muted: bool,
        deafened: bool,
        /// Absent in clients without screen sharing.
        #[serde(default)]
        screen: bool,
    },
    #[serde(rename = "voice.signal", rename_all = "camelCase")]
    Signal { peer_id: Uuid, data: Value },
}

async fn command(state: &AppState, id: Uuid, user: &UserView, command: Command) -> ApiResult<()> {
    match command {
        Command::Ping => state.realtime.direct(id, json!({ "type": "pong" })),
        Command::Watch { server_id } => {
            if let Some(server) = server_id {
                require_member(&state.db, server, user.id).await?;
            }
            state.realtime.watch(id, server_id);
        }
        Command::Join {
            channel_id,
            muted,
            deafened,
        } => {
            let channel = require_channel(&state.db, channel_id, user.id, "voice").await?;
            state.realtime.join(id, channel, muted, deafened)?;
        }
        Command::Leave => state.realtime.leave(id),
        Command::VoiceState {
            muted,
            deafened,
            screen,
        } => state.realtime.update(id, muted, deafened, screen),
        Command::Signal { peer_id, data } => state.realtime.signal(id, peer_id, data)?,
    }
    Ok(())
}

pub(crate) async fn upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
    origins: Arc<Vec<HeaderValue>>,
) -> ApiResult<Response> {
    if let Some(origin) = headers.get(header::ORIGIN) {
        if !origins.contains(origin) {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "Origem não permitida.".into(),
            ));
        }
    }
    Ok(ws
        .max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .on_upgrade(move |socket| connected(state, socket))
        .into_response())
}

async fn session_user(state: &AppState, hash: &str) -> ApiResult<UserView> {
    let session = session::Entity::find_by_id(hash)
        .filter(session::Column::ExpiresAt.gt(Utc::now()))
        .one(&state.db)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    let user = user::Entity::find_by_id(session.user_id)
        .one(&state.db)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    Ok(user.into())
}

async fn connected(state: AppState, mut socket: WebSocket) {
    // Browser WebSockets cannot attach an Authorization header. Authenticate in
    // the first frame, never putting the session token in URLs or access logs.
    let hash = match timeout(Timeout::from_secs(5), socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => {
            let input = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
            match (input["type"].as_str(), input["token"].as_str()) {
                (Some("authenticate"), Some(token)) if token.len() == 64 => token_hash(token),
                _ => return,
            }
        }
        _ => return,
    };
    let user = match session_user(&state, &hash).await {
        Ok(user) => user,
        Err(_) => {
            let _ = socket
                .send(Message::Text(
                    json!({ "type": "session.expired" }).to_string().into(),
                ))
                .await;
            return;
        }
    };
    let id = Uuid::new_v4();
    let mut events = state.realtime.events.subscribe();
    state.realtime.clients.lock().unwrap().insert(
        id,
        Client {
            user: user.clone(),
            session: hash.clone(),
            watching: None,
            voice: None,
        },
    );
    let (mut sender, mut receiver) = socket.split();
    let ready = Message::Text(json!({ "type": "ready", "peerId": id }).to_string().into());
    if sender.send(ready).await.is_err() {
        state.realtime.disconnect(id);
        return;
    }
    let mut heartbeat = interval(Timeout::from_secs(15));
    let mut last_seen = Instant::now();
    let mut window = Instant::now();
    let mut count = 0;
    loop {
        tokio::select! {
            incoming = receiver.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        last_seen = Instant::now();
                        if window.elapsed().as_secs() >= 10 { window = Instant::now(); count = 0; }
                        count += 1;
                        if count > 300 { break; }
                        let value = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
                        let operation = value["type"].as_str().unwrap_or("unknown").to_owned();
                        let result = match serde_json::from_value::<Command>(value) {
                            Ok(input) => command(&state, id, &user, input).await,
                            Err(_) => Err(ApiError::bad("Evento inválido.")),
                        };
                        if let Err(error) = result {
                            state.realtime.direct(id, json!({
                                "type": "error", "operation": operation, "message": error.1
                            }));
                        }
                    }
                    Some(Ok(Message::Pong(_))) => last_seen = Instant::now(),
                    Some(Ok(Message::Ping(data))) => {
                        if sender.send(Message::Pong(data)).await.is_err() { break; }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
            event = events.recv() => {
                let Ok(event) = event else { break };
                if event.recipients.contains(&id) {
                    let result = timeout(Timeout::from_secs(5), sender.send(Message::Text(event.payload.to_string().into()))).await;
                    if !matches!(result, Ok(Ok(()))) || event.close { break; }
                }
            }
            _ = heartbeat.tick() => {
                if last_seen.elapsed().as_secs() > 45 { break; }
                if session_user(&state, &hash).await.is_err() {
                    let _ = sender.send(Message::Text(json!({ "type": "session.expired" }).to_string().into())).await;
                    break;
                }
                if sender.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
            }
        }
    }
    state.realtime.disconnect(id);
    let _ = timeout(Timeout::from_secs(1), sender.close()).await;
}

pub(crate) async fn ice_config(Extension(user): Extension<UserView>) -> ApiResult<Json<Value>> {
    let mut servers = vec![json!({
        "urls": std::env::var("STUN_URL").unwrap_or_else(|_| "stun:stun.l.google.com:19302".into())
    })];
    if let Ok(urls) = std::env::var("TURN_URLS") {
        if !urls.trim().is_empty() {
            let secret = std::env::var("TURN_SECRET").map_err(ApiError::internal)?;
            if secret.is_empty() {
                return Err(ApiError::internal("TURN_SECRET está vazio"));
            }
            let username = format!(
                "{}:{}",
                (Utc::now() + Duration::hours(24)).timestamp(),
                user.id
            );
            let mut mac = Hmac::<sha1::Sha1>::new_from_slice(secret.as_bytes())
                .map_err(ApiError::internal)?;
            mac.update(username.as_bytes());
            servers.push(json!({
                "urls": urls.split(',').map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>(),
                "username": username, "credential": STANDARD.encode(mac.finalize().into_bytes())
            }));
        }
    }
    Ok(Json(json!({ "iceServers": servers })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(hub: &Hub, user: Uuid) -> Uuid {
        let id = Uuid::new_v4();
        hub.clients.lock().unwrap().insert(
            id,
            Client {
                user: UserView {
                    id: user,
                    email: "voice@example.com".into(),
                    name: "Voz".into(),
                },
                session: id.to_string(),
                watching: None,
                voice: None,
            },
        );
        id
    }

    fn room(server: Uuid) -> channel::Model {
        channel::Model {
            id: Uuid::new_v4(),
            server_id: server,
            name: "voz".into(),
            kind: "voice".into(),
            created_by: Uuid::new_v4(),
            created_at: Utc::now(),
        }
    }

    #[test]
    fn full_room_preserves_previous_membership_and_replacement_is_atomic() {
        let hub = Hub {
            capacity: 2,
            ..Hub::new()
        };
        let server = Uuid::new_v4();
        let target = room(server);
        let previous = room(server);
        let user = Uuid::new_v4();
        let first = client(&hub, user);
        let second = client(&hub, Uuid::new_v4());
        let third = client(&hub, Uuid::new_v4());
        assert!(hub.join(first, target.clone(), false, false).is_ok());
        assert!(hub.join(second, target.clone(), false, false).is_ok());
        assert!(hub.join(third, previous.clone(), false, false).is_ok());
        assert!(hub.join(third, target.clone(), false, false).is_err());
        assert_eq!(
            hub.clients.lock().unwrap()[&third]
                .voice
                .as_ref()
                .unwrap()
                .channel,
            previous.id
        );
        let replacement = client(&hub, user);
        assert!(hub.join(replacement, target.clone(), true, false).is_ok());
        {
            let clients = hub.clients.lock().unwrap();
            assert!(clients[&first].voice.is_none());
            assert_eq!(Hub::participants(&clients, target.id).len(), 2);
        }
        hub.disconnect(replacement);
        assert_eq!(
            Hub::participants(&hub.clients.lock().unwrap(), target.id).len(),
            1
        );
    }

    #[test]
    fn signals_cannot_cross_rooms_and_revocation_removes_presence() {
        let hub = Hub::new();
        let a = client(&hub, Uuid::new_v4());
        let b = client(&hub, Uuid::new_v4());
        let room_a = room(Uuid::new_v4());
        let room_b = room(Uuid::new_v4());
        assert!(hub.join(a, room_a.clone(), false, false).is_ok());
        assert!(hub.join(b, room_b, false, false).is_ok());
        assert!(hub.signal(a, b, json!({})).is_err());
        assert!(hub.join(b, room_a.clone(), false, false).is_ok());
        assert!(hub.signal(a, b, json!({})).is_ok());
        hub.revoke(&b.to_string());
        assert!(hub.signal(a, b, json!({})).is_err());
        assert_eq!(
            Hub::participants(&hub.clients.lock().unwrap(), room_a.id).len(),
            1
        );
    }
}
