//! WebKitGTK setup for voice calls. WebView2 enables media capture and shows
//! its own permission prompt on Windows; WebKitGTK ships with capture and
//! WebRTC off and silently denies any permission request no handler answers.
//! The webcam is captured natively (disc-video), so only the microphone is
//! granted to the page.

use tauri::{Manager, Runtime};
use webkit2gtk::{
    glib::object::Cast, PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
    UserMediaPermissionRequestExt, WebViewExt,
};

pub fn enable_media<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    for window in app.webview_windows().values() {
        window.with_webview(|webview| {
            let webview = webview.inner();
            // Only allow capture for the trusted application origin.
            // WebRTC calls use the microphone; local tests still use PulseAudio.
            webview.connect_permission_request(|view, request| {
                let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() else {
                    return false;
                };
                let trusted = view
                    .uri()
                    .and_then(|uri| tauri::Url::parse(&uri).ok())
                    .is_some_and(|url| {
                        matches!(
                            (url.scheme(), url.host_str()),
                            ("tauri", Some("localhost"))
                                | ("http" | "https", Some("tauri.localhost"))
                        ) || (cfg!(debug_assertions)
                            && url.scheme() == "http"
                            && url.host_str() == Some("127.0.0.1")
                            && url.port() == Some(1420))
                    });
                if trusted && media.is_for_audio_device() && !media.is_for_video_device() {
                    request.allow();
                } else {
                    request.deny();
                }
                true
            });
            if let Some(settings) = WebViewExt::settings(&webview) {
                if !settings.enables_media_stream() || !settings.enables_webrtc() {
                    settings.set_enable_media_stream(true);
                    settings.set_enable_webrtc(true);
                    // navigator.mediaDevices is exposed when a document is
                    // created, and the first page load may already be under way.
                    webview.reload();
                }
            }
        })?;
    }
    Ok(())
}
