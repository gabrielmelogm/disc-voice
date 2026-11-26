//! System tray: the app keeps running there after its window is closed.
//!
//! The menu opens the window or one of the recently used servers, mutes or unmutes the
//! microphone during a call, and quits for real. On Windows a left click also brings the
//! window back; AppIndicator (Linux) has no click events and opens the menu on any click,
//! and shows no tooltip. The icon gets a green dot while the user is in a call. The page
//! tells this module what to show (`set_tray_status`) and acts on the `tray-*` events it
//! emits.
//!
//! On Linux the icon needs the AppIndicator library and a panel that shows tray icons
//! (GNOME only does with the AppIndicator extension). Without them closing the window
//! quits, as there would be no way back to a hidden one.

use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, Window};

const TRAY_ID: &str = "main";
const ICON: &[u8] = include_bytes!("../icons/32x32.png");
const APP_NAME: &str = "Disc Voice";
const MAX_RECENT: usize = 5;
const MAX_NAME_CHARS: usize = 32;

const OPEN: &str = "open";
const MUTE: &str = "mute";
const QUIT: &str = "quit";
const RECENT_TITLE: &str = "recent";
const SERVER_PREFIX: &str = "server:";

/// Whether closing the window sends the app to the tray (the page keeps it in sync).
struct TrayState {
    close_to_tray: AtomicBool,
}

/// The one tray menu. AppIndicator cannot swap a tray's menu for another, so its items
/// are rewritten instead, and only when they change.
struct TrayMenu<R: Runtime> {
    menu: Menu<R>,
    shown: Mutex<Shown>,
}

struct Shown {
    in_call: bool,
    entries: Vec<Entry>,
}

#[cfg(windows)]
mod platform {
    pub fn can_build() -> bool {
        true
    }

    pub fn shows_icons() -> bool {
        true
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::sync::OnceLock;
    use webkit2gtk::gio;
    use webkit2gtk::glib::{ToVariant, VariantTy};

    /// tray-icon loads the AppIndicator library on first use and panics if it is missing.
    pub fn can_build() -> bool {
        static FOUND: OnceLock<bool> = OnceLock::new();
        *FOUND.get_or_init(|| {
            ["libayatana-appindicator3.so.1", "libappindicator3.so.1"]
                .iter()
                // SAFETY: these libraries run no code of their own when loaded.
                .any(|name| unsafe { libloading::Library::new(name) }.is_ok())
        })
    }

    /// Whether a panel shows tray icons: KDE, most other desktops and GNOME with the
    /// AppIndicator extension own this D-Bus name. Checked each time, since the user can
    /// turn the extension on or off while the app runs.
    pub fn shows_icons() -> bool {
        let Ok(bus) = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) else {
            return false;
        };
        bus.call_sync(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "NameHasOwner",
            Some(&("org.kde.StatusNotifierWatcher",).to_variant()),
            VariantTy::new("(b)").ok(),
            gio::DBusCallFlags::NONE,
            1000,
            gio::Cancellable::NONE,
        )
        .ok()
        .and_then(|reply| reply.get::<(bool,)>())
        .is_some_and(|(owned,)| owned)
    }
}

/// Whether the tray icon exists and the desktop shows it.
fn available<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.tray_by_id(TRAY_ID).is_some() && platform::shows_icons()
}

