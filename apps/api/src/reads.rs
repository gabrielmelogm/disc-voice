//! Read state: the last message each person has read in each channel, kept
//! in the database so it follows them across devices and restarts.

use super::*;
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use std::collections::HashSet;

/// Unread counts stop here; the app shows "99+" beyond that anyway.
const UNREAD_CAP: i64 = 100;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadView {
    channel_id: Uuid,
    /// Null for direct message conversations.
    server_id: Option<Uuid>,
    /// Same string ids as messages; "0" when nothing was read yet.
    last_read_id: String,
    /// Messages from other people after `last_read_id`, capped at 100.
    unread: i64,
}

/// Read state of every text channel and conversation the user can see.
pub(crate) async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
) -> ApiResult<Json<Vec<ReadView>>> {
    // Without a read marker, a server channel counts only what arrived after
    // the person joined, so joining a server does not flood them with badges.
    let rows = state
        .db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"WITH visible AS (
                   SELECT c.id AS channel_id, c.server_id, m.joined_at AS since
                   FROM channels c
                   JOIN members m ON m.server_id = c.server_id AND m.user_id = $1
                   WHERE c.type = 'text'
                   UNION ALL
                   SELECT d.channel_id, NULL::uuid, NULL::timestamptz
                   FROM dm_channels d WHERE d.user_a = $1 OR d.user_b = $1
               )
               SELECT v.channel_id, v.server_id,
                      COALESCE(r.last_read_message_id, 0) AS last_read, unread.n AS unread
               FROM visible v
               LEFT JOIN channel_reads r ON r.user_id = $1 AND r.channel_id = v.channel_id
               CROSS JOIN LATERAL (
                   SELECT count(*) AS n FROM (
                       SELECT 1 FROM messages msg
                       WHERE msg.channel_id = v.channel_id
                         AND msg.id > COALESCE(r.last_read_message_id, 0)
                         AND msg.author_id IS DISTINCT FROM $1
                         AND (r.channel_id IS NOT NULL OR v.since IS NULL OR msg.created_at > v.since)
                       LIMIT $2
                   ) capped
               ) unread"#,
            [user.id.into(), UNREAD_CAP.into()],
        ))
        .await?;
    let mut reads = Vec::with_capacity(rows.len());
    for row in rows {
        let last: i64 = row.try_get("", "last_read")?;
        reads.push(ReadView {
            channel_id: row.try_get("", "channel_id")?,
            server_id: row.try_get("", "server_id")?,
            last_read_id: last.to_string(),
            unread: row.try_get("", "unread")?,
        });
    }
    Ok(Json(reads))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarkInput {
    /// The newest message seen, as the string id messages carry.
    message_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Marked {
    channel_id: Uuid,
    last_read_id: String,
}

/// Marks a channel as read up to a message. The marker never moves back, so
/// an older device catching up cannot undo a newer read.
pub(crate) async fn mark(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
    Json(input): Json<MarkInput>,
) -> ApiResult<Json<Marked>> {
    require_channel(&state.db, id, user.id, "text").await?;
    let message: i64 = input
        .message_id
        .parse()
        .map_err(|_| ApiError::bad("Mensagem inválida."))?;
    let exists = state
        .db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT 1 AS found FROM messages WHERE id = $1 AND channel_id = $2",
            [message.into(), id.into()],
        ))
        .await?;
    if exists.is_none() {
        return Err(ApiError::bad("Esta mensagem não pertence ao canal."));
    }
    let row = state
        .db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"INSERT INTO channel_reads (user_id, channel_id, last_read_message_id)
               VALUES ($1, $2, $3)
               ON CONFLICT (user_id, channel_id) DO UPDATE SET
                   last_read_message_id = GREATEST(channel_reads.last_read_message_id, EXCLUDED.last_read_message_id),
                   updated_at = now()
               RETURNING last_read_message_id"#,
            [user.id.into(), id.into(), message.into()],
        ))
        .await?
        .ok_or_else(|| ApiError::internal("marcador de leitura não gravado"))?;
    let last: i64 = row.try_get("", "last_read_message_id")?;
    let marked = Marked {
        channel_id: id,
        last_read_id: last.to_string(),
    };
    // The user's other devices clear their badges too.
    state.realtime.publish_users(
        &HashSet::from([user.id]),
        serde_json::json!({ "type": "read.updated", "channelId": id, "lastReadId": marked.last_read_id }),
    );
    Ok(Json(marked))
}
