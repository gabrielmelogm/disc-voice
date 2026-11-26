pub mod backend;
mod engine;
pub mod signal;
pub mod system;

#[cfg(target_os = "linux")]
mod pulse;
#[cfg(target_os = "linux")]
mod system_pulse;
#[cfg(windows)]
mod system_windows;
#[cfg(windows)]
mod wasapi;

pub use engine::*;
#[cfg(target_os = "linux")]
pub use pulse::{PulseBackend, PulseDevice};
pub use system::SystemAudio;
#[cfg(windows)]
pub use wasapi::WasapiBackend;
