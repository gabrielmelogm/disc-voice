//! Discord integration (issue #11).
//!
//! - A bot installed in a Discord server (OAuth2 `bot` scope) lets the owner
//!   of a Disc Voice server bring Discord text channels over. Each channel's
//!   history is imported once, oldest first, 100 messages per request, with
//!   its media copied to the API ([`sync`]). From then on the channel lives
//!   in Disc Voice only; new Discord messages are not followed.
//! - Users may link their Discord account (OAuth2 `identify`). The bot sees
//!   their presence in the Discord servers it shares with them and publishes
//!   it as their Disc Voice activity ([`gateway`]); OAuth2 alone never exposes
//!   another app's activity.
//!
//! The integration is read-only: the bot only needs View Channel and Read
//! Message History.

mod gateway;
pub(crate) mod routes;
mod sync;

use crate::{activity::Activity, entities::discord_account, ApiResult, AppState};
use reqwest::{header::HeaderMap, Method, StatusCode};
use sea_orm::EntityTrait;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    env,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::sync::Notify;
use uuid::Uuid;

pub use gateway::dispatch;

pub const API_URL: &str = "https://discord.com/api/v10";
pub const AUTHORIZE_URL: &str = "https://discord.com/oauth2/authorize";
const CDN_URL: &str = "https://cdn.discordapp.com";
pub const CALLBACK_PATH: &str = "/api/discord/callback";

pub(crate) const VIEW_CHANNEL: u64 = 1 << 10;
pub(crate) const READ_MESSAGE_HISTORY: u64 = 1 << 16;
const ADMINISTRATOR: u64 = 1 << 3;
/// Everything the bot asks for when it is installed.
pub(crate) const BOT_PERMISSIONS: u64 = VIEW_CHANNEL | READ_MESSAGE_HISTORY;

#[derive(Clone, Debug)]
pub struct DiscordConfig {
    pub client_id: String,
    pub client_secret: String,
    pub bot_token: String,
    /// Overridable so tests can point them at a local fake.
    pub api_url: String,
    pub authorize_url: String,
}

impl DiscordConfig {
    /// Requires DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and DISCORD_BOT_TOKEN.
    pub fn from_env() -> Option<Self> {
        let var = |name: &str| {
            env::var(name)
                .ok()
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        Some(Self {
            client_id: var("DISCORD_CLIENT_ID")?,
            client_secret: var("DISCORD_CLIENT_SECRET")?,
            bot_token: var("DISCORD_BOT_TOKEN")?,
            api_url: API_URL.into(),
            authorize_url: AUTHORIZE_URL.into(),
        })
    }
}

/// An OAuth2 flow started by a signed-in user, waiting for Discord's redirect.
#[derive(Clone, Debug)]
pub(crate) enum Flow {
    /// Link the user's Discord account.
    Account { user: Uuid },
    /// Install the bot in a Discord server for this Disc Voice server.
    Install { user: Uuid, server: Uuid },
}

const FLOW_LIFETIME: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Copy)]
struct Link {
    user: Uuid,
    share: bool,
}

/// Privileged intents enabled for the application in the Developer Portal.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Intents {
    pub presence: bool,
    pub message_content: bool,
}

#[derive(Debug)]
pub(crate) enum DiscordError {
    Api {
        status: u16,
        code: u64,
        message: String,
    },
    Network(String),
}

impl DiscordError {
    /// Worth retrying later on its own (outage, network, rate limit).
    pub(crate) fn transient(&self) -> bool {
        match self {
            Self::Network(_) => true,
            Self::Api { status, .. } => *status == 429 || *status >= 500,
        }
    }

