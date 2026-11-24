mod activity;
pub mod discord;
mod dms;
mod entities;
mod files;
mod friends;
pub mod google;
mod members;
mod messages;
pub mod migration;
mod presence;
mod profile;
mod reads;
mod realtime;
mod search;

use axum::{
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use chrono::{Duration, Utc};
use entities::{channel, invite, member, server, session, user};
use sea_orm::{
    sea_query::OnConflict, ActiveModelTrait, ColumnTrait, DatabaseConnection, DbErr, EntityTrait,
    QueryFilter, QueryOrder, Set, SqlErr, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use uuid::Uuid;

#[derive(Clone)]
pub struct AppState {
    pub db: DatabaseConnection,
    pub web_url: String,
    google: Arc<google::GoogleConfig>,
    http: reqwest::Client,
    realtime: Arc<realtime::Hub>,
    /// Present when the Discord integration is configured.
    discord: Option<Arc<discord::Discord>>,
    /// Where stored files live (see [`files`]).
    uploads: std::path::PathBuf,
}

impl AppState {
    pub fn new(db: DatabaseConnection, web_url: String, google: google::GoogleConfig) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("HTTP client");
        Self {
            db,
            web_url,
            google: Arc::new(google),
            http,
            realtime: Arc::new(realtime::Hub::new()),
            discord: None,
            uploads: std::env::temp_dir().join("disc-voice-files"),
        }
    }

    /// Directory for stored files; it must persist across restarts.
    pub fn with_uploads(mut self, dir: impl Into<std::path::PathBuf>) -> Self {
        self.uploads = dir.into();
        self
    }

    /// Enables the Discord integration (bot, imports and activity).
    pub fn with_discord(mut self, config: discord::DiscordConfig) -> Self {
        self.discord = Some(Arc::new(discord::Discord::new(config, self.http.clone())));
        self
    }
}

pub fn router(state: AppState, origins: Vec<HeaderValue>) -> Router {
    let ws_origins = Arc::new(origins.clone());
    let protected = Router::new()
        .route("/me", get(me).patch(profile::update))
        .route("/search", get(search::search))
        .route("/auth/logout", post(logout))
        .route("/servers", get(list_servers).post(create_server))
        .route("/servers/{id}/invite", get(server_invite))
        .route("/servers/{id}/members", get(members::list))
        .route(
            "/servers/{id}/members/{user}",
            axum::routing::patch(members::update),
        )
        .route(
            "/servers/{id}/channels",
            get(list_channels).post(create_channel),
        )
        .route("/invites/{code}", get(preview_invite))
        .route("/invites/{code}/join", post(join_invite))
        .route(
            "/channels/{id}/messages",
            get(messages::list).post(messages::send),
        )
        .route("/channels/{id}/read", post(reads::mark))
        .route("/reads", get(reads::list))
        .route("/dms", get(dms::list).post(dms::open))
        .route("/friends", get(friends::list))
        .route("/friends/requests", post(friends::request))
        .route("/friends/requests/{id}/accept", post(friends::accept))
        .route("/friends/{id}", axum::routing::delete(friends::remove))
        .route("/users/{id}/profile", get(friends::profile))
        .route("/voice/config", get(realtime::ice_config))
        .route("/activities", get(activity::list))
        .route("/discord", get(discord::routes::status))
        .route("/discord/link", post(discord::routes::link_account))
        .route(
            "/discord/account",
            axum::routing::patch(discord::routes::update_account)
                .delete(discord::routes::unlink_account),
        )
        .route("/servers/{id}/discord", get(discord::routes::server))
        .route(
            "/servers/{id}/discord/install",
            post(discord::routes::install),
        )
        .route(
            "/servers/{id}/discord/guilds/{guild}",
            axum::routing::delete(discord::routes::unlink_guild),
        )
        .route(
            "/servers/{id}/discord/imports",
            post(discord::routes::create_import),
        )
        .route(
            "/discord/imports/{channel}/retry",
            post(discord::routes::retry_import),
        )
        .route(
            "/discord/imports/{channel}/finish",
            post(discord::routes::finish_import),
        )
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate));

    Router::new()
        .nest(
            "/api",
            Router::new()
                .route(
                    "/health",
                    get(|| async { Json(serde_json::json!({ "status": "ok" })) }),
                )
                .route("/auth/google/config", get(google_config))
                .route("/auth/google", post(google_login))
                .route("/discord/callback", get(discord::routes::callback))
                .route("/files/{id}/{name}", get(files::serve))
                .route(
                    "/realtime",
                    get(move |state, headers, ws| {
                        realtime::upgrade(state, headers, ws, ws_origins.clone())
                    }),
                )
                .merge(protected)
                .fallback(|| async {
                    ApiError(StatusCode::NOT_FOUND, "Rota não encontrada.".into())
                }),
        )
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(
            CorsLayer::new()
                .allow_origin(origins)
                .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
                .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[derive(Debug)]
struct ApiError(StatusCode, String);
type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    fn bad(message: &str) -> Self {
        Self(StatusCode::BAD_REQUEST, message.into())
    }
    fn unauthorized() -> Self {
        Self(
            StatusCode::UNAUTHORIZED,
            "Entre na sua conta para continuar.".into(),
        )
    }
    fn missing() -> Self {
        Self(
            StatusCode::NOT_FOUND,
            "Servidor ou convite não encontrado.".into(),
        )
    }
    fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(%error, "Falha interna");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Não foi possível concluir a operação.".into(),
        )
    }
}

