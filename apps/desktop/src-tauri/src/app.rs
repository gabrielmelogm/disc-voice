use crate::{browser, call, camera, discord_rpc, notify, pip, screen, sounds, tray};
use disc_audio::{AudioAction, AudioDevices, AudioEngine, AudioStatus};
use tauri::Manager;

#[tauri::command]
async fn list_audio_devices(engine: tauri::State<'_, AudioEngine>) -> Result<AudioDevices, String> {
    let engine = engine.inner().clone();
    tauri::async_runtime::spawn_blocking(move || engine.devices())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn get_audio_status(engine: tauri::State<'_, AudioEngine>) -> Result<AudioStatus, String> {
    let engine = engine.inner().clone();
    tauri::async_runtime::spawn_blocking(move || engine.status())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn audio_action(
    engine: tauri::State<'_, AudioEngine>,
    action: AudioAction,
) -> Result<AudioStatus, String> {
    let engine = engine.inner().clone();
    tauri::async_runtime::spawn_blocking(move || engine.action(action))
        .await
        .map_err(|error| error.to_string())?
}

/// Saves the theme template in the Downloads folder and shows it in the file
/// manager. The webview ignores `<a download>`, so the file is written here.
#[tauri::command]
fn save_theme_template<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    contents: String,
) -> Result<String, String> {
    const MAX_BYTES: usize = 200 * 1024;
    // The app checks the theme again when it is imported; this only keeps
    // the command from writing anything other than a small JSON object.
    if contents.len() > MAX_BYTES || !contents.trim_start().starts_with('{') {
        return Err("O modelo de tema é inválido.".into());
    }
    let paths = app.path();
    let folder = paths
        .download_dir()
        .or_else(|_| paths.document_dir())
        .map_err(|_| "Não foi possível encontrar a pasta Downloads.".to_string())?;
    let mut path = folder.join("tema-disc-voice.json");
    let mut copy = 2;
    while path.exists() {
        path = folder.join(format!("tema-disc-voice ({copy}).json"));
        copy += 1;
    }
    std::fs::write(&path, contents)
        .map_err(|error| format!("Não foi possível salvar o modelo: {error}"))?;
    let _ = tauri_plugin_opener::reveal_item_in_dir(&path);
    Ok(path.display().to_string())
}

/// Media that "Fazer download" may save: what the chat shows as an image or video.
const MEDIA_EXTENSIONS: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "avif", "mp4", "webm"];

/// A file name safe for any file system, from the name the chat shows. Only
/// media extensions are kept, so nothing saved here can run as a program.
fn media_file_name(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    // Windows drops trailing dots and spaces; a leading dot would hide the file.
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']);
    let (stem, extension) = cleaned.rsplit_once('.')?;
    let stem = stem.trim().trim_start_matches('.').trim();
    let extension = extension.to_ascii_lowercase();
    if !MEDIA_EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }
    let stem: String = stem.trim().chars().take(100).collect();
    let stem = if stem.is_empty() {
        "imagem".into()
    } else {
        stem
    };
    Some(format!("{stem}.{extension}"))
}

/// Decodes the `%XX` escapes of `encodeURIComponent`.
fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = value.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Saves media from the chat ("Fazer download") in the Downloads folder and
/// shows it in the file manager. The body is the file; the `x-file-name`
/// header, its name as `encodeURIComponent` gives it.
#[tauri::command]
fn save_media<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    const MAX_BYTES: usize = 64 * 1024 * 1024;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Arquivo inválido.".into());
    };
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("Arquivo inválido.".into());
    }
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|value| value.to_str().ok())
        .and_then(percent_decode)
        .and_then(|name| media_file_name(&name))
        .ok_or("Só é possível baixar imagens e vídeos.")?;
    let paths = app.path();
    let folder = paths
        .download_dir()
        .or_else(|_| paths.document_dir())
        .map_err(|_| "Não foi possível encontrar a pasta Downloads.".to_string())?;
    let (stem, extension) = name.rsplit_once('.').unwrap_or((&name, ""));
    let mut path = folder.join(&name);
    let mut copy = 2;
    while path.exists() {
        path = folder.join(format!("{stem} ({copy}).{extension}"));
        copy += 1;
    }
    std::fs::write(&path, bytes)
        .map_err(|error| format!("Não foi possível salvar o arquivo: {error}"))?;
    let _ = tauri_plugin_opener::reveal_item_in_dir(&path);
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_names_are_safe() {
        assert_eq!(
            media_file_name("Gato dançando.GIF").as_deref(),
            Some("Gato dançando.gif")
        );
        assert_eq!(
            media_file_name("../../etc/foto.png").as_deref(),
            Some("_.._etc_foto.png")
        );
        assert_eq!(media_file_name(".webp").as_deref(), Some("imagem.webp"));
        assert_eq!(media_file_name("script.exe"), None);
        assert_eq!(media_file_name("foto.png.exe"), None);
        assert_eq!(media_file_name("sem extensão"), None);
        assert_eq!(
            percent_decode("Gato%20dan%C3%A7ando.gif").as_deref(),
            Some("Gato dançando.gif")
        );
        assert_eq!(percent_decode("%zz"), None);
    }
}

