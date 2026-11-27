//! Server roles and what they allow. The owner (`servers.owner_id`) can do
//! everything; everyone else has the permissions of @everyone plus those of
//! their roles, and only manages roles below their highest one.

use super::*;
use crate::entities::{member_role, role};
use sea_orm::PaginatorTrait;
use std::collections::{HashMap, HashSet};

/// What a role may allow; stored as bits in `roles.permissions`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i64)]
pub(crate) enum Permission {
    /// Edit the server's name and description.
    ManageServer = 1,
    ManageChannels = 2,
    /// Create, edit, delete and assign roles below one's highest role.
    ManageRoles = 4,
    CreateInvite = 8,
    /// Delete other people's messages in the server.
    ManageMessages = 16,
    MentionEveryone = 32,
    BanMembers = 64,
}

/// Every permission bit.
pub(crate) const ALL: i64 = 127;
/// What @everyone allows in a new server: what any member could always do.
pub(crate) const EVERYONE_DEFAULT: i64 =
    Permission::ManageChannels as i64 | Permission::CreateInvite as i64;

/// What a member may do in a server.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Access {
    pub owner: bool,
    pub permissions: i64,
    /// Position of the member's highest role (0: only @everyone).
    pub top: i32,
}

impl Access {
    pub fn has(&self, permission: Permission) -> bool {
        self.owner || self.permissions & permission as i64 != 0
    }

    /// Whether a role at `position` is below the member's highest role.
    pub fn outranks(&self, position: i32) -> bool {
        self.owner || position < self.top
    }

    /// Whether the member outranks someone with `other` access.
    pub fn outranks_member(&self, other: &Access) -> bool {
        !other.owner && self.outranks(other.top)
    }

    /// Only the owner hands out or takes away permissions they lack.
    fn can_change(&self, before: i64, after: i64) -> bool {
        self.owner || (before ^ after) & !self.permissions == 0
    }
}

fn forbidden() -> ApiError {
    ApiError(
        StatusCode::FORBIDDEN,
        "Você não tem permissão para fazer isso neste servidor.".into(),
    )
}

fn role_missing() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "Cargo não encontrado.".into())
}

pub(crate) async fn find_server(db: &DatabaseConnection, id: Uuid) -> ApiResult<server::Model> {
    server::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Servidor não encontrado.".into()))
}

/// Ids of a member's roles (without @everyone).
async fn roles_of(db: &DatabaseConnection, server: Uuid, user: Uuid) -> ApiResult<Vec<Uuid>> {
    Ok(member_role::Entity::find()
        .filter(member_role::Column::ServerId.eq(server))
        .filter(member_role::Column::UserId.eq(user))
        .all(db)
        .await?
        .into_iter()
        .map(|r| r.role_id)
        .collect())
}

/// What someone may do in a server, whether or not they are a member.
async fn access_of(
    db: &DatabaseConnection,
    server: &server::Model,
    user: Uuid,
) -> ApiResult<Access> {
    if server.owner_id == user {
        return Ok(Access {
            owner: true,
            permissions: ALL,
            top: i32::MAX,
        });
    }
    let mut ids = roles_of(db, server.id, user).await?;
    ids.push(server.id);
    let roles = role::Entity::find()
        .filter(role::Column::ServerId.eq(server.id))
        .filter(role::Column::Id.is_in(ids))
        .all(db)
        .await?;
    Ok(Access {
        owner: false,
        permissions: roles.iter().fold(0, |p, r| p | r.permissions),
        top: roles.iter().map(|r| r.position).max().unwrap_or(0),
    })
}

/// What a member may do in a server; `403` for anyone else.
pub(crate) async fn access(
    db: &DatabaseConnection,
    server: &server::Model,
    user: Uuid,
) -> ApiResult<Access> {
    require_member(db, server.id, user).await?;
    access_of(db, server, user).await
}

/// The server, when the member has this permission; `403` otherwise.
pub(crate) async fn require(
    db: &DatabaseConnection,
    server: Uuid,
    user: Uuid,
    permission: Permission,
) -> ApiResult<(server::Model, Access)> {
    require_member(db, server, user).await?;
    let server = find_server(db, server).await?;
    let access = access_of(db, &server, user).await?;
    if !access.has(permission) {
        return Err(forbidden());
    }
    Ok((server, access))
}