impl From<DbErr> for ApiError {
    fn from(error: DbErr) -> Self {
        if matches!(error.sql_err(), Some(SqlErr::UniqueConstraintViolation(_))) {
            Self(
                StatusCode::CONFLICT,
                "Este e-mail ou nome de canal já está em uso.".into(),
            )
        } else {
            Self::internal(error)
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}

#[derive(Clone, Serialize)]
pub struct UserView {
    pub id: Uuid,
    pub email: String,
    pub name: String,
    pub pronouns: String,
    pub bio: String,
    pub banner: String,
    /// Profile photo URL (from Google), or null to show initials.
    pub avatar: Option<String>,
    /// Discord username of an author known only from imported messages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discord: Option<String>,
}

impl From<user::Model> for UserView {
    fn from(user: user::Model) -> Self {
        Self {
            id: user.id,
            email: user.email,
            name: user.name,
            pronouns: user.pronouns,
            bio: user.bio,
            banner: user.banner,
            avatar: user.avatar_url,
            discord: None,
        }
    }
}

fn user_name(name: &str) -> ApiResult<String> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() || name.chars().count() > 32 || name.chars().any(char::is_control) {
        return Err(ApiError::bad("O nome deve ter entre 1 e 32 caracteres."));
    }
    Ok(name)
}

fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

/// Sessions end after this long without use; each use pushes it forward.
const SESSION_LIFETIME: Duration = Duration::days(30);

/// Slides the expiry of a session in use, writing at most once a day.
async fn renew(db: &DatabaseConnection, session: session::Model) -> ApiResult<()> {
    let expires_at = Utc::now() + SESSION_LIFETIME;
    if expires_at - session.expires_at >= Duration::days(1) {
        let mut active: session::ActiveModel = session.into();
        active.expires_at = Set(expires_at);
        active.update(db).await?;
    }
    Ok(())
}

#[derive(Serialize)]
struct AuthView {
    user: UserView,
    token: String,
}

async fn new_session(db: &DatabaseConnection, user: UserView) -> ApiResult<Json<AuthView>> {
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    session::ActiveModel {
        token_hash: Set(token_hash(&token)),
        user_id: Set(user.id),
        expires_at: Set(Utc::now() + SESSION_LIFETIME),
    }
    .insert(db)
    .await?;
    Ok(Json(AuthView { user, token }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleClientIds {
    desktop_client_id: Option<String>,
    web_client_id: Option<String>,
}

async fn google_config(State(state): State<AppState>) -> Json<GoogleClientIds> {
    Json(GoogleClientIds {
        desktop_client_id: state.google.desktop.as_ref().map(|c| c.id.clone()),
        web_client_id: state.google.web.as_ref().map(|c| c.id.clone()),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleLogin {
    code: String,
    code_verifier: String,
    redirect_uri: String,
    platform: google::Platform,
}

/// Display name for a new account: the Google name, or the e-mail's local part.
fn google_name(claims: &google::Claims) -> String {
    let local = claims.email.split('@').next().unwrap_or_default();
    [claims.name.as_deref().unwrap_or_default(), local]
        .into_iter()
        .map(|name| name.chars().take(32).collect::<String>())
        .find_map(|name| user_name(&name).ok())
        .unwrap_or_else(|| "Usuário".into())
}

async fn google_login(
    State(state): State<AppState>,
    Json(input): Json<GoogleLogin>,
) -> ApiResult<Json<AuthView>> {
    let client = match input.platform {
        google::Platform::Desktop => state.google.desktop.as_ref(),
        google::Platform::Web => state.google.web.as_ref(),
    }
    .ok_or_else(|| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "O login com Google não está configurado neste servidor.".into(),
        )
    })?;
    if !google::valid_redirect(input.platform, &input.redirect_uri)
        || input.code.is_empty()
        || input.code.len() > 512
        || !(43..=128).contains(&input.code_verifier.len())
    {
        return Err(ApiError::bad("Requisição de login inválida."));
    }
    let claims = google::exchange(
        &state.http,
        &state.google.token_url,
        client,
        &input.code,
        &input.code_verifier,
        &input.redirect_uri,
    )
    .await?;

    let existing = user::Entity::find()
        .filter(user::Column::GoogleSub.eq(&claims.sub))
        .one(&state.db)
        .await?;
    let user = match existing {
        // The photo follows the Google account; it is refreshed on every sign-in.
        Some(user) if user.avatar_url != claims.picture => {
            let mut active: user::ActiveModel = user.into();
            active.avatar_url = Set(claims.picture.clone());
            active.update(&state.db).await?
        }
        Some(user) => user,
        None => match user::Entity::find()
            .filter(user::Column::Email.eq(&claims.email))
            .one(&state.db)
            .await?
        {
            // Accounts created before Google Sign-In are linked by verified e-mail.
            Some(user) if user.google_sub.is_none() => {
                let mut active: user::ActiveModel = user.into();
                active.google_sub = Set(Some(claims.sub.clone()));
                active.avatar_url = Set(claims.picture.clone());
                active.update(&state.db).await?
            }
            Some(_) => {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "Este e-mail já está ligado a outra conta Google.".into(),
                ))
            }
            None => {
                user::ActiveModel {
                    id: Set(Uuid::new_v4()),
                    email: Set(claims.email.clone()),
                    name: Set(google_name(&claims)),
                    pronouns: Set(String::new()),
                    bio: Set(String::new()),
                    banner: Set(profile::DEFAULT_BANNER.into()),
                    password_hash: Set(None),
                    google_sub: Set(Some(claims.sub.clone())),
                    avatar_url: Set(claims.picture.clone()),
                    created_at: Set(Utc::now()),
                }
                .insert(&state.db)
                .await?
            }
        },
    };
    new_session(&state.db, user.into()).await
}

#[derive(Clone)]
struct SessionHash(String);

async fn authenticate(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> ApiResult<Response> {
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|s| s.len() == 64)
        .ok_or_else(ApiError::unauthorized)?;
    let hash = token_hash(token);
    let session = session::Entity::find_by_id(hash.clone())
        .filter(session::Column::ExpiresAt.gt(Utc::now()))
        .one(&state.db)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    renew(&state.db, session.clone()).await?;
    let user = user::Entity::find_by_id(session.user_id)
        .one(&state.db)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    request.extensions_mut().insert(UserView::from(user));
    request.extensions_mut().insert(SessionHash(hash));
    Ok(next.run(request).await)
}

async fn me(Extension(user): Extension<UserView>) -> Json<UserView> {
    Json(user)
}

async fn logout(
    State(state): State<AppState>,
    Extension(hash): Extension<SessionHash>,
) -> ApiResult<StatusCode> {
    session::Entity::delete_by_id(hash.0.clone())
        .exec(&state.db)
        .await?;
    state.realtime.revoke(&hash.0);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerView {
    id: Uuid,
    name: String,
    owner_id: Uuid,
}
impl From<server::Model> for ServerView {
    fn from(s: server::Model) -> Self {
        Self {
            id: s.id,
            name: s.name,
            owner_id: s.owner_id,
        }
    }
}

async fn require_member(db: &DatabaseConnection, server_id: Uuid, user_id: Uuid) -> ApiResult<()> {
    if member::Entity::find_by_id((server_id, user_id))
        .one(db)
        .await?
        .is_none()
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Você não faz parte deste servidor.".into(),
        ));
    }
    Ok(())
}

async fn list_servers(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
) -> ApiResult<Json<Vec<ServerView>>> {
    let ids: Vec<_> = member::Entity::find()
        .filter(member::Column::UserId.eq(user.id))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|m| m.server_id)
        .collect();
    let servers = server::Entity::find()
        .filter(server::Column::Id.is_in(ids))
        .order_by_asc(server::Column::CreatedAt)
        .order_by_asc(server::Column::Id)
        .all(&state.db)
        .await?;
    Ok(Json(servers.into_iter().map(Into::into).collect()))
}

