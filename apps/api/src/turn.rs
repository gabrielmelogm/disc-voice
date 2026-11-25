//! Managed TURN from Cloudflare Realtime.
//!
//! Voice is peer-to-peer WebRTC. When both peers sit behind NAT on different
//! networks, audio needs a TURN relay; Cloudflare's lets the server work without
//! opening router ports. The API exchanges its key for short-lived ICE servers
//! (`generate-ice-servers`) and shares them with every client until they near
//! expiry. The API token never leaves the server.

use serde::Deserialize;
use serde_json::Value;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub const API_URL: &str = "https://rtc.live.cloudflare.com/v1";
/// Lifetime requested for each credential (one day).
const TTL: Duration = Duration::from_secs(86_400);
/// Credentials are reused for half their lifetime, so clients always get at
/// least 12 hours of validity, longer than any call.
const REUSE: Duration = Duration::from_secs(TTL.as_secs() / 2);

pub struct CloudflareTurnConfig {
    pub key_id: String,
    pub api_token: String,
    /// Base of the Cloudflare Realtime API (overridden in tests).
    pub api_url: String,
}

impl CloudflareTurnConfig {
    /// Reads `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`; both must be set.
    pub fn from_env() -> Option<Self> {
        let var = |name| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        Some(Self {
            key_id: var("CLOUDFLARE_TURN_KEY_ID")?,
            api_token: var("CLOUDFLARE_TURN_API_TOKEN")?,
            api_url: API_URL.into(),
        })
    }
}

