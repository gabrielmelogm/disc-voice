//! Files kept by the API: what people send in chats (counted against their
//! space, listed in their gallery) and media copied from imported Discord
//! messages. Served at `/api/files/{id}/{name}`.
//!
//! Ids are random, so links work like Discord's CDN: whoever has the link can
//! open the file. Only well-known media types are shown inline; everything
//! else downloads, and nothing served here can run scripts in the app's origin.
//!
//! With a bucket configured (see [`crate::storage`]) new files go to S3 and
//! the link redirects to a short-lived signed URL; otherwise they stay in the
//! uploads directory.
use super::*;
use axum::{
    body::{Body, Bytes},
    extract::{rejection::BytesRejection, Query},
    http::HeaderMap,
};
use entities::file;
use sea_orm::{ConnectionTrait, DbBackend, FromQueryResult, Statement};
use std::path::PathBuf;
use tower::ServiceExt;
use tower_http::services::ServeFile;

/// Largest file anyone can send (and the largest Discord attachment copied).
pub(crate) const MAX_FILE_BYTES: u64 = 15 * 1024 * 1024;
/// Space each person has for the files they send.
pub(crate) const QUOTA_BYTES: u64 = 1024 * 1024 * 1024;
/// Files attached to one message.
pub(crate) const MAX_FILES_PER_MESSAGE: usize = 10;

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

/// Programs, scripts, installers and shortcuts: they could run on the
/// computer of whoever opens them, so nobody can send them. Pages and SVG are
/// here too, since they can run scripts when opened.
const BLOCKED_EXTENSIONS: &[&str] = &[
    // Windows programs and libraries
    "exe",
    "com",
    "scr",
    "pif",
    "cpl",
    "dll",
    "sys",
    "drv",
    "ocx",
    "msi",
    "msp",
    "mst",
    "msc",
    "gadget",
    "appx",
    "appxbundle",
    "msix",
    "msixbundle",
    "application",
    "xbap",
    // Scripts
    "bat",
    "cmd",
    "ps1",
    "ps1xml",
    "ps2",
    "psc1",
    "psd1",
    "psm1",
    "vb",
    "vbe",
    "vbs",
    "js",
    "jse",
    "mjs",
    "wsf",
    "wsh",
    "wsc",
    "ws",
    "hta",
    "sct",
    "sh",
    "bash",
    "zsh",
    "csh",
    "ksh",
    "command",
    "py",
    "pyw",
    "pyc",
    "rb",
    "pl",
    "php",
    "jar",
    "class",
    "scpt",
    "applescript",
    // Shortcuts, registry and settings that run things
    "lnk",
    "url",
    "inf",
    "reg",
    "scf",
    "library-ms",
    "settingcontent-ms",
    "desktop",
    // Installers and packages for other systems
    "apk",
    "xapk",
    "ipa",
    "app",
    "dmg",
    "pkg",
    "mpkg",
    "deb",
    "rpm",
    "run",
    "bin",
    "elf",
    "appimage",
    "snap",
    "flatpakref",
    // Office documents with macros
    "docm",
    "dotm",
    "xlsm",
    "xltm",
    "xlam",
    "pptm",
    "potm",
    "ppam",
    "ppsm",
    "sldm",
    // Pages and images that run scripts
    "html",
    "htm",
    "xhtml",
    "shtml",
    "mht",
    "mhtml",
    "svg",
    "svgz",
    "xml",
    "xsl",
    // Disk images that open as drives (and hide their contents from scans)
    "iso",
    "img",
    "vhd",
    "vhdx",
];

/// Start of program files, whatever the name says.
fn executable(bytes: &[u8]) -> bool {
    const SIGNATURES: &[&[u8]] = &[
        b"MZ",               // Windows (PE)
        b"\x7fELF",          // Linux
        b"\xfe\xed\xfa\xce", // macOS (Mach-O)
        b"\xfe\xed\xfa\xcf",
        b"\xce\xfa\xed\xfe",
        b"\xcf\xfa\xed\xfe",
        b"\xca\xfe\xba\xbe",                 // Mach-O universal, Java class
        b"#!",                               // scripts
        b"\x4c\x00\x00\x00\x01\x14\x02\x00", // Windows shortcut
    ];
    SIGNATURES.iter().any(|s| bytes.starts_with(s))
}

