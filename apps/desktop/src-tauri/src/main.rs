#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(any(windows, target_os = "linux"))]
mod app;

#[cfg(any(windows, target_os = "linux"))]
fn main() {
    app::run();
}

#[cfg(not(any(windows, target_os = "linux")))]
fn main() {
    eprintln!("Disc Voice está disponível somente para Windows e Linux.");
    std::process::exit(1);
}
