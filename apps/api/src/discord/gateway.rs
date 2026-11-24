//! Discord gateway connection of the bot. It brings:
//! - PRESENCE_UPDATE (privileged GUILD_PRESENCES intent): activities of the
//!   members of servers the bot is in, published for linked accounts;
//! - GUILD_DELETE: the bot was removed, so unfinished imports stop.
//!
//! Imports read history over REST once, so the gateway never subscribes to
//! messages (no GUILD_MESSAGES or MESSAGE_CONTENT intent).
use super::{forget_presences, presence, short_text, snowflake, Discord, CDN_URL};
use crate::{activity::Activity, entities::discord_import, AppState};
use futures_util::{SinkExt, StreamExt};
use sea_orm::{sea_query::Expr, ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::time::{interval_at, sleep, timeout, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;

const GUILDS: u64 = 1 << 0;
const GUILD_PRESENCES: u64 = 1 << 8;

enum End {
    /// Reconnect with a new session.
    Retry(String),
    /// The privileged presence intent is not enabled for the app.
    DisallowedIntents,
    /// Configuration problem; reconnecting would not help.
    Fatal(String),
}

pub(super) async fn run(state: AppState) {
    let Some(discord) = state.discord.clone() else {
        return;
    };
    // reqwest and the gateway socket share the aws-lc-rs provider.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    if let Err(error) = discord.refresh_links(&state.db).await {
        tracing::warn!(
            ?error,
            "Não foi possível carregar as contas Discord vinculadas"
        );
    }
    let presence_allowed = discord.intents().await.is_none_or(|i| i.presence);
    if !presence_allowed {
        tracing::warn!(
            "Atividades do Discord desativadas: habilite o Presence Intent no Developer Portal."
        );
    }
    let mut intents = GUILDS | if presence_allowed { GUILD_PRESENCES } else { 0 };
    let mut delay = Duration::from_secs(1);
    loop {
        let started = Instant::now();
        let end = session(&state, &discord, intents).await;
        *discord.live_presence.lock().unwrap() = false;
        forget_presences(&state, &discord).await;
        match end {
            End::Retry(reason) => {
                tracing::warn!(%reason, "Gateway do Discord desconectado; reconectando")
            }
            End::DisallowedIntents => {
                tracing::warn!("O Discord recusou o Presence Intent; conectando sem atividades.");
                intents &= !GUILD_PRESENCES;
            }
            End::Fatal(reason) => {
                tracing::error!(%reason, "Gateway do Discord desativado");
                return;
            }
        }
        if started.elapsed() > Duration::from_secs(60) {
            delay = Duration::from_secs(1);
        }
        sleep(delay + jitter(Duration::from_secs(1))).await;
        delay = (delay * 2).min(Duration::from_secs(300));
    }
}

fn jitter(max: Duration) -> Duration {
    max.mul_f64((Uuid::new_v4().as_u128() % 1000) as f64 / 1000.0)
}

async fn session(state: &AppState, discord: &Arc<Discord>, intents: u64) -> End {
    let gateway: Value = match discord.bot_get("/gateway/bot").await {
        Ok(gateway) => gateway,
        Err(error @ super::DiscordError::Api { status: 401, .. }) => {
            return End::Fatal(error.describe())
        }
        Err(error) => return End::Retry(error.describe()),
    };
    let Some(url) = gateway["url"].as_str() else {
        return End::Retry("resposta sem URL do gateway".into());
    };
    let socket = match timeout(
        Duration::from_secs(15),
        connect_async(format!("{url}/?v=10&encoding=json")),
    )
    .await
    {
        Ok(Ok((socket, _))) => socket,
        Ok(Err(error)) => return End::Retry(error.to_string()),
        Err(_) => return End::Retry("tempo esgotado ao conectar".into()),
    };
    let (mut sink, mut stream) = socket.split();

    let hello = match timeout(Duration::from_secs(15), stream.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => {
            serde_json::from_str::<Value>(&text).unwrap_or(Value::Null)
        }
        _ => return End::Retry("sem HELLO".into()),
    };
    let Some(every) = hello["d"]["heartbeat_interval"]
        .as_u64()
        .filter(|_| hello["op"] == 10)
    else {
        return End::Retry("HELLO inválido".into());
    };
    let every = Duration::from_millis(every.max(1_000));
    let identify = json!({
        "op": 2,
        "d": {
            "token": discord.config.bot_token,
            "intents": intents,
            "properties": { "os": std::env::consts::OS, "browser": "disc-voice", "device": "disc-voice" },
        }
    });
    if sink
        .send(Message::Text(identify.to_string().into()))
        .await
        .is_err()
    {
        return End::Retry("falha ao identificar".into());
    }

    let mut sequence: Option<u64> = None;
    let mut acknowledged = true;
    let mut heartbeat = interval_at(Instant::now() + jitter(every), every);
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if !acknowledged {
                    return End::Retry("heartbeat sem resposta".into());
                }
                acknowledged = false;
                let beat = json!({ "op": 1, "d": sequence });
                if sink.send(Message::Text(beat.to_string().into())).await.is_err() {
                    return End::Retry("falha no heartbeat".into());
                }
            }
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let Ok(payload) = serde_json::from_str::<Value>(&text) else { continue };
                    if let Some(s) = payload["s"].as_u64() {
                        sequence = Some(s);
                    }
                    match payload["op"].as_u64() {
                        Some(0) => {
                            let event = payload["t"].as_str().unwrap_or_default();
                            if event == "READY" {
                                *discord.live_presence.lock().unwrap() = intents & GUILD_PRESENCES != 0;
                                tracing::info!("Gateway do Discord conectado");
                            }
                            dispatch(state, event, &payload["d"]).await;
                        }
                        Some(1) => {
                            let beat = json!({ "op": 1, "d": sequence });
                            if sink.send(Message::Text(beat.to_string().into())).await.is_err() {
                                return End::Retry("falha no heartbeat".into());
                            }
                        }
                        Some(7) => return End::Retry("o Discord pediu reconexão".into()),
                        Some(9) => return End::Retry("sessão inválida".into()),
                        Some(11) => acknowledged = true,
                        _ => {}
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = frame
                        .map(|f| (u16::from(f.code), f.reason.to_string()))
                        .unwrap_or((0, String::new()));
                    return match code {
                        4014 => End::DisallowedIntents,
                        4004 => End::Fatal("token do bot recusado (4004)".into()),
                        4010..=4013 => End::Fatal(format!("configuração recusada ({code}: {reason})")),
                        _ => End::Retry(format!("fechado ({code}: {reason})")),
                    };
                }
                Some(Ok(_)) => {}
                Some(Err(error)) => return End::Retry(error.to_string()),
                None => return End::Retry("conexão encerrada".into()),
            }
        }
    }
}

