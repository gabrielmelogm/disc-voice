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
            Box::new(Friendships),
            Box::new(MemberRoles),
            Box::new(DiscordLogin),
            Box::new(GifProfiles),
            Box::new(UserFiles),
            Box::new(ReactionsAndEdits),
            Box::new(RolesAndBans),
        ]
    }
}

struct RolesAndBans;

impl MigrationName for RolesAndBans {
    fn name(&self) -> &str {
        "m20261203_000016_roles_and_bans"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for RolesAndBans {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Permission bits (see `roles::Permission`): 2 manage channels,
        // 8 create invite, 16 manage messages, 32 mention everyone, 64 ban.
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            ALTER TABLE servers ADD COLUMN description varchar(1024) NOT NULL DEFAULT '';
            -- Roles of a server; the one whose id is the server's is
            -- @everyone, which every member has (position 0).
            CREATE TABLE roles (
                id uuid PRIMARY KEY,
                server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                name varchar(100) NOT NULL CHECK (length(trim(name)) > 0),
                color integer CHECK (color BETWEEN 0 AND 16777215),
                position integer NOT NULL CHECK (position >= 0),
                permissions bigint NOT NULL DEFAULT 0,
                created_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE INDEX roles_server ON roles(server_id, position);
            CREATE TABLE member_roles (
                server_id uuid NOT NULL,
                user_id uuid NOT NULL,
                role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
                PRIMARY KEY (server_id, user_id, role_id),
                FOREIGN KEY (server_id, user_id)
                    REFERENCES members(server_id, user_id) ON DELETE CASCADE
            );
            CREATE INDEX member_roles_role ON member_roles(role_id);
            CREATE TABLE bans (
                server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                banned_by uuid REFERENCES users(id) ON DELETE SET NULL,
                reason varchar(512) NOT NULL DEFAULT '',
                created_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (server_id, user_id)
            );
            -- @everyone keeps what any member could do: create channels and
            -- share the invite.
            INSERT INTO roles (id, server_id, name, position, permissions)
                SELECT id, id, '@everyone', 0, 10 FROM servers;
            -- Moderators become a "Moderador" role with what they could do,
            -- plus deleting messages and banning.
            INSERT INTO roles (id, server_id, name, color, position, permissions)
                SELECT gen_random_uuid(), server_id, 'Moderador', 3066993, 1, 112
                FROM members WHERE role = 'moderator' GROUP BY server_id;
            INSERT INTO member_roles (server_id, user_id, role_id)
                SELECT m.server_id, m.user_id, r.id FROM members m
                JOIN roles r ON r.server_id = m.server_id AND r.name = 'Moderador'
                WHERE m.role = 'moderator';
            ALTER TABLE members DROP COLUMN role;
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
            ALTER TABLE members ADD COLUMN role varchar(16) NOT NULL DEFAULT 'member'
                CHECK (role IN ('member', 'moderator'));
            UPDATE members m SET role = 'moderator' FROM member_roles mr
                JOIN roles r ON r.id = mr.role_id
                WHERE mr.server_id = m.server_id AND mr.user_id = m.user_id
                  AND r.permissions & 16 <> 0;
            DROP TABLE bans, member_roles, roles;
            ALTER TABLE servers DROP COLUMN description;
            "#,
            )
            .await?;
        Ok(())
    }
}

struct ReactionsAndEdits;

impl MigrationName for ReactionsAndEdits {
    fn name(&self) -> &str {
        "m20261202_000015_reactions_and_edits"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for ReactionsAndEdits {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            -- When the author last changed the text ("(editado)").
            ALTER TABLE messages ADD COLUMN edited_at timestamptz;
            -- One row per person and emoji on a message; deleting the
            -- message or the account removes them.
            CREATE TABLE message_reactions (
                message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
                user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                emoji varchar(64) NOT NULL CHECK (length(emoji) > 0),
                created_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (message_id, emoji, user_id)
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
                "DROP TABLE message_reactions; ALTER TABLE messages DROP COLUMN edited_at;",
            )
            .await?;
        Ok(())
    }
}

struct UserFiles;

impl MigrationName for UserFiles {
    fn name(&self) -> &str {
        "m20261201_000014_user_files"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for UserFiles {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            -- Files people send in chats: each counts against its owner's
            -- space until they delete it. Media copied from Discord has no
            -- owner. `storage` says where the bytes are: the API's disk or
            -- the S3 bucket.
            ALTER TABLE files
                ADD COLUMN owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
                ADD COLUMN storage varchar(8) NOT NULL DEFAULT 'local'
                    CHECK (storage IN ('local', 's3')),
                ADD COLUMN width integer,
                ADD COLUMN height integer;
            CREATE INDEX files_owner_idx ON files (owner_id, created_at DESC)
                WHERE owner_id IS NOT NULL;
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
            DROP INDEX files_owner_idx;
            ALTER TABLE files
                DROP COLUMN owner_id,
                DROP COLUMN storage,
                DROP COLUMN width,
                DROP COLUMN height;
            "#,
            )
            .await?;
        Ok(())
    }
}

struct GifProfiles;

impl MigrationName for GifProfiles {
    fn name(&self) -> &str {
        "m20261129_000013_gif_profiles"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for GifProfiles {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            -- A GIF from Klipy as the photo (avatar_source = 'gif') or the
            -- banner. Only Klipy's links are kept, with a still frame for
            -- people who prefer reduced motion.
            ALTER TABLE users
                DROP CONSTRAINT IF EXISTS users_avatar_source_check,
                ADD CONSTRAINT users_avatar_source_check
                    CHECK (avatar_source IN ('google', 'discord', 'gif')),
                ADD COLUMN avatar_still varchar(2048),
                ADD COLUMN banner_gif varchar(2048),
                ADD COLUMN banner_still varchar(2048);
            -- A GIF can be sent without text.
            ALTER TABLE messages
                DROP CONSTRAINT messages_content_check,
                ADD CONSTRAINT messages_content_check CHECK (
                    length(content) <= 4000
                    AND (discord_id IS NOT NULL
                        OR length(trim(content)) >= 1
                        OR jsonb_array_length(attachments) > 0));
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
            UPDATE messages SET content = 'GIF'
                WHERE discord_id IS NULL AND length(trim(content)) = 0;
            ALTER TABLE messages
                DROP CONSTRAINT messages_content_check,
                ADD CONSTRAINT messages_content_check CHECK (
                    length(content) <= 4000
                    AND (discord_id IS NOT NULL OR length(trim(content)) >= 1));
            UPDATE users SET avatar_url = NULL, avatar_source = NULL WHERE avatar_source = 'gif';
            ALTER TABLE users
                DROP COLUMN banner_still,
                DROP COLUMN banner_gif,
                DROP COLUMN avatar_still,
                DROP CONSTRAINT IF EXISTS users_avatar_source_check,
                ADD CONSTRAINT users_avatar_source_check
                    CHECK (avatar_source IN ('google', 'discord'));
            "#,
            )
            .await?;
        Ok(())
    }
}

struct DiscordLogin;

impl MigrationName for DiscordLogin {
    fn name(&self) -> &str {
        "m20261128_000012_discord_login"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for DiscordLogin {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            -- Signing in with Discord: the user's OAuth2 token lists the Discord
            -- servers they manage, to import them. `consent_at` is when they
            -- answered what the integration may use (photo, activity).
            ALTER TABLE discord_accounts
                ADD COLUMN access_token text,
                ADD COLUMN refresh_token text,
                ADD COLUMN token_expires_at timestamptz,
                ADD COLUMN consent_at timestamptz;
            -- Linked before this existed: they already chose in the settings.
            UPDATE discord_accounts SET consent_at = linked_at;
            -- Which account the profile photo follows.
            ALTER TABLE users ADD COLUMN avatar_source varchar(8)
                CHECK (avatar_source IN ('google', 'discord'));
            UPDATE users SET avatar_source = 'google' WHERE avatar_url IS NOT NULL;
            ALTER TABLE servers ADD COLUMN icon_url varchar(512);
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
            ALTER TABLE servers DROP COLUMN icon_url;
            ALTER TABLE users DROP COLUMN avatar_source;
            ALTER TABLE discord_accounts
                DROP COLUMN consent_at,
                DROP COLUMN token_expires_at,
                DROP COLUMN refresh_token,
                DROP COLUMN access_token;
            "#,
            )
            .await?;
        Ok(())
    }
}

struct MemberRoles;

impl MigrationName for MemberRoles {
    fn name(&self) -> &str {
        "m20261127_000011_member_roles"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for MemberRoles {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            -- The owner is servers.owner_id; other members are moderators or members.
            ALTER TABLE members ADD COLUMN role varchar(16) NOT NULL DEFAULT 'member'
                CHECK (role IN ('member', 'moderator'));
            "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("ALTER TABLE members DROP COLUMN role;")
            .await?;
        Ok(())
    }
}

struct Friendships;

impl MigrationName for Friendships {
    fn name(&self) -> &str {
        "m20261126_000010_friendships"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Friendships {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            -- A friend request, and once accepted, the friendship itself.
            -- Declining, cancelling and removing all delete the row.
            CREATE TABLE friendships (
                requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                addressee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                status varchar(8) NOT NULL CHECK (status IN ('pending', 'accepted')),
                created_at timestamptz NOT NULL DEFAULT now(),
                accepted_at timestamptz,
                PRIMARY KEY (requester_id, addressee_id),
                CHECK (requester_id <> addressee_id)
            );
            -- One row per pair, whoever asked first.
            CREATE UNIQUE INDEX friendships_pair ON friendships
                (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));
            CREATE INDEX friendships_addressee ON friendships(addressee_id);
            "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE friendships;")
            .await?;
        Ok(())
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
