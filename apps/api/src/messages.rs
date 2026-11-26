use super::*;
use axum::extract::Query;
use entities::{discord_account, message};
use sea_orm::{ConnectionTrait, DbBackend, QuerySelect, Statement};
use std::collections::HashMap;

/// Author of an imported Discord message, stored with the message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscordAuthor {
    pub id: String,
    pub username: String,
    /// Display name (global name, or the username).
    pub name: String,
    pub avatar: Option<String>,
    #[serde(default)]
    pub bot: bool,
}

/// Disc Voice ids for Discord-only authors: stable, and never a real user id.
const DISCORD_AUTHOR_PREFIX: u64 = 0xd15c_0000_0000_0000;

impl DiscordAuthor {
    fn view(&self) -> UserView {
        UserView {
            id: Uuid::from_u64_pair(DISCORD_AUTHOR_PREFIX, self.id.parse().unwrap_or_default()),
            email: String::new(),
            name: self.name.clone(),
            pronouns: String::new(),
            bio: String::new(),
            banner: profile::DEFAULT_BANNER.into(),
            avatar: self.avatar.clone(),
            avatar_source: None,
            discord: Some(self.username.clone()),
            ..Default::default()
        }
    }
}

/// A file attached to a message. Media imported from Discord is copied to
/// the API (`url` is then `/api/files/...`), since Discord's links expire.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Attachment {
    pub id: String,
    pub filename: String,
    pub url: String,
    pub size: u64,
    pub content_type: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Could not be copied to the API (too large, or the link had expired):
    /// `url` still points to Discord and may not open.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unavailable: bool,
    /// `klipy` for a GIF sent from the picker: `url` is on Klipy's CDN.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Still frame of an animated image, for people who prefer reduced motion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub still: Option<String>,
}

