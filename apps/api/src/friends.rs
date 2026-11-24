//! Friends: requests that the other person accepts, and the presence
//! (online or not) that friends share with each other.

use super::*;
use crate::presence::Status;
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use std::collections::HashSet;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FriendView {
    user: UserView,
    /// `offline` unless the friend has the app open somewhere; then the
    /// status they chose (`online`, `idle` or `dnd`).
    status: Status,
    /// When the friendship started.
    since: chrono::DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RequestView {
    user: UserView,
    created_at: chrono::DateTime<Utc>,
}

#[derive(Serialize)]
pub(crate) struct FriendsView {
    friends: Vec<FriendView>,
    /// Requests others sent to the user, waiting for an answer.
    incoming: Vec<RequestView>,
    /// Requests the user sent.
    outgoing: Vec<RequestView>,
}

/// Where two people stand: no row, a pending request (and who sent it), or friends.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Relation {
    None,
    /// The first person asked the second.
    Outgoing,
    /// The second person asked the first.
    Incoming,
    Friends,
}

impl Relation {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Outgoing => "outgoing",
            Self::Incoming => "incoming",
            Self::Friends => "friends",
        }
    }
}

pub(crate) async fn relation(
    db: &impl ConnectionTrait,
    me: Uuid,
    other: Uuid,
) -> ApiResult<Relation> {
    let row = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT requester_id, status FROM friendships
               WHERE (requester_id = $1 AND addressee_id = $2)
                  OR (requester_id = $2 AND addressee_id = $1)"#,
            [me.into(), other.into()],
        ))
        .await?;
    let Some(row) = row else {
        return Ok(Relation::None);
    };
    let requester: Uuid = row.try_get("", "requester_id")?;
    let status: String = row.try_get("", "status")?;
    Ok(match (status.as_str(), requester == me) {
        ("accepted", _) => Relation::Friends,
        (_, true) => Relation::Outgoing,
        _ => Relation::Incoming,
    })
}

/// Accepted friends of a user.
pub(crate) async fn friend_ids(db: &impl ConnectionTrait, user: Uuid) -> ApiResult<HashSet<Uuid>> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS friend
               FROM friendships
               WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)"#,
            [user.into()],
        ))
        .await?;
    rows.iter()
        .map(|row| row.try_get("", "friend").map_err(Into::into))
        .collect()
}

/// Both people reload their friends list.
fn changed(state: &AppState, a: Uuid, b: Uuid) {
    state.realtime.publish_users(
        &HashSet::from([a, b]),
        serde_json::json!({ "type": "friends.changed" }),
    );
}

pub(crate) async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
) -> ApiResult<Json<FriendsView>> {
    let rows = state
        .db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT requester_id, addressee_id, status, created_at, accepted_at
               FROM friendships
               WHERE requester_id = $1 OR addressee_id = $1"#,
            [user.id.into()],
        ))
        .await?;
    let mut found = Vec::with_capacity(rows.len());
    for row in rows {
        let requester: Uuid = row.try_get("", "requester_id")?;
        let addressee: Uuid = row.try_get("", "addressee_id")?;
        let status: String = row.try_get("", "status")?;
        let created_at: chrono::DateTime<Utc> = row.try_get("", "created_at")?;
        let accepted_at: Option<chrono::DateTime<Utc>> = row.try_get("", "accepted_at")?;
        let other = if requester == user.id {
            addressee
        } else {
            requester
        };
        found.push((other, requester == user.id, status, created_at, accepted_at));
    }
    let people: std::collections::HashMap<_, _> = if found.is_empty() {
        Default::default()
    } else {
        user::Entity::find()
            .filter(user::Column::Id.is_in(found.iter().map(|f| f.0)))
            .all(&state.db)
            .await?
            .into_iter()
            .map(|u| (u.id, UserView::from(u)))
            .collect()
    };
    let presences = state
        .realtime
        .presences(&found.iter().map(|f| f.0).collect());
    let mut view = FriendsView {
        friends: Vec::new(),
        incoming: Vec::new(),
        outgoing: Vec::new(),
    };
    for (other, mine, status, created_at, accepted_at) in found {
        let Some(person) = people.get(&other).cloned() else {
            continue;
        };
        if status == "accepted" {
            view.friends.push(FriendView {
                status: presences.get(&other).copied().unwrap_or(Status::Offline),
                user: person,
                since: accepted_at.unwrap_or(created_at),
            });
        } else if mine {
            view.outgoing.push(RequestView {
                user: person,
                created_at,
            });
        } else {
            view.incoming.push(RequestView {
                user: person,
                created_at,
            });
        }
    }
    view.friends.sort_by_key(|f| f.user.name.to_lowercase());
    // Newest requests first.
    view.incoming
        .sort_by_key(|r| std::cmp::Reverse(r.created_at));
    view.outgoing
        .sort_by_key(|r| std::cmp::Reverse(r.created_at));
    Ok(Json(view))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RequestInput {
    user_id: Uuid,
}

#[derive(Serialize)]
pub(crate) struct RelationView {
    /// `outgoing` (waiting for the other person) or `friends`.
    status: &'static str,
}

