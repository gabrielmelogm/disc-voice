//! Direct messages: a conversation between two people is a channel of type
//! `dm` with no server, whose participants live in `dm_channels`.

use super::*;
use entities::dm_channel;
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use std::collections::{HashMap, HashSet};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationView {
    channel: ChannelView,
    /// The other person of the conversation.
    user: UserView,
    /// Newest message, as the same string id messages use; null when empty.
    last_message_id: Option<String>,
}

/// The participants of a DM channel, or 403 when `user` is not one of them.
pub(crate) async fn require_participant(
    db: &impl ConnectionTrait,
    channel: Uuid,
    user: Uuid,
) -> ApiResult<dm_channel::Model> {
    dm_channel::Entity::find_by_id(channel)
        .one(db)
        .await?
        .filter(|dm| dm.user_a == user || dm.user_b == user)
        .ok_or_else(|| {
            ApiError(
                StatusCode::FORBIDDEN,
                "Você não participa desta conversa.".into(),
            )
        })
}

/// Sends an event about a channel to whoever can see it: the server's
/// audience, or both people of a direct conversation.
pub(crate) async fn publish(
    state: &AppState,
    channel: &channel::Model,
    payload: serde_json::Value,
) -> ApiResult<()> {
    match channel.server_id {
        Some(server) => state.realtime.publish_server(server, payload),
        None => {
            if let Some(dm) = dm_channel::Entity::find_by_id(channel.id)
                .one(&state.db)
                .await?
            {
                state
                    .realtime
                    .publish_users(&HashSet::from([dm.user_a, dm.user_b]), payload);
            }
        }
    }
    Ok(())
}

async fn users(
    db: &DatabaseConnection,
    ids: impl IntoIterator<Item = Uuid>,
) -> ApiResult<HashMap<Uuid, UserView>> {
    let ids: Vec<_> = ids.into_iter().collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(user::Entity::find()
        .filter(user::Column::Id.is_in(ids))
        .all(db)
        .await?
        .into_iter()
        .map(|u| (u.id, UserView::from(u)))
        .collect())
}

pub(crate) async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
) -> ApiResult<Json<Vec<ConversationView>>> {
    let rows = state
        .db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT d.channel_id, d.user_a, d.user_b, latest.id AS last_message_id
               FROM dm_channels d
               JOIN channels c ON c.id = d.channel_id
               LEFT JOIN LATERAL (
                   SELECT max(id) AS id FROM messages WHERE channel_id = d.channel_id
               ) latest ON true
               WHERE d.user_a = $1 OR d.user_b = $1
               ORDER BY latest.id DESC NULLS FIRST, c.created_at DESC, c.id"#,
            [user.id.into()],
        ))
        .await?;
    let mut found = Vec::with_capacity(rows.len());
    for row in rows {
        let dm = dm_channel::Model {
            channel_id: row.try_get("", "channel_id")?,
            user_a: row.try_get("", "user_a")?,
            user_b: row.try_get("", "user_b")?,
        };
        let last: Option<i64> = row.try_get("", "last_message_id")?;
        found.push((dm, last));
    }
    let channels: HashMap<_, _> = channel::Entity::find()
        .filter(channel::Column::Id.is_in(found.iter().map(|(dm, _)| dm.channel_id)))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|c| (c.id, c))
        .collect();
    let people = users(&state.db, found.iter().map(|(dm, _)| dm.other(user.id))).await?;
    let mut channels = channels;
    Ok(Json(
        found
            .into_iter()
            .filter_map(|(dm, last)| {
                Some(ConversationView {
                    channel: channels.remove(&dm.channel_id)?.into(),
                    user: people.get(&dm.other(user.id))?.clone(),
                    last_message_id: last.map(|id| id.to_string()),
                })
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenInput {
    user_id: Uuid,
}

/// Opens the conversation with someone, creating it the first time.
pub(crate) async fn open(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Json(input): Json<OpenInput>,
) -> ApiResult<(StatusCode, Json<ConversationView>)> {
    if input.user_id == user.id {
        return Err(ApiError::bad("Você não pode conversar consigo mesmo."));
    }
    let shared = state
        .db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT 1 AS shared FROM members mine
               JOIN members theirs ON theirs.server_id = mine.server_id
               WHERE mine.user_id = $1 AND theirs.user_id = $2 LIMIT 1"#,
            [user.id.into(), input.user_id.into()],
        ))
        .await?;
    if shared.is_none() {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Você só pode conversar com pessoas dos seus servidores.".into(),
        ));
    }
    let other = users(&state.db, [input.user_id])
        .await?
        .remove(&input.user_id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Pessoa não encontrada.".into()))?;
    let (user_a, user_b) = if user.id < input.user_id {
        (user.id, input.user_id)
    } else {
        (input.user_id, user.id)
    };

    let tx = state.db.begin().await?;
    let channel = channel::ActiveModel {
        id: Set(Uuid::new_v4()),
        server_id: Set(None),
        name: Set("dm".into()),
        kind: Set("dm".into()),
        created_by: Set(user.id),
        created_at: Set(Utc::now()),
        source: Set("local".into()),
    }
    .insert(&tx)
    .await?;
    let inserted = tx
        .execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"INSERT INTO dm_channels (channel_id, user_a, user_b) VALUES ($1, $2, $3)
               ON CONFLICT (user_a, user_b) DO NOTHING"#,
            [channel.id.into(), user_a.into(), user_b.into()],
        ))
        .await?
        .rows_affected()
        == 1;

    if !inserted {
        // The conversation already exists: drop the channel made for it.
        tx.rollback().await?;
        let dm = dm_channel::Entity::find()
            .filter(dm_channel::Column::UserA.eq(user_a))
            .filter(dm_channel::Column::UserB.eq(user_b))
            .one(&state.db)
            .await?
            .ok_or_else(|| ApiError::internal("conversa sem registro"))?;
        let channel = channel::Entity::find_by_id(dm.channel_id)
            .one(&state.db)
            .await?
            .ok_or_else(|| ApiError::internal("conversa sem canal"))?;
        let last = crate::entities::message::Entity::find()
            .filter(crate::entities::message::Column::ChannelId.eq(channel.id))
            .order_by_desc(crate::entities::message::Column::Id)
            .one(&state.db)
            .await?
            .map(|m| m.id.to_string());
        return Ok((
            StatusCode::OK,
            Json(ConversationView {
                channel: channel.into(),
                user: other,
                last_message_id: last,
            }),
        ));
    }
    tx.commit().await?;

    // Each side sees the conversation named after the other person.
    let theirs = ConversationView {
        channel: channel.clone().into(),
        user: user.clone(),
        last_message_id: None,
    };
    state.realtime.publish_users(
        &HashSet::from([input.user_id]),
        serde_json::json!({ "type": "dm.created", "conversation": theirs }),
    );
    let mine = ConversationView {
        channel: channel.into(),
        user: other,
        last_message_id: None,
    };
    state.realtime.publish_users(
        &HashSet::from([user.id]),
        serde_json::json!({ "type": "dm.created", "conversation": mine }),
    );
    Ok((StatusCode::CREATED, Json(mine)))
}
