//! Imports the history of Discord text channels, once.
//!
//! Each import walks the channel oldest first with `after=<last id>` (100
//! messages per request), so local ids follow Discord's order and every page
//! is a resumable checkpoint. Media is copied to the API, since Discord's
//! links expire. When a page comes back short the import is `done`: the
//! channel then belongs to Disc Voice and Discord is not read again.
use super::{Discord, DiscordError};
use crate::{
    entities::discord_import,
    files,
    messages::{lock_channel, Attachment, DiscordAuthor},
    ApiResult, AppState,
};
use chrono::Utc;
use sea_orm::{
    sea_query::{Expr, NullOrdering, Order},
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, QueryFilter,
    QueryOrder, Set, Statement, TransactionTrait,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc, time::Duration};
use uuid::Uuid;

/// Discord's maximum page size.
const PAGE: usize = 100;
/// Pages per turn before letting other imports run.
const PAGES_PER_TURN: usize = 10;
/// Temporary failures are retried after this long.
const RETRY: chrono::Duration = chrono::Duration::minutes(5);
/// Regular messages, replies and app command responses; system messages
/// (joins, pins, boosts…) are skipped.
const KEPT_TYPES: [u64; 4] = [0, 19, 20, 23];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportView {
    channel_id: Uuid,
    server_id: Uuid,
    guild_id: String,
    discord_channel_id: String,
    discord_channel_name: String,
    /// `history` while importing, then `done`.
    phase: String,
    /// queued, running, idle or error.
    status: String,
    imported: i64,
    error: Option<String>,
    synced_at: Option<chrono::DateTime<Utc>>,
}

impl From<&discord_import::Model> for ImportView {
    fn from(m: &discord_import::Model) -> Self {
        Self {
            channel_id: m.channel_id,
            server_id: m.server_id,
            guild_id: m.guild_id.clone(),
            discord_channel_id: m.discord_channel_id.clone(),
            discord_channel_name: m.discord_channel_name.clone(),
            phase: m.phase.clone(),
            status: m.status.clone(),
            imported: m.imported,
            error: m.error.clone(),
            synced_at: m.synced_at,
        }
    }
}

/// Tells the server's members how an import is going; clients showing the
/// channel fetch the new messages, and unlock it when it is done.
pub(crate) fn publish(state: &AppState, import: &discord_import::Model) {
    state.realtime.publish_server(
        import.server_id,
        json!({ "type": "discord.import", "serverId": import.server_id, "import": ImportView::from(import) }),
    );
}

pub(super) async fn run(state: AppState) {
    let Some(discord) = state.discord.clone() else {
        return;
    };
    // Imports interrupted by a restart continue from their last page.
    let recovered = discord_import::Entity::update_many()
        .col_expr(discord_import::Column::Status, Expr::value("queued"))
        .filter(discord_import::Column::Status.eq("running"))
        .exec(&state.db)
        .await;
    if let Err(error) = recovered {
        tracing::warn!(?error, "Não foi possível retomar as importações do Discord");
    }
    loop {
        if let Err(error) = tick(&state, &discord).await {
            tracing::error!(?error, "Falha no importador do Discord");
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    }
}

async fn tick(state: &AppState, discord: &Arc<Discord>) -> ApiResult<()> {
    discord_import::Entity::update_many()
        .col_expr(discord_import::Column::Status, Expr::value("queued"))
        .filter(discord_import::Column::Status.eq("error"))
        .filter(discord_import::Column::RetryAt.lte(Utc::now()))
        .exec(&state.db)
        .await?;
    // The least recently served first, so one huge channel cannot starve the others.
    let next = discord_import::Entity::find()
        .filter(discord_import::Column::Status.eq("queued"))
        .filter(discord_import::Column::Phase.eq("history"))
        .order_by_with_nulls(
            discord_import::Column::SyncedAt,
            Order::Asc,
            NullOrdering::First,
        )
        .one(&state.db)
        .await?;
    if let Some(import) = next {
        return run_import(state, discord, import).await;
    }
    if copy_pending_media(state, discord).await? > 0 {
        return Ok(());
    }
    tokio::select! {
        _ = discord.wake.notified() => {}
        _ = tokio::time::sleep(Duration::from_secs(60)) => {}
    }
    Ok(())
}

async fn save(
    state: &AppState,
    import: discord_import::ActiveModel,
) -> ApiResult<discord_import::Model> {
    let row = import.update(&state.db).await?;
    publish(state, &row);
    Ok(row)
}

/// Names of the guild's channels, to show `<#id>` mentions as `#name`.
async fn channel_names(discord: &Discord, guild: &str) -> HashMap<String, String> {
    #[derive(serde::Deserialize)]
    struct Named {
        id: String,
        #[serde(default)]
        name: Option<String>,
    }
    discord
        .bot_get::<Vec<Named>>(&format!("/guilds/{guild}/channels"))
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|c| Some((c.id, c.name?)))
        .collect()
}