    /// A message for the people managing the integration.
    pub(crate) fn describe(&self) -> String {
        match self {
            // 50001 Missing Access, 50013 Missing Permissions.
            Self::Api { status: 403, .. }
            | Self::Api {
                code: 50001 | 50013,
                ..
            } => "O bot não tem acesso a este canal. Dê a ele as permissões Ver canal e Ler histórico de mensagens.".into(),
            Self::Api { status: 404, .. } => "O canal ou servidor não existe mais no Discord, ou o bot foi removido dele.".into(),
            Self::Api { status: 401, .. } => "O token do bot foi recusado pelo Discord. Confira DISCORD_BOT_TOKEN.".into(),
            Self::Api { status: 429, .. } => "O Discord limitou as requisições. Tentaremos de novo em instantes.".into(),
            Self::Api { status, message, .. } if *status >= 500 => {
                format!("O Discord está instável ({status}: {message}). Tentaremos de novo.")
            }
            Self::Api { status, message, .. } => format!("O Discord recusou a requisição ({status}: {message})."),
            Self::Network(detail) => {
                tracing::debug!(%detail, "Falha de rede com o Discord");
                "Não foi possível falar com o Discord. Tentaremos de novo.".into()
            }
        }
    }
}

pub struct Discord {
    config: DiscordConfig,
    http: reqwest::Client,
    flows: Mutex<HashMap<String, (Flow, Instant)>>,
    /// Linked accounts, by Discord user id.
    links: Mutex<HashMap<String, Link>>,
    /// Last activity seen for each Discord user in a server shared with the bot.
    presences: Mutex<HashMap<String, Option<Activity>>>,
    bot_id: Mutex<Option<String>>,
    intents: Mutex<Option<Intents>>,
    /// The gateway is connected and receiving presences.
    pub(crate) live_presence: Mutex<bool>,
    /// Wakes the import worker.
    wake: Notify,
    /// Downloads attachments, which may take longer than API calls.
    media: reqwest::Client,
}

impl Discord {
    pub(crate) fn new(config: DiscordConfig, http: reqwest::Client) -> Self {
        Self {
            config,
            http,
            flows: Mutex::default(),
            links: Mutex::default(),
            presences: Mutex::default(),
            bot_id: Mutex::default(),
            intents: Mutex::default(),
            live_presence: Mutex::new(false),
            wake: Notify::new(),
            media: reqwest::Client::builder()
                .timeout(Duration::from_secs(120))
                .build()
                .expect("HTTP client"),
        }
    }

    pub(crate) fn wake(&self) {
        self.wake.notify_one();
    }

    /// Attachments are only fetched from Discord's CDN (or the configured
    /// API, for tests), never from arbitrary hosts.
    fn media_allowed(&self, url: &str) -> bool {
        if url.starts_with(&format!("{}/", self.config.api_url)) {
            return true;
        }
        reqwest::Url::parse(url).is_ok_and(|u| {
            u.scheme() == "https"
                && matches!(
                    u.host_str(),
                    Some("cdn.discordapp.com" | "media.discordapp.net")
                )
        })
    }

