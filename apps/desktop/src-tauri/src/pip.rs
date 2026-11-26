//! Picture-in-picture: while the user watches someone's shared screen in a
//! call, minimizing the app (or closing it to the tray) turns the main window
//! into a small floating one, always on top, that keeps showing that screen.
//!
//! The window itself shrinks instead of a second one opening: the call's
//! media lives in the main webview (WebView2's streams, or the Linux engine's
//! frames, which have one reader each), and a hidden page would stop drawing.
//! The page says when picture-in-picture makes sense (`set_pip_ready`) and
//! draws the compact view while it is on (`pip-changed`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Runtime,
    WebviewWindow, Window,
};

const MAIN: &str = "main";
/// The floating window, in logical pixels: a 16:9 screen plus room for controls.
const SIZE: (f64, f64) = (480.0, 300.0);
const MARGIN: f64 = 16.0;
/// The main window's minimum size (`tauri.conf.json`), restored afterwards.
const MIN_SIZE: (f64, f64) = (800.0, 650.0);

/// Where the window was before shrinking.
#[derive(Clone, Copy, Debug)]
struct Saved {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    maximized: bool,
}

#[derive(Default)]
struct PipState {
    /// A remote screen is being shown in a call and the user wants this.
    ready: AtomicBool,
    active: Mutex<Option<Saved>>,
}

/// What a minimize means.
#[derive(Debug, PartialEq, Eq)]
enum OnMinimize {
    Enter,
    /// Minimizing the floating window (a click on its taskbar button) brings
    /// the app back.
    Restore,
    Nothing,
}

fn on_minimize(ready: bool, active: bool) -> OnMinimize {
    match (active, ready) {
        (true, _) => OnMinimize::Restore,
        (false, true) => OnMinimize::Enter,
        (false, false) => OnMinimize::Nothing,
    }
}

/// The top-left corner that puts a window of `size` at the bottom right of
/// the work area, `margin` away from its edges (all physical pixels).
fn corner(work: (i32, i32, u32, u32), size: (u32, u32), margin: u32) -> (i32, i32) {
    let (x, y, width, height) = work;
    let right = x + width as i32 - size.0 as i32 - margin as i32;
    let bottom = y + height as i32 - size.1 as i32 - margin as i32;
    (right.max(x), bottom.max(y))
}

pub fn manage<R: Runtime>(app: &tauri::App<R>) {
    app.manage(PipState::default());
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(MAIN)
}

fn active<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<PipState>().is_some_and(|state| {
        state
            .active
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    })
}

fn ready<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<PipState>()
        .is_some_and(|state| state.ready.load(Ordering::Relaxed))
}

fn enter<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    let Some(state) = window.try_state::<PipState>() else {
        return Ok(());
    };
    let mut active = state.active.lock().unwrap_or_else(PoisonError::into_inner);
    if active.is_some() {
        return Ok(());
    }
    window.unminimize()?;
    window.show()?;
    let saved = Saved {
        position: window.outer_position()?,
        size: window.inner_size()?,
        maximized: window.is_maximized()?,
    };
    if saved.maximized {
        window.unmaximize()?;
    }
    window.set_min_size(None::<LogicalSize<f64>>)?;
    #[cfg(target_os = "linux")]
    window.set_decorations(false)?;
    window.set_size(LogicalSize::new(SIZE.0, SIZE.1))?;
    if let Some(monitor) = window.current_monitor()? {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let size = (
            (SIZE.0 * scale).round() as u32,
            (SIZE.1 * scale).round() as u32,
        );
        let (x, y) = corner(
            (
                area.position.x,
                area.position.y,
                area.size.width,
                area.size.height,
            ),
            size,
            (MARGIN * scale).round() as u32,
        );
        window.set_position(PhysicalPosition::new(x, y))?;
    }
    window.set_always_on_top(true)?;
    *active = Some(saved);
    drop(active);
    window.emit("pip-changed", true)?;
    Ok(())
}

fn exit<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    let Some(state) = window.try_state::<PipState>() else {
        return Ok(());
    };
    let Some(saved) = state
        .active
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
    else {
        return Ok(());
    };
    window.set_always_on_top(false)?;
    window.unminimize()?;
    #[cfg(target_os = "linux")]
    window.set_decorations(true)?;
    window.set_min_size(Some(LogicalSize::new(MIN_SIZE.0, MIN_SIZE.1)))?;
    window.set_size(saved.size)?;
    window.set_position(saved.position)?;
    if saved.maximized {
        window.maximize()?;
    }
    window.show()?;
    window.set_focus()?;
    window.emit("pip-changed", false)?;
    Ok(())
}

/// Leaves picture-in-picture, if on: the app comes back as it was.
pub fn restore<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = main_window(app) {
        if let Err(error) = exit(&window) {
            eprintln!("Não foi possível restaurar a janela: {error}");
        }
    }
}

/// Closing to the tray while watching a screen floats it instead. Returns
/// whether it did (the window then stays visible).
pub fn on_close_to_tray<R: Runtime>(window: &Window<R>) -> bool {
    let app = window.app_handle();
    if window.label() != MAIN || !ready(app) || active(app) {
        return false;
    }
    main_window(app).is_some_and(|main| enter(&main).is_ok())
}

/// Called on every resize of a window: catches minimizing.
pub fn on_resized<R: Runtime>(window: &Window<R>) {
    if window.label() != MAIN || !window.is_minimized().unwrap_or(false) {
        return;
    }
    let app = window.app_handle();
    let Some(main) = main_window(app) else {
        return;
    };
    let result = match on_minimize(ready(app), active(app)) {
        OnMinimize::Enter => enter(&main),
        OnMinimize::Restore => exit(&main),
        OnMinimize::Nothing => Ok(()),
    };
    if let Err(error) = result {
        eprintln!("Não foi possível mudar o picture-in-picture: {error}");
    }
}

/// Whether picture-in-picture should start on minimize: a remote screen is
/// shown in a call and the user turned it on. Turning it off (the share
/// ended, the call too) leaves it.
#[tauri::command]
pub fn set_pip_ready<R: Runtime>(app: AppHandle<R>, ready: bool) {
    if let Some(state) = app.try_state::<PipState>() {
        state.ready.store(ready, Ordering::Relaxed);
    }
    if !ready {
        restore(&app);
    }
}

/// "Back to the app" in the floating window.
#[tauri::command]
pub fn pip_exit<R: Runtime>(app: AppHandle<R>) {
    restore(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimizing_floats_the_screen_or_brings_the_app_back() {
        assert_eq!(on_minimize(true, false), OnMinimize::Enter);
        assert_eq!(on_minimize(false, false), OnMinimize::Nothing);
        assert_eq!(on_minimize(true, true), OnMinimize::Restore);
        assert_eq!(on_minimize(false, true), OnMinimize::Restore);
    }

    #[test]
    fn floats_in_the_bottom_right_corner_of_the_work_area() {
        // A 1920×1040 work area (taskbar below) on a second monitor at x=1920.
        assert_eq!(
            corner((1920, 0, 1920, 1040), (480, 300), 16),
            (1920 + 1920 - 480 - 16, 1040 - 300 - 16)
        );
        // Never off the top-left of a tiny work area.
        assert_eq!(corner((0, 0, 300, 200), (480, 300), 16), (0, 0));
    }
}
