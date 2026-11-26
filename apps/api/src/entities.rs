pub mod user {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "users")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub email: String,
        pub name: String,
        pub pronouns: String,
        pub bio: String,
        pub banner: String,
        pub password_hash: Option<String>,
        #[sea_orm(unique)]
        pub google_sub: Option<String>,
        pub avatar_url: Option<String>,
        pub created_at: DateTimeUtc,
        /// `google` or `discord`: the account the photo follows; `gif` for
        /// a GIF from Klipy.
        pub avatar_source: Option<String>,
        /// Still frame of a GIF avatar (reduced motion).
        pub avatar_still: Option<String>,
        /// A GIF from Klipy shown as the banner, and its still frame.
        pub banner_gif: Option<String>,
        pub banner_still: Option<String>,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod session {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "sessions")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub token_hash: String,
        pub user_id: Uuid,
        pub expires_at: DateTimeUtc,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod server {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "servers")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub name: String,
        pub owner_id: Uuid,
        pub created_at: DateTimeUtc,
        /// Imported from Discord; otherwise initials are shown.
        pub icon_url: Option<String>,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod member {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "members")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub server_id: Uuid,
        #[sea_orm(primary_key, auto_increment = false)]
        pub user_id: Uuid,
        pub joined_at: DateTimeUtc,
        /// `member` or `moderator`; the owner is `servers.owner_id`.
        pub role: String,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod invite {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "invites")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub code: Uuid,
        pub server_id: Uuid,
        pub created_at: DateTimeUtc,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod channel {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "channels")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        /// Absent on direct message conversations (`kind == "dm"`).
        pub server_id: Option<Uuid>,
        pub name: String,
        #[sea_orm(column_name = "type")]
        pub kind: String,
        pub created_by: Uuid,
        pub created_at: DateTimeUtc,
        /// `local`, or `discord` for a read-only mirror of a Discord channel.
        pub source: String,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod dm_channel {
    use sea_orm::entity::prelude::*;

    /// The two people of a direct message conversation, with `user_a < user_b`.
    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "dm_channels")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub channel_id: Uuid,
        pub user_a: Uuid,
        pub user_b: Uuid,
    }
    impl Model {
        /// The person on the other side of the conversation.
        pub fn other(&self, user: Uuid) -> Uuid {
            if self.user_a == user {
                self.user_b
            } else {
                self.user_a
            }
        }
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod message {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "messages")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i64,
        pub channel_id: Uuid,
        /// Absent on messages imported from Discord.
        pub author_id: Option<Uuid>,
        pub client_id: Uuid,
        pub content: String,
        pub created_at: DateTimeUtc,
        pub discord_id: Option<String>,
        pub discord_author: Option<Json>,
        pub attachments: Json,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod file {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "files")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub name: String,
        pub content_type: String,
        pub size: i64,
        pub created_at: DateTimeUtc,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod discord_account {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "discord_accounts")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub user_id: Uuid,
        #[sea_orm(unique)]
        pub discord_id: String,
        pub username: String,
        pub display_name: Option<String>,
        pub avatar_url: Option<String>,
        pub share_activity: bool,
        pub linked_at: DateTimeUtc,
        pub access_token: Option<String>,
        pub refresh_token: Option<String>,
        pub token_expires_at: Option<DateTimeUtc>,
        /// When the user answered what the integration may use; until then
        /// the app asks them.
        pub consent_at: Option<DateTimeUtc>,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod discord_guild {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "discord_guilds")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub server_id: Uuid,
        #[sea_orm(primary_key, auto_increment = false)]
        pub guild_id: String,
        pub name: String,
        pub icon_url: Option<String>,
        pub linked_by: Uuid,
        pub linked_at: DateTimeUtc,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}

pub mod discord_import {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "discord_imports")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub channel_id: Uuid,
        pub server_id: Uuid,
        pub guild_id: String,
        pub discord_channel_id: String,
        pub discord_channel_name: String,
        pub phase: String,
        pub status: String,
        pub cursor: Option<String>,
        pub imported: i64,
        pub error: Option<String>,
        pub retry_at: Option<DateTimeUtc>,
        pub created_by: Uuid,
        pub created_at: DateTimeUtc,
        pub synced_at: Option<DateTimeUtc>,
    }
    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}
    impl ActiveModelBehavior for ActiveModel {}
}