    /// Downloads an attachment of at most `max` bytes.
    pub(crate) async fn download(&self, url: &str, max: u64) -> Result<Vec<u8>, String> {
        if !self.media_allowed(url) {
            return Err("endereço fora da CDN do Discord".into());
        }
        let response = self
            .media
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status()));
        }
        if response.content_length().is_some_and(|n| n > max) {
            return Err("arquivo grande demais".into());
        }
        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        if bytes.len() as u64 > max {
            return Err("arquivo grande demais".into());
        }
        Ok(bytes.to_vec())
    }

    fn start_flow(&self, flow: Flow) -> String {
        let state = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let mut flows = self.flows.lock().unwrap();
        flows.retain(|_, (_, at)| at.elapsed() < FLOW_LIFETIME);
        flows.insert(state.clone(), (flow, Instant::now()));
        state
    }

    /// Each state can be used once, within its lifetime.
    fn take_flow(&self, state: &str) -> Option<Flow> {
        let (flow, at) = self.flows.lock().unwrap().remove(state)?;
        (at.elapsed() < FLOW_LIFETIME).then_some(flow)
    }

    fn authorize_url(
        &self,
        redirect: &str,
        state: &str,
        scope: &str,
        extra: &[(&str, String)],
    ) -> String {
        let mut params = vec![
            ("client_id", self.config.client_id.clone()),
            ("response_type", "code".into()),
            ("redirect_uri", redirect.into()),
            ("scope", scope.into()),
            ("state", state.into()),
        ];
        params.extend(extra.iter().map(|(k, v)| (*k, v.clone())));
        reqwest::Url::parse_with_params(&self.config.authorize_url, &params)
            .map(String::from)
            .unwrap_or_default()
    }

    /// Sends a request to the Discord API, waiting out rate limits and
    /// retrying outages a few times.
    async fn send(
        &self,
        method: Method,
        path: &str,
        auth: &str,
        form: Option<&[(&str, &str)]>,
    ) -> Result<reqwest::Response, DiscordError> {
        let url = format!("{}{path}", self.config.api_url);
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            let mut request = self.http.request(method.clone(), &url).header(
                reqwest::header::USER_AGENT,
                "DiscordBot (disc-voice, 0.1.0)",
            );
            if !auth.is_empty() {
                request = request.header(reqwest::header::AUTHORIZATION, auth);
            }
            if let Some(form) = form {
                request = request.form(form);
            }
            let response = match request.send().await {
                Ok(response) => response,
                Err(error) if attempt < 4 => {
                    tracing::warn!(%error, path, "Falha de rede com o Discord; tentando de novo");
                    tokio::time::sleep(backoff(attempt)).await;
                    continue;
                }
                Err(error) => return Err(DiscordError::Network(error.to_string())),
            };
            let status = response.status();
            if status == StatusCode::TOO_MANY_REQUESTS {
                let headers = response.headers().clone();
                let body = response.json::<Value>().await.ok();
                let wait = retry_after(&headers, body.as_ref());
                tracing::warn!(path, ?wait, "Limite de requisições do Discord");
                if attempt < 6 {
                    tokio::time::sleep(wait).await;
                    continue;
                }
                return Err(DiscordError::Api {
                    status: 429,
                    code: 0,
                    message: "rate limited".into(),
                });
            }
            if status.is_server_error() && attempt < 4 {
                tokio::time::sleep(backoff(attempt)).await;
                continue;
            }
            // An exhausted bucket: wait for it to refill before the next call.
            if let Some(wait) = bucket_wait(response.headers()) {
                tokio::time::sleep(wait).await;
            }
            if !status.is_success() {
                let body = response.json::<Value>().await.unwrap_or(Value::Null);
                return Err(DiscordError::Api {
                    status: status.as_u16(),
                    code: body["code"].as_u64().unwrap_or(0),
                    message: body["message"]
                        .as_str()
                        .or(body["error"].as_str())
                        .unwrap_or_default()
                        .chars()
                        .take(200)
                        .collect(),
                });
            }
            return Ok(response);
        }
    }

    async fn json<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, DiscordError> {
        response
            .json()
            .await
            .map_err(|error| DiscordError::Network(error.to_string()))
    }

    pub(crate) async fn bot_get<T: DeserializeOwned>(&self, path: &str) -> Result<T, DiscordError> {
        let auth = format!("Bot {}", self.config.bot_token);
        Self::json(self.send(Method::GET, path, &auth, None).await?).await
    }

    async fn exchange(&self, code: &str, redirect: &str) -> Result<Token, DiscordError> {
        let form = [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect),
            ("client_id", self.config.client_id.as_str()),
            ("client_secret", self.config.client_secret.as_str()),
        ];
        Self::json(
            self.send(Method::POST, "/oauth2/token", "", Some(&form))
                .await?,
        )
        .await
    }

    async fn user(&self, access_token: &str) -> Result<DiscordUser, DiscordError> {
        let auth = format!("Bearer {access_token}");
        Self::json(self.send(Method::GET, "/users/@me", &auth, None).await?).await
    }

    async fn bot_id(&self) -> Result<String, DiscordError> {
        if let Some(id) = self.bot_id.lock().unwrap().clone() {
            return Ok(id);
        }
        let me: DiscordUser = self.bot_get("/users/@me").await?;
        *self.bot_id.lock().unwrap() = Some(me.id.clone());
        Ok(me.id)
    }

    /// Privileged intents enabled for the app, from its flags (cached).
    pub(crate) async fn intents(&self) -> Option<Intents> {
        if let Some(intents) = *self.intents.lock().unwrap() {
            return Some(intents);
        }
        let app: Value = match self.bot_get("/applications/@me").await {
            Ok(app) => app,
            Err(error) => {
                tracing::warn!(
                    ?error,
                    "Não foi possível ler as flags do aplicativo Discord"
                );
                return None;
            }
        };
        let flags = app["flags"].as_u64().unwrap_or(0);
        // GATEWAY_PRESENCE(_LIMITED) and GATEWAY_MESSAGE_CONTENT(_LIMITED).
        let intents = Intents {
            presence: flags & (1 << 12 | 1 << 13) != 0,
            message_content: flags & (1 << 18 | 1 << 19) != 0,
        };
        *self.intents.lock().unwrap() = Some(intents);
        Some(intents)
    }

    /// Text channels of a guild, with whether the bot can read their history.
    pub(crate) async fn guild_channels(
        &self,
        guild: &str,
    ) -> Result<Vec<GuildChannel>, DiscordError> {
        let info: GuildInfo = self.bot_get(&format!("/guilds/{guild}")).await?;
        let bot = self.bot_id().await?;
        let member: Member = self
            .bot_get(&format!("/guilds/{guild}/members/{bot}"))
            .await?;
        let channels: Vec<ChannelInfo> = self.bot_get(&format!("/guilds/{guild}/channels")).await?;
        let roles: HashMap<String, u64> = info
            .roles
            .iter()
            .map(|r| (r.id.clone(), r.permissions.parse().unwrap_or(0)))
            .collect();
        let categories: HashMap<&str, (&str, i64)> = channels
            .iter()
            .filter(|c| c.kind == 4)
            .map(|c| {
                (
                    c.id.as_str(),
                    (c.name.as_deref().unwrap_or_default(), c.position),
                )
            })
            .collect();
        let mut text: Vec<_> = channels
            .iter()
            .filter(|c| is_text(c.kind))
            .map(|c| {
                let parent = c.parent_id.as_deref().and_then(|id| categories.get(id));
                let permissions = channel_permissions(
                    guild,
                    &info.owner_id,
                    &roles,
                    &bot,
                    &member.roles,
                    &c.permission_overwrites,
                );
                (
                    (parent.map_or(-1, |p| p.1), c.position),
                    GuildChannel {
                        id: c.id.clone(),
                        name: c.name.clone().unwrap_or_default(),
                        category: parent.map(|p| p.0.to_owned()),
                        readable: permissions & (VIEW_CHANNEL | READ_MESSAGE_HISTORY)
                            == VIEW_CHANNEL | READ_MESSAGE_HISTORY,
                    },
                )
            })
            .collect();
        text.sort_by_key(|(order, _)| *order);
        Ok(text.into_iter().map(|(_, c)| c).collect())
    }

    /// Reloads the linked accounts from the database.
    pub(crate) async fn refresh_links(&self, db: &sea_orm::DatabaseConnection) -> ApiResult<()> {
        let links = discord_account::Entity::find()
            .all(db)
            .await?
            .into_iter()
            .map(|a| {
                (
                    a.discord_id,
                    Link {
                        user: a.user_id,
                        share: a.share_activity,
                    },
                )
            })
            .collect();
        *self.links.lock().unwrap() = links;
        Ok(())
    }

    pub(crate) fn presence_seen(&self, discord_id: &str) -> bool {
        self.presences.lock().unwrap().contains_key(discord_id)
    }

    fn cached_activity(&self, discord_id: &str) -> Option<Activity> {
        self.presences
            .lock()
            .unwrap()
            .get(discord_id)
            .cloned()
            .flatten()
    }
}

