#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(any(windows, target_os = "linux"))]
mod app;
#[cfg(any(windows, target_os = "linux"))]
mod call;
#[cfg(any(windows, target_os = "linux"))]
mod camera;
#[cfg(any(windows, target_os = "linux"))]
mod discord_rpc;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(any(windows, target_os = "linux"))]
mod notify;
#[cfg(any(windows, target_os = "linux"))]
mod pip;
#[cfg(any(windows, target_os = "linux"))]
mod screen;
#[cfg(any(windows, target_os = "linux"))]
mod tray;

#[cfg(any(windows, target_os = "linux"))]
fn main() {
    app::run();
}

#[cfg(not(any(windows, target_os = "linux")))]
fn main() {
    eprintln!("Disc Voice está disponível somente para Windows e Linux.");
    std::process::exit(1);
}
