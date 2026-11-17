//! Contract between the platform-independent worker and a native audio API.
//!
//! A backend only knows how to enumerate devices and open streams. Device
//! identity, state, timeouts and error reporting live in the worker, so every
//! platform behaves the same from the UI's point of view.

use crate::signal::{sanitize, Playback, Recording};
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    mpsc::SyncSender,
    Arc, Mutex,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Input,
    Output,
}

pub struct BackendDevice<D> {
    pub device: D,
    pub name: String,
    pub is_default: bool,
}

/// Owned by the audio worker thread for its whole life: implementations may
/// rely on thread affinity (e.g. COM on Windows) and need not be `Send`.
pub trait Backend {
    /// Equality must reflect the native device identity (endpoint ID, sink
    /// name...), never display names or enumeration order.
    type Device: PartialEq;
    /// An open, playing stream. Dropping it must stop and release the stream.
    type Stream;

    fn devices(&mut self, direction: Direction)
        -> Result<Vec<BackendDevice<Self::Device>>, String>;

    /// Opens and starts capture. `sink` receives the native sample rate once
    /// it is known and returns where the real-time callback must write.
    fn open_input(
        &mut self,
        device: &Self::Device,
        sink: impl FnOnce(u32) -> InputSink,
        errors: ErrorSink,
    ) -> Result<Self::Stream, String>;

    /// Opens and starts playback. `source` receives the native sample rate and
    /// may refuse (e.g. nothing recorded yet) before any stream is started.
    fn open_output(
        &mut self,
        device: &Self::Device,
        source: impl FnOnce(u32) -> Result<OutputSource, String>,
        errors: ErrorSink,
    ) -> Result<Self::Stream, String>;
}

/// Destination of captured audio, used from the real-time callback.
pub struct InputSink {
    pub(crate) recording: Arc<Mutex<Recording>>,
    pub(crate) peak: Arc<AtomicU32>,
}

impl InputSink {
    /// Pushes one callback buffer, already split into interleaved frames.
    pub fn capture<F, S>(&self, frames: F)
    where
        F: IntoIterator<Item = S>,
        S: IntoIterator<Item = f32>,
    {
        let mut level = 0.0_f32;
        // The worker only briefly reads metadata while capture is active.
        if let Ok(mut recording) = self.recording.lock() {
            for frame in frames {
                recording.push_frame(frame.into_iter().map(|sample| {
                    let sample = sanitize(sample);
                    level = level.max(sample.abs());
                    sample
                }));
            }
        }
        // Positive finite floats have the same bit ordering as u32.
        self.peak.fetch_max(level.to_bits(), Ordering::Relaxed);
    }
}

/// Mono source for playback, used from the real-time callback.
pub struct OutputSource {
    pub(crate) playback: Playback,
    pub(crate) finished: Arc<AtomicBool>,
}

impl OutputSource {
    pub fn next_frame(&mut self) -> f32 {
        self.playback.next_frame()
    }

    /// Call after filling each buffer so the worker can release the stream.
    pub fn end_buffer(&self) {
        if self.playback.finished() {
            self.finished.store(true, Ordering::Relaxed);
        }
    }
}

/// Reports stream failures from callbacks without blocking them.
#[derive(Clone)]
pub struct ErrorSink {
    pub(crate) sender: SyncSender<(Direction, String)>,
    pub(crate) direction: Direction,
}

impl ErrorSink {
    pub fn report(&self, error: impl ToString) {
        let _ = self.sender.try_send((self.direction, error.to_string()));
    }
}