/// Handles one gateway event. Public so tests can feed events directly.
pub async fn dispatch(state: &AppState, event: &str, data: &Value) {
    let Some(discord) = state.discord.clone() else {
        return;
    };
    match event {
        "READY" => {
            if let Some(id) = data["user"]["id"].as_str() {
                *discord.bot_id.lock().unwrap() = Some(id.to_owned());
            }
        }
        "GUILD_CREATE" => {
            for item in data["presences"].as_array().into_iter().flatten() {
                if let Some(id) = item["user"]["id"].as_str() {
                    let activity = resolve(&discord, id, item).await;
                    presence(state, &discord, id, activity).await;
                }
            }
        }
        "PRESENCE_UPDATE" => {
            if let Some(id) = data["user"]["id"].as_str() {
                let activity = resolve(&discord, id, data).await;
                presence(state, &discord, id, activity).await;
            }
        }
        // The bot left or was removed (not a temporary outage).
        "GUILD_DELETE" if data["unavailable"] != true => {
            let Some(guild) = data["id"].as_str() else {
                return;
            };
            let result = discord_import::Entity::update_many()
                .col_expr(discord_import::Column::Status, Expr::value("error"))
                .col_expr(
                    discord_import::Column::Error,
                    Expr::value("O bot foi removido deste servidor do Discord antes de terminar. Instale-o de novo para continuar, ou conclua com o que já foi importado."),
                )
                .col_expr(discord_import::Column::RetryAt, Expr::value(Option::<chrono::DateTime<chrono::Utc>>::None))
                .filter(discord_import::Column::GuildId.eq(guild))
                // Finished imports no longer depend on Discord.
                .filter(discord_import::Column::Phase.eq("history"))
                .exec_with_returning(&state.db)
                .await;
            match result {
                Ok(rows) => rows
                    .into_iter()
                    .for_each(|row| super::sync::publish(state, &row)),
                Err(error) => tracing::warn!(
                    ?error,
                    "Não foi possível marcar as importações do servidor removido"
                ),
            }
        }
        _ => {}
    }
}

