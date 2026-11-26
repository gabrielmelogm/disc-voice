//! Voice call commands. WebKitGTK ships without WebRTC, so on Linux calls
//! run in the native engine (disc-call) and the UI only relays signaling;
//! WebView2 has WebRTC, so on Windows the UI keeps its own peer connections
//! and these commands only report that.

/// Whether the UI must use the native call engine instead of RTCPeerConnection.
#[tauri::command]
pub fn call_native() -> bool {
    cfg!(target_os = "linux")
}

#[cfg(target_os = "linux")]
pub mod native {
    use disc_call::{CallConfig, CallDevices, CallEngine, CallEvent, VideoSource, SCREEN_BITRATE};
    use disc_video::{CameraEngine, ScreenEngine};
    use std::{sync::Arc, time::Duration};
    use tauri::{
        ipc::{Channel, Response},
        State,
    };

    /// Long enough to avoid busy polling, short enough to notice a stop.
    const FRAME_WAIT: Duration = Duration::from_millis(250);

    async fn blocking<T: Send + 'static>(
        engine: &State<'_, CallEngine>,
        work: impl FnOnce(CallEngine) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let engine = engine.inner().clone();
        tauri::async_runtime::spawn_blocking(move || work(engine))
            .await
            .map_err(|error| error.to_string())?
    }

    /// Opens the microphone and speakers; events arrive on `on_event`.
    /// Resolves to the call's ID, for `call_leave`.
    #[tauri::command]
    pub async fn call_join(
        engine: State<'_, CallEngine>,
        config: CallConfig,
        on_event: Channel<CallEvent>,
    ) -> Result<u64, String> {
        blocking(&engine, move |engine| {
            engine.join(
                config,
                Arc::new(move |event| {
                    let _ = on_event.send(event);
                }),
            )
        })
        .await
    }

    /// Ends the call `id`, or whichever call is running without one.
    #[tauri::command]
    pub async fn call_leave(engine: State<'_, CallEngine>, id: Option<u64>) -> Result<(), String> {
        blocking(&engine, move |engine| {
            engine.leave(id);
            Ok(())
        })
        .await
    }

    #[tauri::command]
    pub fn call_peers(engine: State<'_, CallEngine>, self_id: String, peer_ids: Vec<String>) {
        engine.set_peers(&self_id, &peer_ids);
    }

    #[tauri::command]
    pub fn call_signal(engine: State<'_, CallEngine>, peer_id: String, data: serde_json::Value) {
        engine.signal(&peer_id, data);
    }

    #[tauri::command]
    pub fn call_mute(engine: State<'_, CallEngine>, muted: bool) {
        engine.set_muted(muted);
    }

    #[tauri::command]
    pub fn call_deafen(engine: State<'_, CallEngine>, deafened: bool) {
        engine.set_deafened(deafened);
    }

    #[tauri::command]
    pub async fn call_set_input(
        engine: State<'_, CallEngine>,
        input_id: String,
    ) -> Result<(), String> {
        blocking(&engine, move |engine| engine.set_input(&input_id)).await
    }

    #[tauri::command]
    pub async fn call_set_output(
        engine: State<'_, CallEngine>,
        output_id: String,
    ) -> Result<(), String> {
        blocking(&engine, move |engine| engine.set_output(&output_id)).await
    }

    #[tauri::command]
    pub async fn call_devices(engine: State<'_, CallEngine>) -> Result<CallDevices, String> {
        blocking(&engine, |engine| engine.devices()).await
    }

    /// Sends what the screen engine captures (after `screen_start`) to the
    /// call, at most `bitrate` bits per second for each peer (the chosen
    /// quality's). The call reads the uncompressed frames; the UI keeps
    /// drawing our preview from the JPEG ones (`screen_frame`).
    #[tauri::command]
    pub async fn call_screen_start(
        engine: State<'_, CallEngine>,
        screen: State<'_, ScreenEngine>,
        frame_rate: u32,
        bitrate: Option<u32>,
    ) -> Result<(), String> {
        let screen = screen.inner().clone();
        let bitrate = bitrate.filter(|&bits| bits > 0).unwrap_or(SCREEN_BITRATE);
        blocking(&engine, move |engine| {
            engine.start_video(
                VideoSource::Screen,
                Box::new(move |timeout| screen.next_raw_frame(timeout)),
                frame_rate,
                bitrate,
            )
        })
        .await
    }

    /// Stops our screen, and its audio with it.
    #[tauri::command]
    pub async fn call_screen_stop(engine: State<'_, CallEngine>) -> Result<(), String> {
        blocking(&engine, |engine| {
            engine.stop_video(VideoSource::Screen);
            Ok(())
        })
        .await
    }

    /// Sends the computer's audio (minus this app's) with our screen.
    #[tauri::command]
    pub async fn call_screen_audio_start(engine: State<'_, CallEngine>) -> Result<(), String> {
        blocking(&engine, |engine| engine.start_screen_audio()).await
    }

    #[tauri::command]
    pub async fn call_screen_audio_stop(engine: State<'_, CallEngine>) -> Result<(), String> {
        blocking(&engine, |engine| {
            engine.stop_screen_audio();
            Ok(())
        })
        .await
    }

    /// Our local volume (0 to 1) for the audio of a peer's screen.
    #[tauri::command]
    pub fn call_screen_volume(engine: State<'_, CallEngine>, peer_id: String, volume: f32) {
        engine.set_screen_volume(&peer_id, volume);
    }

    /// Sends what the camera engine captures (after `camera_start_call`) to
    /// the call, at most `frame_rate` per second and `bitrate` bits per second
    /// for each peer. Our own tile is drawn from its JPEGs (`camera_frame`).
    #[tauri::command]
    pub async fn call_camera_start(
        engine: State<'_, CallEngine>,
        camera: State<'_, CameraEngine>,
        frame_rate: u32,
        bitrate: u32,
    ) -> Result<(), String> {
        let camera = camera.inner().clone();
        blocking(&engine, move |engine| {
            engine.start_video(
                VideoSource::Camera,
                Box::new(move |timeout| camera.next_raw_frame(timeout)),
                frame_rate,
                bitrate,
            )
        })
        .await
    }

    #[tauri::command]
    pub async fn call_camera_stop(engine: State<'_, CallEngine>) -> Result<(), String> {
        blocking(&engine, |engine| {
            engine.stop_video(VideoSource::Camera);
            Ok(())
        })
        .await
    }

    /// The next picture of a peer's screen or camera as JPEG bytes. Empty
    /// when none arrived in time.
    #[tauri::command]
    pub async fn call_video_frame(
        engine: State<'_, CallEngine>,
        peer_id: String,
        source: VideoSource,
    ) -> Result<Response, String> {
        let frame = blocking(&engine, move |engine| {
            Ok(engine.video_frame(&peer_id, source, FRAME_WAIT))
        })
        .await?;
        Ok(Response::new(frame.unwrap_or_default()))
    }
}

