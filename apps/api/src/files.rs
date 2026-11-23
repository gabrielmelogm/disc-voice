//! Files kept by the API (for now, media copied from imported Discord
//! messages), served at `/api/files/{id}/{name}`.
//!
//! Ids are random, so links work like Discord's CDN: whoever has the link can
//! open the file. Only well-known media types are shown inline; everything
//! else downloads, and nothing served here can run scripts in the app's origin.
use super::*;
use axum::body::Body;
use entities::file;
use std::path::PathBuf;
use tower::ServiceExt;
use tower_http::services::ServeFile;

/// Larger attachments keep only their original link.
pub(crate) const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;

/// Shown in the app (images, video and audio players).
const INLINE: [&str; 13] = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "video/mp4",
    "video/webm",
    "video/ogg",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
    "audio/mp4",
];

fn path(state: &AppState, id: Uuid) -> PathBuf {
    state.uploads.join(id.simple().to_string())
}

/// Percent-encodes everything but unreserved characters (RFC 3986).
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// API-relative URL of a stored file; the client resolves it against its API base.
pub(crate) fn url(id: Uuid, name: &str) -> String {
    format!("/api/files/{id}/{}", encode(name))
}

/// A plain `type/subtype`, or `application/octet-stream`.
fn content_type(value: Option<&str>) -> String {
    let value = value
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let valid = value.len() <= 100
        && value.split('/').count() == 2
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/.+-".contains(&b));
    if valid {
        value
    } else {
        "application/octet-stream".into()
    }
}

pub(crate) async fn store(
    state: &AppState,
    name: &str,
    kind: Option<&str>,
    bytes: &[u8],
) -> ApiResult<file::Model> {
    let id = Uuid::new_v4();
    let target = path(state, id);
    tokio::fs::create_dir_all(&state.uploads)
        .await
        .map_err(ApiError::internal)?;
    tokio::fs::write(&target, bytes)
        .await
        .map_err(ApiError::internal)?;
    let row = file::ActiveModel {
        id: Set(id),
        name: Set(name.chars().take(255).collect()),
        content_type: Set(content_type(kind)),
        size: Set(bytes.len() as i64),
        created_at: Set(Utc::now()),
    }
    .insert(&state.db)
    .await;
    if row.is_err() {
        let _ = tokio::fs::remove_file(&target).await;
    }
    Ok(row?)
}

pub(crate) async fn serve(
    State(state): State<AppState>,
    Path((id, _name)): Path<(Uuid, String)>,
    request: Request,
) -> ApiResult<Response> {
    let file = file::Entity::find_by_id(id)
        .one(&state.db)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Arquivo não encontrado.".into()))?;
    // Supports Range requests, so videos can seek.
    let response = ServeFile::new(path(&state, id))
        .oneshot(request)
        .await
        .map_err(ApiError::internal)?
        .map(Body::new);
    let (mut parts, body) = response.into_parts();
    if parts.status.is_success() {
        let inline = INLINE.contains(&file.content_type.as_str());
        let headers = &mut parts.headers;
        let value = |v: &str| HeaderValue::from_str(v).map_err(ApiError::internal);
        headers.insert(header::CONTENT_TYPE, value(&file.content_type)?);
        headers.insert(
            header::CONTENT_DISPOSITION,
            value(&format!(
                "{}; filename*=UTF-8''{}",
                if inline { "inline" } else { "attachment" },
                encode(&file.name)
            ))?,
        );
        headers.insert(header::X_CONTENT_TYPE_OPTIONS, value("nosniff")?);
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            value("default-src 'none'; sandbox")?,
        );
        headers.insert(
            header::CACHE_CONTROL,
            value("public, max-age=31536000, immutable")?,
        );
    }
    Ok(Response::from_parts(parts, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_types_are_safe() {
        assert_eq!(
            url(Uuid::nil(), "foto de férias.png"),
            "/api/files/00000000-0000-0000-0000-000000000000/foto%20de%20f%C3%A9rias.png"
        );
        assert_eq!(encode("../a/b"), "..%2Fa%2Fb");
        assert_eq!(content_type(Some("Image/PNG; charset=x")), "image/png");
        assert_eq!(
            content_type(Some("text/html\r\nX: y")),
            "application/octet-stream"
        );
        assert_eq!(content_type(None), "application/octet-stream");
        assert!(!INLINE.contains(&"image/svg+xml"));
    }
}
