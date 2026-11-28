use super::*;
use axum::extract::Query;
use entities::{discord_account, dm_channel, message, reaction};
use sea_orm::{ConnectionTrait, DbBackend, PaginatorTrait, QuerySelect, Statement};
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
    /// The sender deleted the file from their gallery: only the name is left.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
}

impl Attachment {
    /// A file the sender uploaded (`id` is the file's id).
    fn file(file: crate::entities::file::Model) -> Self {
        Self {
            id: file.id.to_string(),
            url: crate::files::url(file.id, &file.name),
            filename: file.name,
            size: file.size.max(0) as u64,
            content_type: Some(file.content_type),
            width: file.width.map(|w| w as u32),
            height: file.height.map(|h| h as u32),
            unavailable: false,
            provider: None,
            still: None,
            deleted: false,
        }
    }

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
            deleted: false,
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
    /// When the author last changed the text.
    #[serde(skip_serializing_if = "Option::is_none")]
    edited_at: Option<chrono::DateTime<Utc>>,
    /// Present on messages imported from Discord.
    #[serde(skip_serializing_if = "Option::is_none")]
    discord_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    attachments: Vec<Attachment>,
    /// People mentioned as `<@id>` in the text, to show their names.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    mentions: Vec<UserView>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    reactions: Vec<ReactionView>,
    /// The message this one answers.
    #[serde(skip_serializing_if = "Option::is_none")]
    reply_to: Option<ReplyView>,
}

/// The message a reply answers, shown above it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplyView {
    id: String,
    /// The original (or its author's account) was deleted: only the id is left.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    author: Option<UserView>,
    #[serde(skip_serializing_if = "String::is_empty")]
    content: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    mentions: Vec<UserView>,
    /// It has files or a GIF, which the preview names when there is no text.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    attachments: bool,
}

/// An emoji on a message and who reacted with it, in the order of the first
/// reaction.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReactionView {
    emoji: String,
    count: usize,
    users: Vec<Uuid>,
}

/// Most distinct emoji on one message.
const MAX_REACTIONS: usize = 20;
/// Most people one message can mention.
const MAX_MENTIONS: usize = 20;

/// Mentions every member of the server, like Discord's `@everyone`.
pub(crate) const EVERYONE: &str = "<@everyone>";

