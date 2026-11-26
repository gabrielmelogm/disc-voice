use super::{
    sync::ImportView, Discord, DiscordError, Flow, LoginTarget, UserGuild, BOT_PERMISSIONS,
    CALLBACK_PATH,
};
use crate::{
    channel_name,
    entities::{channel, discord_account, discord_guild, discord_import, server, user},
    google::Platform,
    insert_server, new_session, server_name, user_name, ApiError, ApiResult, AppState, AuthView,
    InviteView, UserView,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{Html, IntoResponse, Redirect, Response},
    Extension, Json,
};
use chrono::Utc;
use sea_orm::{
    sea_query::OnConflict, ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, Set,
    TransactionTrait,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::HashMap, sync::Arc};
use uuid::Uuid;

fn discord(state: &AppState) -> ApiResult<Arc<Discord>> {
    state.discord.clone().ok_or_else(|| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "A integração com o Discord não está configurada neste servidor.".into(),
        )
    })
}

fn redirect_uri(state: &AppState) -> String {
    format!("{}{CALLBACK_PATH}", state.web_url.trim_end_matches('/'))
}

/// Managing the integration is reserved to the owner of the server.
async fn require_owner(state: &AppState, server: Uuid, user: Uuid) -> ApiResult<server::Model> {
    let server = server::Entity::find_by_id(server)
        .one(&state.db)
        .await?
        .ok_or_else(ApiError::missing)?;
    if server.owner_id != user {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Só o dono do servidor pode gerenciar a integração com o Discord.".into(),
        ));
    }
    Ok(server)
}

