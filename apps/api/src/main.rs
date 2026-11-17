use disc_api::{migration::Migrator, router, AppState};
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
    let origins = env::var("CORS_ORIGINS")
        .unwrap_or_else(|_| format!("{web_url},http://localhost:1420,http://127.0.0.1:1420,https://tauri.localhost,http://tauri.localhost,tauri://localhost"))
        .split(',').map(|s| s.trim().parse()).collect::<Result<Vec<_>, _>>()?;
    let dist = PathBuf::from(env::var("WEB_DIST").unwrap_or_else(|_| "apps/desktop/dist".into()));
    let app = router(AppState::new(db, web_url), origins).fallback_service(
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