/// Whether the actor outranks this person in the server (the owner outranks
/// everyone, nobody outranks the owner).
pub(crate) async fn outranks(
    db: &DatabaseConnection,
    server: &server::Model,
    actor: &Access,
    user: Uuid,
) -> ApiResult<bool> {
    let other = access_of(db, server, user).await?;
    Ok(actor.outranks_member(&other))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoleView {
    id: Uuid,
    name: String,
    color: Option<i32>,
    position: i32,
    permissions: i64,
    /// @everyone: every member has it, and it can't be renamed or deleted.
    everyone: bool,
}

impl From<role::Model> for RoleView {
    fn from(r: role::Model) -> Self {
        Self {
            everyone: r.id == r.server_id,
            id: r.id,
            name: r.name,
            color: r.color,
            position: r.position,
            permissions: r.permissions,
        }
    }
}

/// The server's roles, highest first; @everyone is last.
async fn all_roles(db: &DatabaseConnection, server: Uuid) -> ApiResult<Vec<role::Model>> {
    Ok(role::Entity::find()
        .filter(role::Column::ServerId.eq(server))
        .order_by_desc(role::Column::Position)
        .order_by_asc(role::Column::CreatedAt)
        .all(db)
        .await?)
}

/// Every member's roles in a server (without @everyone).
pub(crate) async fn member_roles(
    db: &DatabaseConnection,
    server: Uuid,
) -> ApiResult<HashMap<Uuid, Vec<Uuid>>> {
    let mut roles: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    for row in member_role::Entity::find()
        .filter(member_role::Column::ServerId.eq(server))
        .all(db)
        .await?
    {
        roles.entry(row.user_id).or_default().push(row.role_id);
    }
    Ok(roles)
}

/// A member's role badges in each of these servers, highest first.
pub(crate) async fn badges(
    db: &DatabaseConnection,
    servers: &[Uuid],
    user: Uuid,
) -> ApiResult<HashMap<Uuid, Vec<RoleView>>> {
    let ids: HashSet<Uuid> = member_role::Entity::find()
        .filter(member_role::Column::ServerId.is_in(servers.iter().copied()))
        .filter(member_role::Column::UserId.eq(user))
        .all(db)
        .await?
        .into_iter()
        .map(|r| r.role_id)
        .collect();
    let mut badges: HashMap<Uuid, Vec<RoleView>> = HashMap::new();
    for role in role::Entity::find()
        .filter(role::Column::Id.is_in(ids))
        .order_by_desc(role::Column::Position)
        .all(db)
        .await?
    {
        badges.entry(role.server_id).or_default().push(role.into());
    }
    Ok(badges)
}

/// Creates @everyone for a new server.
pub(crate) async fn create_everyone(
    db: &impl sea_orm::ConnectionTrait,
    server: Uuid,
) -> ApiResult<()> {
    role::ActiveModel {
        id: Set(server),
        server_id: Set(server),
        name: Set("@everyone".into()),
        color: Set(None),
        position: Set(0),
        permissions: Set(EVERYONE_DEFAULT),
        created_at: Set(Utc::now()),
    }
    .insert(db)
    .await?;
    Ok(())
}

/// Tells whoever has the server open about its roles.
async fn publish(state: &AppState, server: Uuid) -> ApiResult<Vec<RoleView>> {
    let roles: Vec<RoleView> = all_roles(&state.db, server)
        .await?
        .into_iter()
        .map(Into::into)
        .collect();
    state.realtime.publish_server(
        server,
        serde_json::json!({ "type": "roles.updated", "serverId": server, "roles": roles }),
    );
    Ok(roles)
}

pub(crate) async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Vec<RoleView>>> {
    require_member(&state.db, id, user.id).await?;
    let roles = all_roles(&state.db, id).await?;
    Ok(Json(roles.into_iter().map(Into::into).collect()))
}

/// Every field is optional: only the ones sent change.
#[derive(Default, Deserialize)]
pub(crate) struct RoleInput {
    name: Option<String>,
    /// `0xRRGGBB`, or null for the default name color.
    #[serde(default, deserialize_with = "crate::profile::present")]
    color: Option<Option<i32>>,
    permissions: Option<i64>,
}

fn role_name(name: &str) -> ApiResult<String> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty()
        || name.chars().count() > 100
        || name.chars().any(char::is_control)
        || name.eq_ignore_ascii_case("@everyone")
    {
        return Err(ApiError::bad(
            "O nome do cargo deve ter entre 1 e 100 caracteres.",
        ));
    }
    Ok(name)
}

fn role_color(color: Option<i32>) -> ApiResult<Option<i32>> {
    match color {
        Some(c) if !(0..=0xFF_FFFF).contains(&c) => Err(ApiError::bad("Escolha uma cor válida.")),
        color => Ok(color),
    }
}