fn changed(state: &AppState, user: Uuid, server: Option<Uuid>) {
    state.realtime.publish_users(
        &[user].into(),
        json!({ "type": "discord.updated", "serverId": server }),
    );
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountView {
    id: String,
    username: String,
    display_name: Option<String>,
    avatar: Option<String>,
    share_activity: bool,
    /// The user's profile photo is the Discord one.
    use_avatar: bool,
    /// The user has not yet said what the integration may use.
    consent_pending: bool,
    /// Signed in with the `guilds` scope: Discord servers can be imported.
    can_list_guilds: bool,
    /// The bot has seen this account in a Discord server it is in, so its
    /// activity can be synchronized.
    presence_seen: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StatusView {
    enabled: bool,
    /// The bot is receiving Discord presences right now.
    presence: bool,
    account: Option<AccountView>,
    /// Discord application the desktop app shows its Rich Presence with.
    client_id: Option<String>,
}

/// Translates an error of a call made with the user's own token.
fn user_error(error: DiscordError) -> ApiError {
    match error {
        DiscordError::Api { status: 401, .. } => ApiError(
            StatusCode::CONFLICT,
            "Reconecte sua conta do Discord para listar seus servidores.".into(),
        ),
        error => ApiError::bad(&error.describe()),
    }
}

pub(crate) async fn status(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
) -> ApiResult<Json<StatusView>> {
    let Some(discord) = state.discord.clone() else {
        return Ok(Json(StatusView {
            enabled: false,
            presence: false,
            account: None,
            client_id: None,
        }));
    };
    let account = discord_account::Entity::find_by_id(user.id)
        .one(&state.db)
        .await?
        .map(|a| AccountView {
            presence_seen: discord.presence_seen(&a.discord_id),
            use_avatar: user.avatar_source.as_deref() == Some("discord"),
            consent_pending: a.consent_at.is_none(),
            can_list_guilds: a.refresh_token.is_some() || a.access_token.is_some(),
            id: a.discord_id,
            username: a.username,
            display_name: a.display_name,
            avatar: a.avatar_url,
            share_activity: a.share_activity,
        });
    let presence = *discord.live_presence.lock().unwrap();
    Ok(Json(StatusView {
        enabled: true,
        presence,
        account,
        client_id: Some(discord.client_id().to_owned()),
    }))
}

#[derive(Serialize)]
pub(crate) struct UrlView {
    url: String,
}

/// Starts linking the user's Discord account. The app opens the URL in the
/// browser; Discord then redirects to [`callback`].
pub(crate) async fn link_account(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
) -> ApiResult<Json<UrlView>> {
    let discord = discord(&state)?;
    let flow = discord.start_flow(Flow::Account { user: user.id });
    Ok(Json(UrlView {
        url: discord.authorize_url(
            &redirect_uri(&state),
            &flow,
            "identify guilds",
            &[("prompt", "consent".into())],
        ),
    }))
}

/// Every field is optional: only the ones sent change.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountInput {
    share_activity: Option<bool>,
    use_avatar: Option<bool>,
}

pub(crate) async fn update_account(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Json(input): Json<AccountInput>,
) -> ApiResult<StatusCode> {
    let discord = discord(&state)?;
    apply_choices(
        &state,
        &discord,
        user.id,
        input.share_activity,
        input.use_avatar,
        false,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConsentInput {
    share_activity: bool,
    use_avatar: bool,
}

/// The user's answer, right after signing in with Discord, about what the
/// integration may use.
pub(crate) async fn consent(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Json(input): Json<ConsentInput>,
) -> ApiResult<StatusCode> {
    let discord = discord(&state)?;
    apply_choices(
        &state,
        &discord,
        user.id,
        Some(input.share_activity),
        Some(input.use_avatar),
        true,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Shares the activity (or stops) and makes the Discord photo the profile
/// photo (or stops).
async fn apply_choices(
    state: &AppState,
    discord: &Discord,
    user: Uuid,
    share: Option<bool>,
    use_avatar: Option<bool>,
    consent: bool,
) -> ApiResult<()> {
    let account = discord_account::Entity::find_by_id(user)
        .one(&state.db)
        .await?
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                "Nenhuma conta do Discord vinculada.".into(),
            )
        })?;
    let discord_id = account.discord_id.clone();
    let photo = account.avatar_url.clone();
    if share.is_some() || consent {
        let mut active: discord_account::ActiveModel = account.into();
        if let Some(share) = share {
            active.share_activity = Set(share);
        }
        if consent {
            active.consent_at = Set(Some(Utc::now()));
        }
        active.update(&state.db).await?;
    }
    if let Some(share) = share {
        discord.refresh_links(&state.db).await?;
        super::reshare(state, discord, &discord_id, user, share).await?;
    }
    if let Some(use_avatar) = use_avatar {
        let row = user::Entity::find_by_id(user)
            .one(&state.db)
            .await?
            .ok_or_else(ApiError::unauthorized)?;
        let follows = row.avatar_source.as_deref() == Some("discord");
        let next = match (use_avatar, follows) {
            (true, _) => Some((photo, Some("discord".to_owned()))),
            // Back to initials; the next Google sign-in brings its photo.
            (false, true) => Some((None, None)),
            (false, false) => None,
        };
        if let Some((url, source)) =
            next.filter(|(url, source)| *url != row.avatar_url || *source != row.avatar_source)
        {
            let mut active: user::ActiveModel = row.into();
            active.avatar_url = Set(url);
            active.avatar_source = Set(source);
            // Replaces a GIF avatar, if there was one.
            active.avatar_still = Set(None);
            let view = UserView::from(active.update(&state.db).await?);
            crate::profile::broadcast(state, &view).await?;
        }
    }
    changed(state, user, None);
    Ok(())
}

pub(crate) async fn unlink_account(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
) -> ApiResult<StatusCode> {
    let discord = discord(&state)?;
    if let Some(account) = discord_account::Entity::find_by_id(user.id)
        .one(&state.db)
        .await?
    {
        discord_account::Entity::delete_by_id(user.id)
            .exec(&state.db)
            .await?;
        discord.refresh_links(&state.db).await?;
        super::reshare(&state, &discord, &account.discord_id, user.id, false).await?;
    }
    changed(&state, user.id, None);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChannelView {
    id: String,
    name: String,
    category: Option<String>,
    /// The bot can view the channel and read its history.
    readable: bool,
    import: Option<ImportView>,
    /// Not imported yet, and an empty channel of this server has its name:
    /// the history would go there instead of a new channel.
    target: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GuildView {
    id: String,
    name: String,
    icon: Option<String>,
    /// The bot could read the guild; otherwise `error` says why.
    available: bool,
    error: Option<String>,
    channels: Vec<ChannelView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerView {
    /// Message Content intent enabled for the app (null when unknown).
    /// Without it, imported messages arrive without text.
    message_content: Option<bool>,
    guilds: Vec<GuildView>,
    /// Every import of the server, including channels the bot lost access to.
    imports: Vec<ImportView>,
}

/// The Discord servers connected to a Disc Voice server, their text
/// channels and how each import is going.
pub(crate) async fn server(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<ServerView>> {
    let discord = discord(&state)?;
    require_owner(&state, id, user.id).await?;
    let guilds = discord_guild::Entity::find()
        .filter(discord_guild::Column::ServerId.eq(id))
        .all(&state.db)
        .await?;
    let imports = discord_import::Entity::find()
        .filter(discord_import::Column::ServerId.eq(id))
        .all(&state.db)
        .await?;
    let by_channel: HashMap<_, _> = imports
        .iter()
        .map(|i| (i.discord_channel_id.as_str(), ImportView::from(i)))
        .collect();
    let empty = empty_channels(&state.db, id).await?;
    let target = |name: &str, imported: bool| {
        let base = mirror_base(name);
        (!imported && empty.contains_key(&base)).then_some(base)
    };
    let mut views = Vec::new();
    for guild in guilds {
        let (channels, error) = match discord.guild_channels(&guild.guild_id).await {
            Ok(channels) => (channels, None),
            Err(error) => (Vec::new(), Some(error.describe())),
        };
        views.push(GuildView {
            available: error.is_none(),
            error,
            channels: channels
                .into_iter()
                .map(|c| ChannelView {
                    target: target(&c.name, by_channel.contains_key(c.id.as_str())),
                    import: by_channel.get(c.id.as_str()).cloned(),
                    id: c.id,
                    name: c.name,
                    category: c.category,
                    readable: c.readable,
                })
                .collect(),
            id: guild.guild_id,
            name: guild.name,
            icon: guild.icon_url,
        });
    }
    Ok(Json(ServerView {
        message_content: discord.intents().await.map(|i| i.message_content),
        guilds: views,
        imports: imports.iter().map(ImportView::from).collect(),
    }))
}

/// Starts installing the bot in a Discord server (chosen on Discord's page).
pub(crate) async fn install(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<UrlView>> {
    let discord = discord(&state)?;
    require_owner(&state, id, user.id).await?;
    let flow = discord.start_flow(Flow::Install {
        user: user.id,
        server: id,
        guild: None,
    });
    Ok(Json(UrlView {
        url: discord.authorize_url(
            &redirect_uri(&state),
            &flow,
            "bot identify",
            &[
                ("permissions", BOT_PERMISSIONS.to_string()),
                ("integration_type", "0".into()),
            ],
        ),
    }))
}

/// Disconnects a Discord server. Unfinished imports stop (their channels
/// open with what was imported); finished channels are not affected.
pub(crate) async fn unlink_guild(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path((id, guild)): Path<(Uuid, String)>,
) -> ApiResult<StatusCode> {
    discord(&state)?;
    require_owner(&state, id, user.id).await?;
    discord_guild::Entity::delete_by_id((id, guild))
        .exec(&state.db)
        .await?;
    changed(&state, user.id, Some(id));
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportInput {
    guild_id: String,
    channel_id: String,
}

/// The Disc Voice form of a Discord channel name ("Geral 💬" → "geral").
fn mirror_base(name: &str) -> String {
    let mut base = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_alphanumeric() || c == '_' {
            base.push(c);
        } else if !base.ends_with('-') {
            base.push('-');
        }
    }
    let base: String = base.trim_matches('-').chars().take(50).collect();
    if base.is_empty() {
        "discord".to_owned()
    } else {
        base
    }
}

/// A free name for the mirror channel, based on the Discord one.
fn mirror_name(name: &str, taken: &[String]) -> ApiResult<String> {
    let base = mirror_base(name);
    let candidates = std::iter::once(base.clone())
        .chain(std::iter::once(format!("{base}-discord")))
        .chain((2..100).map(|n| format!("{base}-discord-{n}")));
    for candidate in candidates {
        if !taken.contains(&candidate) {
            return channel_name(&candidate);
        }
    }
    Err(ApiError::bad(
        "Não há um nome livre para o canal importado.",
    ))
}

/// Text channels of a server that can take a Discord history, by name: no
/// messages yet (the history would land after them) and no import of their own.
/// Typically the channels created when the server was imported from Discord.
async fn empty_channels<C: sea_orm::ConnectionTrait>(
    db: &C,
    server: Uuid,
) -> ApiResult<HashMap<String, channel::Model>> {
    let channels = channel::Entity::find()
        .from_raw_sql(sea_orm::Statement::from_sql_and_values(
            sea_orm::DbBackend::Postgres,
            r#"SELECT c.* FROM channels c
               WHERE c.server_id = $1 AND c.type = 'text'
                 AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.channel_id = c.id)
                 AND NOT EXISTS (SELECT 1 FROM discord_imports i WHERE i.channel_id = c.id)"#,
            [server.into()],
        ))
        .all(db)
        .await?;
    Ok(channels.into_iter().map(|c| (c.name.clone(), c)).collect())
}

/// Starts importing a Discord text channel: into the empty channel of the
/// same name when there is one (e.g. #geral), else into a new channel. It
/// stays read-only until the history is in.
pub(crate) async fn create_import(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
    Json(input): Json<ImportInput>,
) -> ApiResult<(StatusCode, Json<ImportView>)> {
    let discord = discord(&state)?;
    require_owner(&state, id, user.id).await?;
    let (Some(guild), Some(source)) = (
        super::snowflake(&input.guild_id),
        super::snowflake(&input.channel_id),
    ) else {
        return Err(ApiError::bad("Canal do Discord inválido."));
    };
    discord_guild::Entity::find_by_id((id, guild.to_owned()))
        .one(&state.db)
        .await?
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                "Este servidor do Discord não está conectado.".into(),
            )
        })?;
    let duplicate = discord_import::Entity::find()
        .filter(discord_import::Column::ServerId.eq(id))
        .filter(discord_import::Column::DiscordChannelId.eq(source))
        .one(&state.db)
        .await?;
    if duplicate.is_some() {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Este canal do Discord já foi importado.".into(),
        ));
    }
    let info: super::ChannelInfo = discord
        .bot_get(&format!("/channels/{source}"))
        .await
        .map_err(|error| ApiError(StatusCode::BAD_REQUEST, error.describe()))?;
    if info.guild_id.as_deref() != Some(guild) || !super::is_text(info.kind) {
        return Err(ApiError::bad(
            "Escolha um canal de texto deste servidor do Discord.",
        ));
    }
    let discord_name: String = info.name.unwrap_or_default().chars().take(100).collect();
    // Names are unique per type: a voice channel may share it.
    let taken: Vec<String> = channel::Entity::find()
        .filter(channel::Column::ServerId.eq(id))
        .filter(channel::Column::Kind.eq("text"))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|c| c.name)
        .collect();
    let tx = state.db.begin().await?;
    // Checked inside the transaction, so a message sent meanwhile is seen.
    let matched = empty_channels(&tx, id)
        .await?
        .remove(&mirror_base(&discord_name));
    let created = matched.is_none();
    let channel = match matched {
        // Its history now comes from Discord (and it is locked meanwhile).
        Some(channel) => {
            let mut active: channel::ActiveModel = channel.into();
            active.source = Set("discord".into());
            active.update(&tx).await?
        }
        None => {
            channel::ActiveModel {
                id: Set(Uuid::new_v4()),
                server_id: Set(Some(id)),
                name: Set(mirror_name(&discord_name, &taken)?),
                kind: Set("text".into()),
                created_by: Set(user.id),
                created_at: Set(Utc::now()),
                source: Set("discord".into()),
            }
            .insert(&tx)
            .await?
        }
    };
    let import = discord_import::ActiveModel {
        channel_id: Set(channel.id),
        server_id: Set(id),
        guild_id: Set(guild.into()),
        discord_channel_id: Set(source.into()),
        discord_channel_name: Set(discord_name),
        phase: Set("history".into()),
        status: Set("queued".into()),
        cursor: Set(None),
        imported: Set(0),
        error: Set(None),
        retry_at: Set(None),
        created_by: Set(user.id),
        created_at: Set(Utc::now()),
        synced_at: Set(None),
    }
    .insert(&tx)
    .await?;
    tx.commit().await?;
    // An existing channel turns read-only through the import event below.
    if created {
        state.realtime.publish_server(
            id,
            json!({ "type": "channel.created", "channel": crate::ChannelView { read_only: true, ..channel.into() } }),
        );
    }
    super::sync::publish(&state, &import);
    discord.wake();
    Ok((StatusCode::CREATED, Json(ImportView::from(&import))))
}

