//! Native WebRTC voice calls (and screen sharing) for Linux.
//!
//! WebKitGTK as shipped by distributions (Fedora's 2.54 among them) is built
//! without WebRTC: the page has `getUserMedia` but no `RTCPeerConnection`, and
//! no setting can turn it on. The webview therefore cannot join a call, so on
//! Linux the whole media path lives here instead: one webrtc-rs connection
//! per participant (the same P2P mesh and signaling messages as the browser
//! clients, so Windows and browser peers interoperate), the microphone and
//! speakers through PulseAudio/PipeWire, Opus for voice and H.264 (OpenH264,
//! built from source) for shared screens.
//!
//! The UI keeps the signaling: it relays the engine's offers, answers and
//! candidates over the realtime socket and hands back what peers send.

#[cfg(target_os = "linux")]
mod audio;
#[cfg(target_os = "linux")]
mod engine;
#[cfg(target_os = "linux")]
mod frames;
#[cfg(target_os = "linux")]
mod hub;
#[cfg(target_os = "linux")]
mod keyframes;
#[cfg(target_os = "linux")]
mod peer;
#[cfg(target_os = "linux")]
mod video;

#[cfg(target_os = "linux")]
pub use engine::*;
