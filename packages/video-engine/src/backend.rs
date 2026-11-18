//! Contract between the platform-independent camera worker and a native
//! capture API.
//!
//! A backend only enumerates cameras and opens captures. Stable device IDs,
//! mode selection, start/stop, disconnection and error reporting live in the
//! worker, so every platform behaves the same from the UI's point of view.

use crate::format::{is_complete_jpeg, Mode};
use std::{
    sync::{Arc, Condvar, Mutex, MutexGuard, Weak},
    time::Duration,
};

pub struct BackendDevice<D> {
    pub device: D,
    pub name: String,
    /// Every size/format the camera offers; the worker picks one with
    /// [`crate::format::choose`].
    pub modes: Vec<Mode>,
}

/// Owned by the camera worker thread for its whole life: implementations
/// may rely on thread affinity (e.g. COM on Windows) and need not be `Send`.
pub trait Backend {
    /// Equality must reflect the native device identity (PipeWire node
    /// name, symbolic link...), never display names or enumeration order.
    type Device: PartialEq;
    /// An open, running capture. Dropping it must stop and release the camera.
    type Stream;

    fn devices(&mut self) -> Result<Vec<BackendDevice<Self::Device>>, String>;

    /// Starts capturing `device` in `mode`. Frames must be delivered as
    /// complete JPEG images through `sink`, from any thread.
    fn open(
        &mut self,
        device: &Self::Device,
        mode: &Mode,
        sink: FrameSink,
    ) -> Result<Self::Stream, String>;
}

/// Where a capture delivers frames and fatal errors. Cheap to clone and
/// usable from real-time/streaming threads; stale sinks of a stopped
/// capture are ignored.
#[derive(Clone)]
pub struct FrameSink {
    pub(crate) frames: Weak<Frames>,
    pub(crate) generation: u64,
}

impl FrameSink {
    /// Publishes one JPEG frame. Truncated images are dropped, since drawing
    /// them shows garbage.
    pub fn publish(&self, jpeg: &[u8]) {
        if !is_complete_jpeg(jpeg) {
            return;
        }
        if let Some(frames) = self.frames.upgrade() {
            frames.publish(self.generation, jpeg.to_vec());
        }
    }

    /// Publishes one uncompressed frame as tightly packed I420 planes (Y,
    /// then U, then V) of even dimensions, for consumers that encode it
    /// again (the native call engine), alongside the JPEG for previews.
    pub fn publish_raw(&self, width: u32, height: u32, i420: Vec<u8>) {
        let (w, h) = (width as usize, height as usize);
        if w == 0 || h == 0 || w % 2 != 0 || h % 2 != 0 || i420.len() != w * h * 3 / 2 {
            return;
        }
        if let Some(frames) = self.frames.upgrade() {
            frames.publish_raw(
                self.generation,
                RawFrame {
                    width,
                    height,
                    i420,
                },
            );
        }
    }

    /// Reports that the capture stopped working; the worker releases it and
    /// the UI shows `error`.
    pub fn fail(&self, error: impl Into<String>) {
        if let Some(frames) = self.frames.upgrade() {
            frames.fail(self.generation, error.into());
        }
    }
}

/// An uncompressed frame: tightly packed I420 planes, even dimensions.
#[derive(Debug)]
pub struct RawFrame {
    pub width: u32,
    pub height: u32,
    pub i420: Vec<u8>,
}

#[derive(Default)]
struct State {
    /// Increments on every start, so frames of an old capture are ignored.
    generation: u64,
    sequence: u64,
    delivered: u64,
    latest: Option<Arc<Vec<u8>>>,
    /// The raw frames have their own reader, so their own counters.
    raw_sequence: u64,
    raw_delivered: u64,
    raw: Option<Arc<RawFrame>>,
    error: Option<String>,
    running: bool,
}

/// Latest frame, shared by the backend's threads and the readers. Frames
/// never go through the worker queue, so commands do not add latency.
#[derive(Default)]
pub(crate) struct Frames {
    state: Mutex<State>,
    changed: Condvar,
}

impl Frames {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Starts a new capture generation and returns its sink.
    pub(crate) fn begin(self: &Arc<Self>) -> FrameSink {
        let mut state = self.lock();
        state.generation += 1;
        state.sequence = 0;
        state.delivered = 0;
        state.latest = None;
        state.raw_sequence = 0;
        state.raw_delivered = 0;
        state.raw = None;
        state.error = None;
        state.running = true;
        FrameSink {
            frames: Arc::downgrade(self),
            generation: state.generation,
        }
    }

    pub(crate) fn end(&self) {
        let mut state = self.lock();
        state.running = false;
        state.latest = None;
        state.raw = None;
        self.changed.notify_all();
    }

    /// The error of the running capture, if it failed.
    pub(crate) fn failed(&self) -> bool {
        let state = self.lock();
        state.running && state.error.is_some()
    }

    pub(crate) fn fail_current(&self, error: String) {
        let generation = self.lock().generation;
        self.fail(generation, error);
    }

    fn publish(&self, generation: u64, frame: Vec<u8>) {
        let mut state = self.lock();
        if state.generation != generation || !state.running || state.error.is_some() {
            return;
        }
        state.sequence += 1;
        state.latest = Some(Arc::new(frame));
        self.changed.notify_all();
    }

    fn publish_raw(&self, generation: u64, frame: RawFrame) {
        let mut state = self.lock();
        if state.generation != generation || !state.running || state.error.is_some() {
            return;
        }
        state.raw_sequence += 1;
        state.raw = Some(Arc::new(frame));
        self.changed.notify_all();
    }

    fn fail(&self, generation: u64, error: String) {
        let mut state = self.lock();
        if state.generation == generation && state.running && state.error.is_none() {
            state.error = Some(error);
            state.latest = None;
            state.raw = None;
            self.changed.notify_all();
        }
    }

    /// Waits up to `timeout` for a frame newer than the last one returned.
    pub(crate) fn next(&self, timeout: Duration) -> Result<Option<Arc<Vec<u8>>>, String> {
        let state = self.lock();
        let (mut state, _) = self
            .changed
            .wait_timeout_while(state, timeout, |state| {
                state.running && state.error.is_none() && state.sequence == state.delivered
            })
            .unwrap_or_else(|error| error.into_inner());
        if let Some(error) = state.error.clone().filter(|_| state.running) {
            return Err(error);
        }
        if !state.running || state.sequence == state.delivered {
            return Ok(None);
        }
        state.delivered = state.sequence;
        Ok(state.latest.clone())
    }

    /// Like [`Self::next`], for the raw frames (when the backend makes them).
    pub(crate) fn next_raw(&self, timeout: Duration) -> Result<Option<Arc<RawFrame>>, String> {
        let state = self.lock();
        let (mut state, _) = self
            .changed
            .wait_timeout_while(state, timeout, |state| {
                state.running && state.error.is_none() && state.raw_sequence == state.raw_delivered
            })
            .unwrap_or_else(|error| error.into_inner());
        if let Some(error) = state.error.clone().filter(|_| state.running) {
            return Err(error);
        }
        if !state.running || state.raw_sequence == state.raw_delivered {
            return Ok(None);
        }
        state.raw_delivered = state.raw_sequence;
        Ok(state.raw.clone())
    }
}
