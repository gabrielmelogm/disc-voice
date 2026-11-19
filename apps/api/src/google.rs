//! Google Sign-In: exchanges an authorization code (PKCE) for an ID token.
//!
//! The client secret stays on the API. The ID token comes straight from
//! Google's token endpoint over TLS, so (per OpenID Connect) its signature does
//! not need to be checked, only its claims.

use crate::ApiError;
use axum::http::StatusCode;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use std::env;

pub const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const CALLBACK_PATH: &str = "/auth/google/callback";

#[derive(Clone, Debug)]
pub struct OAuthClient {
    pub id: String,
    pub secret: String,
}

impl OAuthClient {
    fn from_env(prefix: &str) -> Option<Self> {
        let id = env::var(format!("{prefix}_CLIENT_ID")).ok()?;
        let secret = env::var(format!("{prefix}_CLIENT_SECRET")).ok()?;
        (!id.trim().is_empty() && !secret.trim().is_empty()).then(|| Self {
            id: id.trim().into(),
            secret: secret.trim().into(),
        })
    }
}

#[derive(Clone, Debug)]
pub struct GoogleConfig {
    pub desktop: Option<OAuthClient>,
    pub web: Option<OAuthClient>,
    /// Overridable so tests can point it at a local fake.
    pub token_url: String,
}

impl GoogleConfig {
    pub fn from_env() -> Self {
        Self {
            desktop: OAuthClient::from_env("GOOGLE_DESKTOP"),
            web: OAuthClient::from_env("GOOGLE_WEB"),
            token_url: TOKEN_URL.into(),
        }
    }

    pub fn disabled() -> Self {
        Self {
            desktop: None,
            web: None,
            token_url: TOKEN_URL.into(),
        }
    }
}

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Desktop,
    Web,
}