async fn run_import(
    state: &AppState,
    discord: &Discord,
    import: discord_import::Model,
) -> ApiResult<()> {
    let mut active: discord_import::ActiveModel = import.clone().into();
    active.status = Set("running".into());
    let mut import = save(state, active).await?;
    let channels = channel_names(discord, &import.guild_id).await;
    for _ in 0..PAGES_PER_TURN {
        let after = import.cursor.clone().unwrap_or_else(|| "0".into());
        let path = format!(
            "/channels/{}/messages?limit={PAGE}&after={after}",
            import.discord_channel_id
        );
        let page: Vec<Value> = match discord.bot_get(&path).await {
            Ok(page) => page,
            Err(error) => return fail(state, import, error).await,
        };
        let full = page.len() >= PAGE;
        // The cursor passes skipped system messages too.
        let newest = page
            .iter()
            .filter_map(|m| m["id"].as_str()?.parse::<u64>().ok())
            .max()
            .filter(|id| *id > after.parse().unwrap_or(0));
        let mut rows: Vec<Value> = page.iter().filter_map(|m| row(m, &channels)).collect();
        for row in &mut rows {
            let mut attachments: Vec<Attachment> =
                serde_json::from_value(row["attachments"].take()).unwrap_or_default();
            copy_media(state, discord, &mut attachments).await;
            row["attachments"] = json!(attachments);
        }
        let inserted = insert(state, import.channel_id, &rows).await?;
        let mut active: discord_import::ActiveModel = import.clone().into();
        if let Some(newest) = newest {
            active.cursor = Set(Some(newest.to_string()));
        }
        active.imported = Set(import.imported + inserted);
        active.synced_at = Set(Some(Utc::now()));
        active.error = Set(None);
        active.retry_at = Set(None);
        if !full {
            active.phase = Set("done".into());
            active.status = Set("idle".into());
        }
        import = save(state, active).await?;
        if !full {
            return Ok(());
        }
    }
    let mut active: discord_import::ActiveModel = import.into();
    active.status = Set("queued".into());
    save(state, active).await?;
    Ok(())
}

async fn fail(
    state: &AppState,
    import: discord_import::Model,
    error: DiscordError,
) -> ApiResult<()> {
    tracing::warn!(?error, channel = %import.discord_channel_id, "Falha ao importar canal do Discord");
    let mut active: discord_import::ActiveModel = import.into();
    active.status = Set("error".into());
    active.error = Set(Some(error.describe()));
    active.retry_at = Set(error.transient().then(|| Utc::now() + RETRY));
    save(state, active).await?;
    Ok(())
}

/// Copies attachments to the API. Those that can't be copied (too large,
/// expired) keep their Discord link and are marked unavailable.
async fn copy_media(state: &AppState, discord: &Discord, attachments: &mut [Attachment]) {
    for attachment in attachments
        .iter_mut()
        .filter(|a| !a.unavailable && !a.url.starts_with("/api/files/"))
    {
        let copied = match discord
            .download(&attachment.url, files::MAX_FILE_BYTES)
            .await
        {
            Ok(bytes) => files::store(
                state,
                &attachment.filename,
                attachment.content_type.as_deref(),
                &bytes,
            )
            .await
            .map_err(|e| e.1),
            Err(error) => Err(error),
        };
        match copied {
            Ok(file) => attachment.url = files::url(file.id, &file.name),
            Err(error) => {
                tracing::warn!(%error, file = %attachment.filename, "Não foi possível copiar o anexo do Discord");
                attachment.unavailable = true;
            }
        }
    }
}

