use sea_orm_migration::prelude::*;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![Box::new(Initial)]
    }
}

#[derive(DeriveMigrationName)]
struct Initial;

#[async_trait::async_trait]
impl MigrationTrait for Initial {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            CREATE TABLE users (
                id uuid PRIMARY KEY,
                email varchar(254) NOT NULL UNIQUE,
                password_hash text NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE sessions (
                token_hash varchar(64) PRIMARY KEY,
                user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at timestamptz NOT NULL
            );
            CREATE INDEX sessions_expiry ON sessions(expires_at);
            CREATE TABLE servers (
                id uuid PRIMARY KEY,
                name varchar(100) NOT NULL CHECK (length(trim(name)) > 0),
                owner_id uuid NOT NULL REFERENCES users(id),
                created_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE members (
                server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                joined_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (server_id, user_id)
            );
            CREATE INDEX members_user ON members(user_id);
            CREATE TABLE invites (
                code uuid PRIMARY KEY,
                server_id uuid NOT NULL UNIQUE REFERENCES servers(id) ON DELETE CASCADE,
                created_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE channels (
                id uuid PRIMARY KEY,
                server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                name varchar(64) NOT NULL CHECK (length(name) > 0),
                created_by uuid NOT NULL REFERENCES users(id),
                created_at timestamptz NOT NULL DEFAULT now(),
                UNIQUE (server_id, name)
            );
            "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE channels, invites, members, servers, sessions, users;")
            .await?;
        Ok(())
    }
}
