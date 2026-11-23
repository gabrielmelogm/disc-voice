//! Discord gateway connection of the bot. It brings:
//! - PRESENCE_UPDATE (privileged GUILD_PRESENCES intent): activities of the
//!   members of servers the bot is in, published for linked accounts;
//! - GUILD_DELETE: the bot was removed, so unfinished imports stop.
//!
//! Imports read history over REST once, so the gateway never subscribes to
//! messages (no GUILD_MESSAGES or MESSAGE_CONTENT intent).
use super::{forget_presences, presence, short_text, Discord};
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
                    presence(state, &discord, id, activity(item)).await;
                }
            }
        }
        "PRESENCE_UPDATE" => {
            if let Some(id) = data["user"]["id"].as_str() {
                presence(state, &discord, id, activity(data)).await;
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

/// The activity shown for a Discord presence: the first game, stream, music
/// or show, ignoring custom statuses. Offline users have none.
pub(super) fn activity(presence: &Value) -> Option<Activity> {
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
        Some(Activity {
            kind,
            name: short_text(&item["name"], 128)?,
            details: short_text(&item["details"], 128),
            state: short_text(&item["state"], 128),
            started_at: item["timestamps"]["start"]
                .as_i64()
                .and_then(chrono::DateTime::from_timestamp_millis),
            source: "discord",
        })
    })
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
        let activity = activity(&presence).unwrap();
        assert_eq!(
            (activity.kind, activity.name.as_str()),
            ("playing", "Minecraft")
        );
        assert_eq!(activity.details.as_deref(), Some("Sobrevivência"));
        assert_eq!(activity.started_at.unwrap().timestamp(), 1_700_000_000);
        assert_eq!(activity.source, "discord");

        let spotify = json!({ "status": "dnd", "activities": [{ "type": 2, "name": "Spotify", "details": "Música", "state": "Artista" }] });
        assert_eq!(super::activity(&spotify).unwrap().kind, "listening");
        // Only a custom status, offline, or nothing at all: no activity.
        assert!(super::activity(
            &json!({ "status": "online", "activities": [{ "type": 4, "name": "Custom Status" }] })
        )
        .is_none());
        assert!(super::activity(
            &json!({ "status": "offline", "activities": [{ "type": 0, "name": "Minecraft" }] })
        )
        .is_none());
        assert!(super::activity(
            &json!({ "status": "online", "activities": [{ "type": 0, "name": "  " }] })
        )
        .is_none());
    }
}
