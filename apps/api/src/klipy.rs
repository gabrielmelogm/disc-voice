//! GIFs from Klipy (<https://klipy.com>).
//!
//! The desktop app never sees the API key: it asks `/api/gifs`, and the API
//! calls Klipy with `KLIPY_TOKEN` (the key goes in the URL path, so neither
//! URLs nor request errors are ever logged). Results keep Klipy's order and
//! media URLs as returned. Media loads straight from Klipy's CDN; messages and
//! profiles only keep those URLs, after checking they point to it.
use super::*;
use axum::extract::Query;
use serde_json::Value;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

pub const API_URL: &str = "https://api.klipy.com";
/// Hosts that serve Klipy media (their network requirements list these).
const MEDIA_HOSTS: [&str; 3] = ["static.klipy.com", "static1.klipy.com", "static2.klipy.com"];
const PER_PAGE: u32 = 24;
/// Pages are shared between users for a while: a test key allows only 100
/// requests an hour, and trending barely changes in minutes.
const CACHE_TTL: Duration = Duration::from_secs(300);
const CACHE_ENTRIES: usize = 256;
/// Locale and safety level of the results (Brazilian Portuguese app).
const LOCALE: &str = "br";
const CONTENT_FILTER: &str = "medium";

pub struct KlipyConfig {
    pub api_key: String,
    /// Base of the Klipy API (overridden in tests).
    pub api_url: String,
}

impl KlipyConfig {
    /// Reads `KLIPY_TOKEN`.
    pub fn from_env() -> Option<Self> {
        std::env::var("KLIPY_TOKEN")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .map(|api_key| Self {
                api_key,
                api_url: API_URL.into(),
            })
    }
}

type Key = (String, u32);

// Not `Debug`: the key must not end up in logs.
pub(crate) struct Klipy {
    config: KlipyConfig,
    http: reqwest::Client,
    cache: Mutex<HashMap<Key, (Instant, GifPage)>>,
}

/// A GIF as the picker shows it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Gif {
    pub id: String,
    pub slug: String,
    pub title: String,
    /// Animated, for messages and the preview before sending.
    pub url: String,
    /// Animated and small, for the picker grid.
    pub thumbnail: String,
    /// A still frame, shown when the user prefers reduced motion.
    pub still: Option<String>,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GifPage {
    results: Vec<Gif>,
    page: u32,
    has_next: bool,
}

/// What can go wrong talking to Klipy. Never carries the key.
#[derive(Debug, PartialEq)]
pub(crate) enum KlipyError {
    RateLimited,
    Unavailable(String),
}

impl From<KlipyError> for ApiError {
    fn from(error: KlipyError) -> Self {
        match error {
            KlipyError::RateLimited => ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "Muitas buscas de GIF em pouco tempo. Espere um pouco e tente de novo.".into(),
            ),
            KlipyError::Unavailable(reason) => {
                tracing::warn!(%reason, "Klipy indisponível");
                ApiError(
                    StatusCode::BAD_GATEWAY,
                    "O Klipy não respondeu. Tente novamente em instantes.".into(),
                )
            }
        }
    }
}

/// One rendition of a GIF in Klipy's response.
#[derive(Deserialize)]
struct Rendition {
    url: String,
    width: Option<u32>,
    height: Option<u32>,
}

type Formats = HashMap<String, Rendition>;

#[derive(Deserialize)]
struct Item {
    id: Value,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    file: HashMap<String, Formats>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize)]
struct Data {
    #[serde(default)]
    data: Vec<Value>,
    current_page: Option<u32>,
    #[serde(default)]
    has_next: bool,
}

#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    result: bool,
    data: Option<Data>,
}

/// The first of `formats` available in the first of `sizes` that has one.
fn pick<'a>(
    file: &'a HashMap<String, Formats>,
    sizes: &[&str],
    formats: &[&str],
) -> Option<&'a Rendition> {
    sizes.iter().find_map(|size| {
        let renditions = file.get(*size)?;
        formats
            .iter()
            .find_map(|format| renditions.get(*format))
            .filter(|r| media_url(&r.url))
    })
}