/// The activity of a presence, with the app icon as the thumbnail when the
/// activity has no image of its own (e.g. a game Discord detected). Icons are
/// only looked up for linked accounts, whose activity is published.
async fn resolve(discord: &Discord, discord_id: &str, presence: &Value) -> Option<Activity> {
    let (item, mut activity) = chosen(presence, &discord.config.client_id)?;
    if activity.image.is_none() && discord.is_linked(discord_id) {
        if let Some(app) = item["application_id"].as_str().and_then(snowflake) {
            activity.image = discord.app_icon(app).await;
        }
    }
    Some(activity)
}

/// The activity shown for a Discord presence: the first game, stream, music
/// or show, ignoring custom statuses and Disc Voice's own Rich Presence
/// (`own_app`). Offline users have none.
#[cfg(test)]
pub(super) fn activity(presence: &Value, own_app: &str) -> Option<Activity> {
    chosen(presence, own_app).map(|(_, activity)| activity)
}

fn chosen<'a>(presence: &'a Value, own_app: &str) -> Option<(&'a Value, Activity)> {
    if matches!(presence["status"].as_str(), Some("offline" | "invisible")) {
        return None;
    }
    presence["activities"].as_array()?.iter().find_map(|item| {
        let kind = match item["type"].as_u64()? {
            0 => "playing",
            1 => "streaming",
            2 => "listening",
            3 => "watching",
            5 => "competing",
            _ => return None,
        };
        let app = item["application_id"].as_str().and_then(snowflake);
        if app.is_some_and(|app| app == own_app) {
            return None;
        }
        let assets = &item["assets"];
        let (image, image_text) = [("large_image", "large_text"), ("small_image", "small_text")]
            .into_iter()
            .find_map(|(image, text)| {
                let url = asset_url(app, assets[image].as_str()?)?;
                Some((Some(url), short_text(&assets[text], 128)))
            })
            .unwrap_or_default();
        Some((
            item,
            Activity {
                kind,
                name: short_text(&item["name"], 128)?,
                details: short_text(&item["details"], 128),
                state: short_text(&item["state"], 128),
                started_at: item["timestamps"]["start"]
                    .as_i64()
                    .and_then(chrono::DateTime::from_timestamp_millis),
                image,
                image_text,
                source: "discord",
            },
        ))
    })
}