fn permissions(value: i64) -> ApiResult<i64> {
    if value & !ALL != 0 {
        return Err(ApiError::bad("Permissão desconhecida."));
    }
    Ok(value)
}

/// A new role, just above @everyone.
pub(crate) async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
    Json(input): Json<RoleInput>,
) -> ApiResult<(StatusCode, Json<RoleView>)> {
    let (_, access) = require(&state.db, id, user.id, Permission::ManageRoles).await?;
    let name = role_name(input.name.as_deref().unwrap_or("novo cargo"))?;
    let color = role_color(input.color.flatten())?;
    let granted = permissions(input.permissions.unwrap_or(0))?;
    if !access.can_change(0, granted) {
        return Err(forbidden());
    }
    if role::Entity::find()
        .filter(role::Column::ServerId.eq(id))
        .count(&state.db)
        .await?
        > 250
    {
        return Err(ApiError::bad(
            "Este servidor já tem o máximo de 250 cargos.",
        ));
    }
    let tx = state.db.begin().await?;
    role::Entity::update_many()
        .col_expr(
            role::Column::Position,
            sea_orm::sea_query::Expr::col(role::Column::Position).add(1),
        )
        .filter(role::Column::ServerId.eq(id))
        .filter(role::Column::Position.gte(1))
        .exec(&tx)
        .await?;
    let role = role::ActiveModel {
        id: Set(Uuid::new_v4()),
        server_id: Set(id),
        name: Set(name),
        color: Set(color),
        position: Set(1),
        permissions: Set(granted),
        created_at: Set(Utc::now()),
    }
    .insert(&tx)
    .await?;
    tx.commit().await?;
    publish(&state, id).await?;
    Ok((StatusCode::CREATED, Json(role.into())))
}

/// A role of this server that the member may manage.
async fn managed_role(
    state: &AppState,
    access: &Access,
    server: Uuid,
    id: Uuid,
) -> ApiResult<role::Model> {
    let role = role::Entity::find_by_id(id)
        .filter(role::Column::ServerId.eq(server))
        .one(&state.db)
        .await?
        .ok_or_else(role_missing)?;
    // @everyone is below everyone, so anyone who manages roles edits it.
    if role.id != server && !access.outranks(role.position) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Você só pode gerenciar cargos abaixo do seu cargo mais alto.".into(),
        ));
    }
    Ok(role)
}

