use super::*;
use crate::klipy::GifChoice;

pub(crate) const DEFAULT_BANNER: &str = "brand";
/// Banner colors from the design system palette; the client maps them to tokens.
const BANNERS: [&str; 5] = [DEFAULT_BANNER, "green", "amber", "red", "graphite"];

/// Every field is optional: only the ones sent change.
#[derive(Deserialize)]
pub(crate) struct ProfileInput {
    name: Option<String>,
    pronouns: Option<String>,
    bio: Option<String>,
    banner: Option<String>,
    /// A GIF from Klipy as the photo, or null to remove it.
    #[serde(default, rename = "avatarGif", deserialize_with = "present")]
    avatar_gif: Option<Option<GifChoice>>,
    /// A GIF from Klipy over the banner color, or null to remove it.
    #[serde(default, rename = "bannerGif", deserialize_with = "present")]
    banner_gif: Option<Option<GifChoice>>,
}

/// Tells a field sent as null (`Some(None)`) from a missing one (`None`).
fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

fn pronouns(value: &str) -> ApiResult<String> {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.chars().count() > 40 || value.chars().any(char::is_control) {
        return Err(ApiError::bad("Os pronomes devem ter até 40 caracteres."));
    }
    Ok(value)
}

fn bio(value: &str) -> ApiResult<String> {
    let value = value.trim().replace("\r\n", "\n");
    // Line breaks are allowed in "Sobre mim"; other control characters are not.
    if value.chars().count() > 190 || value.chars().any(|c| c.is_control() && c != '\n') {
        return Err(ApiError::bad("O “Sobre mim” deve ter até 190 caracteres."));
    }
    Ok(value)
}

fn banner(value: &str) -> ApiResult<String> {
    BANNERS
        .contains(&value)
        .then(|| value.to_owned())
        .ok_or_else(|| ApiError::bad("Escolha uma das cores de banner disponíveis."))
}

pub(crate) async fn update(
    State(state): State<AppState>,
    Extension(current): Extension<UserView>,
    Json(input): Json<ProfileInput>,
) -> ApiResult<Json<UserView>> {
    let mut row = user::ActiveModel {
        id: Set(current.id),
        ..Default::default()
    };
    let mut changed = false;
    if let Some(value) = input.name {
        row.name = Set(user_name(&value)?);
        changed = true;
    }
    if let Some(value) = input.pronouns {
        row.pronouns = Set(pronouns(&value)?);
        changed = true;
    }
    if let Some(value) = input.bio {
        row.bio = Set(bio(&value)?);
        changed = true;
    }
    if let Some(value) = input.banner {
        row.banner = Set(banner(&value)?);
        changed = true;
    }
    match input.avatar_gif {
        Some(Some(gif)) => {
            let gif = gif.validate()?;
            row.avatar_url = Set(Some(gif.url));
            row.avatar_source = Set(Some("gif".into()));
            row.avatar_still = Set(gif.still);
            changed = true;
        }
        // Back to initials; the next Google sign-in brings its photo.
        Some(None) if current.avatar_source.as_deref() == Some("gif") => {
            row.avatar_url = Set(None);
            row.avatar_source = Set(None);
            row.avatar_still = Set(None);
            changed = true;
        }
        _ => {}
    }
    if let Some(gif) = input.banner_gif {
        let gif = gif.map(GifChoice::validate).transpose()?;
        row.banner_still = Set(gif.as_ref().and_then(|g| g.still.clone()));
        row.banner_gif = Set(gif.map(|g| g.url));
        changed = true;
    }
    if !changed {
        return Ok(Json(current));
    }
    let view = UserView::from(row.update(&state.db).await?);
    broadcast(&state, &view).await?;
    Ok(Json(view))
}

/// Tells everyone who sees the user (their servers, themselves) about a
/// changed profile.
pub(crate) async fn broadcast(state: &AppState, view: &UserView) -> ApiResult<()> {
    let servers: Vec<_> = member::Entity::find()
        .filter(member::Column::UserId.eq(view.id))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|m| m.server_id)
        .collect();
    state.realtime.profile_updated(view, &servers);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_profile_fields() {
        assert_eq!(pronouns("  ela /  dela ").unwrap(), "ela / dela");
        assert!(pronouns(&"a".repeat(41)).is_err());
        assert_eq!(bio(" linha 1\r\nlinha 2 ").unwrap(), "linha 1\nlinha 2");
        assert!(bio(&"á".repeat(190)).is_ok());
        assert!(bio(&"á".repeat(191)).is_err());
        assert!(bio("tab\there").is_err());
        assert!(banner("green").is_ok());
        assert!(banner("#ff0000").is_err());
    }
}
