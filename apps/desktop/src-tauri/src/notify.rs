//! OS notifications with the app's own name and icon, and the sender's avatar.
//!
//! On Windows the notification plugin only names the app when it runs from an install
//! (in `tauri dev` the toast says "Windows PowerShell"), so toasts are sent here: the
//! app ID is registered under HKCU with its display name and icon, and each toast shows
//! the avatar the page drew. Elsewhere the notification plugin sends them.

use serde::Deserialize;
use tauri::{AppHandle, Runtime};

#[derive(Deserialize)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct Avatar {
    /// File name stem: the page derives it from what the image shows.
    key: String,
    /// PNG bytes.
    png: Vec<u8>,
}

#[tauri::command]
pub async fn show_notification<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: String,
    avatar: Option<Avatar>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || imp::show(&app, &title, &body, avatar))
        .await
        .map_err(|error| error.to_string())?
}

/// Prepares the OS to show the app's notifications; failures only lose the branding.
pub fn manage<R: Runtime>(app: &tauri::App<R>) {
    imp::register(app.handle());
}

/// Keeps a file name to letters, digits and dashes so the page cannot pick a path.
#[cfg_attr(not(windows), allow(dead_code))]
fn safe_key(key: &str) -> Option<String> {
    let key: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(64)
        .collect();
    (!key.is_empty()).then_some(key)
}

#[cfg_attr(not(windows), allow(dead_code))]
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
#[cfg_attr(not(windows), allow(dead_code))]
const MAX_AVATAR_BYTES: usize = 256 * 1024;

#[cfg(windows)]
mod imp {
    use super::{safe_key, Avatar, MAX_AVATAR_BYTES, PNG_SIGNATURE};
    use std::path::PathBuf;
    use tauri::{AppHandle, Manager, Runtime};
    use tauri_winrt_notification::{IconCrop, Toast};
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    const ICON: &[u8] = include_bytes!("../icons/128x128@2x.png");

    fn folder<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
        let dir = app
            .path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?
            .join("notifications");
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        Ok(dir)
    }

    /// Names the app ID (the same one the installer gives its shortcut) and sets its icon.
    pub fn register<R: Runtime>(app: &AppHandle<R>) {
        let result = (|| -> Result<(), String> {
            let icon = folder(app)?.join("app-icon.png");
            std::fs::write(&icon, ICON).map_err(|error| error.to_string())?;
            let path = format!(
                r"Software\Classes\AppUserModelId\{}",
                app.config().identifier
            );
            let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
                .create_subkey(path)
                .map_err(|error| error.to_string())?;
            let name = app
                .config()
                .product_name
                .clone()
                .unwrap_or_else(|| "Disc Voice".into());
            key.set_value("DisplayName", &name)
                .map_err(|error| error.to_string())?;
            key.set_value("IconUri", &icon.display().to_string())
                .map_err(|error| error.to_string())?;
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("Não foi possível registrar as notificações: {error}");
        }
    }

    fn avatar_file<R: Runtime>(app: &AppHandle<R>, avatar: Avatar) -> Option<PathBuf> {
        let key = safe_key(&avatar.key)?;
        if avatar.png.len() > MAX_AVATAR_BYTES || !avatar.png.starts_with(PNG_SIGNATURE) {
            return None;
        }
        let file = folder(app).ok()?.join(format!("avatar-{key}.png"));
        // The key names the picture, so a file already there shows the same thing.
        if !file.exists() {
            let partial = file.with_extension("tmp");
            std::fs::write(&partial, &avatar.png).ok()?;
            std::fs::rename(&partial, &file).ok()?;
        }
        Some(file)
    }

    pub fn show<R: Runtime>(
        app: &AppHandle<R>,
        title: &str,
        body: &str,
        avatar: Option<Avatar>,
    ) -> Result<(), String> {
        let mut toast = Toast::new(&app.config().identifier)
            .title(title)
            .text1(body)
            // The page plays the app's own sound.
            .sound(None);
        if let Some(file) = avatar.and_then(|avatar| avatar_file(app, avatar)) {
            toast = toast.icon(&file, IconCrop::Circular, title);
        }
        let app = app.clone();
        toast
            .on_activated(move |_| {
                crate::tray::show_main(&app);
                Ok(())
            })
            .show()
            .map_err(|error| error.to_string())
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Avatar;
    use tauri::{AppHandle, Runtime};
    use tauri_plugin_notification::NotificationExt;

    pub fn register<R: Runtime>(_app: &AppHandle<R>) {}

    pub fn show<R: Runtime>(
        app: &AppHandle<R>,
        title: &str,
        body: &str,
        _avatar: Option<Avatar>,
    ) -> Result<(), String> {
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::safe_key;

    #[test]
    fn keys_cannot_leave_the_folder() {
        assert_eq!(safe_key("ab12-cd").as_deref(), Some("ab12-cd"));
        assert_eq!(safe_key("../../evil").as_deref(), Some("evil"));
        assert_eq!(safe_key("..\\"), None);
    }
}
