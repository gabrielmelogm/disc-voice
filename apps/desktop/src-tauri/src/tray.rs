//! System tray: the app keeps running there after its window is closed.
//!
//! A left click brings the window back. The right-click menu opens one of the recently
//! used servers, mutes or unmutes the microphone during a call, and quits for real. The
//! icon gets a green dot while the user is in a call. The page tells this module what
//! to show (`set_tray_status`) and acts on the `tray-*` events it emits.
//!
//! Windows only for now; elsewhere closing the window quits as before.

use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

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
pub struct TrayState {
    close_to_tray: AtomicBool,
}

impl TrayState {
    pub fn close_to_tray(&self) -> bool {
        self.close_to_tray.load(Ordering::Relaxed)
    }
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

fn build_menu<R: Runtime>(app: &AppHandle<R>, status: &TrayStatus) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    for entry in menu_entries(status) {
        match entry {
            Entry::Item { id, text, enabled } => {
                menu.append(&MenuItem::with_id(app, id, text, enabled, None::<&str>)?)?
            }
            Entry::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
        }
    }
    Ok(menu)
}

/// Brings the main window back from the tray, the taskbar or behind other windows.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
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

pub fn manage<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    app.manage(TrayState {
        close_to_tray: AtomicBool::new(true),
    });
    let handle = app.handle();
    let status = TrayStatus::default();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(false)?)
        .tooltip(tooltip(&status))
        .menu(&build_menu(handle, &status)?)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu)
        .on_tray_icon_event(on_icon)
        .build(app)?;
    Ok(())
}

#[tauri::command]
pub fn set_close_to_tray(state: tauri::State<'_, TrayState>, enabled: bool) {
    state.close_to_tray.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
pub fn set_tray_status<R: Runtime>(app: AppHandle<R>, status: TrayStatus) -> Result<(), String> {
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or("Ícone da bandeja indisponível")?;
    (|| -> tauri::Result<()> {
        tray.set_icon(Some(icon(status.call.is_some())?))?;
        tray.set_tooltip(Some(tooltip(&status)))?;
        tray.set_menu(Some(build_menu(&app, &status)?))
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