/// Image type from the file's first bytes: only these are ever shown inline.
fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && matches!(&bytes[8..12], b"avif" | b"avis")
    {
        Some("image/avif")
    } else {
        None
    }
}

/// Width and height of a PNG or GIF, to keep its box while it loads.
fn dimensions(kind: &str, bytes: &[u8]) -> Option<(i32, i32)> {
    let (w, h) = match kind {
        "image/png" if bytes.len() >= 24 => (
            u32::from_be_bytes(bytes[16..20].try_into().ok()?),
            u32::from_be_bytes(bytes[20..24].try_into().ok()?),
        ),
        "image/gif" if bytes.len() >= 10 => (
            u16::from_le_bytes([bytes[6], bytes[7]]) as u32,
            u16::from_le_bytes([bytes[8], bytes[9]]) as u32,
        ),
        _ => return None,
    };
    let valid = |v: u32| (1..=100_000).contains(&v);
    (valid(w) && valid(h)).then_some((w as i32, h as i32))
}

/// Type for files that are not images, from the extension.
fn type_for_extension(extension: &str) -> &'static str {
    match extension {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "pdf" => "application/pdf",
        "txt" | "log" | "md" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "zip" => "application/zip",
        "7z" => "application/x-7z-compressed",
        "rar" => "application/vnd.rar",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

/// The name shown and saved: no folders or control characters, and no
/// trailing dots or spaces (Windows drops them, so `a.exe.` would run).
fn file_name(name: &str) -> ApiResult<String> {
    let name = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let name: String = name
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .trim_end_matches(['.', ' '])
        .chars()
        .take(255)
        .collect();
    if name.is_empty() {
        return Err(ApiError::bad("Dê um nome ao arquivo."));
    }
    Ok(name)
}

fn extension(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((_, ext)) => ext.to_ascii_lowercase(),
        None => String::new(),
    }
}

/// What a sent file is stored as, or why it is refused.
fn check(name: &str, bytes: &[u8]) -> ApiResult<(&'static str, Option<(i32, i32)>)> {
    let blocked = || {
        ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Este tipo de arquivo não é permitido, porque pode executar programas no computador de quem abrir.".into(),
        )
    };
    // Every extension counts: `foto.exe.png` is as suspicious as `foto.png.exe`.
    if name
        .split('.')
        .skip(1)
        .any(|part| BLOCKED_EXTENSIONS.contains(&part.trim().to_ascii_lowercase().as_str()))
    {
        return Err(blocked());
    }
    if executable(bytes) {
        return Err(blocked());
    }
    if bytes.is_empty() {
        return Err(ApiError::bad("O arquivo está vazio."));
    }
    Ok(match sniff_image(bytes) {
        Some(kind) => (kind, dimensions(kind, bytes)),
        None => (type_for_extension(&extension(name)), None),
    })
}

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

/// Id of a file kept here, from its URL (the inverse of [`url`]); `None` for
/// links elsewhere, like Discord's CDN.
pub(crate) fn stored_id(url: &str) -> Option<Uuid> {
    let (id, _) = url.strip_prefix("/api/files/")?.split_once('/')?;
    Uuid::parse_str(id).ok()
}

/// Whether a stored file is an image the app shows inline.
pub(crate) fn is_image(content_type: &str) -> bool {
    matches!(
        content_type,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif"
    )
}

/// Deletes a file that belongs to no one (e.g. a replaced server icon).
pub(crate) async fn discard(state: &AppState, id: Uuid) {
    let found = file::Entity::find_by_id(id)
        .filter(file::Column::OwnerId.is_null())
        .one(&state.db)
        .await;
    let file = match found {
        Ok(Some(file)) => file,
        Ok(None) => return,
        Err(error) => {
            tracing::warn!(%error, file = %id, "Não foi possível apagar o arquivo");
            return;
        }
    };
    if let Err(error) = file::Entity::delete_by_id(id).exec(&state.db).await {
        tracing::warn!(%error, file = %id, "Não foi possível apagar o arquivo");
        return;
    }
    erase(state, id, &file.storage).await;
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

/// Writes the bytes where new files go: the bucket, or the uploads directory.
async fn write(state: &AppState, id: Uuid, kind: &str, bytes: Vec<u8>) -> ApiResult<&'static str> {
    if let Some(bucket) = &state.bucket {
        bucket
            .put(id, kind, bytes)
            .await
            .map_err(ApiError::internal)?;
        return Ok("s3");
    }
    tokio::fs::create_dir_all(&state.uploads)
        .await
        .map_err(ApiError::internal)?;
    tokio::fs::write(path(state, id), bytes)
        .await
        .map_err(ApiError::internal)?;
    Ok("local")
}