#[derive(Deserialize)]
struct NameInput {
    name: String,
}

fn server_name(name: &str) -> ApiResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
        return Err(ApiError::bad(
            "O nome do servidor deve ter entre 1 e 100 caracteres.",
        ));
    }
    Ok(name.into())
}

fn channel_name(name: &str) -> ApiResult<String> {
    let name = name.trim().to_lowercase();
    if name.is_empty()
        || name.chars().count() > 64
        || !name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err(ApiError::bad(
            "Use de 1 a 64 letras, números, hífens ou sublinhados no canal.",
        ));
    }
    Ok(name)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InviteView {
    code: Uuid,
    url: String,
    server: ServerView,
}
fn invite_view(state: &AppState, code: Uuid, server: server::Model) -> InviteView {
    InviteView {
        code,
        url: format!("{}/?invite={code}", state.web_url.trim_end_matches('/')),
        server: server.into(),
    }
}

async fn create_server(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Json(input): Json<NameInput>,
) -> ApiResult<(StatusCode, Json<InviteView>)> {
    let name = server_name(&input.name)?;
    let tx = state.db.begin().await?;
    let server = server::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set(name),
        owner_id: Set(user.id),
        created_at: Set(Utc::now()),
    }
    .insert(&tx)
    .await?;
    member::ActiveModel {
        server_id: Set(server.id),
        user_id: Set(user.id),
        joined_at: Set(Utc::now()),
        role: Set("member".into()),
    }
    .insert(&tx)
    .await?;
    let invite = invite::ActiveModel {
        code: Set(Uuid::new_v4()),
        server_id: Set(server.id),
        created_at: Set(Utc::now()),
    }
    .insert(&tx)
    .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(invite_view(&state, invite.code, server)),
    ))
}

