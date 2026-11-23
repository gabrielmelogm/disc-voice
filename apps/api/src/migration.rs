use sea_orm_migration::prelude::*;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(Initial),
            Box::new(Chat),
            Box::new(UserName),
            Box::new(ProfileAndSearch),
            Box::new(GoogleAuth),
            Box::new(Avatar),
            Box::new(Discord),
            Box::new(OneTimeImportAndFiles),
            Box::new(DmsAndReadState),
        ]
    }
}

struct DmsAndReadState;

impl MigrationName for DmsAndReadState {
    fn name(&self) -> &str {
        "m20261125_000009_dms_and_read_state"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for DmsAndReadState {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            -- A direct message conversation is a channel outside any server.
            ALTER TABLE channels
                ALTER COLUMN server_id DROP NOT NULL,
                DROP CONSTRAINT channels_type_check,
                ADD CONSTRAINT channels_type_check CHECK (type IN ('text', 'voice', 'dm')),
                ADD CONSTRAINT channels_dm_check CHECK ((type = 'dm') = (server_id IS NULL));
            -- The two people of a conversation, in a fixed order so a pair has one row.
            CREATE TABLE dm_channels (
                channel_id uuid PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
                user_a uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                user_b uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                CHECK (user_a < user_b),
                UNIQUE (user_a, user_b)
            );
            CREATE INDEX dm_channels_user_b ON dm_channels(user_b);
            -- The last message each person has read in each channel.
            CREATE TABLE channel_reads (
                user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
                last_read_message_id bigint NOT NULL,
                updated_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (user_id, channel_id)
            );
            -- Existing history counts as read, so nobody starts with every channel unread.
            INSERT INTO channel_reads (user_id, channel_id, last_read_message_id)
            SELECT m.user_id, c.id, latest.id
            FROM channels c
            JOIN members m ON m.server_id = c.server_id
            JOIN LATERAL (SELECT max(id) AS id FROM messages WHERE channel_id = c.id) latest ON true
            WHERE c.type = 'text' AND latest.id IS NOT NULL;
            "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            DROP TABLE channel_reads, dm_channels;
            DELETE FROM channels WHERE type = 'dm';
            ALTER TABLE channels
                DROP CONSTRAINT channels_dm_check,
                DROP CONSTRAINT channels_type_check,
                ADD CONSTRAINT channels_type_check CHECK (type IN ('text', 'voice')),
                ALTER COLUMN server_id SET NOT NULL;
            "#,
            )
            .await?;
        Ok(())
    }
}

struct OneTimeImportAndFiles;

impl MigrationName for OneTimeImportAndFiles {
    fn name(&self) -> &str {
        "m20261124_000008_one_time_import_and_files"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for OneTimeImportAndFiles {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            -- A text and a voice channel may share a name (e.g. "geral").
            ALTER TABLE channels
                DROP CONSTRAINT channels_server_id_name_key,
                ADD CONSTRAINT channels_server_id_type_name_key UNIQUE (server_id, type, name);
            -- Imports run once: after the backlog the channel belongs to Disc Voice.
            ALTER TABLE discord_imports DROP CONSTRAINT discord_imports_phase_check;
            UPDATE discord_imports SET phase = 'done', status = 'idle' WHERE phase = 'sync';
            ALTER TABLE discord_imports ADD CONSTRAINT discord_imports_phase_check
                CHECK (phase IN ('history', 'done'));
            -- Files kept by the API (e.g. media copied from Discord).
            CREATE TABLE files (
                id uuid PRIMARY KEY,
                name varchar(255) NOT NULL,
                content_type varchar(100) NOT NULL,
                size bigint NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now()
            );
            "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            DROP TABLE files;
            ALTER TABLE discord_imports DROP CONSTRAINT discord_imports_phase_check;
            UPDATE discord_imports SET phase = 'sync' WHERE phase = 'done';
            ALTER TABLE discord_imports ADD CONSTRAINT discord_imports_phase_check
                CHECK (phase IN ('history', 'sync'));
            ALTER TABLE channels
                DROP CONSTRAINT channels_server_id_type_name_key,
                ADD CONSTRAINT channels_server_id_name_key UNIQUE (server_id, name);
            "#,
            )
            .await?;
        Ok(())
    }
}

struct Discord;