fn gif(item: Item) -> Option<Gif> {
    // Ads and other item types are not GIFs.
    if item.kind.as_deref().is_some_and(|kind| kind != "gif") {
        return None;
    }
    const ANIMATED: [&str; 2] = ["webp", "gif"];
    let main = pick(&item.file, &["md", "hd", "sm"], &ANIMATED)?;
    let thumbnail = pick(&item.file, &["sm", "xs", "md"], &ANIMATED).unwrap_or(main);
    let still = pick(&item.file, &["md", "sm", "hd"], &["jpg"]);
    let id = match &item.id {
        Value::String(id) => id.clone(),
        Value::Number(id) => id.to_string(),
        _ => return None,
    };
    Some(Gif {
        id,
        slug: item.slug,
        title: item.title.chars().take(200).collect(),
        url: main.url.clone(),
        thumbnail: thumbnail.url.clone(),
        still: still.map(|r| r.url.clone()),
        width: main.width.unwrap_or(0),
        height: main.height.unwrap_or(0),
    })
}

/// Turns Klipy's response into a page for the picker, keeping its order.
fn parse(body: &str, page: u32) -> Result<GifPage, KlipyError> {
    let envelope: Envelope = serde_json::from_str(body)
        .map_err(|error| KlipyError::Unavailable(format!("resposta inválida: {error}")))?;
    let data = envelope
        .data
        .filter(|_| envelope.result)
        .ok_or_else(|| KlipyError::Unavailable("a resposta não trouxe resultados".into()))?;
    let results = data
        .data
        .into_iter()
        .filter_map(|item| serde_json::from_value(item).ok())
        .filter_map(gif)
        .collect();
    Ok(GifPage {
        results,
        page: data.current_page.unwrap_or(page),
        has_next: data.has_next,
    })
}

/// A Klipy media URL, as the API returned it: HTTPS on Klipy's CDN.
pub(crate) fn media_url(value: &str) -> bool {
    if value.len() > 2048 || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url
            .host_str()
            .is_some_and(|host| MEDIA_HOSTS.contains(&host))
}

/// A GIF chosen in the picker, sent back to be kept (in a message or profile).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GifChoice {
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub title: String,
    pub url: String,
    pub still: Option<String>,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
}

impl GifChoice {
    /// Only URLs from Klipy's CDN are kept, and the text fields are bounded.
    pub(crate) fn validate(self) -> ApiResult<Self> {
        let still_ok = self.still.as_deref().is_none_or(media_url);
        if !media_url(&self.url) || !still_ok || self.width > 10_000 || self.height > 10_000 {
            return Err(ApiError::bad("Escolha um GIF do Klipy."));
        }
        let clean = |value: &str, max: usize| -> String {
            value
                .chars()
                .filter(|c| !c.is_control())
                .take(max)
                .collect::<String>()
                .trim()
                .to_owned()
        };
        Ok(Self {
            slug: clean(&self.slug, 200),
            title: clean(&self.title, 200),
            ..self
        })
    }
}

/// A stable id per user for Klipy's personalization, without revealing the user id.
fn customer_id(user: Uuid) -> String {
    format!("{:x}", Sha256::digest(format!("disc-voice:{user}")))[..32].to_owned()
}