/// People mentioned as `<@user-id>` in a message, without repeats.
pub(crate) fn mentioned(content: &str) -> Vec<Uuid> {
    let mut ids = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("<@") {
        rest = &rest[start + 2..];
        let id = rest
            .get(..36)
            .filter(|_| rest[36..].starts_with('>'))
            .and_then(|id| Uuid::parse_str(id).ok());
        if let Some(id) = id {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    ids
}

/// Reactions of these messages, grouped by emoji.
async fn reactions_of(
    db: &DatabaseConnection,
    ids: Vec<i64>,
) -> ApiResult<HashMap<i64, Vec<ReactionView>>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = reaction::Entity::find()
        .filter(reaction::Column::MessageId.is_in(ids))
        .order_by_asc(reaction::Column::CreatedAt)
        .order_by_asc(reaction::Column::UserId)
        .all(db)
        .await?;
    Ok(group_reactions(rows))
}

fn group_reactions(rows: Vec<reaction::Model>) -> HashMap<i64, Vec<ReactionView>> {
    let mut grouped: HashMap<i64, Vec<ReactionView>> = HashMap::new();
    for row in rows {
        let list = grouped.entry(row.message_id).or_default();
        match list.iter_mut().find(|r| r.emoji == row.emoji) {
            Some(existing) => {
                existing.users.push(row.user_id);
                existing.count += 1;
            }
            None => list.push(ReactionView {
                emoji: row.emoji,
                count: 1,
                users: vec![row.user_id],
            }),
        }
    }
    grouped
}

/// Everything needed to show a page of messages: authors, mentioned people,
/// reactions and the messages they answer.
pub(crate) struct Views {
    authors: Authors,
    reactions: HashMap<i64, Vec<ReactionView>>,
    replied: HashMap<i64, message::Model>,
}

impl Views {
    pub(crate) async fn load(db: &DatabaseConnection, rows: &[message::Model]) -> ApiResult<Self> {
        let answered: Vec<i64> = rows.iter().filter_map(|m| m.reply_to).collect();
        let replied: HashMap<i64, message::Model> = if answered.is_empty() {
            HashMap::new()
        } else {
            message::Entity::find()
                .filter(message::Column::Id.is_in(answered))
                .all(db)
                .await?
                .into_iter()
                .map(|m| (m.id, m))
                .collect()
        };
        let shown = || rows.iter().chain(replied.values());
        let authors = Authors::load(
            db,
            shown().map(|m| (m.author_id, m.discord_author.as_ref())),
            shown().flat_map(|m| mentioned(&m.content)),
        )
        .await?;
        let reactions = reactions_of(db, rows.iter().map(|m| m.id).collect()).await?;
        Ok(Self {
            authors,
            reactions,
            replied,
        })
    }

    /// The preview of the message `id` answers, from the same channel.
    fn reply(&self, channel: Uuid, id: i64) -> ReplyView {
        let original = self
            .replied
            .get(&id)
            .filter(|r| r.channel_id == channel)
            .and_then(|r| Some((r, self.authors.get(r.author_id, r.discord_author.as_ref())?)));
        match original {
            Some((r, author)) => ReplyView {
                id: id.to_string(),
                deleted: false,
                author: Some(author),
                content: r.content.clone(),
                mentions: self.authors.mentions(&r.content),
                attachments: r.attachments.as_array().is_some_and(|a| !a.is_empty()),
            },
            None => ReplyView {
                id: id.to_string(),
                deleted: true,
                author: None,
                content: String::new(),
                mentions: Vec::new(),
                attachments: false,
            },
        }
    }

    /// None when the author no longer exists.
    pub(crate) fn view(&mut self, m: message::Model) -> Option<MessageView> {
        let author = self.authors.get(m.author_id, m.discord_author.as_ref())?;
        let mentions = self.authors.mentions(&m.content);
        let reactions = self.reactions.remove(&m.id).unwrap_or_default();
        let reply_to = m.reply_to.map(|id| self.reply(m.channel_id, id));
        Some(MessageView {
            id: m.id.to_string(),
            channel_id: m.channel_id,
            client_id: m.client_id,
            author,
            content: m.content,
            created_at: m.created_at,
            edited_at: m.edited_at,
            discord_id: m.discord_id,
            attachments: serde_json::from_value(m.attachments).unwrap_or_default(),
            mentions,
            reactions,
            reply_to,
        })
    }
}

/// One message as everyone sees it.
async fn view_one(db: &DatabaseConnection, m: message::Model) -> ApiResult<MessageView> {
    let rows = [m];
    let mut views = Views::load(db, &rows).await?;
    let [m] = rows;
    views
        .view(m)
        .ok_or_else(|| ApiError::internal("mensagem sem autor"))
}

/// Authors of a page of messages. A Discord author whose account is linked
/// to a Disc Voice user shows as that user.
#[derive(Default)]
pub(crate) struct Authors {
    users: HashMap<Uuid, UserView>,
    linked: HashMap<String, UserView>,
}

impl Authors {
    /// `rows` are the messages' authors; `mentioned`, people mentioned in them.
    pub(crate) async fn load<'a>(
        db: &DatabaseConnection,
        rows: impl Iterator<Item = (Option<Uuid>, Option<&'a serde_json::Value>)>,
        mentioned: impl Iterator<Item = Uuid>,
    ) -> ApiResult<Self> {
        let (mut ids, mut discord): (Vec<_>, Vec<_>) = (mentioned.collect(), Vec::new());
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

    /// The people a message mentions who still have an account.
    pub(crate) fn mentions(&self, content: &str) -> Vec<UserView> {
        mentioned(content)
            .into_iter()
            .filter_map(|id| self.users.get(&id).cloned())
            .collect()
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
    let mut views = Views::load(&state.db, &rows).await?;
    let messages = rows.into_iter().filter_map(|m| views.view(m)).collect();
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
    /// Ids of files the sender uploaded with `POST /files`.
    #[serde(default)]
    files: Vec<Uuid>,
    /// Id of a message of the same channel that this one answers.
    reply_to: Option<String>,
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
    let mut attachments: Vec<Attachment> = crate::files::owned(&state, user.id, &input.files)
        .await?
        .into_iter()
        .map(Attachment::file)
        .collect();
    if let Some(gif) = input.gif {
        attachments.push(Attachment::gif(gif.validate()?));
    }
    check_content(content, !attachments.is_empty())?;
    check_mentions(&state.db, &channel, user.id, content).await?;
    let reply_to = match input.reply_to.as_deref() {
        Some(original) => Some(answered(&state.db, id, original).await?),
        None => None,
    };
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
            || existing.reply_to != reply_to
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
            reply_to: Set(reply_to),
            ..Default::default()
        }
        .insert(&tx)
        .await?
    };
    tx.commit().await?;
    let view = view_one(&state.db, row).await?;
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

/// The id of the message a reply answers, which must be in the same channel.
async fn answered(db: &DatabaseConnection, channel: Uuid, original: &str) -> ApiResult<i64> {
    let gone = || ApiError::bad("A mensagem que você está respondendo não existe mais.");
    let id: i64 = original.parse().map_err(|_| gone())?;
    message::Entity::find_by_id(id)
        .filter(message::Column::ChannelId.eq(channel))
        .one(db)
        .await?
        .map(|m| m.id)
        .ok_or_else(gone)
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

fn check_content(content: &str, attachments: bool) -> ApiResult<()> {
    if (content.is_empty() && !attachments)
        || content.chars().count() > 4000
        || content.contains('\0')
    {
        return Err(ApiError::bad(
            "A mensagem deve ter entre 1 e 4000 caracteres.",
        ));
    }
    Ok(())
}

/// Only people who can read the channel can be mentioned in it, and only the
/// owner and moderators can mention everyone of a server.
async fn check_mentions(
    db: &DatabaseConnection,
    channel: &channel::Model,
    author: Uuid,
    content: &str,
) -> ApiResult<()> {
    if content.contains(EVERYONE) {
        let Some(server) = channel.server_id else {
            return Err(ApiError::bad("@everyone só pode ser usado em servidores."));
        };
        let server = crate::roles::find_server(db, server).await?;
        if !crate::roles::access(db, &server, author)
            .await?
            .has(crate::roles::Permission::MentionEveryone)
        {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "Você não tem permissão para mencionar @everyone.".into(),
            ));
        }
    }
    let ids = mentioned(content);
    if ids.is_empty() {
        return Ok(());
    }
    let allowed = ids.len() <= MAX_MENTIONS
        && match channel.server_id {
            Some(server) => {
                member::Entity::find()
                    .filter(member::Column::ServerId.eq(server))
                    .filter(member::Column::UserId.is_in(ids.clone()))
                    .count(db)
                    .await?
                    == ids.len() as u64
            }
            None => dm_channel::Entity::find_by_id(channel.id)
                .one(db)
                .await?
                .is_some_and(|dm| ids.iter().all(|id| [dm.user_a, dm.user_b].contains(id))),
        };
    if !allowed {
        return Err(ApiError::bad(
            "Só é possível mencionar até 20 pessoas que participam desta conversa.",
        ));
    }
    Ok(())
}

/// A message of this channel, which the user can read.
async fn find_message(
    state: &AppState,
    user: &UserView,
    channel: Uuid,
    id: i64,
) -> ApiResult<(channel::Model, message::Model)> {
    let channel = require_channel(&state.db, channel, user.id, MESSAGES).await?;
    let message = message::Entity::find_by_id(id)
        .filter(message::Column::ChannelId.eq(channel.id))
        .one(&state.db)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Mensagem não encontrada.".into()))?;
    Ok((channel, message))
}

/// A message the user wrote, to change or delete.
async fn own_message(
    state: &AppState,
    user: &UserView,
    channel: Uuid,
    id: i64,
) -> ApiResult<(channel::Model, message::Model)> {
    let (channel, message) = find_message(state, user, channel, id).await?;
    if message.author_id != Some(user.id) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Você só pode alterar as suas próprias mensagens.".into(),
        ));
    }
    Ok((channel, message))
}

