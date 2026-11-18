//! Screen sharing commands, backed by the native engine: the ScreenCast
//! portal plus PipeWire on Linux, Windows.Graphics.Capture on Windows.
//! Other platforms report that the feature is unavailable.

/// Whether native screen capture exists on this platform.
#[tauri::command]
pub fn screen_native() -> bool {
    cfg!(any(windows, target_os = "linux"))
}

#[cfg(any(windows, target_os = "linux"))]
pub mod native {
    use disc_video::{ScreenEngine, ScreenInfo, ScreenRequest};
    use std::time::Duration;
    use tauri::{ipc::Response, State};

    /// Long enough to avoid busy polling, short enough to notice a stop.
    const FRAME_WAIT: Duration = Duration::from_millis(250);

    async fn blocking<T: Send + 'static>(
        engine: &State<'_, ScreenEngine>,
        work: impl FnOnce(ScreenEngine) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let engine = engine.inner().clone();
        tauri::async_runtime::spawn_blocking(move || work(engine))
            .await
            .map_err(|error| error.to_string())?
    }

    /// Opens the system picker; resolves once the user chose (the capture
    /// info) or dismissed it (`null`). `screen_stop` cancels a pending call.
    #[tauri::command]
    pub async fn screen_start(
        engine: State<'_, ScreenEngine>,
        request: ScreenRequest,
    ) -> Result<Option<ScreenInfo>, String> {
        blocking(&engine, move |engine| engine.start(request)).await
    }

    #[tauri::command]
    pub async fn screen_stop(engine: State<'_, ScreenEngine>) -> Result<(), String> {
        blocking(&engine, |engine| {
            engine.stop();
            Ok(())
        })
        .await
    }

    /// The next JPEG frame as raw bytes (an `ArrayBuffer` in JavaScript),
    /// or an empty buffer when none arrived in time (screens only send
    /// frames when their content changes).
    #[tauri::command]
    pub async fn screen_frame(engine: State<'_, ScreenEngine>) -> Result<Response, String> {
        let frame = blocking(&engine, |engine| engine.next_frame(FRAME_WAIT)).await?;
        Ok(Response::new(
            frame.map(|frame| frame.to_vec()).unwrap_or_default(),
        ))
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
pub mod native {
    const UNSUPPORTED: &str =
        "O compartilhamento de tela ainda não está disponível nesta plataforma.";

    /// Extra IPC arguments (the request) are ignored by Tauri.
    #[tauri::command]
    pub fn screen_start() -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn screen_stop() -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub fn screen_frame() -> Result<Vec<u8>, String> {
        Err(UNSUPPORTED.into())
    }
}

/// Registers the native engine.
pub fn manage(app: &tauri::App) -> Result<(), String> {
    use tauri::Manager;
    #[cfg(target_os = "linux")]
    app.manage(disc_video::ScreenEngine::new()?);
    #[cfg(windows)]
    {
        // The Windows picker is a dialog owned by the main window.
        let window = app
            .get_webview_window("main")
            .ok_or("A janela principal não foi encontrada.")?;
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        app.manage(disc_video::ScreenEngine::new_for_window(hwnd.0 as isize)?);
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    let _ = app;
    Ok(())
}

/// Ends any sharing (and closes an open picker) when the window closes.
pub fn shutdown(window: &tauri::Window) {
    use tauri::Manager;
    if let Some(engine) = window.try_state::<disc_video::ScreenEngine>() {
        engine.shutdown();
    }
}