/// Applies a Discord presence: remembered for everyone, published as the
/// activity of linked users who share it.
async fn presence(
    state: &AppState,
    discord: &Discord,
    discord_id: &str,
    activity: Option<Activity>,
) {
    discord
        .presences
        .lock()
        .unwrap()
        .insert(discord_id.to_owned(), activity.clone());
    let link = discord.links.lock().unwrap().get(discord_id).copied();
    if let Some(link) = link.filter(|l| l.share) {
        if let Err(error) = crate::activity::set(state, link.user, activity).await {
            tracing::warn!(?error, "Não foi possível publicar a atividade");
        }
    }
}

/// Publishes (or clears) a linked user's activity after their sharing changed.
pub(crate) async fn reshare(
    state: &AppState,
    discord: &Discord,
    discord_id: &str,
    user: Uuid,
    share: bool,
) -> ApiResult<()> {
    let activity = share.then(|| discord.cached_activity(discord_id)).flatten();
    crate::activity::set(state, user, activity).await
}

/// Forgets all presences, e.g. while the gateway is disconnected.
async fn forget_presences(state: &AppState, discord: &Discord) {
    let seen: Vec<String> = discord
        .presences
        .lock()
        .unwrap()
        .drain()
        .map(|(id, _)| id)
        .collect();
    let links = discord.links.lock().unwrap().clone();
    for id in seen {
        if let Some(link) = links.get(&id).filter(|l| l.share) {
            let _ = crate::activity::set(state, link.user, None).await;
        }
    }
}

