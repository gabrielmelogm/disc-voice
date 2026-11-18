//! Screen capture: the contract a native screen-capture API implements and
//! the platform-independent worker that drives it.
//!
//! Unlike cameras there is nothing to enumerate: the system shows its own
//! picker (the ScreenCast portal on Linux) when a capture starts, so a
//! backend only opens captures. Frames reach the UI as JPEG images through
//! the same [`FrameSink`] the camera uses, so both previews share one path.

use crate::backend::{FrameSink, Frames};
use crate::worker::{self, Reply};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{Receiver, RecvTimeoutError, Sender},
        Arc,
    },
    time::Duration,
};

pub const MIN_FRAME_RATE: u32 = 1;
pub const MAX_FRAME_RATE: u32 = 60;
/// Frame size limits accepted from the UI (from 360p up to 4K).
pub const MIN_SIZE: (u32, u32) = (640, 360);
pub const MAX_SIZE: (u32, u32) = (3840, 2160);

/// What the UI asks for. Values outside the supported limits are clamped.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenRequest {
    /// Larger sources are scaled down to fit, keeping their aspect ratio;
    /// smaller ones are never scaled up.
    pub max_width: u32,
    pub max_height: u32,
    /// Upper bound: screen casts only produce frames when the content
    /// changes, so a static screen delivers fewer.
    pub frame_rate: u32,
    /// Draw the mouse pointer into the frames.
    pub cursor: bool,
}

impl Default for ScreenRequest {
    fn default() -> Self {
        Self {
            max_width: 1280,
            max_height: 720,
            frame_rate: 30,
            cursor: true,
        }
    }
}

impl ScreenRequest {
    pub fn normalized(&self) -> Self {
        Self {
            max_width: self.max_width.clamp(MIN_SIZE.0, MAX_SIZE.0),
            max_height: self.max_height.clamp(MIN_SIZE.1, MAX_SIZE.1),
            frame_rate: self.frame_rate.clamp(MIN_FRAME_RATE, MAX_FRAME_RATE),
            cursor: self.cursor,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    Monitor,
    Window,
    /// A virtual screen created for the cast (some compositors offer it).
    Virtual,
    Unknown,
}

/// What the user picked, as reported by the system.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScreenSource {
    pub kind: SourceKind,
    /// Native size of the source; `None` when the system does not say.
    pub size: Option<(u32, u32)>,
}

/// A running capture, as the UI sees it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenInfo {
    pub source: SourceKind,
    /// Native size of the shared source, 0 × 0 when unknown.
    pub width: u32,
    pub height: u32,
    /// The normalized request the capture runs with.
    pub max_width: u32,
    pub max_height: u32,
    pub frame_rate: u32,
    pub cursor: bool,
}

/// Lets the UI abandon a start that is still waiting on the user, e.g.
/// while the system picker is open. Every [`ScreenEngine::stop`] cancels
/// the starts issued before it.
#[derive(Clone, Debug)]
pub struct CancelToken {
    epoch: Arc<AtomicU64>,
    issued: u64,
}

impl CancelToken {
    fn issue(epoch: &Arc<AtomicU64>) -> Self {
        Self {
            epoch: epoch.clone(),
            issued: epoch.load(Ordering::SeqCst),
        }
    }

    /// A token that never fires, for tools and tests.
    pub fn never() -> Self {
        Self::issue(&Arc::new(AtomicU64::new(0)))
    }

    pub fn is_cancelled(&self) -> bool {
        self.epoch.load(Ordering::SeqCst) != self.issued
    }
}

/// Owned by the screen worker thread for its whole life: implementations
/// may rely on thread affinity and need not be `Send`.
pub trait ScreenBackend {
    /// A running capture. Dropping it must stop capturing and end the
    /// system's sharing session (portal session, sharing indicator...).
    type Stream;

    /// Asks the user what to share and starts capturing it.
    ///
    /// Returns `Ok(None)` when the user dismissed the picker or `cancel`
    /// fired while waiting. Frames must be complete JPEG images, no larger
    /// than the request's size and no more than its frame rate, delivered
    /// through `sink` from any thread. When the system ends the sharing
    /// (the user stopped it from the desktop, the window closed...), the
    /// backend reports it with [`FrameSink::fail`].
    fn open(
        &mut self,
        request: &ScreenRequest,
        cancel: &CancelToken,
        sink: FrameSink,
    ) -> Result<Option<(Self::Stream, ScreenSource)>, String>;
}