/// A failed import of the user's server, which they can retry or finish.
async fn failed_import(
    state: &AppState,
    user: Uuid,
    channel: Uuid,
) -> ApiResult<discord_import::Model> {
    let import = discord_import::Entity::find_by_id(channel)
        .one(&state.db)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Importação não encontrada.".into()))?;
    require_owner(state, import.server_id, user).await?;
    if import.phase != "history" || import.status != "error" {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Esta importação não está com erro.".into(),
        ));
    }
    Ok(import)
}

/// Retries a failed import from where it stopped.
pub(crate) async fn retry_import(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(channel): Path<Uuid>,
) -> ApiResult<Json<ImportView>> {
    let discord = discord(&state)?;
    let mut active: discord_import::ActiveModel =
        failed_import(&state, user.id, channel).await?.into();
    active.status = Set("queued".into());
    active.retry_at = Set(None);
    let import = active.update(&state.db).await?;
    super::sync::publish(&state, &import);
    discord.wake();
    Ok(Json(ImportView::from(&import)))
}

/// Gives up on the rest of a failed import: the channel keeps what was
/// imported and opens for new messages.
pub(crate) async fn finish_import(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(channel): Path<Uuid>,
) -> ApiResult<Json<ImportView>> {
    discord(&state)?;
    let mut active: discord_import::ActiveModel =
        failed_import(&state, user.id, channel).await?.into();
    active.phase = Set("done".into());
    active.status = Set("idle".into());
    active.retry_at = Set(None);
    let import = active.update(&state.db).await?;
    super::sync::publish(&state, &import);
    Ok(Json(ImportView::from(&import)))
}