#[cfg(not(target_os = "linux"))]
pub mod native {
    //! WebView2 runs calls itself; the UI never calls these here. Extra IPC
    //! arguments are ignored by Tauri.
    const UNSUPPORTED: &str = "O motor de chamadas nativo não é usado nesta plataforma.";

    #[tauri::command]
    pub fn call_join() -> Result<u64, String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn call_leave() {}

    #[tauri::command]
    pub fn call_peers() {}

    #[tauri::command]
    pub fn call_signal() {}

    #[tauri::command]
    pub fn call_mute() {}

    #[tauri::command]
    pub fn call_deafen() {}

    #[tauri::command]
    pub fn call_set_input() -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn call_set_output() -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn call_devices() -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn call_screen_start() -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn call_screen_stop() {}

    #[tauri::command]
    pub fn call_screen_audio_start() -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn call_screen_audio_stop() {}

    #[tauri::command]
    pub fn call_screen_volume() {}

    #[tauri::command]
    pub fn call_camera_start() -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn call_camera_stop() {}

    #[tauri::command]
    pub fn call_video_frame() -> Result<Vec<u8>, String> {
        Err(UNSUPPORTED.into())
    }
}

/// Registers the native engine (Linux only).
pub fn manage(app: &tauri::App) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        app.manage(disc_call::CallEngine::new()?);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = app;
    Ok(())
}

/// Ends the call when the window closes.
pub fn shutdown(window: &tauri::Window) {
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        if let Some(engine) = window.try_state::<disc_call::CallEngine>() {
            engine.shutdown();
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = window;
}