/// Copies media of messages imported before attachments were stored by the
/// API, while their Discord links still work. Returns how many messages it
/// handled.
async fn copy_pending_media(state: &AppState, discord: &Discord) -> ApiResult<usize> {
    let rows = state
        .db
        .query_all(Statement::from_string(
            DbBackend::Postgres,
            r#"SELECT id, attachments FROM messages
               WHERE discord_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM jsonb_array_elements(attachments) a
                 WHERE a->>'url' NOT LIKE '/api/files/%'
                   AND NOT COALESCE((a->>'unavailable')::boolean, false))
               ORDER BY id LIMIT 20"#,
        ))
        .await?;
    for row in &rows {
        let id: i64 = row.try_get("", "id")?;
        let value: Value = row.try_get("", "attachments")?;
        let mut attachments: Vec<Attachment> = serde_json::from_value(value).unwrap_or_default();
        copy_media(state, discord, &mut attachments).await;
        state
            .db
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE messages SET attachments = $2::jsonb WHERE id = $1",
                [id.into(), json!(attachments).into()],
            ))
            .await?;
    }
    Ok(rows.len())
}

/// Stores a page in chronological order, skipping messages already imported.
/// Returns how many were new.
async fn insert(state: &AppState, channel: Uuid, rows: &[Value]) -> ApiResult<i64> {
    if rows.is_empty() {
        return Ok(0);
    }
    let tx = state.db.begin().await?;
    lock_channel(&tx, channel).await?;
    let inserted = tx
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"INSERT INTO messages (channel_id, author_id, client_id, content, created_at, discord_id, discord_author, attachments)
               SELECT $1, NULL, gen_random_uuid(), r.content, r.created_at, r.discord_id, r.author, r.attachments
               FROM jsonb_to_recordset($2::jsonb)
                    AS r(discord_id text, content text, created_at timestamptz, author jsonb, attachments jsonb)
               ORDER BY r.discord_id::numeric
               ON CONFLICT (channel_id, discord_id) WHERE discord_id IS NOT NULL DO NOTHING
               RETURNING id"#,
            [channel.into(), Value::Array(rows.to_vec()).into()],
        ))
        .await?
        .len();
    tx.commit().await?;
    Ok(inserted as i64)
}