// Not `Debug`: the token must not end up in logs.
pub(crate) struct CloudflareTurn {
    config: CloudflareTurnConfig,
    http: reqwest::Client,
    cache: Mutex<Option<(Instant, Vec<Value>)>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Generated {
    ice_servers: Vec<IceServer>,
}

#[derive(Deserialize)]
struct IceServer {
    urls: Urls,
    username: Option<String>,
    credential: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Urls {
    One(String),
    Many(Vec<String>),
}

/// Browsers block port 53, so those URLs would only time out.
fn usable(url: &str) -> bool {
    let without_query = url.split('?').next().unwrap_or(url);
    !without_query.ends_with(":53")
}

/// Turns Cloudflare's response into `RTCIceServer` objects for the client.
fn parse(body: &str) -> Result<Vec<Value>, String> {
    let generated: Generated =
        serde_json::from_str(body).map_err(|error| format!("resposta inválida: {error}"))?;
    let servers: Vec<Value> = generated
        .ice_servers
        .into_iter()
        .filter_map(|server| {
            let urls: Vec<String> = match server.urls {
                Urls::One(url) => vec![url],
                Urls::Many(urls) => urls,
            }
            .into_iter()
            .filter(|url| usable(url))
            .collect();
            if urls.is_empty() {
                return None;
            }
            let mut value = serde_json::json!({ "urls": urls });
            if let (Some(username), Some(credential)) = (server.username, server.credential) {
                value["username"] = username.into();
                value["credential"] = credential.into();
            }
            Some(value)
        })
        .collect();
    let has_turn = servers.iter().any(|server| {
        server["urls"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .any(|url| url.starts_with("turn:") || url.starts_with("turns:"))
    });
    if !has_turn {
        return Err("a resposta não trouxe servidores TURN".into());
    }
    Ok(servers)
}

impl CloudflareTurn {
    pub(crate) fn new(config: CloudflareTurnConfig, http: reqwest::Client) -> Self {
        Self {
            config,
            http,
            cache: Mutex::new(None),
        }
    }

    /// ICE servers with fresh-enough credentials, asking Cloudflare only when
    /// the cached ones are past [`REUSE`]. Errors never include the token.
    pub(crate) async fn ice_servers(&self) -> Result<Vec<Value>, String> {
        // Held across the request so concurrent joins share one call.
        let mut cache = self.cache.lock().await;
        if let Some((fetched, servers)) = cache.as_ref() {
            if fetched.elapsed() < REUSE {
                return Ok(servers.clone());
            }
        }
        let servers = self.generate().await?;
        *cache = Some((Instant::now(), servers.clone()));
        Ok(servers)
    }

    async fn generate(&self) -> Result<Vec<Value>, String> {
        let url = format!(
            "{}/turn/keys/{}/credentials/generate-ice-servers",
            self.config.api_url.trim_end_matches('/'),
            self.config.key_id
        );
        let response = self
            .http
            .post(url)
            .bearer_auth(&self.config.api_token)
            .json(&serde_json::json!({ "ttl": TTL.as_secs() }))
            .send()
            .await
            // Without the URL: it carries the key id, which is harmless but noisy.
            .map_err(|error| format!("falha na requisição: {}", error.without_url()))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| format!("falha ao ler a resposta: {}", error.without_url()))?;
        if !status.is_success() {
            let excerpt: String = body.chars().take(200).collect();
            return Err(format!("HTTP {status}: {excerpt}"));
        }
        parse(&body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::HeaderMap, http::StatusCode, routing::post, Json, Router};
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn sample() -> Value {
        json!({ "iceServers": [
            { "urls": ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
            { "urls": [
                "turn:turn.cloudflare.com:3478?transport=udp",
                "turn:turn.cloudflare.com:53?transport=udp",
                "turn:turn.cloudflare.com:443?transport=tcp",
                "turns:turn.cloudflare.com:443?transport=tcp"
              ],
              "username": "user", "credential": "secret" }
        ]})
    }

    #[test]
    fn parses_ice_servers_and_drops_port_53() {
        let servers = parse(&sample().to_string()).unwrap();
        assert_eq!(
            servers,
            vec![
                json!({ "urls": ["stun:stun.cloudflare.com:3478"] }),
                json!({
                    "urls": [
                        "turn:turn.cloudflare.com:3478?transport=udp",
                        "turn:turn.cloudflare.com:443?transport=tcp",
                        "turns:turn.cloudflare.com:443?transport=tcp"
                    ],
                    "username": "user", "credential": "secret"
                }),
            ]
        );
    }

    #[test]
    fn accepts_a_single_url_string() {
        let body = json!({ "iceServers": [
            { "urls": "turn:turn.cloudflare.com:3478", "username": "u", "credential": "c" }
        ]});
        let servers = parse(&body.to_string()).unwrap();
        assert_eq!(servers[0]["urls"], json!(["turn:turn.cloudflare.com:3478"]));
    }

    #[test]
    fn rejects_responses_without_turn() {
        assert!(parse(r#"{"iceServers":[{"urls":["stun:stun.cloudflare.com:3478"]}]}"#).is_err());
        assert!(parse(r#"{"error":"nope"}"#).is_err());
        assert!(parse("not json").is_err());
    }

    /// A fake Cloudflare endpoint that counts calls and checks the request.
    async fn fake(status: StatusCode) -> (CloudflareTurn, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let route = post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                assert_eq!(headers["authorization"], "Bearer token");
                assert_eq!(body, json!({ "ttl": 86_400 }));
                (status, Json(sample()))
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let app =
                Router::new().route("/v1/turn/keys/key/credentials/generate-ice-servers", route);
            axum::serve(listener, app).await.unwrap();
        });
        let turn = CloudflareTurn::new(
            CloudflareTurnConfig {
                key_id: "key".into(),
                api_token: "token".into(),
                api_url: format!("http://{address}/v1"),
            },
            reqwest::Client::new(),
        );
        (turn, calls)
    }

    #[tokio::test]
    async fn generates_once_and_reuses_the_credentials() {
        let (turn, calls) = fake(StatusCode::CREATED).await;
        let first = turn.ice_servers().await.unwrap();
        let second = turn.ice_servers().await.unwrap();
        assert_eq!(first, second);
        assert_eq!(first[1]["username"], "user");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn regenerates_after_the_reuse_window() {
        let (turn, calls) = fake(StatusCode::CREATED).await;
        turn.ice_servers().await.unwrap();
        let stale = Instant::now().checked_sub(REUSE + Duration::from_secs(1));
        if let Some(stale) = stale {
            turn.cache.lock().await.as_mut().unwrap().0 = stale;
            turn.ice_servers().await.unwrap();
            assert_eq!(calls.load(Ordering::SeqCst), 2);
        }
    }

    #[tokio::test]
    async fn reports_errors_without_the_token() {
        let (turn, calls) = fake(StatusCode::UNAUTHORIZED).await;
        let error = turn.ice_servers().await.unwrap_err();
        assert!(error.contains("401"), "{error}");
        assert!(!error.contains("token"), "{error}");
        // Failures are not cached: the next join tries again.
        assert!(turn.ice_servers().await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
