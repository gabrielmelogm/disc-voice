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

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let engine = AudioEngine::new().map_err(std::io::Error::other)?;
            app.manage(engine);
            #[cfg(target_os = "linux")]
            crate::linux::enable_camera(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<AudioEngine>().shutdown();
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_audio_devices,
            get_audio_status,
            audio_action,
        ])
        .run(tauri::generate_context!())
        .expect("Não foi possível iniciar o Disc Voice");
}
