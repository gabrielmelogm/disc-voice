//! Webcam commands. On Linux the camera is captured natively (WebKitGTK's
//! own capture corrupts PipeWire frames); on Windows the UI keeps using
//! WebView2's getUserMedia and these commands only report that.

/// Whether the UI must use the native camera instead of getUserMedia.
#[tauri::command]
pub fn camera_native() -> bool {
    cfg!(target_os = "linux")
}

#[cfg(target_os = "linux")]
pub mod native {
    use disc_video::{CameraDevice, CameraEngine, CameraInfo};
    use std::time::Duration;
    use tauri::{ipc::Response, State};

    /// Long enough to avoid busy polling, short enough to notice a stop.
    const FRAME_WAIT: Duration = Duration::from_millis(250);

    async fn blocking<T: Send + 'static>(
        engine: &State<'_, CameraEngine>,
        work: impl FnOnce(CameraEngine) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let engine = engine.inner().clone();
        tauri::async_runtime::spawn_blocking(move || work(engine))
            .await
            .map_err(|error| error.to_string())?
    }

    #[tauri::command]
    pub async fn camera_devices(
        engine: State<'_, CameraEngine>,
    ) -> Result<Vec<CameraDevice>, String> {
        blocking(&engine, |engine| engine.devices()).await
    }

    #[tauri::command]
    pub async fn camera_start(
        engine: State<'_, CameraEngine>,
        device_id: String,
    ) -> Result<CameraInfo, String> {
        blocking(&engine, move |engine| engine.start(&device_id)).await
    }

    #[tauri::command]
    pub async fn camera_stop(engine: State<'_, CameraEngine>) -> Result<(), String> {
        blocking(&engine, |engine| {
            engine.stop();
            Ok(())
        })
        .await
    }

    /// The next JPEG frame as raw bytes (an `ArrayBuffer` in JavaScript),
    /// or an empty buffer when none arrived in time. The UI pulls frames at
    /// its own pace, so a slow page drops frames instead of queueing them.
    #[tauri::command]
    pub async fn camera_frame(engine: State<'_, CameraEngine>) -> Result<Response, String> {
        let frame = blocking(&engine, |engine| engine.next_frame(FRAME_WAIT)).await?;
        Ok(Response::new(
            frame.map(|frame| frame.to_vec()).unwrap_or_default(),
        ))
    }
}

#[cfg(not(target_os = "linux"))]
pub mod native {
    const UNSUPPORTED: &str = "A câmera nativa não é usada nesta plataforma.";

    #[tauri::command]
    pub fn camera_devices() -> Result<Vec<()>, String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn camera_start(device_id: String) -> Result<(), String> {
        let _ = device_id;
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn camera_stop() -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub fn camera_frame() -> Result<Vec<u8>, String> {
        Err(UNSUPPORTED.into())
    }
}

/// Registers the native engine (Linux only).
pub fn manage(app: &tauri::App) {
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        app.manage(disc_video::CameraEngine::new());
    }
    #[cfg(not(target_os = "linux"))]
    let _ = app;
}

/// Releases the webcam when the window closes.
pub fn shutdown(window: &tauri::Window) {
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        if let Some(engine) = window.try_state::<disc_video::CameraEngine>() {
            engine.stop();
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = window;
}