/// Sends a friend request. When the other person had already asked, this
/// accepts theirs instead.
pub(crate) async fn request(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Json(input): Json<RequestInput>,
) -> ApiResult<Json<RelationView>> {
    let other = input.user_id;
    if other == user.id {
        return Err(ApiError::bad("Você não pode adicionar a si mesmo."));
    }
    if user::Entity::find_by_id(other)
        .one(&state.db)
        .await?
        .is_none()
    {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Pessoa não encontrada.".into(),
        ));
    }
    let status = match relation(&state.db, user.id, other).await? {
        Relation::Friends => {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Vocês já são amigos.".into(),
            ))
        }
        Relation::Outgoing => Relation::Outgoing,
        Relation::Incoming => {
            accept_pending(&state.db, other, user.id).await?;
            Relation::Friends
        }
        Relation::None => {
            let inserted = state
                .db
                .execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    r#"INSERT INTO friendships (requester_id, addressee_id, status)
                       VALUES ($1, $2, 'pending') ON CONFLICT DO NOTHING"#,
                    [user.id.into(), other.into()],
                ))
                .await?
                .rows_affected();
            if inserted == 0 {
                // Both asked at the same moment: the other request won.
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "Já existe um pedido de amizade entre vocês.".into(),
                ));
            }
            Relation::Outgoing
        }
    };
    changed(&state, user.id, other);
    if status == Relation::Friends {
        announce_both(&state, user.id, other);
    }
    Ok(Json(RelationView {
        status: status.as_str(),
    }))
}

async fn accept_pending(
    db: &impl ConnectionTrait,
    requester: Uuid,
    addressee: Uuid,
) -> ApiResult<bool> {
    Ok(db
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"UPDATE friendships SET status = 'accepted', accepted_at = now()
               WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'"#,
            [requester.into(), addressee.into()],
        ))
        .await?
        .rows_affected()
        == 1)
}

/// New friends learn whether the other is online right away.
fn announce_both(state: &AppState, a: Uuid, b: Uuid) {
    for (user, friend) in [(a, b), (b, a)] {
        state.realtime.publish_users(
            &HashSet::from([friend]),
            serde_json::json!({
                "type": "presence.updated", "userId": user,
                "status": state.realtime.presence(user)
            }),
        );
    }
}

/// Accepts a request someone sent to the user.
pub(crate) async fn accept(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(other): Path<Uuid>,
) -> ApiResult<Json<RelationView>> {
    if !accept_pending(&state.db, other, user.id).await? {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Pedido de amizade não encontrado.".into(),
        ));
    }
    changed(&state, user.id, other);
    announce_both(&state, user.id, other);
    Ok(Json(RelationView { status: "friends" }))
}

/// Declines or cancels a request, or ends a friendship.
pub(crate) async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(other): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let removed = state
        .db
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"DELETE FROM friendships
               WHERE (requester_id = $1 AND addressee_id = $2)
                  OR (requester_id = $2 AND addressee_id = $1)"#,
            [user.id.into(), other.into()],
        ))
        .await?
        .rows_affected();
    if removed == 0 {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Pedido ou amizade não encontrado.".into(),
        ));
    }
    changed(&state, user.id, other);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileView {
    user: UserView,
    member_since: chrono::DateTime<Utc>,
    /// Servers both people are in.
    mutual_servers: Vec<ServerView>,
    /// `none`, `outgoing`, `incoming` or `friends`, from the viewer's side.
    friendship: &'static str,
    /// Presence, shared with friends and people in a mutual server; null otherwise.
    status: Option<Status>,
}

/// Someone's profile as the user sees it. Only people the user is connected
/// to (a shared server, a request or friendship, or a conversation) are found.
pub(crate) async fn profile(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(other): Path<Uuid>,
) -> ApiResult<Json<ProfileView>> {
    let missing = || ApiError(StatusCode::NOT_FOUND, "Pessoa não encontrada.".into());
    let person = user::Entity::find_by_id(other)
        .one(&state.db)
        .await?
        .ok_or_else(missing)?;
    let servers = state
        .db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT s.id, s.name, s.owner_id FROM servers s
               JOIN members mine ON mine.server_id = s.id AND mine.user_id = $1
               JOIN members theirs ON theirs.server_id = s.id AND theirs.user_id = $2
               ORDER BY s.created_at, s.id"#,
            [user.id.into(), other.into()],
        ))
        .await?;
    let mut mutual_servers = Vec::with_capacity(servers.len());
    for row in servers {
        mutual_servers.push(ServerView {
            id: row.try_get("", "id")?,
            name: row.try_get("", "name")?,
            owner_id: row.try_get("", "owner_id")?,
        });
    }
    let friendship = relation(&state.db, user.id, other).await?;
    let conversation = state
        .db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT 1 AS found FROM dm_channels
               WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)"#,
            [user.id.into(), other.into()],
        ))
        .await?
        .is_some();
    let visible = other == user.id
        || !mutual_servers.is_empty()
        || friendship != Relation::None
        || conversation;
    if !visible {
        return Err(missing());
    }
    // Members of a server see each other's presence in its people list.
    let status =
        (friendship == Relation::Friends || other == user.id || !mutual_servers.is_empty())
            .then(|| state.realtime.presence(other));
    Ok(Json(ProfileView {
        member_since: person.created_at,
        user: person.into(),
        mutual_servers,
        friendship: friendship.as_str(),
        status,
    }))
}