#[derive(Deserialize)]
pub(crate) struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

fn page(title: &str, text: &str) -> Html<String> {
    let escape = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    };
    Html(format!(
        r#"<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Disc Voice</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box;text-align:center">
<main style="max-width:420px"><h1 style="font-size:22px">{}</h1><p>{}</p></main></body></html>"#,
        escape(title),
        escape(text)
    ))
}

/// Discord redirects here after the user authorizes (or cancels). The page
/// tells them to go back to the app, which hears about it in real time.
pub(crate) async fn callback(
    State(state): State<AppState>,
    Query(query): Query<CallbackQuery>,
) -> Response {
    let Some(discord) = state.discord.clone() else {
        return page(
            "Integração indisponível",
            "A integração com o Discord não está configurada.",
        )
        .into_response();
    };
    let flow = query.state.as_deref().and_then(|s| discord.take_flow(s));
    let Some(flow) = flow else {
        return page(
            "Link expirado",
            "Este pedido de autorização expirou. Volte ao Disc Voice e tente de novo.",
        )
        .into_response();
    };
    let code = query.code.filter(|c| !c.is_empty() && c.len() <= 512);
    // A sign-in goes back to the app, which shows how it went.
    if let Flow::Login { target } = flow {
        let result = match (query.error.is_some(), code) {
            (true, _) => Err("O login foi cancelado no Discord.".to_owned()),
            (false, None) => Err("O Discord não enviou a autorização. Tente de novo.".to_owned()),
            (false, Some(code)) => login(&state, &discord, &code).await.map_err(|e| e.1),
        };
        let location = match &result {
            Ok(ticket) => target.redirect(&state.web_url, Ok(ticket)),
            Err(error) => target.redirect(&state.web_url, Err(error)),
        };
        return Redirect::to(&location).into_response();
    }
    if query.error.is_some() {
        return page(
            "Autorização cancelada",
            "Nada foi alterado. Você pode fechar esta aba.",
        )
        .into_response();
    }
    let Some(code) = code else {
        return page(
            "Resposta inválida",
            "O Discord não enviou a autorização. Tente de novo.",
        )
        .into_response();
    };
    let result = match flow {
        Flow::Login { .. } => unreachable!("handled above"),
        Flow::Account { user } => link(&state, &discord, user, &code).await,
        Flow::Install {
            user,
            server,
            guild,
        } => connect_guild(&state, &discord, user, server, guild.as_deref(), &code).await,
    };
    match result {
        Ok(text) => page(
            "Tudo certo!",
            &format!("{text} Você já pode fechar esta aba e voltar ao Disc Voice."),
        )
        .into_response(),
        Err(error) => page("Não deu certo", &error.1).into_response(),
    }
}