#[derive(Deserialize)]
pub(crate) struct EditMessage {
    content: String,
}

/// The author changes the text; files and GIFs stay.
pub(crate) async fn edit(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path((channel, id)): Path<(Uuid, i64)>,
    Json(input): Json<EditMessage>,
) -> ApiResult<Json<MessageView>> {
    let (channel, message) = own_message(&state, &user, channel, id).await?;
    let content = input.content.trim();
    let attachments = message
        .attachments
        .as_array()
        .is_some_and(|a| !a.is_empty());
    check_content(content, attachments)?;
    if content == message.content {
        return Ok(Json(view_one(&state.db, message).await?));
    }
    check_mentions(&state.db, &channel, user.id, content).await?;
    let mut active: message::ActiveModel = message.into();
    active.content = Set(content.into());
    active.edited_at = Set(Some(Utc::now()));
    let view = view_one(&state.db, active.update(&state.db).await?).await?;
    dms::publish(
        &state,
        &channel,
        serde_json::json!({ "type": "message.updated", "message": view }),
    )
    .await?;
    Ok(Json(view))
}

/// The author, or in a server whoever can manage messages, deletes the
/// message, with its reactions, for everyone.
pub(crate) async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path((channel, id)): Path<(Uuid, i64)>,
) -> ApiResult<StatusCode> {
    let (channel, message) = find_message(&state, &user, channel, id).await?;
    if message.author_id != Some(user.id) {
        let moderates = match channel.server_id {
            Some(server) => {
                let server = crate::roles::find_server(&state.db, server).await?;
                crate::roles::access(&state.db, &server, user.id)
                    .await?
                    .has(crate::roles::Permission::ManageMessages)
            }
            None => false,
        };
        if !moderates {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "Você só pode excluir as suas próprias mensagens.".into(),
            ));
        }
    }
    message::Entity::delete_by_id(message.id)
        .exec(&state.db)
        .await?;
    dms::publish(
        &state,
        &channel,
        serde_json::json!({
            "type": "message.deleted", "channelId": channel.id, "messageId": message.id.to_string()
        }),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A single emoji, possibly made of several code points (skin tones, flags,
/// keycaps, ZWJ sequences); never text.
fn valid_emoji(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().count() <= 16
        && !value.is_ascii()
        && value.chars().all(|c| {
            !c.is_whitespace()
                && !c.is_control()
                && (!c.is_ascii() || c.is_ascii_digit() || c == '#' || c == '*')
        })
}

/// Adds (`PUT`) or removes (`DELETE`) the user's reaction.
pub(crate) async fn react(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    method: axum::http::Method,
    Path((channel, id, emoji)): Path<(Uuid, i64, String)>,
) -> ApiResult<Json<Vec<ReactionView>>> {
    if !valid_emoji(&emoji) {
        return Err(ApiError::bad("Reaja com um emoji."));
    }
    let (channel, message) = find_message(&state, &user, channel, id).await?;
    if method == axum::http::Method::PUT {
        let current = reactions_of(&state.db, vec![message.id])
            .await?
            .remove(&message.id)
            .unwrap_or_default();
        if current.len() >= MAX_REACTIONS && !current.iter().any(|r| r.emoji == emoji) {
            return Err(ApiError::bad(
                "Esta mensagem já tem o máximo de 20 emojis diferentes.",
            ));
        }
        reaction::Entity::insert(reaction::ActiveModel {
            message_id: Set(message.id),
            emoji: Set(emoji),
            user_id: Set(user.id),
            created_at: Set(Utc::now()),
        })
        .on_conflict(
            OnConflict::columns([
                reaction::Column::MessageId,
                reaction::Column::Emoji,
                reaction::Column::UserId,
            ])
            .do_nothing()
            .to_owned(),
        )
        .exec_without_returning(&state.db)
        .await?;
    } else {
        reaction::Entity::delete_by_id((message.id, emoji, user.id))
            .exec(&state.db)
            .await?;
    }
    let reactions = reactions_of(&state.db, vec![message.id])
        .await?
        .remove(&message.id)
        .unwrap_or_default();
    dms::publish(
        &state,
        &channel,
        serde_json::json!({
            "type": "message.reactions", "channelId": channel.id,
            "messageId": message.id.to_string(), "reactions": reactions
        }),
    )
    .await?;
    Ok(Json(reactions))
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

    #[test]
    fn finds_mentions() {
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let text = format!("<@{a}> e <@{b}>, de novo <@{a}>; <@123> <@{a} <@>");
        assert_eq!(mentioned(&text), vec![a, b]);
        assert!(mentioned("sem menções <@").is_empty());
        assert!(mentioned(&format!("ç<@{a}")).is_empty());
    }

    #[test]
    fn accepts_only_emoji() {
        for ok in ["👍", "❤️", "👍🏽", "🇧🇷", "1️⃣", "👨‍👩‍👧"] {
            assert!(valid_emoji(ok), "{ok}");
        }
        for bad in ["", "a", "ok👍", "👍 ", "\u{0}", "<@x>", &"😀".repeat(17)] {
            assert!(!valid_emoji(bad), "{bad}");
        }
    }

    #[test]
    fn groups_reactions_by_emoji_in_order() {
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let row = |message_id, emoji: &str, user_id| reaction::Model {
            message_id,
            emoji: emoji.into(),
            user_id,
            created_at: Utc::now(),
        };
        let grouped = group_reactions(vec![
            row(1, "🔥", a),
            row(1, "👀", a),
            row(2, "🔥", b),
            row(1, "🔥", b),
        ]);
        let first = &grouped[&1];
        assert_eq!(first.len(), 2);
        assert_eq!((first[0].emoji.as_str(), first[0].count), ("🔥", 2));
        assert_eq!(first[0].users, vec![a, b]);
        assert_eq!(first[1].emoji, "👀");
        assert_eq!(grouped[&2][0].users, vec![b]);
    }
}