enum Request {
    Start(ScreenRequest, CancelToken, Reply<Option<ScreenInfo>>),
    Stop(Reply<()>),
    Shutdown,
}

/// Screen captures are owned by one worker thread; frames bypass it and
/// are read from shared state, exactly like [`crate::CameraEngine`].
#[derive(Clone)]
pub struct ScreenEngine {
    sender: Sender<Request>,
    frames: Arc<Frames>,
    epoch: Arc<AtomicU64>,
}

impl ScreenEngine {
    /// Starts the worker with the native backend of the current platform.
    #[cfg(target_os = "linux")]
    pub fn new() -> Result<Self, String> {
        Self::with_backend(crate::screencast::ScreenCastBackend::new)
    }

    pub fn with_backend<B, F>(make: F) -> Result<Self, String>
    where
        B: ScreenBackend + 'static,
        F: FnOnce() -> Result<B, String> + Send + 'static,
    {
        let frames = Arc::new(Frames::default());
        let worker_frames = frames.clone();
        let sender = worker::spawn("disc-screen", make, move |backend, receiver| {
            ScreenWorker::new(backend, worker_frames).run(receiver)
        })?;
        Ok(Self {
            sender,
            frames,
            epoch: Arc::new(AtomicU64::new(0)),
        })
    }

    /// Opens the system picker and starts sharing what the user chose,
    /// replacing any running capture. Blocks until the user answers;
    /// `Ok(None)` means the user (or [`Self::stop`]) cancelled.
    pub fn start(&self, request: ScreenRequest) -> Result<Option<ScreenInfo>, String> {
        let cancel = CancelToken::issue(&self.epoch);
        worker::call(&self.sender, |reply| Request::Start(request, cancel, reply))
    }

    /// Stops sharing. Also dismisses a picker that is still open, so it
    /// never waits on the user.
    pub fn stop(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        let _ = worker::call(&self.sender, Request::Stop);
    }

    pub fn shutdown(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        let _ = self.sender.send(Request::Shutdown);
    }

    /// Waits up to `timeout` for a frame newer than the last one returned.
    /// `Ok(None)` means no new frame (timeout, unchanged screen or not
    /// sharing); an error means the sharing ended and should be shown.
    pub fn next_frame(&self, timeout: Duration) -> Result<Option<Arc<Vec<u8>>>, String> {
        self.frames.next(timeout)
    }
}

struct ScreenWorker<B: ScreenBackend> {
    backend: B,
    capture: Option<B::Stream>,
    frames: Arc<Frames>,
}

impl<B: ScreenBackend> ScreenWorker<B> {
    fn new(backend: B, frames: Arc<Frames>) -> Self {
        Self {
            backend,
            capture: None,
            frames,
        }
    }

