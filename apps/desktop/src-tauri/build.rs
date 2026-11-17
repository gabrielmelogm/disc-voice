fn main() {
    // The native app ships for Windows and Linux; other targets only compile a stub.
    if matches!(
        std::env::var("CARGO_CFG_TARGET_OS").as_deref(),
        Ok("windows" | "linux")
    ) {
        tauri_build::build();
    }
}
