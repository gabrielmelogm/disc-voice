use super::{sync::ImportView, Discord, Flow, BOT_PERMISSIONS, CALLBACK_PATH};
use crate::{
    channel_name,
    entities::{channel, discord_account, discord_guild, discord_import, server},
    ApiError, ApiResult, AppState, UserView,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Html,
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
        }));
    };
    let account = discord_account::Entity::find_by_id(user.id)
        .one(&state.db)
        .await?
        .map(|a| AccountView {
            presence_seen: discord.presence_seen(&a.discord_id),
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
            "identify",
            &[("prompt", "consent".into())],
        ),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountInput {
    share_activity: bool,
}

pub(crate) async fn update_account(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Json(input): Json<AccountInput>,
) -> ApiResult<StatusCode> {
    let discord = discord(&state)?;
    let account = discord_account::Entity::find_by_id(user.id)
        .one(&state.db)
        .await?
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                "Nenhuma conta do Discord vinculada.".into(),
            )
        })?;
    let discord_id = account.discord_id.clone();
    let mut active: discord_account::ActiveModel = account.into();
    active.share_activity = Set(input.share_activity);
    active.update(&state.db).await?;
    discord.refresh_links(&state.db).await?;
    super::reshare(&state, &discord, &discord_id, user.id, input.share_activity).await?;
    changed(&state, user.id, None);
    Ok(StatusCode::NO_CONTENT)
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

/// A free name for the mirror channel, based on the Discord one.
fn mirror_name(name: &str, taken: &[String]) -> ApiResult<String> {
    let mut base = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_alphanumeric() || c == '_' {
            base.push(c);
        } else if !base.ends_with('-') {
            base.push('-');
        }
    }
    let base: String = base.trim_matches('-').chars().take(50).collect();
    let base = if base.is_empty() {
        "discord".to_owned()
    } else {
        base
    };
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

/// Starts importing a Discord text channel into a new read-only channel.
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
    let name = mirror_name(&discord_name, &taken)?;
    let tx = state.db.begin().await?;
    let channel = channel::ActiveModel {
        id: Set(Uuid::new_v4()),
        server_id: Set(Some(id)),
        name: Set(name),
        kind: Set("text".into()),
        created_by: Set(user.id),
        created_at: Set(Utc::now()),
        source: Set("discord".into()),
    }
    .insert(&tx)
    .await?;
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
    state.realtime.publish_server(
        id,
        json!({ "type": "channel.created", "channel": crate::ChannelView { read_only: true, ..channel.into() } }),
    );
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
) -> Html<String> {
    let Some(discord) = state.discord.clone() else {
        return page(
            "Integração indisponível",
            "A integração com o Discord não está configurada.",
        );
    };
    let flow = query.state.as_deref().and_then(|s| discord.take_flow(s));
    let Some(flow) = flow else {
        return page(
            "Link expirado",
            "Este pedido de autorização expirou. Volte ao Disc Voice e tente de novo.",
        );
    };
    if query.error.is_some() {
        return page(
            "Autorização cancelada",
            "Nada foi alterado. Você pode fechar esta aba.",
        );
    }
    let Some(code) = query.code.filter(|c| !c.is_empty() && c.len() <= 512) else {
        return page(
            "Resposta inválida",
            "O Discord não enviou a autorização. Tente de novo.",
        );
    };
    let result = match flow {
        Flow::Account { user } => link(&state, &discord, user, &code).await,
        Flow::Install { user, server } => {
            connect_guild(&state, &discord, user, server, &code).await
        }
    };
    match result {
        Ok(text) => page(
            "Tudo certo!",
            &format!("{text} Você já pode fechar esta aba e voltar ao Disc Voice."),
        ),
        Err(error) => page("Não deu certo", &error.1),
    }
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
    })
    .on_conflict(
        OnConflict::column(discord_account::Column::UserId)
            .update_columns([
                discord_account::Column::DiscordId,
                discord_account::Column::Username,
                discord_account::Column::DisplayName,
                discord_account::Column::AvatarUrl,
                discord_account::Column::LinkedAt,
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
    let name: String = guild.name.chars().take(100).collect();
    discord_guild::Entity::insert(discord_guild::ActiveModel {
        server_id: Set(server),
        guild_id: Set(guild_id.into()),
        name: Set(name.clone()),
        icon_url: Set(super::icon_url(guild_id, guild.icon.as_deref())),
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
    Ok(format!("O servidor “{name}” do Discord foi conectado. Escolha os canais para importar no Disc Voice."))
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
