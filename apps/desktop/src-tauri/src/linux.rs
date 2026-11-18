//! WebKitGTK setup for the webcam. WebView2 enables media capture and shows
//! its own permission prompt on Windows; WebKitGTK ships with capture off and
//! silently denies any permission request no handler answers.

use tauri::{Manager, Runtime};
use webkit2gtk::{
    glib::object::Cast, PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
    UserMediaPermissionRequestExt, WebViewExt,
};

pub fn enable_camera<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    for window in app.webview_windows().values() {
        window.with_webview(|webview| {
            let webview = webview.inner();
            // Only the bundled UI is loaded (the CSP blocks frames and remote
            // pages), so camera requests come from the app itself. Microphone
            // capture goes through the native audio engine and stays denied.
            webview.connect_permission_request(|_, request| {
                let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() else {
                    return false;
                };
                if media.is_for_video_device() && !media.is_for_audio_device() {
                    request.allow();
                } else {
                    request.deny();
                }
                true
            });
            if let Some(settings) = WebViewExt::settings(&webview) {
                if !settings.enables_media_stream() {
                    settings.set_enable_media_stream(true);
                    // navigator.mediaDevices is exposed when a document is
                    // created, and the first page load may already be under way.
                    webview.reload();
                }
            }
        })?;
    }
    Ok(())
}