/// Channels of a server whose Discord history is still being imported;
/// they accept no new messages until it finishes.
pub(crate) async fn importing(
    db: &sea_orm::DatabaseConnection,
    server: Uuid,
) -> ApiResult<HashSet<Uuid>> {
    use crate::entities::discord_import;
    use sea_orm::{ColumnTrait, QueryFilter};
    Ok(discord_import::Entity::find()
        .filter(discord_import::Column::ServerId.eq(server))
        .filter(discord_import::Column::Phase.eq("history"))
        .all(db)
        .await?
        .into_iter()
        .map(|i| i.channel_id)
        .collect())
}

/// Starts the gateway connection and the import worker.
pub fn spawn(state: &AppState) {
    if state.discord.is_some() {
        tokio::spawn(gateway::run(state.clone()));
        spawn_worker(state);
    }
}

/// Starts only the import worker (the gateway is optional for imports).
pub fn spawn_worker(state: &AppState) {
    if state.discord.is_some() {
        tokio::spawn(sync::run(state.clone()));
    }
}

fn backoff(attempt: u32) -> Duration {
    Duration::from_millis(500 * 2u64.pow(attempt.min(6)))
}

fn seconds(value: f64) -> Duration {
    Duration::from_secs_f64(value.clamp(0.0, 60.0))
}

/// How long a 429 asks to wait: the body's `retry_after`, else the headers.
fn retry_after(headers: &HeaderMap, body: Option<&Value>) -> Duration {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<f64>().ok())
    };
    body.and_then(|b| b["retry_after"].as_f64())
        .or_else(|| header("x-ratelimit-reset-after"))
        .or_else(|| header("retry-after"))
        .map(seconds)
        .unwrap_or(Duration::from_secs(1))
}

/// Time until an exhausted rate limit bucket refills.
fn bucket_wait(headers: &HeaderMap) -> Option<Duration> {
    let value = |name: &str| headers.get(name)?.to_str().ok()?.parse::<f64>().ok();
    (value("x-ratelimit-remaining")? <= 0.0)
        .then(|| seconds(value("x-ratelimit-reset-after").unwrap_or(1.0)))
}

/// Text (0) and announcement (5) channels hold importable history.
fn is_text(kind: u8) -> bool {
    matches!(kind, 0 | 5)
}

