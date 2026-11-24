//! What users are doing right now ("Jogando Minecraft"). Activities live in
//! memory and reach the people who share a server with the user. Discord is
//! the first source; others (e.g. games detected by the desktop app) can
//! publish through [`set`] with their own `source`.
use super::*;
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Activity {
    /// playing, streaming, listening, watching or competing.
    pub kind: &'static str,
    pub name: String,
    pub details: Option<String>,
    pub state: Option<String>,
    pub started_at: Option<chrono::DateTime<Utc>>,
    /// Thumbnail URL (album cover, game art or app icon).
    pub image: Option<String>,
    /// Tooltip of the thumbnail, e.g. the album name.
    pub image_text: Option<String>,
    /// Where it came from, e.g. `discord`.
    pub source: &'static str,
}

/// The user and everyone who shares a server with them.
pub(crate) async fn audience(db: &DatabaseConnection, user: Uuid) -> ApiResult<HashSet<Uuid>> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT DISTINCT theirs.user_id FROM members mine
               JOIN members theirs ON theirs.server_id = mine.server_id
               WHERE mine.user_id = $1"#,
            [user.into()],
        ))
        .await?;
    let mut users: HashSet<Uuid> = rows
        .iter()
        .filter_map(|row| row.try_get("", "user_id").ok())
        .collect();
    users.insert(user);
    Ok(users)
}

/// Sets (or clears, with `None`) a user's activity and tells who can see it.
pub(crate) async fn set(state: &AppState, user: Uuid, activity: Option<Activity>) -> ApiResult<()> {
    if !state.realtime.set_activity(user, activity.clone()) {
        return Ok(());
    }
    let audience = audience(&state.db, user).await?;
    state.realtime.publish_users(
        &audience,
        serde_json::json!({ "type": "activity.updated", "userId": user, "activity": activity }),
    );
    Ok(())
}

/// Current activities of the people the user can see, by user id.
pub(crate) async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
) -> ApiResult<Json<HashMap<Uuid, Activity>>> {
    let audience = audience(&state.db, user.id).await?;
    Ok(Json(state.realtime.activities(&audience)))
}
