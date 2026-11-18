use crate::backend::{Backend, BackendDevice, Frames};
use crate::format::{self, Encoding, Mode};
use crate::worker::{self, Reply};
use serde::Serialize;
use std::{
    sync::{
        mpsc::{Receiver, RecvTimeoutError, Sender},
        Arc,
    },
    time::Duration,
};

const NOT_FOUND: &str = "A câmera selecionada não está disponível. Atualize os dispositivos.";
const NO_MODE: &str = "A câmera não oferece um formato de vídeo compatível.";
const DISCONNECTED: &str = "A webcam foi desconectada. Selecione outra câmera.";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraDevice {
    /// Stable for the life of the app, even if the list reorders.
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraInfo {
    pub device_id: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
    /// `true` when the camera's own MJPEG is forwarded without re-encoding.
    pub passthrough: bool,
}

enum Request {
    Devices(Reply<Vec<CameraDevice>>),
    Start(String, Reply<CameraInfo>),
    Stop(Reply<()>),
    Shutdown,
}

/// Native cameras and captures are owned by one worker thread; calls are
/// serialized. Frames bypass the worker and are read from shared state.
#[derive(Clone)]
pub struct CameraEngine {
    sender: Sender<Request>,
    frames: Arc<Frames>,
}

impl CameraEngine {
    /// Starts the worker with the native backend of the current platform.
    #[cfg(target_os = "linux")]
    pub fn new() -> Result<Self, String> {
        Self::with_backend(crate::pipewire::PipeWireBackend::new)
    }

    /// The backend is created on the worker thread, so it may depend on
    /// thread-local state such as COM apartments.
    pub fn with_backend<B, F>(make: F) -> Result<Self, String>
    where
        B: Backend + 'static,
        F: FnOnce() -> Result<B, String> + Send + 'static,
    {
        let frames = Arc::new(Frames::default());
        let worker_frames = frames.clone();
        // Dropping Worker closes the capture, including on window shutdown.
        let sender = worker::spawn("disc-video", make, move |backend, receiver| {
            Worker::new(backend, worker_frames).run(receiver)
        })?;
        Ok(Self { sender, frames })
    }

    fn request<T>(&self, make: impl FnOnce(Reply<T>) -> Request) -> Result<T, String> {
        worker::call(&self.sender, make)
    }

    pub fn devices(&self) -> Result<Vec<CameraDevice>, String> {
        self.request(Request::Devices)
    }

    /// Starts capture on `device_id` (or the first camera when empty),
    /// replacing any running capture.
    pub fn start(&self, device_id: &str) -> Result<CameraInfo, String> {
        let device_id = device_id.to_owned();
        self.request(|reply| Request::Start(device_id, reply))
    }

    pub fn stop(&self) {
        let _ = self.request(Request::Stop);
    }

    pub fn shutdown(&self) {
        let _ = self.sender.send(Request::Shutdown);
    }

    /// Waits up to `timeout` for a frame newer than the last one returned.
    /// `Ok(None)` means no new frame (timeout or not capturing); an error
    /// means the capture stopped and should be shown to the user.
    pub fn next_frame(&self, timeout: Duration) -> Result<Option<Arc<Vec<u8>>>, String> {
        self.frames.next(timeout)
    }
}

struct DeviceEntry<D> {
    info: CameraDevice,
    device: D,
    modes: Vec<Mode>,
}

struct Capture<S> {
    _stream: S,
    device_id: String,
}

struct Worker<B: Backend> {
    backend: B,
    devices: Vec<DeviceEntry<B::Device>>,
    next_device_id: u64,
    capture: Option<Capture<B::Stream>>,
    frames: Arc<Frames>,
}

impl<B: Backend> Worker<B> {
    fn new(backend: B, frames: Arc<Frames>) -> Self {
        Self {
            backend,
            devices: Vec::new(),
            next_device_id: 0,
            capture: None,
            frames,
        }
    }

    fn run(&mut self, receiver: Receiver<Request>) {
        loop {
            self.tick();
            match receiver.recv_timeout(Duration::from_millis(25)) {
                Ok(Request::Devices(reply)) => {
                    let _ = reply.send(self.devices());
                }
                Ok(Request::Start(device_id, reply)) => {
                    let _ = reply.send(self.start(&device_id));
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

    /// Releases a capture whose backend reported a fatal error. The error
    /// stays visible until the UI stops or restarts the camera.
    fn tick(&mut self) {
        if self.capture.is_some() && self.frames.failed() {
            self.capture = None;
        }
    }

    fn devices(&mut self) -> Result<Vec<CameraDevice>, String> {
        let found = self.backend.devices()?;
        self.devices = reconcile_devices(found, &self.devices, &mut self.next_device_id);
        let disconnected = self.capture.as_ref().is_some_and(|capture| {
            !self
                .devices
                .iter()
                .any(|entry| entry.info.id == capture.device_id)
        });
        if disconnected {
            self.capture = None;
            self.frames.fail_current(DISCONNECTED.into());
        }
        Ok(self
            .devices
            .iter()
            .map(|entry| entry.info.clone())
            .collect())
    }

    fn start(&mut self, device_id: &str) -> Result<CameraInfo, String> {
        self.stop();
        let entry = self
            .devices
            .iter()
            .find(|entry| device_id.is_empty() || entry.info.id == device_id)
            .ok_or(NOT_FOUND)?;
        let mode = format::choose(&entry.modes).ok_or(NO_MODE)?;
        let sink = self.frames.begin();
        let stream = self
            .backend
            .open(&entry.device, &mode, sink)
            .inspect_err(|_| self.frames.end())?;
        let info = CameraInfo {
            device_id: entry.info.id.clone(),
            width: mode.width,
            height: mode.height,
            frame_rate: mode.fps(),
            passthrough: mode.encoding == Encoding::Jpeg,
        };
        self.capture = Some(Capture {
            _stream: stream,
            device_id: info.device_id.clone(),
        });
        Ok(info)
    }

    fn stop(&mut self) {
        self.frames.end();
        self.capture = None;
    }
}

/// Keeps public IDs stable across enumerations. Matching uses the backend's
/// native identity, so duplicate names and reorderings stay distinct.
fn reconcile_devices<D: PartialEq>(
    devices: Vec<BackendDevice<D>>,
    previous: &[DeviceEntry<D>],
    next_id: &mut u64,
) -> Vec<DeviceEntry<D>> {
    devices
        .into_iter()
        .map(|found| {
            let id = previous
                .iter()
                .find(|entry| entry.device == found.device)
                .map(|entry| entry.info.id.clone())
                .unwrap_or_else(|| {
                    *next_id += 1;
                    format!("camera-{next_id}")
                });
            DeviceEntry {
                info: CameraDevice {
                    id,
                    name: found.name,
                },
                device: found.device,
                modes: found.modes,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::FrameSink;
    use std::{
        cell::RefCell,
        rc::Rc,
        sync::{mpsc, Mutex},
        thread,
        time::Instant,
    };

    /// Sinks handed to the fake backend, to publish frames as a capture would.
    type Sinks = Arc<Mutex<Vec<FrameSink>>>;

    const JPEG: [u8; 6] = [0xFF, 0xD8, 1, 2, 0xFF, 0xD9];

    fn mode(encoding: Encoding, width: u32, height: u32, fps: i32) -> Mode {
        Mode {
            raw_format: (encoding == Encoding::Raw).then(|| "YUY2".into()),
            encoding,
            width,
            height,
            fps_numerator: fps,
            fps_denominator: 1,
        }
    }

    #[derive(Default)]
    struct State {
        devices: Vec<(u32, &'static str)>,
        fail_open: Option<String>,
        opened: Vec<(u32, Mode)>,
        open_streams: usize,
    }

    /// Tracks open captures through Drop, like a real native stream would.
    struct FakeStream(Rc<RefCell<State>>);

    impl Drop for FakeStream {
        fn drop(&mut self) {
            self.0.borrow_mut().open_streams -= 1;
        }
    }

    struct FakeBackend {
        state: Rc<RefCell<State>>,
        sinks: Sinks,
    }

    impl Backend for FakeBackend {
        type Device = u32;
        type Stream = FakeStream;

        fn devices(&mut self) -> Result<Vec<BackendDevice<u32>>, String> {
            Ok(self
                .state
                .borrow()
                .devices
                .iter()
                .map(|&(device, name)| BackendDevice {
                    device,
                    name: name.into(),
                    modes: vec![
                        mode(Encoding::Raw, 1280, 720, 10),
                        mode(Encoding::Jpeg, 1280, 720, 30),
                    ],
                })
                .collect())
        }

        fn open(
            &mut self,
            device: &u32,
            mode: &Mode,
            sink: FrameSink,
        ) -> Result<FakeStream, String> {
            let mut state = self.state.borrow_mut();
            if let Some(error) = state.fail_open.clone() {
                return Err(error);
            }
            state.opened.push((*device, mode.clone()));
            state.open_streams += 1;
            self.sinks.lock().unwrap().push(sink);
            Ok(FakeStream(self.state.clone()))
        }
    }

    fn worker() -> (Worker<FakeBackend>, Rc<RefCell<State>>, Sinks) {
        let state = Rc::new(RefCell::new(State {
            devices: vec![(1, "Webcam"), (2, "Webcam")],
            ..State::default()
        }));
        let sinks = Arc::new(Mutex::new(Vec::new()));
        let mut worker = Worker::new(
            FakeBackend {
                state: state.clone(),
                sinks: sinks.clone(),
            },
            Arc::new(Frames::default()),
        );
        worker.devices().unwrap();
        (worker, state, sinks)
    }

    fn sink(sinks: &Sinks, index: usize) -> FrameSink {
        sinks.lock().unwrap()[index].clone()
    }

    #[test]
    fn device_ids_follow_native_identity_not_names_or_order() {
        let (mut worker, state, _) = worker();
        let ids: Vec<_> = worker
            .devices()
            .unwrap()
            .into_iter()
            .map(|d| d.id)
            .collect();
        assert_eq!(ids, ["camera-1", "camera-2"]);
        state.borrow_mut().devices = vec![(3, "USB"), (2, "Webcam")];
        let ids: Vec<_> = worker
            .devices()
            .unwrap()
            .into_iter()
            .map(|d| d.id)
            .collect();
        assert_eq!(ids, ["camera-3", "camera-2"]);
    }

    #[test]
    fn start_opens_the_best_mode_and_frames_flow() {
        let (mut worker, state, sinks) = worker();
        let info = worker.start("camera-2").unwrap();
        assert_eq!(
            info,
            CameraInfo {
                device_id: "camera-2".into(),
                width: 1280,
                height: 720,
                frame_rate: 30.0,
                passthrough: true,
            }
        );
        assert_eq!(
            state.borrow().opened,
            [(2, mode(Encoding::Jpeg, 1280, 720, 30))]
        );

        sink(&sinks, 0).publish(&JPEG);
        let frame = worker.frames.next(Duration::ZERO).unwrap().unwrap();
        assert_eq!(frame.as_slice(), JPEG);
        // The same frame is not returned twice.
        assert_eq!(worker.frames.next(Duration::ZERO), Ok(None));
        // Truncated JPEGs are dropped.
        sink(&sinks, 0).publish(&JPEG[..4]);
        assert_eq!(worker.frames.next(Duration::ZERO), Ok(None));
    }

    #[test]
    fn empty_id_starts_the_first_camera_and_unknown_id_fails() {
        let (mut worker, state, _) = worker();
        assert_eq!(worker.start("").unwrap().device_id, "camera-1");
        assert_eq!(worker.start("camera-9").unwrap_err(), NOT_FOUND);
        assert_eq!(state.borrow().open_streams, 0);
    }

    #[test]
    fn restarting_ignores_frames_of_the_previous_capture() {
        let (mut worker, state, sinks) = worker();
        worker.start("camera-1").unwrap();
        worker.start("camera-2").unwrap();
        assert_eq!(state.borrow().open_streams, 1);
        sink(&sinks, 0).publish(&JPEG);
        assert_eq!(worker.frames.next(Duration::ZERO), Ok(None));
        sink(&sinks, 1).publish(&JPEG);
        assert!(worker.frames.next(Duration::ZERO).unwrap().is_some());
    }

    #[test]
    fn backend_errors_release_the_capture_and_reach_the_ui() {
        let (mut worker, state, sinks) = worker();
        worker.start("camera-1").unwrap();
        sink(&sinks, 0).fail("parou");
        worker.tick();
        assert_eq!(state.borrow().open_streams, 0);
        assert_eq!(worker.frames.next(Duration::ZERO), Err("parou".into()));
        worker.stop();
        assert_eq!(worker.frames.next(Duration::ZERO), Ok(None));
    }

    #[test]
    fn failed_open_reports_the_error_and_leaves_nothing_running() {
        let (mut worker, state, _) = worker();
        state.borrow_mut().fail_open = Some("ocupada".into());
        assert_eq!(worker.start("camera-1").unwrap_err(), "ocupada");
        assert_eq!(worker.frames.next(Duration::ZERO), Ok(None));
    }

    #[test]
    fn disconnected_camera_stops_with_an_error() {
        let (mut worker, state, _) = worker();
        worker.start("camera-2").unwrap();
        state
            .borrow_mut()
            .devices
            .retain(|&(device, _)| device != 2);
        worker.devices().unwrap();
        assert_eq!(state.borrow().open_streams, 0);
        assert_eq!(worker.frames.next(Duration::ZERO), Err(DISCONNECTED.into()));
    }

    #[test]
    fn next_frame_waits_for_a_frame_from_another_thread() {
        let (mut worker, _, sinks) = worker();
        worker.start("camera-1").unwrap();
        let sink = sink(&sinks, 0);
        let (started_tx, started_rx) = mpsc::channel();
        let producer = thread::spawn(move || {
            started_rx.recv().unwrap();
            thread::sleep(Duration::from_millis(20));
            sink.publish(&JPEG);
        });
        let started = Instant::now();
        started_tx.send(()).unwrap();
        assert!(worker
            .frames
            .next(Duration::from_secs(2))
            .unwrap()
            .is_some());
        assert!(started.elapsed() < Duration::from_secs(1));
        producer.join().unwrap();
    }

    #[test]
    fn engine_runs_the_backend_on_its_own_thread() {
        let engine = CameraEngine::with_backend(|| {
            Ok(FakeBackend {
                state: Rc::new(RefCell::new(State {
                    devices: vec![(7, "Webcam")],
                    ..State::default()
                })),
                sinks: Arc::new(Mutex::new(Vec::new())),
            })
        })
        .unwrap();
        let devices = engine.devices().unwrap();
        assert_eq!(
            devices,
            [CameraDevice {
                id: "camera-1".into(),
                name: "Webcam".into()
            }]
        );
        assert_eq!(engine.start("camera-1").unwrap().width, 1280);
        engine.stop();
        assert_eq!(engine.next_frame(Duration::ZERO), Ok(None));
        engine.shutdown();
    }

    #[test]
    fn engine_reports_backend_startup_failure() {
        let result = CameraEngine::with_backend(|| -> Result<FakeBackend, String> {
            Err("sem câmera".into())
        });
        assert_eq!(result.err().as_deref(), Some("sem câmera"));
    }
}
