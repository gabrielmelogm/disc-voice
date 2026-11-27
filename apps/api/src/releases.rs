//! Tells every open desktop app that a new version was released.
//!
//! `.github/workflows/desktop.yml` calls `POST /api/releases/notify` with
//! `Authorization: Bearer <RELEASE_NOTIFY_TOKEN>` once the update manifests are
//! published. Each live connection gets `app.update` with the version and its
//! channels; the app then shows a discreet notice. No download link goes out
//! here: the app asks the website for a signed one only when the user clicks
//! to update.
use super::*;
use axum::http::HeaderMap;

pub(crate) const CHANNELS: [&str; 3] = ["alpha", "beta", "stable"];

#[derive(Deserialize)]
pub(crate) struct Released {
    version: String,
    channels: Vec<String>,
}

/// A semver version like `1.2.3` or `0.1.0-alpha.4`.
pub(crate) fn valid_version(version: &str) -> bool {
    let (core, pre) = match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    };
    let parts: Vec<_> = core.split('.').collect();
    version.len() <= 64
        && parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        && pre.is_none_or(|pre| {
            !pre.is_empty()
                && pre
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        })
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    let given = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    // Comparing digests keeps the time independent of where they differ.
    !token.is_empty() && Sha256::digest(given.as_bytes()) == Sha256::digest(token.as_bytes())
}

pub(crate) async fn notify(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Released>,
) -> ApiResult<StatusCode> {
    let Some(token) = state.release_token.as_deref() else {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Rota não encontrada.".into(),
        ));
    };
    if !authorized(&headers, token) {
        return Err(ApiError::unauthorized());
    }
    let version = body.version.trim_start_matches('v');
    if !valid_version(version) {
        return Err(ApiError::bad("Versão inválida."));
    }
    let mut channels: Vec<&str> = CHANNELS
        .into_iter()
        .filter(|name| body.channels.iter().any(|c| c == name))
        .collect();
    channels.dedup();
    if channels.is_empty() || channels.len() != body.channels.len() {
        return Err(ApiError::bad("Canais inválidos."));
    }
    let count = state.realtime.publish_all(
        serde_json::json!({ "type": "app.update", "version": version, "channels": channels }),
    );
    tracing::info!(%version, ?channels, connections = count, "Nova versão do app anunciada");
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_semver_versions() {
        for version in ["1.2.3", "0.1.0-alpha.4", "10.0.0-rc.1"] {
            assert!(valid_version(version), "{version}");
        }
        for version in [
            "",
            "1.2",
            "1.2.3.4",
            "1.x.3",
            "1.2.3-",
            "1.2.3-a b",
            "1.2.3+<script>",
        ] {
            assert!(!valid_version(version), "{version}");
        }
    }

    #[test]
    fn checks_the_bearer_token() {
        let mut headers = HeaderMap::new();
        assert!(!authorized(&headers, "secret"));
        headers.insert(header::AUTHORIZATION, "Bearer wrong".parse().unwrap());
        assert!(!authorized(&headers, "secret"));
        headers.insert(header::AUTHORIZATION, "Bearer secret".parse().unwrap());
        assert!(authorized(&headers, "secret"));
        assert!(!authorized(&headers, ""));
    }
}