#[derive(Serialize)]
pub(crate) struct LoginConfig {
    enabled: bool,
}

/// Whether the app can offer "Continue with Discord".
pub(crate) async fn login_config(State(state): State<AppState>) -> Json<LoginConfig> {
    Json(LoginConfig {
        enabled: state.discord.is_some(),
    })
}

#[derive(Deserialize)]
pub(crate) struct LoginStart {
    platform: Platform,
    port: Option<u16>,
    state: Option<String>,
}

/// Starts signing in with Discord. The app opens the URL in the browser;
/// Discord redirects to [`callback`], which sends the browser back to the app
/// (its local server on the desktop) with a ticket for [`login_finish`].
pub(crate) async fn login_start(
    State(state): State<AppState>,
    Json(input): Json<LoginStart>,
) -> ApiResult<Json<UrlView>> {
    let discord = discord(&state)?;
    let target = match input.platform {
        Platform::Desktop => input
            .port
            .zip(input.state.as_deref())
            .and_then(|(port, s)| LoginTarget::desktop(port, s)),
        Platform::Web => input.state.as_deref().and_then(LoginTarget::web),
    }
    .ok_or_else(|| ApiError::bad("Requisição de login inválida."))?;
    let flow = discord.start_flow(Flow::Login { target });
    Ok(Json(UrlView {
        url: discord.authorize_url(
            &redirect_uri(&state),
            &flow,
            "identify email guilds",
            &[("prompt", "none".into())],
        ),
    }))
}

#[derive(Deserialize)]
pub(crate) struct LoginFinish {
    ticket: String,
}

/// Exchanges the ticket of a finished Discord sign-in for a session.
pub(crate) async fn login_finish(
    State(state): State<AppState>,
    Json(input): Json<LoginFinish>,
) -> ApiResult<Json<AuthView>> {
    let discord = discord(&state)?;
    let id = discord.take_ticket(&input.ticket).ok_or_else(|| {
        ApiError(
            StatusCode::UNAUTHORIZED,
            "Este login expirou. Tente de novo.".into(),
        )
    })?;
    let user = user::Entity::find_by_id(id)
        .one(&state.db)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    let pending = discord_account::Entity::find_by_id(id)
        .one(&state.db)
        .await?
        .is_some_and(|a| a.consent_at.is_none());
    let Json(mut auth) = new_session(&state.db, user.into()).await?;
    auth.discord_consent = pending;
    Ok(Json(auth))
}

/// Display name for a new account: the Discord display name or username.
fn discord_name(profile: &super::DiscordUser) -> String {
    [
        profile.global_name.as_deref().unwrap_or_default(),
        profile.username.as_str(),
    ]
    .into_iter()
    .map(|name| name.chars().take(32).collect::<String>())
    .find_map(|name| user_name(&name).ok())
    .unwrap_or_else(|| "Usuário".into())
}