async fn erase(state: &AppState, id: Uuid, storage: &str) {
    let result = match (storage, &state.bucket) {
        ("s3", Some(bucket)) => bucket.delete(id).await,
        ("s3", None) => Err("bucket não configurado".into()),
        _ => tokio::fs::remove_file(path(state, id))
            .await
            .map_err(|e| e.to_string()),
    };
    if let Err(error) = result {
        tracing::warn!(%error, file = %id, "Não foi possível apagar o arquivo guardado");
    }
}

/// Keeps media copied from Discord (no owner, no quota).
pub(crate) async fn store(
    state: &AppState,
    name: &str,
    kind: Option<&str>,
    bytes: &[u8],
) -> ApiResult<file::Model> {
    let id = Uuid::new_v4();
    let kind = content_type(kind);
    let storage = write(state, id, &kind, bytes.to_vec()).await?;
    let row = file::ActiveModel {
        id: Set(id),
        name: Set(name.chars().take(255).collect()),
        content_type: Set(kind),
        size: Set(bytes.len() as i64),
        created_at: Set(Utc::now()),
        owner_id: Set(None),
        storage: Set(storage.into()),
        width: Set(None),
        height: Set(None),
    }
    .insert(&state.db)
    .await;
    if let Err(error) = row {
        erase(state, id, storage).await;
        return Err(error.into());
    }
    Ok(row?)
}

/// A file in the sender's gallery.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileView {
    id: Uuid,
    name: String,
    url: String,
    size: i64,
    content_type: String,
    width: Option<i32>,
    height: Option<i32>,
    created_at: chrono::DateTime<Utc>,
}

impl From<file::Model> for FileView {
    fn from(f: file::Model) -> Self {
        Self {
            url: url(f.id, &f.name),
            id: f.id,
            name: f.name,
            size: f.size,
            content_type: f.content_type,
            width: f.width,
            height: f.height,
            created_at: f.created_at,
        }
    }
}

#[derive(FromQueryResult)]
struct Used {
    used: Option<i64>,
}

async fn used(db: &impl ConnectionTrait, owner: Uuid) -> ApiResult<u64> {
    // SUM of bigint is numeric in PostgreSQL: cast it back.
    let row = Used::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT COALESCE(SUM(size), 0)::bigint AS used FROM files WHERE owner_id = $1",
        [owner.into()],
    ))
    .one(db)
    .await?;
    Ok(row.and_then(|r| r.used).unwrap_or(0).max(0) as u64)
}

#[derive(Deserialize)]
pub(crate) struct UploadQuery {
    name: String,
}

fn too_large() -> ApiError {
    ApiError(
        StatusCode::PAYLOAD_TOO_LARGE,
        "O arquivo passa do limite de 15 MB.".into(),
    )
}

/// `POST /files?name=...` with the file as the body. The file is kept in the
/// sender's space; send it by listing its id in a message's `files`.
pub(crate) async fn upload(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Query(input): Query<UploadQuery>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> ApiResult<(StatusCode, Json<FileView>)> {
    let bytes = body.map_err(|rejection| {
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            too_large()
        } else {
            ApiError::bad("Não foi possível receber o arquivo.")
        }
    })?;
    // The body limit already holds this; kept for clarity if the limit moves.
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(too_large());
    }
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|len| len != bytes.len() as u64) {
        return Err(ApiError::bad("Não foi possível receber o arquivo."));
    }
    let name = file_name(&input.name)?;
    let (kind, size) = check(&name, &bytes)?;
    let id = Uuid::new_v4();
    let tx = state.db.begin().await?;
    // One upload at a time per person, so two can't both fit in the last bit of space.
    tx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [format!("files:{}", user.id).into()],
    ))
    .await?;
    if used(&tx, user.id).await? + bytes.len() as u64 > QUOTA_BYTES {
        return Err(ApiError(
            StatusCode::INSUFFICIENT_STORAGE,
            "Seu espaço de 1 GB na nuvem está cheio. Apague arquivos na galeria para liberar espaço.".into(),
        ));
    }
    let len = bytes.len() as i64;
    let storage = write(&state, id, kind, bytes.into()).await?;
    let row = file::ActiveModel {
        id: Set(id),
        name: Set(name),
        content_type: Set(kind.into()),
        size: Set(len),
        created_at: Set(Utc::now()),
        owner_id: Set(Some(user.id)),
        storage: Set(storage.into()),
        width: Set(size.map(|s| s.0)),
        height: Set(size.map(|s| s.1)),
    }
    .insert(&tx)
    .await;
    let row = match row {
        Ok(row) => row,
        Err(error) => {
            erase(&state, id, storage).await;
            return Err(error.into());
        }
    };
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(row.into())))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Gallery {
    files: Vec<FileView>,
    used: u64,
    quota: u64,
    max_file_size: u64,
}