/// Discord markup that only makes sense inside Discord (mentions by id,
/// custom emoji, timestamps) as plain text.
fn readable(
    content: &str,
    users: &HashMap<String, String>,
    channels: &HashMap<String, String>,
) -> String {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let token = |inner: &str| -> Option<String> {
        if let Some(id) = inner.strip_prefix("@&") {
            return digits(id).then(|| "@cargo".into());
        }
        if let Some(id) = inner.strip_prefix("@!").or_else(|| inner.strip_prefix('@')) {
            return digits(id).then(|| format!("@{}", users.get(id).map_or("usuário", |n| n)));
        }
        if let Some(id) = inner.strip_prefix('#') {
            return digits(id).then(|| format!("#{}", channels.get(id).map_or("canal", |n| n)));
        }
        if let Some(emoji) = inner.strip_prefix("a:").or_else(|| inner.strip_prefix(':')) {
            let (name, id) = emoji.split_once(':')?;
            return (digits(id) && !name.is_empty()).then(|| format!(":{name}:"));
        }
        if let Some(time) = inner.strip_prefix("t:") {
            let seconds = time.split(':').next()?.parse().ok()?;
            let date = chrono::DateTime::from_timestamp(seconds, 0)?;
            return Some(date.format("%d/%m/%Y %H:%M UTC").to_string());
        }
        None
    };
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        match tail
            .find('>')
            .and_then(|end| Some((end, token(&tail[1..end])?)))
        {
            Some((end, text)) => {
                out.push_str(&text);
                rest = &tail[end + 1..];
            }
            None => {
                out.push('<');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// A Discord message as a row for [`insert`], or None for system messages.
fn row(message: &Value, channels: &HashMap<String, String>) -> Option<Value> {
    if !KEPT_TYPES.contains(&message["type"].as_u64().unwrap_or(0)) {
        return None;
    }
    let id = super::snowflake(message["id"].as_str()?)?;
    let author = &message["author"];
    let author_id = super::snowflake(author["id"].as_str()?)?;
    let display = |user: &Value| {
        super::short_text(&user["global_name"], 32)
            .or_else(|| super::short_text(&user["username"], 32))
    };
    let author = DiscordAuthor {
        id: author_id.into(),
        username: author["username"]
            .as_str()
            .unwrap_or("desconhecido")
            .chars()
            .take(32)
            .collect(),
        name: display(author).unwrap_or_else(|| "Usuário do Discord".into()),
        avatar: super::avatar_url(author_id, author["avatar"].as_str()),
        bot: author["bot"] == true,
    };
    let attachments: Vec<Attachment> = message["attachments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| {
            Some(Attachment {
                id: a["id"].as_str()?.into(),
                filename: a["filename"].as_str()?.chars().take(255).collect(),
                url: a["url"]
                    .as_str()
                    .filter(|u| u.starts_with("https://") || u.starts_with("http://"))?
                    .into(),
                size: a["size"].as_u64().unwrap_or(0),
                content_type: a["content_type"]
                    .as_str()
                    .map(|s| s.chars().take(100).collect()),
                width: a["width"].as_u64().and_then(|w| u32::try_from(w).ok()),
                height: a["height"].as_u64().and_then(|h| u32::try_from(h).ok()),
                unavailable: false,
                provider: None,
                still: None,
            })
        })
        .collect();
    let users: HashMap<String, String> = message["mentions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|u| Some((u["id"].as_str()?.to_owned(), display(u)?)))
        .collect();
    let content: String = readable(
        message["content"].as_str().unwrap_or_default(),
        &users,
        channels,
    )
    .chars()
    .filter(|c| *c != '\0')
    .take(4000)
    .collect();
    Some(json!({
        "discord_id": id,
        "content": content,
        "created_at": message["timestamp"].as_str()?,
        "author": author,
        "attachments": attachments,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_messages() {
        let message = json!({
            "id": "1100000000000000001", "type": 19, "content": "Olá\u{0}!",
            "timestamp": "2024-05-01T12:00:00.000000+00:00",
            "author": { "id": "42", "username": "ana", "global_name": "Ana", "avatar": "abc" },
            "attachments": [
                { "id": "9", "filename": "foto.png", "url": "https://cdn.discordapp.com/attachments/1/9/foto.png", "size": 1024, "content_type": "image/png", "width": 10, "height": 20 },
                { "id": "10", "filename": "x", "url": "javascript:alert(1)", "size": 1 }
            ]
        });
        let converted = row(&message, &HashMap::new()).unwrap();
        assert_eq!(converted["discord_id"], "1100000000000000001");
        assert_eq!(converted["content"], "Olá!");
        assert_eq!(converted["author"]["name"], "Ana");
        assert_eq!(
            converted["author"]["avatar"],
            "https://cdn.discordapp.com/avatars/42/abc.png?size=128"
        );
        assert_eq!(converted["attachments"].as_array().unwrap().len(), 1);
        assert_eq!(converted["attachments"][0]["contentType"], "image/png");
        // Joins, pins and other system messages are skipped.
        assert!(row(&json!({ "id": "1", "type": 7, "author": { "id": "1" }, "timestamp": "2024-05-01T12:00:00Z" }), &HashMap::new()).is_none());
        // Without a global name, the username is shown.
        let plain = json!({ "id": "2", "type": 0, "content": "", "timestamp": "2024-05-01T12:00:00Z", "author": { "id": "3", "username": "bob" } });
        assert_eq!(
            row(&plain, &HashMap::new()).unwrap()["author"]["name"],
            "bob"
        );
    }

    #[test]
    fn makes_discord_markup_readable() {
        let users = HashMap::from([("42".to_owned(), "Ana".to_owned())]);
        let channels = HashMap::from([("7".to_owned(), "regras".to_owned())]);
        assert_eq!(
            readable(
                "<@42> e <@!99>, leiam <#7> <@&5> <:pog:123> <a:dança:456> <t:0:R>",
                &users,
                &channels
            ),
            "@Ana e @usuário, leiam #regras @cargo :pog: :dança: 01/01/1970 00:00 UTC"
        );
        // Anything else stays as written.
        assert_eq!(
            readable("a < b > c <x> <@abc> <", &users, &channels),
            "a < b > c <x> <@abc> <"
        );
    }
}
