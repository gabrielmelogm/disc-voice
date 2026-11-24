//! Who is in a server: every member with their role and presence.
//! The owner is the server's `owner_id`; the owner can make others moderators.

use super::*;
use crate::presence::Status;
use std::collections::{HashMap, HashSet};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemberView {
    user: UserView,
    /// `owner`, `moderator` or `member`.
    role: &'static str,
    status: Status,
    joined_at: chrono::DateTime<Utc>,
}

fn role(server: &server::Model, member: &member::Model) -> &'static str {
    if member.user_id == server.owner_id {
        "owner"
    } else if member.role == "moderator" {
        "moderator"
    } else {
        "member"
    }
}

pub(crate) fn view(
    state: &AppState,
    server: &server::Model,
    member: &member::Model,
    user: UserView,
) -> MemberView {
    MemberView {
        role: role(server, member),
        status: state.realtime.presence(member.user_id),
        joined_at: member.joined_at,
        user,
    }
}

async fn find_server(db: &DatabaseConnection, id: Uuid) -> ApiResult<server::Model> {
    server::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Servidor não encontrado.".into()))
}

/// Every member of a server, sorted by name.
pub(crate) async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Vec<MemberView>>> {
    require_member(&state.db, id, user.id).await?;
    let server = find_server(&state.db, id).await?;
    let members = member::Entity::find()
        .filter(member::Column::ServerId.eq(id))
        .all(&state.db)
        .await?;
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
                role: role(&server, m),
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

#[derive(Deserialize)]
pub(crate) struct RoleInput {
    role: String,
}

/// The owner makes a member a moderator, or a moderator a member again.
pub(crate) async fn update(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path((id, member_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<RoleInput>,
) -> ApiResult<Json<MemberView>> {
    require_member(&state.db, id, user.id).await?;
    let server = find_server(&state.db, id).await?;
    if server.owner_id != user.id {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Somente o dono do servidor pode mudar os papéis.".into(),
        ));
    }
    if !matches!(input.role.as_str(), "member" | "moderator") {
        return Err(ApiError::bad("Escolha entre membro e moderador."));
    }
    if member_id == server.owner_id {
        return Err(ApiError::bad("O dono do servidor não muda de papel."));
    }
    let member = member::Entity::find_by_id((id, member_id))
        .one(&state.db)
        .await?
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                "Pessoa não encontrada neste servidor.".into(),
            )
        })?;
    let person = user::Entity::find_by_id(member_id)
        .one(&state.db)
        .await?
        .ok_or_else(|| {
            ApiError(
                StatusCode::NOT_FOUND,
                "Pessoa não encontrada neste servidor.".into(),
            )
        })?;
    let member = if member.role == input.role {
        member
    } else {
        let mut active: member::ActiveModel = member.into();
        active.role = Set(input.role);
        active.update(&state.db).await?
    };
    let view = view(&state, &server, &member, person.into());
    state.realtime.publish_server(
        id,
        serde_json::json!({ "type": "member.updated", "serverId": id, "member": view }),
    );
    Ok(Json(view))
}