/// The update platform of this install (`windows-x86_64`, `linux-x86_64`,
/// `linux-x86_64-flatpak`), as the update manifests name it, or `None` when it
/// cannot update itself: a .deb or .rpm is updated by the package manager, and
/// development builds never update. The Flatpak cannot replace its own files:
/// it only tells of a new version, and the user installs the new .flatpak.
#[tauri::command]
fn updater_platform() -> Option<String> {
    if cfg!(debug_assertions) {
        return None;
    }
    #[cfg(target_os = "linux")]
    let os = {
        // Set by Flatpak inside the sandbox.
        if std::env::var_os("FLATPAK_ID").is_some() {
            return Some(format!("linux-{}-flatpak", std::env::consts::ARCH));
        }
        // Set by the AppImage runtime to the path the update replaces.
        std::env::var_os("APPIMAGE")?;
        "linux"
    };
    #[cfg(not(target_os = "linux"))]
    let os = "windows";
    Some(format!("{os}-{}", std::env::consts::ARCH))
}

pub fn run() {
    tauri::Builder::default()
        // Opening the app again while it sits in the tray brings back the running one.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            tray::show_main(app)
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let engine = AudioEngine::new().map_err(std::io::Error::other)?;
            app.manage(engine);
            camera::manage(app).map_err(std::io::Error::other)?;
            screen::manage(app).map_err(std::io::Error::other)?;
            call::manage(app).map_err(std::io::Error::other)?;
            notify::manage(app);
            discord_rpc::manage(app);
            tray::manage(app);
            pip::manage(app);
            // On Windows the frontend draws its own title bar to match the app theme.
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                window.set_decorations(false)?;
                window.set_shadow(true)?;
            }
            #[cfg(target_os = "linux")]
            crate::linux::enable_media(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // The call and the connection keep running; Quit in the tray menu exits.
                if tray::hides_on_close(window) {
                    api.prevent_close();
                    // Watching a shared screen, it floats instead of hiding.
                    if !pip::on_close_to_tray(window) {
                        let _ = window.hide();
                    }
                }
            }
            if matches!(event, tauri::WindowEvent::Resized(_)) {
                pip::on_resized(window);
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<AudioEngine>().shutdown();
                camera::shutdown(window);
                screen::shutdown(window);
                call::shutdown(window);
                discord_rpc::shutdown(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_audio_devices,
            get_audio_status,
            audio_action,
            camera::camera_native,
            camera::native::camera_devices,
            camera::native::camera_start,
            camera::native::camera_start_call,
            camera::native::camera_stop,
            camera::native::camera_frame,
            screen::screen_native,
            screen::native::screen_start,
            screen::native::screen_stop,
            screen::native::screen_frame,
            screen::native::screen_audio_start,
            screen::native::screen_audio_stop,
            call::call_native,
            call::native::call_join,
            call::native::call_leave,
            call::native::call_peers,
            call::native::call_signal,
            call::native::call_mute,
            call::native::call_deafen,
            call::native::call_set_input,
            call::native::call_set_output,
            call::native::call_devices,
            call::native::call_screen_start,
            call::native::call_screen_stop,
            call::native::call_screen_audio_start,
            call::native::call_screen_audio_stop,
            call::native::call_screen_volume,
            call::native::call_camera_start,
            call::native::call_camera_stop,
            call::native::call_video_frame,
            notify::show_notification,
            sounds::sound_native,
            sounds::native::play_sound,
            discord_rpc::discord_presence,
            browser::open_url,
            save_theme_template,
            save_media,
            updater_platform,
            pip::set_pip_ready,
            pip::pip_exit,
            tray::tray_supported,
            tray::set_close_to_tray,
            tray::set_tray_status,
        ])
        .run(tauri::generate_context!())
        .expect("Não foi possível iniciar o Disc Voice");
}