/// Computes a member's permissions in a channel, following Discord's rules:
/// base role permissions, then @everyone, role and member overwrites.
fn channel_permissions(
    guild: &str,
    owner: &str,
    roles: &HashMap<String, u64>,
    member: &str,
    member_roles: &[String],
    overwrites: &[Overwrite],
) -> u64 {
    if member == owner {
        return u64::MAX;
    }
    let mut permissions = roles.get(guild).copied().unwrap_or(0);
    for role in member_roles {
        permissions |= roles.get(role).copied().unwrap_or(0);
    }
    if permissions & ADMINISTRATOR != 0 {
        return u64::MAX;
    }
    let bits = |o: &Overwrite| {
        (
            o.allow.parse::<u64>().unwrap_or(0),
            o.deny.parse::<u64>().unwrap_or(0),
        )
    };
    if let Some(everyone) = overwrites.iter().find(|o| o.id == guild) {
        let (allow, deny) = bits(everyone);
        permissions = (permissions & !deny) | allow;
    }
    let (mut allow, mut deny) = (0, 0);
    for overwrite in overwrites
        .iter()
        .filter(|o| o.kind == 0 && member_roles.contains(&o.id))
    {
        let (a, d) = bits(overwrite);
        allow |= a;
        deny |= d;
    }
    permissions = (permissions & !deny) | allow;
    if let Some(own) = overwrites.iter().find(|o| o.kind == 1 && o.id == member) {
        let (allow, deny) = bits(own);
        permissions = (permissions & !deny) | allow;
    }
    permissions
}

fn avatar_url(user_id: &str, hash: Option<&str>) -> Option<String> {
    let hash = hash.filter(|h| h.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))?;
    Some(format!("{CDN_URL}/avatars/{user_id}/{hash}.png?size=128"))
}

fn icon_url(guild_id: &str, hash: Option<&str>) -> Option<String> {
    let hash = hash.filter(|h| h.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))?;
    Some(format!("{CDN_URL}/icons/{guild_id}/{hash}.png?size=128"))
}

/// A Discord id (snowflake): digits only.
fn snowflake(value: &str) -> Option<&str> {
    (!value.is_empty() && value.len() <= 20 && value.bytes().all(|b| b.is_ascii_digit()))
        .then_some(value)
}