/// Finds (or creates) the Disc Voice account of a Discord user and returns
/// a sign-in ticket for it.
async fn login(state: &AppState, discord: &Discord, code: &str) -> ApiResult<String> {
    let token = discord
        .exchange(code, &redirect_uri(state))
        .await
        .map_err(|e| ApiError::bad(&e.describe()))?;
    let profile = discord
        .user(&token.access_token)
        .await
        .map_err(|e| ApiError::bad(&e.describe()))?;
    let id = super::snowflake(&profile.id)
        .ok_or_else(|| ApiError::bad("Resposta inválida do Discord."))?
        .to_owned();
    let email = profile
        .email
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty() && e.len() <= 254 && profile.verified == Some(true))
        .ok_or_else(|| {
            ApiError::bad("Confirme seu e-mail no Discord para entrar com ele no Disc Voice.")
        })?
        .to_owned();
    let photo = super::avatar_url(&id, profile.avatar.as_deref());
    let account = discord_account::Entity::find()
        .filter(discord_account::Column::DiscordId.eq(&id))
        .one(&state.db)
        .await?;
    let user = match &account {
        Some(account) => user::Entity::find_by_id(account.user_id)
            .one(&state.db)
            .await?
            .ok_or_else(ApiError::unauthorized)?,
        None => match user::Entity::find()
            .filter(user::Column::Email.eq(&email))
            .one(&state.db)
            .await?
        {
            // An account with the same verified e-mail (e.g. from Google).
            Some(user) => {
                if discord_account::Entity::find_by_id(user.id)
                    .one(&state.db)
                    .await?
                    .is_some()
                {
                    return Err(ApiError(
                        StatusCode::CONFLICT,
                        "Este e-mail já está ligado a outra conta do Discord.".into(),
                    ));
                }
                user
            }
            // The photo waits for the user's answer about the integration.
            None => {
                user::ActiveModel {
                    id: Set(Uuid::new_v4()),
                    email: Set(email),
                    name: Set(discord_name(&profile)),
                    pronouns: Set(String::new()),
                    bio: Set(String::new()),
                    banner: Set(crate::profile::DEFAULT_BANNER.into()),
                    password_hash: Set(None),
                    google_sub: Set(None),
                    avatar_url: Set(None),
                    avatar_source: Set(None),
                    created_at: Set(Utc::now()),
                    ..Default::default()
                }
                .insert(&state.db)
                .await?
            }
        },
    };
    let display = profile
        .global_name
        .as_deref()
        .map(|n| n.chars().take(64).collect::<String>());
    // Activity is only shared once the user says so.
    discord_account::Entity::insert(discord_account::ActiveModel {
        user_id: Set(user.id),
        discord_id: Set(id),
        username: Set(profile.username.chars().take(64).collect()),
        display_name: Set(display),
        avatar_url: Set(photo.clone()),
        share_activity: Set(false),
        linked_at: Set(Utc::now()),
        access_token: Set(Some(token.access_token.clone())),
        refresh_token: Set(token.refresh_token.clone()),
        token_expires_at: Set(Some(token.expires_at())),
        consent_at: Set(None),
    })
    .on_conflict(
        OnConflict::column(discord_account::Column::UserId)
            .update_columns([
                discord_account::Column::Username,
                discord_account::Column::DisplayName,
                discord_account::Column::AvatarUrl,
                discord_account::Column::AccessToken,
                discord_account::Column::RefreshToken,
                discord_account::Column::TokenExpiresAt,
            ])
            .to_owned(),
    )
    .exec_without_returning(&state.db)
    .await?;
    // A photo that follows Discord is refreshed on every sign-in.
    if user.avatar_source.as_deref() == Some("discord") && user.avatar_url != photo {
        let mut active: user::ActiveModel = user.clone().into();
        active.avatar_url = Set(photo);
        let view = UserView::from(active.update(&state.db).await?);
        crate::profile::broadcast(state, &view).await?;
    }
    discord.refresh_links(&state.db).await?;
    Ok(discord.issue_ticket(user.id))
}

async fn link(state: &AppState, discord: &Discord, user: Uuid, code: &str) -> ApiResult<String> {
    let token = discord
        .exchange(code, &redirect_uri(state))
        .await
        .map_err(|e| ApiError::bad(&e.describe()))?;
    let profile = discord
        .user(&token.access_token)
        .await
        .map_err(|e| ApiError::bad(&e.describe()))?;
    let id = super::snowflake(&profile.id)
        .ok_or_else(|| ApiError::bad("Resposta inválida do Discord."))?;
    let owner = discord_account::Entity::find()
        .filter(discord_account::Column::DiscordId.eq(id))
        .one(&state.db)
        .await?;
    if owner.is_some_and(|a| a.user_id != user) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Esta conta do Discord já está vinculada a outro usuário do Disc Voice.".into(),
        ));
    }
    let display = profile
        .global_name
        .as_deref()
        .map(|n| n.chars().take(64).collect::<String>());
    discord_account::Entity::insert(discord_account::ActiveModel {
        user_id: Set(user),
        discord_id: Set(id.into()),
        username: Set(profile.username.chars().take(64).collect()),
        display_name: Set(display),
        avatar_url: Set(super::avatar_url(id, profile.avatar.as_deref())),
        share_activity: Set(true),
        linked_at: Set(Utc::now()),
        access_token: Set(Some(token.access_token.clone())),
        refresh_token: Set(token.refresh_token.clone()),
        token_expires_at: Set(Some(token.expires_at())),
        // Linking from the settings is the answer: the switches are there.
        consent_at: Set(Some(Utc::now())),
    })
    .on_conflict(
        OnConflict::column(discord_account::Column::UserId)
            .update_columns([
                discord_account::Column::DiscordId,
                discord_account::Column::Username,
                discord_account::Column::DisplayName,
                discord_account::Column::AvatarUrl,
                discord_account::Column::LinkedAt,
                discord_account::Column::AccessToken,
                discord_account::Column::RefreshToken,
                discord_account::Column::TokenExpiresAt,
                discord_account::Column::ConsentAt,
            ])
            .to_owned(),
    )
    .exec_without_returning(&state.db)
    .await?;
    discord.refresh_links(&state.db).await?;
    let share = discord_account::Entity::find_by_id(user)
        .one(&state.db)
        .await?
        .is_some_and(|a| a.share_activity);
    super::reshare(state, discord, id, user, share).await?;
    changed(state, user, None);
    Ok(format!("A conta @{} foi vinculada.", profile.username))
}