    fn run(&mut self, receiver: Receiver<Request>) {
        loop {
            self.tick();
            match receiver.recv_timeout(Duration::from_millis(25)) {
                Ok(Request::Start(request, cancel, reply)) => {
                    let _ = reply.send(self.start(&request, &cancel));
                }
                Ok(Request::Stop(reply)) => {
                    self.stop();
                    let _ = reply.send(Ok(()));
                }
                Ok(Request::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
        self.stop();
    }

    /// Releases a capture the system ended. The error stays visible until
    /// the UI stops or restarts sharing.
    fn tick(&mut self) {
        if self.capture.is_some() && self.frames.failed() {
            self.capture = None;
        }
    }

    fn start(
        &mut self,
        request: &ScreenRequest,
        cancel: &CancelToken,
    ) -> Result<Option<ScreenInfo>, String> {
        self.stop();
        if cancel.is_cancelled() {
            return Ok(None);
        }
        let request = request.normalized();
        let sink = self.frames.begin();
        let opened = self.backend.open(&request, cancel, sink);
        let Ok(Some((stream, source))) = opened else {
            self.frames.end();
            return opened.map(|_| None);
        };
        if cancel.is_cancelled() {
            // Stopped while the picker was answered: never show the capture.
            drop(stream);
            self.frames.end();
            return Ok(None);
        }
        let (width, height) = source.size.unwrap_or((0, 0));
        self.capture = Some(stream);
        Ok(Some(ScreenInfo {
            source: source.kind,
            width,
            height,
            max_width: request.max_width,
            max_height: request.max_height,
            frame_rate: request.frame_rate,
            cursor: request.cursor,
        }))
    }

    fn stop(&mut self) {
        self.frames.end();
        self.capture = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc, sync::Mutex};

    const JPEG: [u8; 6] = [0xFF, 0xD8, 1, 2, 0xFF, 0xD9];

    /// What the fake picker answers.
    #[derive(Clone)]
    enum Pick {
        Share(ScreenSource),
        Dismiss,
        Fail(&'static str),
    }

    struct State {
        pick: Pick,
        requests: Vec<ScreenRequest>,
        open_streams: usize,
    }

    struct FakeStream(Rc<RefCell<State>>);

    impl Drop for FakeStream {
        fn drop(&mut self) {
            self.0.borrow_mut().open_streams -= 1;
        }
    }

    struct FakeBackend {
        state: Rc<RefCell<State>>,
        sinks: Arc<Mutex<Vec<FrameSink>>>,
        /// Runs while the "picker" is open, e.g. to cancel from the UI.
        while_picking: Option<Box<dyn FnMut()>>,
    }

    impl ScreenBackend for FakeBackend {
        type Stream = FakeStream;

        fn open(
            &mut self,
            request: &ScreenRequest,
            _cancel: &CancelToken,
            sink: FrameSink,
        ) -> Result<Option<(FakeStream, ScreenSource)>, String> {
            if let Some(action) = self.while_picking.as_mut() {
                action();
            }
            let mut state = self.state.borrow_mut();
            state.requests.push(request.clone());
            match state.pick.clone() {
                Pick::Dismiss => Ok(None),
                Pick::Fail(error) => Err(error.into()),
                Pick::Share(source) => {
                    state.open_streams += 1;
                    self.sinks.lock().unwrap().push(sink);
                    Ok(Some((FakeStream(self.state.clone()), source)))
                }
            }
        }
    }

    fn monitor() -> ScreenSource {
        ScreenSource {
            kind: SourceKind::Monitor,
            size: Some((2560, 1440)),
        }
    }

    type Sinks = Arc<Mutex<Vec<FrameSink>>>;

    fn worker(pick: Pick) -> (ScreenWorker<FakeBackend>, Rc<RefCell<State>>, Sinks) {
        let state = Rc::new(RefCell::new(State {
            pick,
            requests: Vec::new(),
            open_streams: 0,
        }));
        let sinks = Arc::new(Mutex::new(Vec::new()));
        let worker = ScreenWorker::new(
            FakeBackend {
                state: state.clone(),
                sinks: sinks.clone(),
                while_picking: None,
            },
            Arc::new(Frames::default()),
        );
        (worker, state, sinks)
    }

    fn sink(sinks: &Sinks, index: usize) -> FrameSink {
        sinks.lock().unwrap()[index].clone()
    }

    #[test]
    fn requests_are_clamped_to_supported_limits() {
        let request = ScreenRequest {
            max_width: 10_000,
            max_height: 10,
            frame_rate: 240,
            cursor: false,
        };
        assert_eq!(
            request.normalized(),
            ScreenRequest {
                max_width: 3840,
                max_height: 360,
                frame_rate: 60,
                cursor: false,
            }
        );
        let zero = ScreenRequest {
            frame_rate: 0,
            ..ScreenRequest::default()
        };
        assert_eq!(zero.normalized().frame_rate, 1);
    }

    #[test]
    fn start_shares_the_picked_source_and_frames_flow() {
        let (mut worker, state, sinks) = worker(Pick::Share(monitor()));
        let request = ScreenRequest {
            frame_rate: 120,
            ..ScreenRequest::default()
        };
        let info = worker
            .start(&request, &CancelToken::never())
            .unwrap()
            .unwrap();
        assert_eq!(
            info,
            ScreenInfo {
                source: SourceKind::Monitor,
                width: 2560,
                height: 1440,
                max_width: 1280,
                max_height: 720,
                frame_rate: 60,
                cursor: true,
            }
        );
        // The backend receives the normalized request.
        assert_eq!(state.borrow().requests[0].frame_rate, 60);

        sink(&sinks, 0).publish(&JPEG);
        let frame = worker.frames.next(Duration::ZERO).unwrap().unwrap();
        assert_eq!(frame.as_slice(), JPEG);
        assert_eq!(worker.frames.next(Duration::ZERO), Ok(None));
    }

    #[test]
    fn unknown_source_size_is_reported_as_zero() {
        let (mut worker, _, _) = worker(Pick::Share(ScreenSource {
            kind: SourceKind::Window,
            size: None,
        }));
        let info = worker
            .start(&ScreenRequest::default(), &CancelToken::never())
            .unwrap()
            .unwrap();
        assert_eq!(
            (info.source, info.width, info.height),
            (SourceKind::Window, 0, 0)
        );
    }

    #[test]
    fn dismissed_picker_starts_nothing() {
        let (mut worker, state, _) = worker(Pick::Dismiss);
        assert_eq!(
            worker.start(&ScreenRequest::default(), &CancelToken::never()),
            Ok(None)
        );
        assert_eq!(state.borrow().open_streams, 0);
        assert_eq!(worker.frames.next(Duration::ZERO), Ok(None));
    }

    #[test]
    fn failed_open_reports_the_error_and_leaves_nothing_running() {
        let (mut worker, state, _) = worker(Pick::Fail("sem portal"));
        assert_eq!(
            worker.start(&ScreenRequest::default(), &CancelToken::never()),
            Err("sem portal".into())
        );
        assert_eq!(state.borrow().open_streams, 0);
        assert_eq!(worker.frames.next(Duration::ZERO), Ok(None));
    }

    #[test]
    fn cancelled_before_the_worker_runs_never_opens_the_picker() {
        let (mut worker, state, _) = worker(Pick::Share(monitor()));
        let epoch = Arc::new(AtomicU64::new(0));
        let cancel = CancelToken::issue(&epoch);
        epoch.fetch_add(1, Ordering::SeqCst);
        assert_eq!(worker.start(&ScreenRequest::default(), &cancel), Ok(None));
        assert!(state.borrow().requests.is_empty());
    }

    #[test]
    fn cancelled_while_picking_releases_the_capture_at_once() {
        let (mut worker, state, _) = worker(Pick::Share(monitor()));
        let epoch = Arc::new(AtomicU64::new(0));
        let cancel = CancelToken::issue(&epoch);
        let ui = epoch.clone();
        worker.backend.while_picking = Some(Box::new(move || {
            ui.fetch_add(1, Ordering::SeqCst);
        }));
        assert_eq!(worker.start(&ScreenRequest::default(), &cancel), Ok(None));
        assert_eq!(state.borrow().open_streams, 0);
    }

    #[test]
    fn restarting_replaces_the_capture_and_ignores_old_frames() {
        let (mut worker, state, sinks) = worker(Pick::Share(monitor()));
        let never = CancelToken::never();
        worker.start(&ScreenRequest::default(), &never).unwrap();
        worker.start(&ScreenRequest::default(), &never).unwrap();
        assert_eq!(state.borrow().open_streams, 1);
        sink(&sinks, 0).publish(&JPEG);
        assert_eq!(worker.frames.next(Duration::ZERO), Ok(None));
        sink(&sinks, 1).publish(&JPEG);
        assert!(worker.frames.next(Duration::ZERO).unwrap().is_some());
    }

    #[test]
    fn sharing_ended_by_the_system_releases_it_and_reaches_the_ui() {
        let (mut worker, state, sinks) = worker(Pick::Share(monitor()));
        worker
            .start(&ScreenRequest::default(), &CancelToken::never())
            .unwrap();
        sink(&sinks, 0).fail("encerrado");
        worker.tick();
        assert_eq!(state.borrow().open_streams, 0);
        assert_eq!(worker.frames.next(Duration::ZERO), Err("encerrado".into()));
        worker.stop();
        assert_eq!(worker.frames.next(Duration::ZERO), Ok(None));
    }

    /// The engine thread owns the backend; `stop` from another thread
    /// cancels a start that is blocked on the picker.
    struct BlockingBackend(std::sync::mpsc::Sender<()>);

    impl ScreenBackend for BlockingBackend {
        type Stream = ();

        fn open(
            &mut self,
            _: &ScreenRequest,
            cancel: &CancelToken,
            _: FrameSink,
        ) -> Result<Option<((), ScreenSource)>, String> {
            let _ = self.0.send(());
            while !cancel.is_cancelled() {
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(None)
        }
    }

    #[test]
    fn engine_stop_dismisses_an_open_picker() {
        let (picking_tx, picking) = std::sync::mpsc::channel();
        let engine = ScreenEngine::with_backend(move || Ok(BlockingBackend(picking_tx))).unwrap();
        let starter = engine.clone();
        let start = std::thread::spawn(move || starter.start(ScreenRequest::default()));
        picking.recv().unwrap();
        engine.stop();
        assert_eq!(start.join().unwrap(), Ok(None));
        engine.shutdown();
    }

    #[test]
    fn engine_reports_backend_startup_failure() {
        let result = ScreenEngine::with_backend(|| -> Result<BlockingBackend, String> {
            Err("sem tela".into())
        });
        assert_eq!(result.err().as_deref(), Some("sem tela"));
    }
}