/// Whether closing this window should hide it in the tray instead of quitting.
pub fn hides_on_close<R: Runtime>(window: &Window<R>) -> bool {
    window
        .try_state::<TrayState>()
        .is_some_and(|state| state.close_to_tray.load(Ordering::Relaxed))
        && available(window.app_handle())
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct RecentServer {
    id: String,
    name: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrayStatus {
    /// Name of the voice channel the user is in, if any.
    call: Option<String>,
    muted: bool,
    /// Most recently used first.
    recent: Vec<RecentServer>,
}

#[derive(Debug, PartialEq)]
enum Entry {
    Item {
        id: String,
        text: String,
        enabled: bool,
    },
    Separator,
}

fn item(id: &str, text: impl Into<String>, enabled: bool) -> Entry {
    Entry::Item {
        id: id.into(),
        text: text.into(),
        enabled,
    }
}

/// Names come from other people: keep them short.
fn short(name: &str) -> String {
    let name = name.trim();
    let mut text: String = name.chars().take(MAX_NAME_CHARS).collect();
    if name.chars().count() > MAX_NAME_CHARS {
        text.push('…');
    }
    text
}

/// A name as a menu item, where `&` would otherwise mark a keyboard mnemonic.
fn label(name: &str) -> String {
    short(name).replace('&', "&&")
}

/// What the right-click menu shows, top to bottom.
fn menu_entries(status: &TrayStatus) -> Vec<Entry> {
    let mut entries = vec![item(OPEN, format!("Abrir {APP_NAME}"), true)];
    let recent: Vec<_> = status
        .recent
        .iter()
        .filter(|server| !server.id.is_empty())
        .take(MAX_RECENT)
        .collect();
    if !recent.is_empty() {
        entries.push(Entry::Separator);
        entries.push(item(RECENT_TITLE, "Servidores recentes", false));
        for server in recent {
            entries.push(item(
                &format!("{SERVER_PREFIX}{}", server.id),
                label(&server.name),
                true,
            ));
        }
    }
    entries.push(Entry::Separator);
    let mute = if status.muted {
        "Ativar microfone"
    } else {
        "Silenciar microfone"
    };
    entries.push(item(MUTE, mute, status.call.is_some()));
    entries.push(Entry::Separator);
    entries.push(item(QUIT, format!("Sair do {APP_NAME}"), true));
    entries
}

fn tooltip(status: &TrayStatus) -> String {
    match &status.call {
        Some(channel) => format!("{APP_NAME} — Em chamada: {}", short(channel)),
        None => APP_NAME.into(),
    }
}

/// Draws a green "in a call" dot, with a dark ring, on the bottom-right corner.
fn call_badge(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut out = rgba.to_vec();
    let size = width.min(height) as f32;
    let outer = size * 0.3;
    let inner = outer - (size / 16.0).max(1.0);
    let cx = width as f32 - outer;
    let cy = height as f32 - outer;
    for y in 0..height {
        for x in 0..width {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let distance = (dx * dx + dy * dy).sqrt();
            let color = if distance <= inner {
                [0x23, 0xa5, 0x5a, 0xff]
            } else if distance <= outer {
                [0x14, 0x11, 0x1c, 0xff]
            } else {
                continue;
            };
            let at = ((y * width + x) * 4) as usize;
            out[at..at + 4].copy_from_slice(&color);
        }
    }
    out
}

fn icon(in_call: bool) -> tauri::Result<Image<'static>> {
    let base = Image::from_bytes(ICON)?;
    if !in_call {
        return Ok(base);
    }
    let (width, height) = (base.width(), base.height());
    Ok(Image::new_owned(
        call_badge(base.rgba(), width, height),
        width,
        height,
    ))
}

/// Replaces the menu's items with these entries.
fn fill<R: Runtime>(app: &AppHandle<R>, menu: &Menu<R>, entries: &[Entry]) -> tauri::Result<()> {
    while menu.remove_at(0)?.is_some() {}
    for entry in entries {
        match entry {
            Entry::Item { id, text, enabled } => {
                menu.append(&MenuItem::with_id(app, id, text, *enabled, None::<&str>)?)?
            }
            Entry::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
        }
    }
    Ok(())
}

/// Brings the main window back from the tray, the taskbar or behind other windows.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    // Out of picture-in-picture first: the user wants the whole app.
    crate::pip::restore(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn on_menu<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        OPEN => show_main(app),
        MUTE => {
            let _ = app.emit("tray-toggle-mute", ());
        }
        QUIT => app.exit(0),
        id => {
            if let Some(server) = id.strip_prefix(SERVER_PREFIX) {
                show_main(app);
                let _ = app.emit("tray-open-server", server.to_string());
            }
        }
    }
}

fn on_icon<R: Runtime>(tray: &TrayIcon<R>, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        show_main(tray.app_handle());
    }
}

fn build<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let handle = app.handle();
    let status = TrayStatus::default();
    let entries = menu_entries(&status);
    let menu = Menu::new(handle)?;
    fill(handle, &menu, &entries)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(false)?)
        .tooltip(tooltip(&status))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu)
        .on_tray_icon_event(on_icon)
        .build(app)?;
    app.manage(TrayMenu {
        menu,
        shown: Mutex::new(Shown {
            in_call: false,
            entries,
        }),
    });
    Ok(())
}