async fn connect_guild(
    state: &AppState,
    discord: &Discord,
    user: Uuid,
    server: Uuid,
    expected: Option<&str>,
    code: &str,
) -> ApiResult<String> {
    // Ownership may have changed while the user was on Discord's page.
    require_owner(state, server, user).await?;
    let token = discord
        .exchange(code, &redirect_uri(state))
        .await
        .map_err(|e| ApiError::bad(&e.describe()))?;
    // The guild comes from Discord's token response: the user really
    // installed the bot there (which requires Manage Server).
    let guild = token.guild.ok_or_else(|| {
        ApiError::bad("O Discord não informou o servidor escolhido. Tente de novo.")
    })?;
    let guild_id = super::snowflake(&guild.id)
        .ok_or_else(|| ApiError::bad("Resposta inválida do Discord."))?;
    if expected.is_some_and(|e| e != guild_id) {
        return Err(ApiError::bad(
            "O bot foi adicionado a outro servidor do Discord. Tente importar de novo.",
        ));
    }
    let name: String = guild.name.chars().take(100).collect();
    let icon = super::icon_url(guild_id, guild.icon.as_deref());
    link_guild(state, user, server, guild_id, &name, icon).await?;
    if expected.is_some() {
        let count = build_structure(state, discord, user, server, guild_id).await?;
        return Ok(format!(
            "O servidor “{name}” foi importado com {count} {}.",
            if count == 1 { "canal" } else { "canais" }
        ));
    }
    Ok(format!("O servidor “{name}” do Discord foi conectado. Escolha os canais para importar no Disc Voice."))
}

/// Connects a Discord server (where the bot is) to a Disc Voice server.
async fn link_guild(
    state: &AppState,
    user: Uuid,
    server: Uuid,
    guild_id: &str,
    name: &str,
    icon: Option<String>,
) -> ApiResult<()> {
    discord_guild::Entity::insert(discord_guild::ActiveModel {
        server_id: Set(server),
        guild_id: Set(guild_id.into()),
        name: Set(name.into()),
        icon_url: Set(icon),
        linked_by: Set(user),
        linked_at: Set(Utc::now()),
    })
    .on_conflict(
        OnConflict::columns([
            discord_guild::Column::ServerId,
            discord_guild::Column::GuildId,
        ])
        .update_columns([discord_guild::Column::Name, discord_guild::Column::IconUrl])
        .to_owned(),
    )
    .exec_without_returning(&state.db)
    .await?;
    changed(state, user, Some(server));
    Ok(())
}

/// Most channels a Discord server can have.
const MAX_CHANNELS: usize = 500;

/// Creates the text and voice channels of a Discord server in a Disc Voice
/// server, in Discord's order. They start empty and belong to Disc Voice;
/// history can still be imported per channel.
async fn build_structure(
    state: &AppState,
    discord: &Discord,
    user: Uuid,
    server: Uuid,
    guild: &str,
) -> ApiResult<usize> {
    let list = discord
        .guild_structure(guild)
        .await
        .map_err(|e| ApiError::bad(&e.describe()))?;
    let mut taken: HashMap<String, Vec<String>> = HashMap::new();
    for c in channel::Entity::find()
        .filter(channel::Column::ServerId.eq(server))
        .all(&state.db)
        .await?
    {
        taken.entry(c.kind).or_default().push(c.name);
    }
    // Channels are listed by creation time: one millisecond apart keeps the order.
    let base = Utc::now();
    let tx = state.db.begin().await?;
    let mut created = Vec::new();
    for (i, (kind, name)) in list.into_iter().take(MAX_CHANNELS).enumerate() {
        let names = taken.entry(kind.to_owned()).or_default();
        let Ok(name) = mirror_name(&name, names) else {
            continue;
        };
        names.push(name.clone());
        let channel = channel::ActiveModel {
            id: Set(Uuid::new_v4()),
            server_id: Set(Some(server)),
            name: Set(name),
            kind: Set(kind.into()),
            created_by: Set(user),
            created_at: Set(base + chrono::Duration::milliseconds(i as i64)),
            source: Set("local".into()),
        }
        .insert(&tx)
        .await?;
        created.push(channel);
    }
    tx.commit().await?;
    let count = created.len();
    for channel in created {
        state.realtime.publish_server(
            server,
            json!({ "type": "channel.created", "channel": crate::ChannelView::from(channel) }),
        );
    }
    changed(state, user, Some(server));
    Ok(count)
}

