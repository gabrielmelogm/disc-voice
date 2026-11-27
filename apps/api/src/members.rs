//! Who is in a server: every member with their roles and presence.
//! The owner is the server's `owner_id`; roles are in [`crate::roles`].

use super::*;
use crate::presence::Status;
use std::collections::{HashMap, HashSet};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemberView {
    user: UserView,
    /// The server's owner, who can do everything.
    owner: bool,
    /// Ids of the member's roles, without @everyone.
    roles: Vec<Uuid>,
    status: Status,
    joined_at: chrono::DateTime<Utc>,
}

pub(crate) fn view(
    state: &AppState,
    server: &server::Model,
    member: &member::Model,
    user: UserView,
    roles: Vec<Uuid>,
) -> MemberView {
    MemberView {
        owner: member.user_id == server.owner_id,
        roles,
        status: state.realtime.presence(member.user_id),
        joined_at: member.joined_at,
        user,
    }
}

/// Every member of a server, sorted by name.
pub(crate) async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Vec<MemberView>>> {
    require_member(&state.db, id, user.id).await?;
    let server = roles::find_server(&state.db, id).await?;
    let members = member::Entity::find()
        .filter(member::Column::ServerId.eq(id))
        .all(&state.db)
        .await?;
    let mut roles = roles::member_roles(&state.db, id).await?;
    let ids: HashSet<Uuid> = members.iter().map(|m| m.user_id).collect();
    let users: HashMap<Uuid, UserView> = user::Entity::find()
        .filter(user::Column::Id.is_in(ids.iter().copied()))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|u| (u.id, u.into()))
        .collect();
    let presences = state.realtime.presences(&ids);
    let mut views: Vec<MemberView> = members
        .iter()
        .filter_map(|m| {
            Some(MemberView {
                owner: m.user_id == server.owner_id,
                roles: roles.remove(&m.user_id).unwrap_or_default(),
                status: presences
                    .get(&m.user_id)
                    .copied()
                    .unwrap_or(Status::Offline),
                joined_at: m.joined_at,
                user: users.get(&m.user_id)?.clone(),
            })
        })
        .collect();
    views.sort_by_cached_key(|m| (m.user.name.to_lowercase(), m.user.id));
    Ok(Json(views))
}
