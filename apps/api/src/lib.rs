mod entities;
mod messages;
pub mod migration;
mod realtime;

use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
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
use tokio::sync::Semaphore;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use uuid::Uuid;

#[derive(Clone)]
pub struct AppState {
    pub db: DatabaseConnection,
    pub web_url: String,
    password_jobs: Arc<Semaphore>,
    realtime: Arc<realtime::Hub>,
}

impl AppState {
    pub fn new(db: DatabaseConnection, web_url: String) -> Self {
        Self {
            db,
            web_url,
            password_jobs: Arc::new(Semaphore::new(8)),
            realtime: Arc::new(realtime::Hub::new()),
        }
    }
}

pub fn router(state: AppState, origins: Vec<HeaderValue>) -> Router {
    let ws_origins = Arc::new(origins.clone());
    let protected = Router::new()
        .route("/me", get(me))
        .route("/auth/logout", post(logout))
        .route("/servers", get(list_servers).post(create_server))
        .route("/servers/{id}/invite", get(server_invite))
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
        .route("/voice/config", get(realtime::ice_config))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate));

    Router::new()
        .nest(
            "/api",
            Router::new()
                .route(
                    "/health",
                    get(|| async { Json(serde_json::json!({ "status": "ok" })) }),
                )
                .route("/auth/register", post(register))
                .route("/auth/login", post(login))
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
                .allow_methods([Method::GET, Method::POST])
                .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

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
}

impl From<user::Model> for UserView {
    fn from(user: user::Model) -> Self {
        Self {
            id: user.id,
            email: user.email,
        }
    }
}

#[derive(Deserialize)]
struct Credentials {
    email: String,
    password: String,
}

fn credentials(input: &Credentials) -> ApiResult<String> {
    let email = input.email.trim().to_lowercase();
    let parts: Vec<_> = email.split('@').collect();
    if email.len() > 254
        || parts.len() != 2
        || parts[0].is_empty()
        || !parts[1].contains('.')
        || parts[1].starts_with('.')
        || parts[1].ends_with('.')
        || email.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(ApiError::bad("Informe um e-mail válido."));
    }
    if input.password.chars().count() < 8 || input.password.len() > 128 {
        return Err(ApiError::bad(
            "A senha deve ter pelo menos 8 caracteres e no máximo 128 bytes.",
        ));
    }
    Ok(email)
}

fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
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
        expires_at: Set(Utc::now() + Duration::days(7)),
    }
    .insert(db)
    .await?;
    Ok(Json(AuthView { user, token }))
}

async fn register(
    State(state): State<AppState>,
    Json(input): Json<Credentials>,
) -> ApiResult<Json<AuthView>> {
    let email = credentials(&input)?;
    let permit = state
        .password_jobs
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "Tente novamente em alguns segundos.".into(),
            )
        })?;
    let password_hash = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        Argon2::default()
            .hash_password(input.password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|hash| hash.to_string())
            .map_err(ApiError::internal)
    })
    .await
    .map_err(ApiError::internal)??;
    let user = user::ActiveModel {
        id: Set(Uuid::new_v4()),
        email: Set(email),
        password_hash: Set(password_hash),
        created_at: Set(Utc::now()),
    }
    .insert(&state.db)
    .await?;
    new_session(&state.db, user.into()).await
}

async fn login(
    State(state): State<AppState>,
    Json(input): Json<Credentials>,
) -> ApiResult<Json<AuthView>> {
    let email = credentials(&input)?;
    let user = user::Entity::find()
        .filter(user::Column::Email.eq(email))
        .one(&state.db)
        .await?;
    let permit = state
        .password_jobs
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "Tente novamente em alguns segundos.".into(),
            )
        })?;
    let hash = user.as_ref().map(|u| u.password_hash.clone());
    let valid = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        match hash {
            Some(hash) => PasswordHash::new(&hash).is_ok_and(|hash| {
                Argon2::default()
                    .verify_password(input.password.as_bytes(), &hash)
                    .is_ok()
            }),
            None => {
                // Also perform password work for unknown accounts.
                let _ = Argon2::default()
                    .hash_password(input.password.as_bytes(), &SaltString::generate(&mut OsRng));
                false
            }
        }
    })
    .await
    .map_err(ApiError::internal)?;
    match user {
        Some(user) if valid => new_session(&state.db, user.into()).await,
        _ => Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "E-mail ou senha incorretos.".into(),
        )),
    }
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
    member::Entity::insert(member::ActiveModel {
        server_id: Set(server.id),
        user_id: Set(user.id),
        joined_at: Set(Utc::now()),
    })
    .on_conflict(
        OnConflict::columns([member::Column::ServerId, member::Column::UserId])
            .do_nothing()
            .to_owned(),
    )
    .exec_without_returning(&state.db)
    .await?;
    Ok(Json(server.into()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChannelView {
    id: Uuid,
    server_id: Uuid,
    name: String,
    #[serde(rename = "type")]
    kind: String,
}
impl From<channel::Model> for ChannelView {
    fn from(c: channel::Model) -> Self {
        Self {
            id: c.id,
            server_id: c.server_id,
            name: c.name,
            kind: c.kind,
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
    Ok(Json(channels.into_iter().map(Into::into).collect()))
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
        server_id: Set(id),
        name: Set(name),
        kind: Set(input.kind.as_str().into()),
        created_by: Set(user.id),
        created_at: Set(Utc::now()),
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
    require_member(db, channel.server_id, user).await?;
    if channel.kind != kind {
        return Err(ApiError::bad(
            "Este tipo de canal não suporta esta operação.",
        ));
    }
    Ok(channel)
}
