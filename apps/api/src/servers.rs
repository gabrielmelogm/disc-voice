//! Editing and deleting a server, and banning people from it.

use super::*;
use crate::entities::ban;
use crate::roles::Permission;
use std::collections::HashSet;

/// Every field is optional: only the ones sent change.
#[derive(Deserialize)]
pub(crate) struct ServerInput {
    name: Option<String>,
    description: Option<String>,
}

fn description(value: &str) -> ApiResult<String> {
    let value = value.trim().replace("\r\n", "\n");
    if value.chars().count() > 300 || value.chars().any(|c| c.is_control() && c != '\n') {
        return Err(ApiError::bad("A descrição deve ter até 300 caracteres."));
    }
    Ok(value)
}

async fn member_ids(db: &DatabaseConnection, server: Uuid) -> ApiResult<HashSet<Uuid>> {
    Ok(member::Entity::find()
        .filter(member::Column::ServerId.eq(server))
        .all(db)
        .await?
        .into_iter()
        .map(|m| m.user_id)
        .collect())
}

/// Changes the server's name or description; every member sees it.
pub(crate) async fn update(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
    Json(input): Json<ServerInput>,
) -> ApiResult<Json<ServerView>> {
    let (server, _) = roles::require(&state.db, id, user.id, Permission::ManageServer).await?;
    let mut active: server::ActiveModel = server.clone().into();
    if let Some(name) = input.name {
        active.name = Set(server_name(&name)?);
    }
    if let Some(value) = input.description {
        active.description = Set(description(&value)?);
    }
    let view = ServerView::from(active.update(&state.db).await?);
    state.realtime.publish_users(
        &member_ids(&state.db, id).await?,
        serde_json::json!({ "type": "server.updated", "server": view }),
    );
    Ok(Json(view))
}

/// The owner deletes the server with everything in it. It disappears for every
/// member, and its voice rooms end.
pub(crate) async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    require_member(&state.db, id, user.id).await?;
    let server = roles::find_server(&state.db, id).await?;
    if server.owner_id != user.id {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Somente o dono pode excluir o servidor.".into(),
        ));
    }
    let members = member_ids(&state.db, id).await?;
    // Channels, messages, members, roles, bans, invites and Discord links go
    // with it (ON DELETE CASCADE).
    server::Entity::delete_by_id(id).exec(&state.db).await?;
    state.realtime.publish_users(
        &members,
        serde_json::json!({ "type": "server.deleted", "serverId": id, "serverName": server.name }),
    );
    state.realtime.remove_from_server(id, None);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BanView {
    user: UserView,
    reason: String,
    created_at: chrono::DateTime<Utc>,
}

pub(crate) async fn bans(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Vec<BanView>>> {
    roles::require(&state.db, id, user.id, Permission::BanMembers).await?;
    let bans = ban::Entity::find()
        .filter(ban::Column::ServerId.eq(id))
        .order_by_desc(ban::Column::CreatedAt)
        .all(&state.db)
        .await?;
    let users: std::collections::HashMap<Uuid, user::Model> = user::Entity::find()
        .filter(user::Column::Id.is_in(bans.iter().map(|b| b.user_id)))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|u| (u.id, u))
        .collect();
    Ok(Json(
        bans.into_iter()
            .filter_map(|b| {
                Some(BanView {
                    user: users.get(&b.user_id)?.clone().into(),
                    reason: b.reason,
                    created_at: b.created_at,
                })
            })
            .collect(),
    ))
}

#[derive(Default, Deserialize)]
pub(crate) struct BanInput {
    #[serde(default)]
    reason: String,
}

/// Bans someone: they leave the server at once and can't come back through
/// the invite until unbanned.
pub(crate) async fn ban(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path((id, target)): Path<(Uuid, Uuid)>,
    input: Option<Json<BanInput>>,
) -> ApiResult<StatusCode> {
    let (server, access) = roles::require(&state.db, id, user.id, Permission::BanMembers).await?;
    let reason = input.map(|Json(i)| i.reason).unwrap_or_default();
    let reason = reason.split_whitespace().collect::<Vec<_>>().join(" ");
    if reason.chars().count() > 512 {
        return Err(ApiError::bad("O motivo deve ter até 512 caracteres."));
    }
    if target == user.id {
        return Err(ApiError::bad("Você não pode banir a si mesmo."));
    }
    if target == server.owner_id {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "O dono do servidor não pode ser banido.".into(),
        ));
    }
    if user::Entity::find_by_id(target)
        .one(&state.db)
        .await?
        .is_none()
    {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Pessoa não encontrada.".into(),
        ));
    }
    if !roles::outranks(&state.db, &server, &access, target).await? {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Você só pode banir pessoas com cargos abaixo do seu.".into(),
        ));
    }
    let tx = state.db.begin().await?;
    ban::Entity::insert(ban::ActiveModel {
        server_id: Set(id),
        user_id: Set(target),
        banned_by: Set(Some(user.id)),
        reason: Set(reason),
        created_at: Set(Utc::now()),
    })
    .on_conflict(
        OnConflict::columns([ban::Column::ServerId, ban::Column::UserId])
            .update_columns([ban::Column::BannedBy, ban::Column::Reason])
            .to_owned(),
    )
    .exec_without_returning(&tx)
    .await?;
    let removed = member::Entity::delete_by_id((id, target))
        .exec(&tx)
        .await?
        .rows_affected;
    tx.commit().await?;
    if removed > 0 {
        state.realtime.publish_server(
            id,
            serde_json::json!({ "type": "member.left", "serverId": id, "userId": target }),
        );
        state.realtime.publish_users(
            &HashSet::from([target]),
            serde_json::json!({ "type": "server.banned", "serverId": id, "serverName": server.name }),
        );
        state.realtime.remove_from_server(id, Some(target));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn unban(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path((id, target)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    roles::require(&state.db, id, user.id, Permission::BanMembers).await?;
    let removed = ban::Entity::delete_by_id((id, target))
        .exec(&state.db)
        .await?
        .rows_affected;
    if removed == 0 {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Banimento não encontrado.".into(),
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Whether this person is banned from the server.
pub(crate) async fn banned(db: &DatabaseConnection, server: Uuid, user: Uuid) -> ApiResult<bool> {
    Ok(ban::Entity::find_by_id((server, user))
        .one(db)
        .await?
        .is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_descriptions() {
        assert_eq!(description(" a\r\nb ").unwrap(), "a\nb");
        assert!(description(&"á".repeat(300)).is_ok());
        assert!(description(&"á".repeat(301)).is_err());
        assert!(description("tab\there").is_err());
    }
}