/// Trimmed, single-line text of at most `max` characters, or None.
fn short_text(value: &Value, max: usize) -> Option<String> {
    let text: String = value
        .as_str()?
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect();
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

#[derive(Deserialize)]
struct Token {
    access_token: String,
    #[serde(default)]
    guild: Option<TokenGuild>,
}

#[derive(Deserialize)]
struct TokenGuild {
    id: String,
    name: String,
    #[serde(default)]
    icon: Option<String>,
}

#[derive(Deserialize)]
struct DiscordUser {
    id: String,
    username: String,
    #[serde(default)]
    global_name: Option<String>,
    #[serde(default)]
    avatar: Option<String>,
}

#[derive(Deserialize)]
struct Role {
    id: String,
    permissions: String,
}

#[derive(Deserialize)]
struct GuildInfo {
    owner_id: String,
    #[serde(default)]
    roles: Vec<Role>,
}

#[derive(Deserialize)]
struct Member {
    #[serde(default)]
    roles: Vec<String>,
}

#[derive(Deserialize)]
struct Overwrite {
    id: String,
    #[serde(rename = "type")]
    kind: u8,
    allow: String,
    deny: String,
}

#[derive(Deserialize)]
struct ChannelInfo {
    id: String,
    #[serde(rename = "type")]
    kind: u8,
    #[serde(default)]
    guild_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    position: i64,
    #[serde(default)]
    permission_overwrites: Vec<Overwrite>,
}

pub(crate) struct GuildChannel {
    pub id: String,
    pub name: String,
    pub category: Option<String>,
    pub readable: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    fn overwrite(id: &str, kind: u8, allow: u64, deny: u64) -> Overwrite {
        Overwrite {
            id: id.into(),
            kind,
            allow: allow.to_string(),
            deny: deny.to_string(),
        }
    }

    #[test]
    fn computes_channel_permissions() {
        let read = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
        let roles = HashMap::from([
            ("g".to_owned(), read),
            ("mod".to_owned(), 0),
            ("admin".to_owned(), ADMINISTRATOR),
        ]);
        let none: &[String] = &[];
        let modr = ["mod".to_owned()];
        // @everyone can read.
        assert_eq!(
            channel_permissions("g", "owner", &roles, "bot", none, &[]) & read,
            read
        );
        // A hidden channel...
        let hidden = [overwrite("g", 0, 0, VIEW_CHANNEL)];
        assert_eq!(
            channel_permissions("g", "owner", &roles, "bot", none, &hidden) & VIEW_CHANNEL,
            0
        );
        // ...visible to a role the bot has, and to the bot itself.
        let role = [
            overwrite("g", 0, 0, VIEW_CHANNEL),
            overwrite("mod", 0, VIEW_CHANNEL, 0),
        ];
        assert_ne!(
            channel_permissions("g", "owner", &roles, "bot", &modr, &role) & VIEW_CHANNEL,
            0
        );
        let member = [
            overwrite("g", 0, 0, VIEW_CHANNEL),
            overwrite("bot", 1, VIEW_CHANNEL, 0),
        ];
        assert_ne!(
            channel_permissions("g", "owner", &roles, "bot", none, &member) & VIEW_CHANNEL,
            0
        );
        // A member deny wins over a role allow.
        let denied = [
            overwrite("mod", 0, VIEW_CHANNEL, 0),
            overwrite("bot", 1, 0, VIEW_CHANNEL),
        ];
        assert_eq!(
            channel_permissions("g", "owner", &roles, "bot", &modr, &denied) & VIEW_CHANNEL,
            0
        );
        // Administrators and the owner bypass overwrites.
        assert_eq!(
            channel_permissions("g", "owner", &roles, "bot", &["admin".to_owned()], &hidden),
            u64::MAX
        );
        assert_eq!(
            channel_permissions("g", "bot", &roles, "bot", none, &hidden),
            u64::MAX
        );
    }

    #[test]
    fn reads_rate_limits() {
        let mut headers = HeaderMap::new();
        assert_eq!(retry_after(&headers, None), Duration::from_secs(1));
        headers.insert("retry-after", HeaderValue::from_static("3"));
        assert_eq!(retry_after(&headers, None), Duration::from_secs(3));
        let body = serde_json::json!({ "retry_after": 0.25, "global": false });
        assert_eq!(
            retry_after(&headers, Some(&body)),
            Duration::from_millis(250)
        );
        assert_eq!(
            retry_after(&headers, Some(&serde_json::json!({ "retry_after": 1e9 }))),
            Duration::from_secs(60)
        );

        assert_eq!(bucket_wait(&headers), None);
        headers.insert("x-ratelimit-remaining", HeaderValue::from_static("2"));
        assert_eq!(bucket_wait(&headers), None);
        headers.insert("x-ratelimit-remaining", HeaderValue::from_static("0"));
        headers.insert("x-ratelimit-reset-after", HeaderValue::from_static("1.5"));
        assert_eq!(bucket_wait(&headers), Some(Duration::from_millis(1500)));
    }

    #[test]
    fn validates_ids_and_text() {
        assert_eq!(snowflake("80351110224678912"), Some("80351110224678912"));
        assert_eq!(snowflake("../guilds"), None);
        assert_eq!(snowflake(""), None);
        assert_eq!(
            short_text(&serde_json::json!("  Minecraft\n "), 128).as_deref(),
            Some("Minecraft")
        );
        assert_eq!(short_text(&serde_json::json!("   "), 128), None);
        assert_eq!(
            short_text(&serde_json::json!("abcdef"), 3).as_deref(),
            Some("abc")
        );
        assert_eq!(avatar_url("1", Some("../x")), None);
        assert_eq!(
            avatar_url("1", Some("a_bc")).as_deref(),
            Some("https://cdn.discordapp.com/avatars/1/a_bc.png?size=128")
        );
    }

    #[test]
    fn errors_explain_what_to_do() {
        let forbidden = DiscordError::Api {
            status: 403,
            code: 50001,
            message: "Missing Access".into(),
        };
        assert!(forbidden.describe().contains("Ler histórico"));
        assert!(!forbidden.transient());
        assert!(DiscordError::Api {
            status: 502,
            code: 0,
            message: String::new()
        }
        .transient());
        assert!(DiscordError::Network("x".into()).transient());
    }
}