impl MigrationName for Discord {
    fn name(&self) -> &str {
        "m20261123_000007_discord"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Discord {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            -- A Discord account linked to a Disc Voice user (OAuth2 identify).
            CREATE TABLE discord_accounts (
                user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                discord_id varchar(24) NOT NULL UNIQUE,
                username varchar(64) NOT NULL,
                display_name varchar(64),
                avatar_url varchar(512),
                share_activity boolean NOT NULL DEFAULT true,
                linked_at timestamptz NOT NULL DEFAULT now()
            );
            -- A Discord server where the bot was installed for a Disc Voice server.
            CREATE TABLE discord_guilds (
                server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                guild_id varchar(24) NOT NULL,
                name varchar(100) NOT NULL,
                icon_url varchar(512),
                linked_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                linked_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (server_id, guild_id)
            );
            CREATE INDEX discord_guilds_guild ON discord_guilds(guild_id);
            -- A Discord text channel mirrored into a read-only Disc Voice channel.
            -- `history` walks the backlog oldest first; `sync` then follows new messages.
            CREATE TABLE discord_imports (
                channel_id uuid PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
                server_id uuid NOT NULL,
                guild_id varchar(24) NOT NULL,
                discord_channel_id varchar(24) NOT NULL,
                discord_channel_name varchar(100) NOT NULL,
                phase varchar(8) NOT NULL DEFAULT 'history' CHECK (phase IN ('history', 'sync')),
                status varchar(8) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'idle', 'error')),
                cursor varchar(24),
                imported bigint NOT NULL DEFAULT 0,
                error text,
                retry_at timestamptz,
                created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at timestamptz NOT NULL DEFAULT now(),
                synced_at timestamptz,
                UNIQUE (server_id, discord_channel_id),
                FOREIGN KEY (server_id, guild_id) REFERENCES discord_guilds(server_id, guild_id) ON DELETE CASCADE
            );
            CREATE INDEX discord_imports_work ON discord_imports(status, created_at);
            CREATE INDEX discord_imports_source ON discord_imports(discord_channel_id);
            ALTER TABLE channels ADD COLUMN source varchar(8) NOT NULL DEFAULT 'local'
                CHECK (source IN ('local', 'discord'));
            -- Imported messages keep the Discord author instead of a local one,
            -- may have no text (attachments only) and are unique per channel.
            ALTER TABLE messages
                ALTER COLUMN author_id DROP NOT NULL,
                ADD COLUMN discord_id varchar(24),
                ADD COLUMN discord_author jsonb,
                ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]',
                DROP CONSTRAINT messages_content_check,
                ADD CONSTRAINT messages_content_check CHECK (
                    length(content) <= 4000
                    AND (discord_id IS NOT NULL OR length(trim(content)) >= 1)),
                ADD CONSTRAINT messages_author_check CHECK (
                    author_id IS NOT NULL OR discord_author IS NOT NULL);
            CREATE UNIQUE INDEX messages_discord ON messages(channel_id, discord_id)
                WHERE discord_id IS NOT NULL;
            "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            DELETE FROM messages WHERE discord_id IS NOT NULL;
            DROP INDEX messages_discord;
            ALTER TABLE messages
                DROP CONSTRAINT messages_author_check,
                DROP CONSTRAINT messages_content_check,
                ADD CONSTRAINT messages_content_check CHECK (length(trim(content)) BETWEEN 1 AND 4000),
                DROP COLUMN attachments,
                DROP COLUMN discord_author,
                DROP COLUMN discord_id,
                ALTER COLUMN author_id SET NOT NULL;
            ALTER TABLE channels DROP COLUMN source;
            DROP TABLE discord_imports, discord_guilds, discord_accounts;
            "#,
            )
            .await?;
        Ok(())
    }
}

struct Avatar;

impl MigrationName for Avatar {
    fn name(&self) -> &str {
        "m20261119_000006_avatar"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Avatar {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("ALTER TABLE users ADD COLUMN avatar_url varchar(2048);")
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("ALTER TABLE users DROP COLUMN avatar_url;")
            .await?;
        Ok(())
    }
}

struct GoogleAuth;

impl MigrationName for GoogleAuth {
    fn name(&self) -> &str {
        "m20261118_000005_google_auth"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for GoogleAuth {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            ALTER TABLE users
                ADD COLUMN google_sub text UNIQUE,
                ALTER COLUMN password_hash DROP NOT NULL;
            "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("ALTER TABLE users DROP COLUMN google_sub;")
            .await?;
        Ok(())
    }
}

struct ProfileAndSearch;

impl MigrationName for ProfileAndSearch {
    fn name(&self) -> &str {
        "m20261118_000004_profile_and_search"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for ProfileAndSearch {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            ALTER TABLE users
                ADD COLUMN pronouns varchar(40) NOT NULL DEFAULT '',
                ADD COLUMN bio varchar(190) NOT NULL DEFAULT '',
                ADD COLUMN banner varchar(16) NOT NULL DEFAULT 'brand'
                    CHECK (banner IN ('brand', 'green', 'amber', 'red', 'graphite'));
            CREATE INDEX messages_search ON messages USING gin (to_tsvector('simple', content));
            "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "DROP INDEX messages_search; ALTER TABLE users DROP COLUMN pronouns, DROP COLUMN bio, DROP COLUMN banner;",
            )
            .await?;
        Ok(())
    }
}

struct UserName;

impl MigrationName for UserName {
    fn name(&self) -> &str {
        "m20261117_000003_user_name"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for UserName {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            ALTER TABLE users ADD COLUMN name varchar(32);
            UPDATE users SET name = left(split_part(email, '@', 1), 32);
            ALTER TABLE users ALTER COLUMN name SET NOT NULL,
                ADD CONSTRAINT users_name_not_blank CHECK (length(trim(name)) > 0);
            "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("ALTER TABLE users DROP COLUMN name;")
            .await?;
        Ok(())
    }
}

struct Chat;

impl MigrationName for Chat {
    fn name(&self) -> &str {
        "m20261117_000002_chat"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Chat {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            ALTER TABLE channels ADD COLUMN type varchar(8) NOT NULL DEFAULT 'text'
                CHECK (type IN ('text', 'voice'));
            CREATE TABLE messages (
                id bigserial PRIMARY KEY,
                channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
                author_id uuid NOT NULL REFERENCES users(id),
                client_id uuid NOT NULL,
                content text NOT NULL CHECK (length(trim(content)) BETWEEN 1 AND 4000),
                created_at timestamptz NOT NULL DEFAULT now(),
                UNIQUE (author_id, client_id)
            );
            CREATE INDEX messages_channel_history ON messages(channel_id, id);
            "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE messages; ALTER TABLE channels DROP COLUMN type;")
            .await?;
        Ok(())
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