/// Everything the user has sent, newest first, and the space it takes.
pub(crate) async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
) -> ApiResult<Json<Gallery>> {
    let files = file::Entity::find()
        .filter(file::Column::OwnerId.eq(user.id))
        .order_by_desc(file::Column::CreatedAt)
        .order_by_desc(file::Column::Id)
        .all(&state.db)
        .await?;
    Ok(Json(Gallery {
        used: files.iter().map(|f| f.size.max(0) as u64).sum(),
        files: files.into_iter().map(Into::into).collect(),
        quota: QUOTA_BYTES,
        max_file_size: MAX_FILE_BYTES,
    }))
}

/// Deletes one of the user's files, freeing its space. Messages that had it
/// keep the name, marked as deleted.
pub(crate) async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let file = file::Entity::find_by_id(id)
        .filter(file::Column::OwnerId.eq(user.id))
        .one(&state.db)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Arquivo não encontrado.".into()))?;
    let tx = state.db.begin().await?;
    tx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"UPDATE messages SET attachments = (
               SELECT jsonb_agg(CASE WHEN a->>'id' = $1
                   THEN a || '{"deleted": true}'::jsonb ELSE a END ORDER BY i)
               FROM jsonb_array_elements(attachments) WITH ORDINALITY AS t(a, i))
           WHERE attachments @> $2::jsonb"#,
        [
            id.to_string().into(),
            serde_json::json!([{ "id": id.to_string() }]).into(),
        ],
    ))
    .await?;
    file::Entity::delete_by_id(id).exec(&tx).await?;
    tx.commit().await?;
    erase(&state, file.id, &file.storage).await;
    Ok(StatusCode::NO_CONTENT)
}

/// The user's own files with these ids, in that order.
pub(crate) async fn owned(
    state: &AppState,
    owner: Uuid,
    ids: &[Uuid],
) -> ApiResult<Vec<file::Model>> {
    if ids.len() > MAX_FILES_PER_MESSAGE {
        return Err(ApiError::bad("Envie no máximo 10 arquivos por mensagem."));
    }
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut rows = file::Entity::find()
        .filter(file::Column::Id.is_in(ids.to_vec()))
        .filter(file::Column::OwnerId.eq(owner))
        .all(&state.db)
        .await?;
    let mut ordered = Vec::with_capacity(ids.len());
    for id in ids {
        let Some(index) = rows.iter().position(|f| f.id == *id) else {
            return Err(ApiError::bad(
                "Um dos arquivos não existe mais. Envie-o de novo.",
            ));
        };
        ordered.push(rows.swap_remove(index));
    }
    Ok(ordered)
}

#[derive(Deserialize)]
pub(crate) struct ServeQuery {
    #[serde(default)]
    download: Option<String>,
}