/// Discord servers already imported by the user, with their Disc Voice server.
async fn imported_guilds(state: &AppState, user: Uuid) -> ApiResult<HashMap<String, Uuid>> {
    let owned: Vec<Uuid> = server::Entity::find()
        .filter(server::Column::OwnerId.eq(user))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|s| s.id)
        .collect();
    Ok(discord_guild::Entity::find()
        .filter(discord_guild::Column::ServerId.is_in(owned))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|g| (g.guild_id, g.server_id))
        .collect())
}

/// The Discord servers the user manages, which they may import.
async fn managed(discord: &Discord, token: &str) -> ApiResult<Vec<UserGuild>> {
    Ok(discord
        .user_guilds(token)
        .await
        .map_err(user_error)?
        .into_iter()
        .filter(|g| g.managed() && super::snowflake(&g.id).is_some())
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuildOption {
    id: String,
    name: String,
    icon: Option<String>,
    /// The bot is already there: importing needs no extra authorization.
    bot_installed: bool,
    /// Already imported into this Disc Voice server.
    imported_server_id: Option<Uuid>,
}

pub(crate) async fn managed_guilds(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
) -> ApiResult<Json<Vec<GuildOption>>> {
    let discord = discord(&state)?;
    let token = discord.user_token(&state.db, user.id).await?;
    let guilds = managed(&discord, &token).await?;
    let bot = discord.bot_guild_ids().await.unwrap_or_else(|error| {
        tracing::warn!(?error, "Não foi possível listar os servidores do bot");
        Default::default()
    });
    let imported = imported_guilds(&state, user.id).await?;
    Ok(Json(
        guilds
            .into_iter()
            .map(|g| GuildOption {
                icon: super::icon_url(&g.id, g.icon.as_deref()),
                bot_installed: bot.contains(&g.id),
                imported_server_id: imported.get(&g.id).copied(),
                name: g.name.chars().take(100).collect(),
                id: g.id,
            })
            .collect(),
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuildImportView {
    server: InviteView,
    /// The bot must be added to the Discord server first: open this URL.
    /// The channels are created once Discord redirects back.
    install_url: Option<String>,
    channels: usize,
    /// The server was created but its channels could not be read.
    warning: Option<String>,
}

/// Creates a Disc Voice server from a Discord server the user manages: its
/// name and icon right away, its text and voice channels once the bot is in.
pub(crate) async fn import_guild(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(guild): Path<String>,
) -> ApiResult<(StatusCode, Json<GuildImportView>)> {
    let discord = discord(&state)?;
    let guild = super::snowflake(&guild)
        .ok_or_else(|| ApiError::bad("Servidor do Discord inválido."))?
        .to_owned();
    let token = discord.user_token(&state.db, user.id).await?;
    let info = managed(&discord, &token)
        .await?
        .into_iter()
        .find(|g| g.id == guild)
        .ok_or_else(|| {
            ApiError(
                StatusCode::FORBIDDEN,
                "Você precisa gerenciar este servidor no Discord para importá-lo.".into(),
            )
        })?;
    if imported_guilds(&state, user.id).await?.contains_key(&guild) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Você já importou este servidor do Discord.".into(),
        ));
    }
    let name = server_name(&info.name.chars().take(100).collect::<String>())
        .unwrap_or_else(|_| "Servidor do Discord".into());
    let icon = super::icon_url(&guild, info.icon.as_deref());
    let view = insert_server(&state, user.id, name.clone(), icon.clone()).await?;
    let server = view.server.id;
    let bot_in = discord
        .bot_guild_ids()
        .await
        .is_ok_and(|ids| ids.contains(&guild));
    if bot_in {
        link_guild(&state, user.id, server, &guild, &name, icon).await?;
        let (channels, warning) =
            match build_structure(&state, &discord, user.id, server, &guild).await {
                Ok(count) => (count, None),
                Err(error) => (0, Some(error.1)),
            };
        return Ok((
            StatusCode::CREATED,
            Json(GuildImportView {
                server: view,
                install_url: None,
                channels,
                warning,
            }),
        ));
    }
    let flow = discord.start_flow(Flow::Install {
        user: user.id,
        server,
        guild: Some(guild.clone()),
    });
    let install_url = discord.authorize_url(
        &redirect_uri(&state),
        &flow,
        "bot identify",
        &[
            ("permissions", BOT_PERMISSIONS.to_string()),
            ("integration_type", "0".into()),
            ("guild_id", guild),
            ("disable_guild_select", "true".into()),
        ],
    );
    Ok((
        StatusCode::CREATED,
        Json(GuildImportView {
            server: view,
            install_url: Some(install_url),
            channels: 0,
            warning: None,
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_mirror_channels() {
        assert_eq!(mirror_name("Geral 💬 Chat", &[]).unwrap(), "geral-chat");
        assert_eq!(
            mirror_name("geral", &["geral".into()]).unwrap(),
            "geral-discord"
        );
        assert_eq!(
            mirror_name("geral", &["geral".into(), "geral-discord".into()]).unwrap(),
            "geral-discord-2"
        );
        assert_eq!(mirror_name("💬", &[]).unwrap(), "discord");
        assert!(mirror_name(&"a".repeat(200), &[]).unwrap().chars().count() <= 64);
    }
}
