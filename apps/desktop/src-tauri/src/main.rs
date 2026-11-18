#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(any(windows, target_os = "linux"))]
mod app;
#[cfg(target_os = "linux")]
mod linux;

#[cfg(any(windows, target_os = "linux"))]
fn main() {
    #[cfg(target_os = "linux")]
    linux::prepare_environment();
    app::run();
}

#[cfg(not(any(windows, target_os = "linux")))]
fn main() {
    eprintln!("Disc Voice está disponível somente para Windows e Linux.");
    std::process::exit(1);
}
