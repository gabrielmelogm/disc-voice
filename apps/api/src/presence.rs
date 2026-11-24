//! Presence: whether someone has the app open, and the status they chose
//! (online, idle or do not disturb). It lives in memory, in the realtime hub,
//! and reaches the person's friends and everyone who shares a server with them.

use super::*;
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Status {
    #[default]
    Online,
    Idle,
    /// Do not disturb.
    Dnd,
    Offline,
}

/// Who sees a user's presence: their friends, the people who share a server
/// with them, and their own other devices.
async fn audience(state: &AppState, user: Uuid) -> ApiResult<HashSet<Uuid>> {
    let mut users = crate::activity::audience(&state.db, user).await?;
    users.extend(crate::friends::friend_ids(&state.db, user).await?);
    Ok(users)
}

/// Tells everyone who can see the user their current presence.
pub(crate) async fn announce(state: &AppState, user: Uuid) -> ApiResult<()> {
    let audience = audience(state, user).await?;
    // Read at the last moment, so a quick change is never overtaken by an older one.
    let status = state.realtime.presence(user);
    state.realtime.publish_users(
        &audience,
        serde_json::json!({ "type": "presence.updated", "userId": user, "status": status }),
    );
    Ok(())
}
