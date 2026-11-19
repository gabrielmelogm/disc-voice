#[cfg(windows)]
use crate::tray;
use crate::{call, camera, notify, screen};
use disc_audio::{AudioAction, AudioDevices, AudioEngine, AudioStatus};
use tauri::Manager;

/// Whether the app can live in the system tray (Windows only for now).
#[tauri::command]
fn tray_supported() -> bool {
    cfg!(windows)
}

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

pub fn run() {
    let builder = tauri::Builder::default();
    // Opening the app again while it sits in the tray brings back the running one.
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        tray::show_main(app)
    }));
    builder
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let engine = AudioEngine::new().map_err(std::io::Error::other)?;
            app.manage(engine);
            camera::manage(app).map_err(std::io::Error::other)?;
            screen::manage(app).map_err(std::io::Error::other)?;
            call::manage(app).map_err(std::io::Error::other)?;
            notify::manage(app);
            #[cfg(windows)]
            tray::manage(app)?;
            #[cfg(target_os = "linux")]
            crate::linux::enable_media(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(windows)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // The call and the connection keep running; Quit in the tray menu exits.
                if window.state::<tray::TrayState>().close_to_tray() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<AudioEngine>().shutdown();
                camera::shutdown(window);
                screen::shutdown(window);
                call::shutdown(window);
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
            call::native::call_camera_start,
            call::native::call_camera_stop,
            call::native::call_video_frame,
            notify::show_notification,
            tray_supported,
            #[cfg(windows)]
            tray::set_close_to_tray,
            #[cfg(windows)]
            tray::set_tray_status,
        ])
        .run(tauri::generate_context!())
        .expect("Não foi possível iniciar o Disc Voice");
}