pub(crate) async fn serve(
    State(state): State<AppState>,
    Path((id, _name)): Path<(Uuid, String)>,
    Query(query): Query<ServeQuery>,
    request: Request,
) -> ApiResult<Response> {
    let file = file::Entity::find_by_id(id)
        .one(&state.db)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Arquivo não encontrado.".into()))?;
    let inline = INLINE.contains(&file.content_type.as_str()) && query.download.is_none();
    let disposition = format!(
        "{}; filename*=UTF-8''{}",
        if inline { "inline" } else { "attachment" },
        encode(&file.name)
    );
    let value = |v: &str| HeaderValue::from_str(v).map_err(ApiError::internal);
    if file.storage == "s3" {
        let bucket = state.bucket.as_ref().ok_or_else(|| {
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "Os arquivos estão indisponíveis no momento.".into(),
            )
        })?;
        // Anything that is not shown inline downloads as plain bytes.
        let kind = if inline {
            file.content_type.as_str()
        } else {
            "application/octet-stream"
        };
        let link = bucket.link(file.id, kind, &disposition);
        let mut response = StatusCode::TEMPORARY_REDIRECT.into_response();
        let headers = response.headers_mut();
        headers.insert(header::LOCATION, value(&link)?);
        // Signed links last at least an hour; the redirect is cached for less.
        headers.insert(header::CACHE_CONTROL, value("private, max-age=1800")?);
        return Ok(response);
    }
    // Supports Range requests, so videos can seek.
    let response = ServeFile::new(path(&state, id))
        .oneshot(request)
        .await
        .map_err(ApiError::internal)?
        .map(Body::new);
    let (mut parts, body) = response.into_parts();
    if parts.status.is_success() {
        let headers = &mut parts.headers;
        headers.insert(header::CONTENT_TYPE, value(&file.content_type)?);
        headers.insert(header::CONTENT_DISPOSITION, value(&disposition)?);
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
        let id = Uuid::new_v4();
        assert_eq!(stored_id(&url(id, "ícone.png")), Some(id));
        assert_eq!(stored_id("https://cdn.discordapp.com/icons/1/a.png"), None);
        assert_eq!(stored_id("/api/files/nao-e-uuid/a.png"), None);
        assert!(is_image("image/webp") && !is_image("video/mp4"));
        assert_eq!(content_type(Some("Image/PNG; charset=x")), "image/png");
        assert_eq!(
            content_type(Some("text/html\r\nX: y")),
            "application/octet-stream"
        );
        assert_eq!(content_type(None), "application/octet-stream");
        assert!(!INLINE.contains(&"image/svg+xml"));
    }

    #[test]
    fn file_names_lose_folders_and_trailing_dots() {
        assert_eq!(file_name("C:\\Users\\a\\foto.png").unwrap(), "foto.png");
        assert_eq!(file_name("../../etc/passwd").unwrap(), "passwd");
        assert_eq!(file_name("virus.exe. . ").unwrap(), "virus.exe");
        assert_eq!(file_name("a\u{0}b\r\n.txt").unwrap(), "ab.txt");
        assert!(file_name("  ").is_err());
        assert!(file_name("pasta/").is_err());
    }

    #[test]
    fn dangerous_files_are_refused() {
        let text = b"oi";
        for name in [
            "setup.exe",
            "foto.png.exe",
            "foto.EXE.png",
            "run.ps1",
            "page.html",
            "logo.svg",
            "atalho.lnk",
            "planilha.xlsm",
            "app.apk",
        ] {
            assert!(check(name, text).is_err(), "{name}");
        }
        // A program renamed to look like a picture.
        assert!(check("foto.png", b"MZ\x90\x00").is_err());
        assert!(check("script.txt", b"#!/bin/sh\nrm -rf /").is_err());
        assert!(check("vazio.txt", b"").is_err());
        assert_eq!(check("notas.txt", text).unwrap().0, "text/plain");
        assert_eq!(
            check("relatorio.pdf", b"%PDF-1.7").unwrap().0,
            "application/pdf"
        );
        assert_eq!(
            check("sem-extensao", text).unwrap().0,
            "application/octet-stream"
        );
    }

    #[test]
    fn images_are_typed_by_their_bytes() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&640u32.to_be_bytes());
        png.extend_from_slice(&480u32.to_be_bytes());
        assert_eq!(
            check("x.jpg", &png).unwrap(),
            ("image/png", Some((640, 480)))
        );
        assert_eq!(
            check("anim.gif", b"GIF89a\x10\x00\x20\x00").unwrap(),
            ("image/gif", Some((16, 32)))
        );
        assert_eq!(check("f.jpg", b"\xff\xd8\xff\xe0").unwrap().0, "image/jpeg");
        assert_eq!(
            check("f.webp", b"RIFF\0\0\0\0WEBPVP8 ").unwrap().0,
            "image/webp"
        );
        // Named like an image, but it isn't one: never shown inline.
        assert_eq!(
            check("fake.png", b"hello").unwrap().0,
            "application/octet-stream"
        );
    }
}
