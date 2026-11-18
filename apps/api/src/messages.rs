use super::*;
use axum::extract::Query;
use entities::message;
use sea_orm::{ConnectionTrait, DbBackend, QuerySelect, Statement};
use std::collections::HashMap;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageView {
    id: String,
    channel_id: Uuid,
    client_id: Uuid,
    author: UserView,
    content: String,
    created_at: chrono::DateTime<Utc>,
}

impl MessageView {
    fn new(m: message::Model, author: UserView) -> Self {
        Self {
            id: m.id.to_string(),
            channel_id: m.channel_id,
            client_id: m.client_id,
            author,
            content: m.content,
            created_at: m.created_at,
        }
    }
}

#[derive(Default, Deserialize)]
pub(crate) struct History {
    before: Option<i64>,
    after: Option<i64>,
    limit: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    messages: Vec<MessageView>,
    has_more: bool,
}

pub(crate) async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
    Query(input): Query<History>,
) -> ApiResult<Json<Page>> {
    require_channel(&state.db, id, user.id, "text").await?;
    if input.before.is_some() && input.after.is_some() {
        return Err(ApiError::bad("Use apenas before ou after."));
    }
    let limit = input.limit.unwrap_or(50).clamp(1, 100);
    let mut query = message::Entity::find().filter(message::Column::ChannelId.eq(id));
    if let Some(before) = input.before {
        query = query.filter(message::Column::Id.lt(before));
    }
    if let Some(after) = input.after {
        query = query
            .filter(message::Column::Id.gt(after))
            .order_by_asc(message::Column::Id);
    } else {
        query = query.order_by_desc(message::Column::Id);
    }
    let mut rows = query.limit(limit + 1).all(&state.db).await?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    if input.after.is_none() {
        rows.reverse();
    }
    let authors: HashMap<_, _> = user::Entity::find()
        .filter(user::Column::Id.is_in(rows.iter().map(|m| m.author_id)))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|u| (u.id, UserView::from(u)))
        .collect();
    let messages = rows
        .into_iter()
        .map(|m| {
            let author = authors[&m.author_id].clone();
            MessageView::new(m, author)
        })
        .collect();
    Ok(Json(Page { messages, has_more }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendMessage {
    client_id: Uuid,
    content: String,
}

pub(crate) async fn send(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Path(id): Path<Uuid>,
    Json(input): Json<SendMessage>,
) -> ApiResult<Json<MessageView>> {
    let channel = require_channel(&state.db, id, user.id, "text").await?;
    let content = input.content.trim();
    if content.is_empty() || content.chars().count() > 4000 || content.contains('\0') {
        return Err(ApiError::bad(
            "A mensagem deve ter entre 1 e 4000 caracteres.",
        ));
    }
    let tx = state.db.begin().await?;
    // Serialize commits within a channel: history cursors must never skip a
    // lower sequence whose transaction was still open when the page was read.
    tx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [id.to_string().into()],
    ))
    .await?;
    let existing = message::Entity::find()
        .filter(message::Column::AuthorId.eq(user.id))
        .filter(message::Column::ClientId.eq(input.client_id))
        .one(&tx)
        .await?;
    let row = if let Some(existing) = existing {
        if existing.channel_id != id || existing.content != content {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Identificador de envio já utilizado.".into(),
            ));
        }
        existing
    } else {
        message::ActiveModel {
            channel_id: Set(id),
            author_id: Set(user.id),
            client_id: Set(input.client_id),
            content: Set(content.into()),
            created_at: Set(Utc::now()),
            ..Default::default()
        }
        .insert(&tx)
        .await?
    };
    tx.commit().await?;
    let view = MessageView::new(row, user);
    state.realtime.publish_server(
        channel.server_id,
        serde_json::json!({
            "type": "message.created", "message": view
        }),
    );
    Ok(Json(view))
}