pub(crate) async fn update(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path((id, role_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<RoleInput>,
) -> ApiResult<Json<RoleView>> {
    let (_, access) = require(&state.db, id, user.id, Permission::ManageRoles).await?;
    let role = managed_role(&state, &access, id, role_id).await?;
    let everyone = role.id == id;
    let mut active: role::ActiveModel = role.clone().into();
    if let Some(name) = input.name {
        if everyone {
            return Err(ApiError::bad("O cargo @everyone não pode ser renomeado."));
        }
        active.name = Set(role_name(&name)?);
    }
    if let Some(color) = input.color {
        active.color = Set(role_color(color)?);
    }
    if let Some(value) = input.permissions {
        let value = permissions(value)?;
        if !access.can_change(role.permissions, value) {
            return Err(forbidden());
        }
        active.permissions = Set(value);
    }
    let role = active.update(&state.db).await?;
    publish(&state, id).await?;
    Ok(Json(role.into()))
}

pub(crate) async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path((id, role_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    let (_, access) = require(&state.db, id, user.id, Permission::ManageRoles).await?;
    let role = managed_role(&state, &access, id, role_id).await?;
    if role.id == id {
        return Err(ApiError::bad("O cargo @everyone não pode ser excluído."));
    }
    let tx = state.db.begin().await?;
    role::Entity::delete_by_id(role.id).exec(&tx).await?;
    role::Entity::update_many()
        .col_expr(
            role::Column::Position,
            sea_orm::sea_query::Expr::col(role::Column::Position).sub(1),
        )
        .filter(role::Column::ServerId.eq(id))
        .filter(role::Column::Position.gt(role.position))
        .exec(&tx)
        .await?;
    tx.commit().await?;
    publish(&state, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub(crate) struct OrderInput {
    /// Every role but @everyone, highest first.
    ids: Vec<Uuid>,
}

/// Puts the roles in a new order. Roles at or above the member's highest one
/// keep their place.
pub(crate) async fn reorder(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
    Json(input): Json<OrderInput>,
) -> ApiResult<Json<Vec<RoleView>>> {
    let (_, access) = require(&state.db, id, user.id, Permission::ManageRoles).await?;
    let roles: HashMap<Uuid, role::Model> = all_roles(&state.db, id)
        .await?
        .into_iter()
        .filter(|r| r.id != id)
        .map(|r| (r.id, r))
        .collect();
    let unique: HashSet<Uuid> = input.ids.iter().copied().collect();
    if unique.len() != input.ids.len()
        || unique.len() != roles.len()
        || !unique.iter().all(|id| roles.contains_key(id))
    {
        return Err(ApiError::bad(
            "Envie todos os cargos do servidor, uma vez cada.",
        ));
    }
    let count = input.ids.len() as i32;
    let moves: Vec<(Uuid, i32)> = input
        .ids
        .iter()
        .enumerate()
        .map(|(i, id)| (*id, count - i as i32))
        .filter(|(id, position)| roles[id].position != *position)
        .collect();
    if moves
        .iter()
        .any(|(id, position)| !access.outranks(roles[id].position) || !access.outranks(*position))
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Você só pode reordenar cargos abaixo do seu cargo mais alto.".into(),
        ));
    }
    let tx = state.db.begin().await?;
    for (role_id, position) in moves {
        role::Entity::update_many()
            .col_expr(role::Column::Position, position.into())
            .filter(role::Column::Id.eq(role_id))
            .exec(&tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(publish(&state, id).await?))
}

/// Gives (`PUT`) or takes away (`DELETE`) a member's role.
pub(crate) async fn assign(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    method: axum::http::Method,
    Path((id, member_id, role_id)): Path<(Uuid, Uuid, Uuid)>,
) -> ApiResult<Json<crate::members::MemberView>> {
    let (server, access) = require(&state.db, id, user.id, Permission::ManageRoles).await?;
    let role = managed_role(&state, &access, id, role_id).await?;
    if role.id == id {
        return Err(ApiError::bad("Todos os membros já têm o cargo @everyone."));
    }
    let missing = || {
        ApiError(
            StatusCode::NOT_FOUND,
            "Pessoa não encontrada neste servidor.".into(),
        )
    };
    let member = member::Entity::find_by_id((id, member_id))
        .one(&state.db)
        .await?
        .ok_or_else(missing)?;
    let person = user::Entity::find_by_id(member_id)
        .one(&state.db)
        .await?
        .ok_or_else(missing)?;
    if method == axum::http::Method::PUT {
        member_role::Entity::insert(member_role::ActiveModel {
            server_id: Set(id),
            user_id: Set(member_id),
            role_id: Set(role.id),
        })
        .on_conflict(
            OnConflict::columns([
                member_role::Column::ServerId,
                member_role::Column::UserId,
                member_role::Column::RoleId,
            ])
            .do_nothing()
            .to_owned(),
        )
        .exec_without_returning(&state.db)
        .await?;
    } else {
        member_role::Entity::delete_by_id((id, member_id, role.id))
            .exec(&state.db)
            .await?;
    }
    let roles = roles_of(&state.db, id, member_id).await?;
    let view = crate::members::view(&state, &server, &member, person.into(), roles);
    state.realtime.publish_server(
        id,
        serde_json::json!({ "type": "member.updated", "serverId": id, "member": view }),
    );
    Ok(Json(view))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_permissions_and_hierarchy() {
        let owner = Access {
            owner: true,
            permissions: ALL,
            top: i32::MAX,
        };
        let moderator = Access {
            owner: false,
            permissions: Permission::ManageRoles as i64 | Permission::BanMembers as i64,
            top: 3,
        };
        let member = Access {
            owner: false,
            permissions: EVERYONE_DEFAULT,
            top: 0,
        };
        assert!(owner.has(Permission::ManageServer));
        assert!(moderator.has(Permission::BanMembers));
        assert!(!moderator.has(Permission::ManageMessages));
        assert!(member.has(Permission::CreateInvite));
        assert!(moderator.outranks(2) && !moderator.outranks(3));
        assert!(moderator.outranks_member(&member));
        assert!(!moderator.outranks_member(&owner));
        assert!(!member.outranks_member(&moderator));
        assert!(!moderator.outranks_member(&moderator));
        // Only permissions the member has can be granted or taken away.
        assert!(moderator.can_change(0, Permission::BanMembers as i64));
        assert!(!moderator.can_change(0, Permission::ManageServer as i64));
        assert!(!moderator.can_change(Permission::ManageServer as i64, 0));
        assert!(owner.can_change(0, ALL));
        assert!(role_name("@everyone").is_err());
        assert_eq!(role_name("  Mod   Chefe ").unwrap(), "Mod Chefe");
        assert!(role_color(Some(0x1000000)).is_err());
        assert!(permissions(128).is_err());
    }
}
