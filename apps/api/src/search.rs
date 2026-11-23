//! Global search (Ctrl+K) over the servers the user belongs to.
use super::*;
use axum::extract::Query;
use sea_orm::{DbBackend, FromQueryResult, Statement};

const MESSAGE_PAGE: i64 = 20;
const NAME_LIMIT: i64 = 8;

#[derive(Deserialize)]
pub(crate) struct SearchInput {
    q: String,
    /// Message cursor: only messages with a lower id. Channels and people are
    /// returned on the first page only.
    before: Option<i64>,
}

#[derive(Serialize, FromQueryResult)]
#[serde(rename_all = "camelCase")]
struct ChannelHit {
    id: Uuid,
    server_id: Uuid,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    server_name: String,
}

#[derive(FromQueryResult)]
struct MessageRow {
    id: i64,
    channel_id: Uuid,
    author_id: Option<Uuid>,
    discord_author: Option<serde_json::Value>,
    content: String,
    created_at: chrono::DateTime<Utc>,
    channel_name: String,
    server_id: Uuid,
    server_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageHit {
    id: String,
    channel_id: Uuid,
    channel_name: String,
    server_id: Uuid,
    server_name: String,
    author: UserView,
    content: String,
    created_at: chrono::DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Results {
    channels: Vec<ChannelHit>,
    people: Vec<UserView>,
    messages: Vec<MessageHit>,
    /// Pass as `before` to load more messages; absent on the last page.
    next_cursor: Option<String>,
}

/// Prefix query over the words of the input. Words keep only letters and
/// digits, so the input can never inject tsquery operators.
fn text_query(input: &str) -> Option<String> {
    let words: Vec<_> = input
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .take(8)
        .map(|w| format!("{}:*", w.to_lowercase()))
        .collect();
    (!words.is_empty()).then(|| words.join(" & "))
}

/// ILIKE pattern that matches the input literally anywhere in the name.
fn like_pattern(input: &str) -> String {
    let escaped = input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

pub(crate) async fn search(
    State(state): State<AppState>,
    Extension(user): Extension<UserView>,
    Query(input): Query<SearchInput>,
) -> ApiResult<Json<Results>> {
    let q = input.q.trim();
    if q.is_empty() || q.chars().count() > 100 {
        return Err(ApiError::bad("A busca deve ter entre 1 e 100 caracteres."));
    }
    let (mut channels, mut people) = (Vec::new(), Vec::new());
    if input.before.is_none() {
        let pattern = like_pattern(q);
        channels = ChannelHit::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT c.id, c.server_id, c.name, c.type AS kind, s.name AS server_name
               FROM channels c
               JOIN members m ON m.server_id = c.server_id AND m.user_id = $1
               JOIN servers s ON s.id = c.server_id
               WHERE c.name ILIKE $2 ESCAPE '\'
               ORDER BY position(lower($3) IN c.name), c.name, s.name
               LIMIT $4"#,
            [
                user.id.into(),
                pattern.clone().into(),
                q.into(),
                NAME_LIMIT.into(),
            ],
        ))
        .all(&state.db)
        .await?;
        people = user::Entity::find()
            .from_raw_sql(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"SELECT u.* FROM users u
                   WHERE u.id <> $1 AND u.name ILIKE $2 ESCAPE '\'
                     AND EXISTS (
                       SELECT 1 FROM members mine
                       JOIN members theirs ON theirs.server_id = mine.server_id
                       WHERE mine.user_id = $1 AND theirs.user_id = u.id)
                   ORDER BY position(lower($3) IN lower(u.name)), u.name
                   LIMIT $4"#,
                [user.id.into(), pattern.into(), q.into(), NAME_LIMIT.into()],
            ))
            .all(&state.db)
            .await?
            .into_iter()
            .map(UserView::from)
            .collect();
    }

    let mut rows = match text_query(q) {
        // The expression matches the messages_search GIN index.
        Some(query) => {
            MessageRow::find_by_statement(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"SELECT msg.id, msg.channel_id, msg.author_id, msg.discord_author, msg.content, msg.created_at,
                          c.name AS channel_name, c.server_id, s.name AS server_name
                   FROM messages msg
                   JOIN channels c ON c.id = msg.channel_id
                   JOIN members m ON m.server_id = c.server_id AND m.user_id = $1
                   JOIN servers s ON s.id = c.server_id
                   WHERE to_tsvector('simple', msg.content) @@ to_tsquery('simple', $2)
                     AND ($3::bigint IS NULL OR msg.id < $3)
                   ORDER BY msg.id DESC
                   LIMIT $4"#,
                [
                    user.id.into(),
                    query.into(),
                    input.before.into(),
                    (MESSAGE_PAGE + 1).into(),
                ],
            ))
            .all(&state.db)
            .await?
        }
        None => Vec::new(),
    };
    let more = rows.len() > MESSAGE_PAGE as usize;
    rows.truncate(MESSAGE_PAGE as usize);
    let next_cursor = more
        .then(|| rows.last().map(|m| m.id.to_string()))
        .flatten();
    let authors = messages::Authors::load(
        &state.db,
        rows.iter()
            .map(|m| (m.author_id, m.discord_author.as_ref())),
    )
    .await?;
    let messages = rows
        .into_iter()
        .filter_map(|m| {
            Some(MessageHit {
                author: authors.get(m.author_id, m.discord_author.as_ref())?,
                id: m.id.to_string(),
                channel_id: m.channel_id,
                channel_name: m.channel_name,
                server_id: m.server_id,
                server_name: m.server_name,
                content: m.content,
                created_at: m.created_at,
            })
        })
        .collect();
    Ok(Json(Results {
        channels,
        people,
        messages,
        next_cursor,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_safe_queries() {
        assert_eq!(
            text_query("Olá, mundo!").as_deref(),
            Some("olá:* & mundo:*")
        );
        assert_eq!(
            text_query("a & !b | c:*").as_deref(),
            Some("a:* & b:* & c:*")
        );
        assert_eq!(text_query("  ...  "), None);
        assert_eq!(like_pattern("50%_a\\b"), "%50\\%\\_a\\\\b%");
    }
}