/// URL of an activity asset, following Discord's image key formats.
/// Unknown or unsafe keys have none.
fn asset_url(app: Option<&str>, key: &str) -> Option<String> {
    let safe = |value: &str, extra: &[char]| {
        !value.is_empty()
            && value.len() <= 512
            && !value.contains("..")
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c) || extra.contains(&c))
    };
    if let Some(path) = key.strip_prefix("mp:") {
        return safe(path, &['/', '%', '=', '&', '~', '+'])
            .then(|| format!("https://media.discordapp.net/{path}"));
    }
    if let Some((provider, id)) = key.split_once(':') {
        if !safe(id, &[]) {
            return None;
        }
        return match provider {
            "spotify" => Some(format!("https://i.scdn.co/image/{id}")),
            "youtube" => Some(format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg")),
            "twitch" => Some(format!(
                "https://static-cdn.jtvnw.net/previews-ttv/live_user_{}-320x180.jpg",
                id.to_ascii_lowercase()
            )),
            _ => None,
        };
    }
    let (app, key) = (app?, snowflake(key)?);
    Some(format!("{CDN_URL}/app-assets/{app}/{key}.png?size=160"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_presences_to_activities() {
        let presence = json!({
            "status": "online",
            "activities": [
                { "type": 4, "name": "Custom Status", "state": "estudando" },
                { "type": 0, "name": "Minecraft", "details": "Sobrevivência", "timestamps": { "start": 1_700_000_000_000i64 } },
            ]
        });
        let activity = activity(&presence, OWN).unwrap();
        assert_eq!(
            (activity.kind, activity.name.as_str()),
            ("playing", "Minecraft")
        );
        assert_eq!(activity.details.as_deref(), Some("Sobrevivência"));
        assert_eq!(activity.started_at.unwrap().timestamp(), 1_700_000_000);
        assert_eq!(activity.source, "discord");
        assert_eq!(activity.image, None);

        let spotify = json!({ "status": "dnd", "activities": [{ "type": 2, "name": "Spotify", "details": "Música", "state": "Artista" }] });
        assert_eq!(super::activity(&spotify, OWN).unwrap().kind, "listening");
        // Only a custom status, offline, or nothing at all: no activity.
        assert!(super::activity(
            &json!({ "status": "online", "activities": [{ "type": 4, "name": "Custom Status" }] }),
            OWN
        )
        .is_none());
        assert!(super::activity(
            &json!({ "status": "offline", "activities": [{ "type": 0, "name": "Minecraft" }] }),
            OWN
        )
        .is_none());
        assert!(super::activity(
            &json!({ "status": "online", "activities": [{ "type": 0, "name": "  " }] }),
            OWN
        )
        .is_none());
    }

    const OWN: &str = "999";

    #[test]
    fn reads_activity_thumbnails() {
        let spotify = json!({ "status": "online", "activities": [{
            "type": 2, "name": "Spotify",
            "assets": { "large_image": "spotify:ab67616d0000b273", "large_text": "Álbum" }
        }] });
        let found = activity(&spotify, OWN).unwrap();
        assert_eq!(
            found.image.as_deref(),
            Some("https://i.scdn.co/image/ab67616d0000b273")
        );
        assert_eq!(found.image_text.as_deref(), Some("Álbum"));

        // An app asset, falling back to the small image.
        let game = json!({ "status": "online", "activities": [{
            "type": 0, "name": "Jogo", "application_id": "123",
            "assets": { "large_image": "bad key", "small_image": "456" }
        }] });
        assert_eq!(
            activity(&game, OWN).unwrap().image.as_deref(),
            Some("https://cdn.discordapp.com/app-assets/123/456.png?size=160")
        );

        assert_eq!(
            asset_url(None, "mp:external/abc/https/x.png").as_deref(),
            Some("https://media.discordapp.net/external/abc/https/x.png")
        );
        assert_eq!(
            asset_url(None, "youtube:dQw4w9WgXcQ").as_deref(),
            Some("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")
        );
        assert_eq!(asset_url(None, "mp:../x"), None);
        assert_eq!(asset_url(None, "spotify:a?b"), None);
        assert_eq!(asset_url(None, "other:abc"), None);
        // An app asset needs the app.
        assert_eq!(asset_url(None, "456"), None);
    }

    #[test]
    fn ignores_own_rich_presence() {
        let presence = json!({ "status": "online", "activities": [
            { "type": 0, "name": "Disc Voice", "application_id": OWN, "details": "Em um canal de voz" },
            { "type": 2, "name": "Spotify" },
        ] });
        assert_eq!(activity(&presence, OWN).unwrap().name, "Spotify");
        let only_own = json!({ "status": "online", "activities": [
            { "type": 0, "name": "Disc Voice", "application_id": OWN },
        ] });
        assert!(activity(&only_own, OWN).is_none());
    }
}
