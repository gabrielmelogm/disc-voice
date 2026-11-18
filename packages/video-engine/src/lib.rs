pub mod backend;
mod engine;
pub mod format;
pub mod screen;
mod worker;

#[cfg(target_os = "linux")]
mod pipewire;
#[cfg(target_os = "linux")]
mod portal;
#[cfg(target_os = "linux")]
mod screencast;

pub use engine::*;
#[cfg(target_os = "linux")]
pub use pipewire::PipeWireBackend;
pub use screen::{
    CancelToken, ScreenBackend, ScreenEngine, ScreenInfo, ScreenRequest, ScreenSource, SourceKind,
};
#[cfg(target_os = "linux")]
pub use screencast::ScreenCastBackend;