impl Attachment {
    /// A GIF chosen in the Klipy picker. It stays on Klipy's CDN, as their
    /// terms ask: the API keeps only the link.
    fn gif(gif: crate::klipy::GifChoice) -> Self {
        let webp = gif
            .url
            .split('?')
            .next()
            .unwrap_or_default()
            .ends_with(".webp");
        let title = if gif.title.is_empty() {
            "GIF"
        } else {
            &gif.title
        };
        Self {
            id: if gif.slug.is_empty() {
                "klipy".into()
            } else {
                format!("klipy:{}", gif.slug)
            },
            filename: format!("{title}.{}", if webp { "webp" } else { "gif" }),
            content_type: Some(if webp { "image/webp" } else { "image/gif" }.into()),
            url: gif.url,
            size: 0,
            width: (gif.width > 0).then_some(gif.width),
            height: (gif.height > 0).then_some(gif.height),
            unavailable: false,
            provider: Some("klipy".into()),
            still: gif.still,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageView {
    id: String,
    channel_id: Uuid,
    client_id: Uuid,
    author: UserView,
    content: String,
    created_at: chrono::DateTime<Utc>,
    /// Present on messages imported from Discord.
    #[serde(skip_serializing_if = "Option::is_none")]
    discord_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    attachments: Vec<Attachment>,
}

impl MessageView {
    fn new(m: message::Model, author: UserView) -> Self {
        Self {
            id: m.id.to_string(),
            channel_id: m.channel_id,
            client_id: m.client_id,
            author,
            content: m.content,
            created_at: m.created_at,
            discord_id: m.discord_id,
            attachments: serde_json::from_value(m.attachments).unwrap_or_default(),
        }
    }
}

/// Authors of a page of messages. A Discord author whose account is linked
/// to a Disc Voice user shows as that user.
#[derive(Default)]
pub(crate) struct Authors {
    users: HashMap<Uuid, UserView>,
    linked: HashMap<String, UserView>,
}

impl Authors {
    pub(crate) async fn load<'a>(
        db: &DatabaseConnection,
        rows: impl Iterator<Item = (Option<Uuid>, Option<&'a serde_json::Value>)>,
    ) -> ApiResult<Self> {
        let (mut ids, mut discord) = (Vec::new(), Vec::new());
        for (user, author) in rows {
            ids.extend(user);
            if let Some(id) = author.and_then(|a| a["id"].as_str()) {
                discord.push(id.to_owned());
            }
        }
        let accounts = if discord.is_empty() {
            Vec::new()
        } else {
            discord_account::Entity::find()
                .filter(discord_account::Column::DiscordId.is_in(discord))
                .all(db)
                .await?
        };
        ids.extend(accounts.iter().map(|a| a.user_id));
        let users: HashMap<_, _> = if ids.is_empty() {
            HashMap::new()
        } else {
            user::Entity::find()
                .filter(user::Column::Id.is_in(ids))
                .all(db)
                .await?
                .into_iter()
                .map(|u| (u.id, UserView::from(u)))
                .collect()
        };
        let linked = accounts
            .into_iter()
            .filter_map(|a| Some((a.discord_id, users.get(&a.user_id)?.clone())))
            .collect();
        Ok(Self { users, linked })
    }

    pub(crate) fn get(
        &self,
        user: Option<Uuid>,
        discord: Option<&serde_json::Value>,
    ) -> Option<UserView> {
        if let Some(id) = user {
            return self.users.get(&id).cloned();
        }
        let author: DiscordAuthor = serde_json::from_value(discord?.clone()).ok()?;
        Some(
            self.linked
                .get(&author.id)
                .cloned()
                .unwrap_or_else(|| author.view()),
        )
    }
}

#[derive(Default, Deserialize)]
pub(crate) struct History {
    before: Option<i64>,
    after: Option<i64>,
    limit: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    messages: Vec<MessageView>,
    has_more: bool,
}

pub(crate) async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
    Query(input): Query<History>,
) -> ApiResult<Json<Page>> {
    require_channel(&state.db, id, user.id, MESSAGES).await?;
    if input.before.is_some() && input.after.is_some() {
        return Err(ApiError::bad("Use apenas before ou after."));
    }
    let limit = input.limit.unwrap_or(50).clamp(1, 100);
    let mut query = message::Entity::find().filter(message::Column::ChannelId.eq(id));
    if let Some(before) = input.before {
        query = query.filter(message::Column::Id.lt(before));
    }
    if let Some(after) = input.after {
        query = query
            .filter(message::Column::Id.gt(after))
            .order_by_asc(message::Column::Id);
    } else {
        query = query.order_by_desc(message::Column::Id);
    }
    let mut rows = query.limit(limit + 1).all(&state.db).await?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    if input.after.is_none() {
        rows.reverse();
    }
    let authors = Authors::load(
        &state.db,
        rows.iter()
            .map(|m| (m.author_id, m.discord_author.as_ref())),
    )
    .await?;
    let messages = rows
        .into_iter()
        .filter_map(|m| {
            let author = authors.get(m.author_id, m.discord_author.as_ref())?;
            Some(MessageView::new(m, author))
        })
        .collect();
    Ok(Json(Page { messages, has_more }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendMessage {
    client_id: Uuid,
    #[serde(default)]
    content: String,
    /// A GIF from the Klipy picker; the text is then optional.
    gif: Option<crate::klipy::GifChoice>,
}

pub(crate) async fn send(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
    Json(input): Json<SendMessage>,
) -> ApiResult<Json<MessageView>> {
    let channel = require_channel(&state.db, id, user.id, MESSAGES).await?;
    // New messages would land among the history still being imported.
    let importing = match channel.server_id {
        Some(server) if channel.source == "discord" => crate::discord::importing(&state.db, server)
            .await?
            .contains(&id),
        _ => false,
    };
    if importing {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Este canal ainda está sendo importado do Discord. Você poderá enviar mensagens quando a importação terminar.".into(),
        ));
    }
    let content = input.content.trim();
    let attachments = match input.gif {
        Some(gif) => vec![Attachment::gif(gif.validate()?)],
        None => Vec::new(),
    };
    if (content.is_empty() && attachments.is_empty())
        || content.chars().count() > 4000
        || content.contains('\0')
    {
        return Err(ApiError::bad(
            "A mensagem deve ter entre 1 e 4000 caracteres.",
        ));
    }
    let attachments = serde_json::to_value(&attachments).map_err(ApiError::internal)?;
    let tx = state.db.begin().await?;
    lock_channel(&tx, id).await?;
    let existing = message::Entity::find()
        .filter(message::Column::AuthorId.eq(user.id))
        .filter(message::Column::ClientId.eq(input.client_id))
        .one(&tx)
        .await?;
    let row = if let Some(existing) = existing {
        if existing.channel_id != id
            || existing.content != content
            || existing.attachments != attachments
        {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Identificador de envio já utilizado.".into(),
            ));
        }
        existing
    } else {
        message::ActiveModel {
            channel_id: Set(id),
            author_id: Set(Some(user.id)),
            client_id: Set(input.client_id),
            content: Set(content.into()),
            created_at: Set(Utc::now()),
            attachments: Set(attachments),
            ..Default::default()
        }
        .insert(&tx)
        .await?
    };
    tx.commit().await?;
    let view = MessageView::new(row, user);
    match channel.server_id {
        // Every online member hears about it, whatever server they have open,
        // with the names a notification needs.
        Some(server) => publish_to_members(&state, server, &channel, &view).await?,
        None => {
            dms::publish(
                &state,
                &channel,
                serde_json::json!({ "type": "message.created", "message": view }),
            )
            .await?
        }
    }
    Ok(Json(view))
}

async fn publish_to_members(
    state: &AppState,
    server: Uuid,
    channel: &channel::Model,
    view: &MessageView,
) -> ApiResult<()> {
    let server_name = server::Entity::find_by_id(server)
        .one(&state.db)
        .await?
        .map(|s| s.name)
        .unwrap_or_default();
    let members: std::collections::HashSet<Uuid> = member::Entity::find()
        .filter(member::Column::ServerId.eq(server))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|m| m.user_id)
        .collect();
    state.realtime.publish_users(
        &members,
        serde_json::json!({
            "type": "message.created", "message": view,
            "serverId": server, "serverName": server_name, "channelName": channel.name,
            // Room chat of a voice channel: clients keep it out of unread badges.
            "channelType": channel.kind
        }),
    );
    Ok(())
}

/// Serializes commits within a channel: history cursors must never skip a
/// lower sequence whose transaction was still open when the page was read.
pub(crate) async fn lock_channel(tx: &impl ConnectionTrait, channel: Uuid) -> ApiResult<()> {
    tx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [channel.to_string().into()],
    ))
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discord_authors_get_stable_distinct_ids() {
        let author = DiscordAuthor {
            id: "80351110224678912".into(),
            username: "nelly".into(),
            name: "Nelly".into(),
            avatar: None,
            bot: false,
        };
        let view = author.view();
        assert_eq!(view.id, author.view().id);
        assert_eq!(view.discord.as_deref(), Some("nelly"));
        assert_eq!(view.name, "Nelly");
        let json = serde_json::to_value(&author).unwrap();
        let authors = Authors::default();
        assert_eq!(authors.get(None, Some(&json)).unwrap().id, view.id);
        // A local author that no longer exists is skipped.
        assert!(authors.get(Some(Uuid::new_v4()), None).is_none());
    }
}