/// Desktop apps use a loopback redirect on any port; the web client redirects
/// to the app's own callback route.
pub(crate) fn valid_redirect(platform: Platform, uri: &str) -> bool {
    let Ok(parsed) = uri.parse::<axum::http::Uri>() else {
        return false;
    };
    if parsed.query().is_some() {
        return false;
    }
    match platform {
        Platform::Desktop => {
            parsed.scheme_str() == Some("http")
                && parsed.host() == Some("127.0.0.1")
                && parsed.port_u16().is_some()
                && matches!(parsed.path(), "" | "/")
        }
        Platform::Web => {
            let local = matches!(parsed.host(), Some("localhost" | "127.0.0.1"));
            (parsed.scheme_str() == Some("https") || (local && parsed.scheme_str() == Some("http")))
                && parsed.path() == CALLBACK_PATH
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
    /// Profile photo, kept only when it is a reasonable HTTPS URL.
    #[serde(default)]
    pub picture: Option<String>,
}

#[derive(Deserialize)]
struct RawClaims {
    iss: String,
    aud: String,
    exp: i64,
    sub: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    email_verified: Option<serde_json::Value>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    picture: Option<String>,
}

/// Google serves photos at `...=s96-c`; ask for a size that stays sharp in
/// the large profile avatars.
fn picture(url: Option<String>) -> Option<String> {
    let url = url?;
    let parsed = url.parse::<axum::http::Uri>().ok()?;
    if parsed.scheme_str() != Some("https") || parsed.host().is_none() || url.len() > 2000 {
        return None;
    }
    Some(match url.rsplit_once("=s96-c") {
        Some((base, "")) => format!("{base}=s256-c"),
        _ => url,
    })
}

fn rejected() -> ApiError {
    ApiError(
        StatusCode::UNAUTHORIZED,
        "Não foi possível entrar com o Google. Tente novamente.".into(),
    )
}

/// Validates the claims of an ID token issued for `client_id`.
pub(crate) fn claims(id_token: &str, client_id: &str, now: i64) -> Result<Claims, ApiError> {
    let payload = id_token.split('.').nth(1).ok_or_else(rejected)?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .map_err(|_| rejected())?;
    let raw: RawClaims = serde_json::from_slice(&bytes).map_err(|_| rejected())?;
    let verified = matches!(raw.email_verified, Some(serde_json::Value::Bool(true)))
        || matches!(&raw.email_verified, Some(serde_json::Value::String(s)) if s == "true");
    if !matches!(
        raw.iss.as_str(),
        "https://accounts.google.com" | "accounts.google.com"
    ) || raw.aud != client_id
        || raw.exp <= now
        || raw.sub.is_empty()
    {
        return Err(rejected());
    }
    let email = raw
        .email
        .map(|e| e.trim().to_lowercase())
        .unwrap_or_default();
    if email.is_empty() || !verified {
        return Err(ApiError::bad(
            "Sua conta Google precisa ter um e-mail verificado.",
        ));
    }
    Ok(Claims {
        sub: raw.sub,
        email,
        name: raw.name,
        picture: picture(raw.picture),
    })
}

#[derive(Deserialize)]
struct TokenResponse {
    id_token: String,
}

pub(crate) async fn exchange(
    http: &reqwest::Client,
    token_url: &str,
    client: &OAuthClient,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<Claims, ApiError> {
    let response = http
        .post(token_url)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect_uri),
            ("client_id", &client.id),
            ("client_secret", &client.secret),
        ])
        .send()
        .await
        .map_err(ApiError::internal)?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        tracing::warn!(%status, %body, "Google recusou o código de autorização");
        return Err(rejected());
    }
    let token: TokenResponse = response.json().await.map_err(ApiError::internal)?;
    claims(&token.id_token, &client.id, chrono::Utc::now().timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(claims: serde_json::Value) -> String {
        format!(
            "e30.{}.sig",
            URL_SAFE_NO_PAD.encode(claims.to_string().as_bytes())
        )
    }

    #[test]
    fn redirects() {
        assert!(valid_redirect(Platform::Desktop, "http://127.0.0.1:53124"));
        assert!(valid_redirect(Platform::Desktop, "http://127.0.0.1:53124/"));
        assert!(!valid_redirect(Platform::Desktop, "http://evil.com:80"));
        assert!(!valid_redirect(Platform::Desktop, "http://127.0.0.1"));
        assert!(valid_redirect(
            Platform::Web,
            "https://discvoice.example/auth/google/callback"
        ));
        assert!(valid_redirect(
            Platform::Web,
            "http://localhost:1420/auth/google/callback"
        ));
        assert!(!valid_redirect(
            Platform::Web,
            "http://discvoice.example/auth/google/callback"
        ));
        assert!(!valid_redirect(Platform::Web, "https://discvoice.example/"));
    }

    #[test]
    fn validates_claims() {
        let good = serde_json::json!({
            "iss": "https://accounts.google.com", "aud": "client", "exp": 200,
            "sub": "123", "email": "Ana@Example.com", "email_verified": true, "name": "Ana"
        });
        let parsed = claims(&token(good.clone()), "client", 100).unwrap();
        assert_eq!(
            (parsed.sub.as_str(), parsed.email.as_str()),
            ("123", "ana@example.com")
        );
        for (key, value) in [
            ("aud", serde_json::json!("other")),
            ("iss", serde_json::json!("https://evil.com")),
            ("exp", serde_json::json!(50)),
            ("email_verified", serde_json::json!(false)),
        ] {
            let mut bad = good.clone();
            bad[key] = value;
            assert!(claims(&token(bad), "client", 100).is_err(), "{key}");
        }
        assert!(claims("garbage", "client", 100).is_err());
    }

    #[test]
    fn pictures() {
        assert_eq!(
            picture(Some("https://lh3.googleusercontent.com/a/abc=s96-c".into())).as_deref(),
            Some("https://lh3.googleusercontent.com/a/abc=s256-c")
        );
        assert_eq!(
            picture(Some("https://lh3.googleusercontent.com/a/abc".into())).as_deref(),
            Some("https://lh3.googleusercontent.com/a/abc")
        );
        assert_eq!(picture(Some("http://example.com/a.png".into())), None);
        assert_eq!(picture(Some("javascript:alert(1)".into())), None);
        assert_eq!(picture(None), None);
    }
}