impl Klipy {
    pub(crate) fn new(config: KlipyConfig, http: reqwest::Client) -> Self {
        Self {
            config,
            http,
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// Trending GIFs when `query` is empty, search results otherwise.
    pub(crate) async fn page(
        &self,
        query: &str,
        page: u32,
        user: Uuid,
    ) -> Result<GifPage, KlipyError> {
        let key = (query.to_lowercase(), page);
        {
            let cache = self.cache.lock().await;
            if let Some((fetched, page)) = cache.get(&key) {
                if fetched.elapsed() < CACHE_TTL {
                    return Ok(page.clone());
                }
            }
        }
        let result = self.fetch(query, page, user).await?;
        let mut cache = self.cache.lock().await;
        if cache.len() >= CACHE_ENTRIES {
            cache.retain(|_, (fetched, _)| fetched.elapsed() < CACHE_TTL);
            if cache.len() >= CACHE_ENTRIES {
                cache.clear();
            }
        }
        cache.insert(key, (Instant::now(), result.clone()));
        Ok(result)
    }

    async fn fetch(&self, query: &str, page: u32, user: Uuid) -> Result<GifPage, KlipyError> {
        let endpoint = if query.is_empty() {
            "trending"
        } else {
            "search"
        };
        let base = format!(
            "{}/api/v1/{}/gifs/{endpoint}",
            self.config.api_url.trim_end_matches('/'),
            self.config.api_key
        );
        let page_text = page.to_string();
        let per_page = PER_PAGE.to_string();
        let customer = customer_id(user);
        let mut params = vec![
            ("page", page_text.as_str()),
            ("per_page", per_page.as_str()),
            ("customer_id", customer.as_str()),
            ("locale", LOCALE),
            ("content_filter", CONTENT_FILTER),
            ("format_filter", "gif,webp,jpg"),
        ];
        if !query.is_empty() {
            params.push(("q", query));
        }
        let response = self
            .http
            .get(base)
            .query(&params)
            .send()
            .await
            // Without the URL: it carries the key.
            .map_err(|error| {
                KlipyError::Unavailable(format!("falha na requisição: {}", error.without_url()))
            })?;
        let status = response.status();
        if status == StatusCode::TOO_MANY_REQUESTS {
            return Err(KlipyError::RateLimited);
        }
        let body = response.text().await.map_err(|error| {
            KlipyError::Unavailable(format!("falha ao ler a resposta: {}", error.without_url()))
        })?;
        if !status.is_success() {
            let excerpt: String = body
                .chars()
                .take(200)
                .collect::<String>()
                .replace(&self.config.api_key, "***");
            return Err(KlipyError::Unavailable(format!("HTTP {status}: {excerpt}")));
        }
        parse(&body, page)
    }
}

#[derive(Deserialize)]
pub(crate) struct GifQuery {
    #[serde(default)]
    q: String,
    page: Option<u32>,
}

/// `GET /api/gifs?q=&page=`: search, or trending without `q`.
pub(crate) async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Query(input): Query<GifQuery>,
) -> ApiResult<Json<GifPage>> {
    let klipy = state.klipy.as_ref().ok_or_else(|| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "Os GIFs não estão configurados neste servidor.".into(),
        )
    })?;
    let query = input.q.split_whitespace().collect::<Vec<_>>().join(" ");
    if query.chars().count() > 100 {
        return Err(ApiError::bad("A busca deve ter até 100 caracteres."));
    }
    let page = input.page.unwrap_or(1).clamp(1, 50);
    Ok(Json(klipy.page(&query, page, user.id).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::RawQuery, routing::get, Router};
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn rendition(name: &str, size: u32) -> Value {
        json!({ "url": format!("https://static.klipy.com/ii/abc/{name}"), "width": size, "height": size, "size": 1000 })
    }

    fn sample() -> Value {
        json!({ "result": true, "data": {
            "data": [
                { "id": 8041071659142944u64, "slug": "hello-hi-662", "title": "Hello", "type": "gif",
                  "file": {
                    "hd": { "gif": rendition("hd.gif", 498), "webp": rendition("hd.webp", 498), "jpg": rendition("hd.jpg", 498) },
                    "md": { "gif": rendition("md.gif", 498), "webp": rendition("md.webp", 498), "jpg": rendition("md.jpg", 498) },
                    "sm": { "gif": rendition("sm.gif", 220), "webp": rendition("sm.webp", 220), "jpg": rendition("sm.jpg", 220) }
                  } },
                { "id": 2, "slug": "only-gif", "title": "Só GIF", "type": "gif",
                  "file": { "hd": { "gif": rendition("only.gif", 300) } } },
                { "id": 3, "type": "ad", "file": {} },
                { "id": 4, "slug": "evil", "type": "gif",
                  "file": { "md": { "gif": { "url": "https://evil.example/x.gif" } } } }
            ],
            "current_page": 1, "per_page": 24, "has_next": true
        }})
    }

    #[test]
    fn parses_gifs_in_order_and_skips_the_rest() {
        let page = parse(&sample().to_string(), 1).unwrap();
        assert!(page.has_next);
        assert_eq!(page.results.len(), 2);
        let first = &page.results[0];
        assert_eq!(first.id, "8041071659142944");
        assert_eq!(first.url, "https://static.klipy.com/ii/abc/md.webp");
        assert_eq!(first.thumbnail, "https://static.klipy.com/ii/abc/sm.webp");
        assert_eq!(
            first.still.as_deref(),
            Some("https://static.klipy.com/ii/abc/md.jpg")
        );
        assert_eq!((first.width, first.height), (498, 498));
        let second = &page.results[1];
        assert_eq!(second.url, "https://static.klipy.com/ii/abc/only.gif");
        assert_eq!(second.thumbnail, second.url);
        assert_eq!(second.still, None);
    }

    #[test]
    fn rejects_failed_responses() {
        assert!(parse(r#"{"result":false}"#, 1).is_err());
        assert!(parse("not json", 1).is_err());
    }

    #[test]
    fn only_klipy_media_urls_are_kept() {
        assert!(media_url("https://static.klipy.com/ii/a/b.gif"));
        assert!(media_url("https://static2.klipy.com/ii/a/b.webp"));
        assert!(!media_url("http://static.klipy.com/ii/a/b.gif"));
        assert!(!media_url("https://static.klipy.com.evil.example/b.gif"));
        assert!(!media_url("https://user@static.klipy.com/b.gif"));
        assert!(!media_url("https://static.klipy.com:8443/b.gif"));
        assert!(!media_url("javascript:alert(1)"));
        let choice = GifChoice {
            slug: "a".into(),
            title: " Oi\u{0}  ".into(),
            url: "https://static.klipy.com/ii/a/b.gif".into(),
            still: Some("https://evil.example/s.jpg".into()),
            width: 1,
            height: 1,
        };
        assert!(choice.clone().validate().is_err());
        let ok = GifChoice {
            still: None,
            ..choice
        }
        .validate()
        .unwrap();
        assert_eq!(ok.title, "Oi");
    }

    #[test]
    fn customer_ids_are_stable_and_opaque() {
        let user = Uuid::new_v4();
        assert_eq!(customer_id(user), customer_id(user));
        assert_eq!(customer_id(user).len(), 32);
        assert!(!customer_id(user).contains(&user.simple().to_string()));
    }

    /// A fake Klipy that counts calls and records the query string.
    async fn fake(status: StatusCode) -> (Klipy, Arc<AtomicUsize>, Arc<std::sync::Mutex<String>>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(std::sync::Mutex::new(String::new()));
        let (counter, last) = (calls.clone(), seen.clone());
        let route = get(move |RawQuery(query): RawQuery| {
            let (counter, last) = (counter.clone(), last.clone());
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                *last.lock().unwrap() = query.unwrap_or_default();
                (status, Json(sample()))
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let app = Router::new()
                .route("/api/v1/secret-key/gifs/trending", route.clone())
                .route("/api/v1/secret-key/gifs/search", route);
            axum::serve(listener, app).await.unwrap();
        });
        let klipy = Klipy::new(
            KlipyConfig {
                api_key: "secret-key".into(),
                api_url: format!("http://{address}"),
            },
            reqwest::Client::new(),
        );
        (klipy, calls, seen)
    }

    #[tokio::test]
    async fn searches_and_caches_pages() {
        let (klipy, calls, seen) = fake(StatusCode::OK).await;
        let user = Uuid::new_v4();
        let page = klipy.page("gato feliz", 2, user).await.unwrap();
        assert_eq!(page.results.len(), 2);
        let query = seen.lock().unwrap().clone();
        assert!(query.contains("q=gato+feliz"), "{query}");
        assert!(query.contains("page=2"), "{query}");
        assert!(query.contains(&format!("customer_id={}", customer_id(user))));
        // Same search, another user: served from the cache.
        klipy.page("Gato Feliz", 2, Uuid::new_v4()).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        klipy.page("", 1, user).await.unwrap();
        assert!(!seen.lock().unwrap().contains("q="));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn reports_rate_limits_and_errors_without_the_key() {
        let (klipy, calls, _) = fake(StatusCode::TOO_MANY_REQUESTS).await;
        assert_eq!(
            klipy.page("", 1, Uuid::new_v4()).await,
            Err(KlipyError::RateLimited)
        );
        // Failures are not cached.
        assert!(klipy.page("", 1, Uuid::new_v4()).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        let (klipy, _, _) = fake(StatusCode::UNAUTHORIZED).await;
        let Err(KlipyError::Unavailable(reason)) = klipy.page("oi", 1, Uuid::new_v4()).await else {
            panic!("expected an error");
        };
        assert!(reason.contains("401"), "{reason}");
        assert!(!reason.contains("secret-key"), "{reason}");
    }
}