/// Creates the tray icon where it can be. Without one the app still runs, and closing
/// the window quits.
pub fn manage<R: Runtime>(app: &tauri::App<R>) {
    app.manage(TrayState {
        close_to_tray: AtomicBool::new(true),
    });
    if !platform::can_build() {
        eprintln!("Bandeja do sistema indisponível: instale a libayatana-appindicator3");
        return;
    }
    if let Err(error) = build(app) {
        eprintln!("Não foi possível criar o ícone da bandeja: {error}");
    }
}

/// Whether the app can live in the system tray right now.
#[tauri::command]
pub fn tray_supported<R: Runtime>(app: AppHandle<R>) -> bool {
    available(&app)
}

#[tauri::command]
pub fn set_close_to_tray(app: AppHandle<impl Runtime>, enabled: bool) {
    if let Some(state) = app.try_state::<TrayState>() {
        state.close_to_tray.store(enabled, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn set_tray_status<R: Runtime>(app: AppHandle<R>, status: TrayStatus) -> Result<(), String> {
    let (Some(tray), Some(menu)) = (app.tray_by_id(TRAY_ID), app.try_state::<TrayMenu<R>>()) else {
        return Err("Ícone da bandeja indisponível".into());
    };
    let mut shown = menu.shown.lock().unwrap_or_else(PoisonError::into_inner);
    (|| -> tauri::Result<()> {
        let in_call = status.call.is_some();
        // On Linux every new icon is written to a file: only change it when it differs.
        if shown.in_call != in_call {
            tray.set_icon(Some(icon(in_call)?))?;
            shown.in_call = in_call;
        }
        tray.set_tooltip(Some(tooltip(&status)))?;
        let entries = menu_entries(&status);
        if shown.entries != entries {
            fill(&app, &menu.menu, &entries)?;
            shown.entries = entries;
        }
        Ok(())
    })()
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(id: &str, name: &str) -> RecentServer {
        RecentServer {
            id: id.into(),
            name: name.into(),
        }
    }

    fn find<'a>(entries: &'a [Entry], wanted: &str) -> Option<(&'a str, bool)> {
        entries.iter().find_map(|entry| match entry {
            Entry::Item { id, text, enabled } if id == wanted => Some((text.as_str(), *enabled)),
            _ => None,
        })
    }

    #[test]
    fn mute_only_works_in_a_call() {
        let idle = menu_entries(&TrayStatus::default());
        assert_eq!(find(&idle, MUTE), Some(("Silenciar microfone", false)));
        let muted = TrayStatus {
            call: Some("Geral".into()),
            muted: true,
            ..Default::default()
        };
        assert_eq!(
            find(&menu_entries(&muted), MUTE),
            Some(("Ativar microfone", true))
        );
    }

    #[test]
    fn lists_at_most_five_servers_and_quit_is_last() {
        let recent = (0..8)
            .map(|i| server(&i.to_string(), &format!("S{i}")))
            .collect();
        let entries = menu_entries(&TrayStatus {
            recent,
            ..Default::default()
        });
        let servers = entries
            .iter()
            .filter(
                |entry| matches!(entry, Entry::Item { id, .. } if id.starts_with(SERVER_PREFIX)),
            )
            .count();
        assert_eq!(servers, MAX_RECENT);
        assert_eq!(find(&entries, "server:0"), Some(("S0", true)));
        assert_eq!(
            find(&entries, RECENT_TITLE).map(|(_, enabled)| enabled),
            Some(false)
        );
        assert!(matches!(entries.last(), Some(Entry::Item { id, .. }) if id == QUIT));
    }

    #[test]
    fn no_recent_section_without_servers() {
        let entries = menu_entries(&TrayStatus::default());
        assert_eq!(find(&entries, RECENT_TITLE), None);
    }

    #[test]
    fn server_names_are_short_and_literal() {
        assert_eq!(label("  A & B "), "A && B");
        let long = "x".repeat(40);
        assert_eq!(label(&long), format!("{}…", "x".repeat(MAX_NAME_CHARS)));
    }

    #[test]
    fn badge_paints_the_corner_only() {
        let (width, height) = (32, 32);
        let rgba = vec![0u8; (width * height * 4) as usize];
        let out = call_badge(&rgba, width, height);
        assert_eq!(out.len(), rgba.len());
        let pixel = |x: u32, y: u32| &out[((y * width + x) * 4) as usize..][..4];
        assert_eq!(pixel(25, 25), [0x23, 0xa5, 0x5a, 0xff]);
        assert_eq!(pixel(8, 8), [0, 0, 0, 0]);
    }
}