async fn server_invite(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<InviteView>> {
    require_member(&state.db, id, user.id).await?;
    let server = server::Entity::find_by_id(id)
        .one(&state.db)
        .await?
        .ok_or_else(ApiError::missing)?;
    let invite = invite::Entity::find()
        .filter(invite::Column::ServerId.eq(id))
        .one(&state.db)
        .await?
        .ok_or_else(ApiError::missing)?;
    Ok(Json(invite_view(&state, invite.code, server)))
}

async fn resolve_invite(state: &AppState, code: &str) -> ApiResult<(Uuid, server::Model)> {
    let code = Uuid::parse_str(code).map_err(|_| ApiError::missing())?;
    let invite = invite::Entity::find_by_id(code)
        .one(&state.db)
        .await?
        .ok_or_else(ApiError::missing)?;
    let server = server::Entity::find_by_id(invite.server_id)
        .one(&state.db)
        .await?
        .ok_or_else(ApiError::missing)?;
    Ok((code, server))
}

async fn preview_invite(
    State(state): State<AppState>,
    Path(code): Path<String>,
) -> ApiResult<Json<InviteView>> {
    let (code, server) = resolve_invite(&state, &code).await?;
    Ok(Json(invite_view(&state, code, server)))
}

async fn join_invite(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(code): Path<String>,
) -> ApiResult<Json<ServerView>> {
    let (_, server) = resolve_invite(&state, &code).await?;
    let member = member::ActiveModel {
        server_id: Set(server.id),
        user_id: Set(user.id),
        joined_at: Set(Utc::now()),
        role: Set("member".into()),
    };
    let inserted = member::Entity::insert(member)
        .on_conflict(
            OnConflict::columns([member::Column::ServerId, member::Column::UserId])
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(&state.db)
        .await?;
    if inserted == 1 {
        // Whoever has the server open sees the newcomer in its people list.
        if let Some(member) = member::Entity::find_by_id((server.id, user.id))
            .one(&state.db)
            .await?
        {
            let view = members::view(&state, &server, &member, user.clone());
            state.realtime.publish_server(
                server.id,
                serde_json::json!({ "type": "member.joined", "serverId": server.id, "member": view }),
            );
        }
    }
    Ok(Json(server.into()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChannelView {
    id: Uuid,
    /// Null for direct message conversations.
    server_id: Option<Uuid>,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    /// `discord` for channels imported from Discord.
    source: String,
    /// Still importing its Discord history: nobody can send messages yet.
    read_only: bool,
}
impl From<channel::Model> for ChannelView {
    fn from(c: channel::Model) -> Self {
        Self {
            id: c.id,
            server_id: c.server_id,
            name: c.name,
            kind: c.kind,
            source: c.source,
            read_only: false,
        }
    }
}

async fn list_channels(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Vec<ChannelView>>> {
    require_member(&state.db, id, user.id).await?;
    let channels = channel::Entity::find()
        .filter(channel::Column::ServerId.eq(id))
        .order_by_asc(channel::Column::CreatedAt)
        .order_by_asc(channel::Column::Id)
        .all(&state.db)
        .await?;
    let importing = discord::importing(&state.db, id).await?;
    Ok(Json(
        channels
            .into_iter()
            .map(|c| ChannelView {
                read_only: importing.contains(&c.id),
                ..c.into()
            })
            .collect(),
    ))
}

async fn create_channel(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
    Json(input): Json<ChannelInput>,
) -> ApiResult<(StatusCode, Json<ChannelView>)> {
    require_member(&state.db, id, user.id).await?;
    let name = channel_name(&input.name)?;
    let channel = channel::ActiveModel {
        id: Set(Uuid::new_v4()),
        server_id: Set(Some(id)),
        name: Set(name),
        kind: Set(input.kind.as_str().into()),
        created_by: Set(user.id),
        created_at: Set(Utc::now()),
        source: Set("local".into()),
    }
    .insert(&state.db)
    .await?;
    let view = ChannelView::from(channel);
    state.realtime.publish_server(
        id,
        serde_json::json!({ "type": "channel.created", "channel": view }),
    );
    Ok((StatusCode::CREATED, Json(view)))
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ChannelKind {
    #[default]
    Text,
    Voice,
}

impl ChannelKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Voice => "voice",
        }
    }
}

#[derive(Deserialize)]
struct ChannelInput {
    name: String,
    #[serde(default, rename = "type")]
    kind: ChannelKind,
}

async fn require_channel(
    db: &DatabaseConnection,
    id: Uuid,
    user: Uuid,
    kind: &str,
) -> ApiResult<channel::Model> {
    let channel = channel::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Canal não encontrado.".into()))?;
    match channel.server_id {
        Some(server) => require_member(db, server, user).await?,
        None => {
            dms::require_participant(db, channel.id, user).await?;
        }
    }
    // Direct messages hold messages like text channels do.
    if channel.kind != kind && !(kind == "text" && channel.kind == "dm") {
        return Err(ApiError::bad(
            "Este tipo de canal não suporta esta operação.",
        ));
    }
    Ok(channel)
}

/// The server of a channel that must belong to one (anything but a DM).
fn server_of(channel: &channel::Model) -> ApiResult<Uuid> {
    channel
        .server_id
        .ok_or_else(|| ApiError::bad("Este tipo de canal não suporta esta operação."))
}
