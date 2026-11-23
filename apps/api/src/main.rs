use disc_api::{
    discord::DiscordConfig, google::GoogleConfig, migration::Migrator, router, AppState,
};
use sea_orm::{ConnectOptions, Database};
use sea_orm_migration::MigratorTrait;
use std::{env, path::PathBuf, time::Duration};
use tower_http::services::{ServeDir, ServeFile};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "disc_api=info,tower_http=info".into()),
        )
        .init();
    let database_url = env::var("DATABASE_URL").map_err(|_| {
        "DATABASE_URL não está definida. Copie .env.example para .env na raiz do projeto."
    })?;
    let mut options = ConnectOptions::new(database_url);
    options
        .max_connections(10)
        .connect_timeout(Duration::from_secs(10))
        .sqlx_logging(false);
    let db = Database::connect(options).await.map_err(|error| {
        format!(
            "Não foi possível conectar ao PostgreSQL ({error}). \
             Inicie o banco com `npm run db:up` e confira se DATABASE_URL e \
             POSTGRES_PORT no .env apontam para a mesma porta."
        )
    })?;
    Migrator::up(&db, None).await.map_err(|error| {
        format!("Conectou ao PostgreSQL, mas não foi possível aplicar as migrações: {error}")
    })?;
    let web_url = env::var("PUBLIC_WEB_URL").unwrap_or_else(|_| "http://localhost:3001".into());
    let url = axum::http::Uri::try_from(&web_url)?;
    if !matches!(url.scheme_str(), Some("http" | "https"))
        || url.authority().is_none()
        || url.path() != "/"
        || url.query().is_some()
    {
        return Err("PUBLIC_WEB_URL deve ser uma origem HTTP(S), sem caminho ou query.".into());
    }
    let web_url = web_url.trim_end_matches('/').to_owned();
    let configured = env::var("CORS_ORIGINS")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "http://localhost:1420,http://127.0.0.1:1420,https://tauri.localhost,http://tauri.localhost,tauri://localhost".into());
    // The public web origin always serves the bundled client, so it must be
    // accepted by CORS and by the realtime WebSocket origin check.
    let origins: Vec<axum::http::HeaderValue> = std::iter::once(web_url.as_str())
        .chain(configured.split(','))
        .map(|s| s.trim().trim_end_matches('/'))
        .filter(|s| !s.is_empty())
        .map(str::parse)
        .collect::<Result<_, _>>()?;
    let dist = PathBuf::from(env::var("WEB_DIST").unwrap_or_else(|_| "apps/desktop/dist".into()));
    let google = GoogleConfig::from_env();
    if google.desktop.is_none() && google.web.is_none() {
        tracing::warn!(
            "Login com Google desativado: defina GOOGLE_DESKTOP_CLIENT_ID/SECRET e GOOGLE_WEB_CLIENT_ID/SECRET."
        );
    }
    let mut state = AppState::new(db, web_url, google)
        .with_uploads(env::var("UPLOADS_DIR").unwrap_or_else(|_| "data/uploads".into()));
    match DiscordConfig::from_env() {
        Some(config) => {
            // Discord only accepts redirects registered exactly as sent.
            tracing::info!(
                redirect = %format!("{}{}", state.web_url, disc_api::discord::CALLBACK_PATH),
                "Integração com o Discord ativa: cadastre este redirect em OAuth2 > Redirects no Developer Portal"
            );
            state = state.with_discord(config);
            disc_api::discord::spawn(&state);
        }
        None => tracing::warn!(
            "Integração com o Discord desativada: defina DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET e DISCORD_BOT_TOKEN."
        ),
    }
    let app = router(state, origins).fallback_service(
        ServeDir::new(&dist).not_found_service(ServeFile::new(dist.join("index.html"))),
    );
    let listener = tokio::net::TcpListener::bind(
        env::var("API_BIND").unwrap_or_else(|_| "127.0.0.1:3001".into()),
    )
    .await?;
    tracing::info!(address = %listener.local_addr()?, "Disc Voice API iniciada");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
