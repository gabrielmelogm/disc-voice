pub mod backend;
mod engine;
pub mod signal;

#[cfg(target_os = "linux")]
mod pulse;
#[cfg(windows)]
mod wasapi;

pub use engine::*;
#[cfg(target_os = "linux")]
pub use pulse::PulseBackend;
#[cfg(windows)]
pub use wasapi::WasapiBackend;
