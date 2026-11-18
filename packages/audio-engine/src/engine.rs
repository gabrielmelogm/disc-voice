use crate::backend::{Backend, BackendDevice, Direction, ErrorSink, InputSink, OutputSource};
use crate::signal::{Playback, Recording, MAX_RECORDING_SECONDS};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

type Reply<T> = SyncSender<Result<T, String>>;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Serialize)]
pub struct AudioDevices {
    pub inputs: Vec<AudioDevice>,
    pub outputs: Vec<AudioDevice>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStatus {
    pub sequence: u64,
    pub input_active: bool,
    pub output_active: bool,
    pub peak: f32,
    pub recorded_seconds: f64,
    pub recording_ready: bool,
    pub sample_rate: Option<u32>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AudioAction {
    StartMicrophone { device_id: String },
    StopMicrophone,
    PlayTone { device_id: String, volume: f32 },
    PlayRecording { device_id: String, volume: f32 },
    StopOutput,
    StopAll,
}

enum Request {
    Devices(Reply<AudioDevices>),
    Action(AudioAction, Reply<AudioStatus>),
    Status(Reply<AudioStatus>),
    Shutdown,
}

/// Native devices and streams are owned by one worker, never by Tauri's
/// async executor. Calls are serialized and callbacks never invoke IPC.
#[derive(Clone)]
pub struct AudioEngine {
    sender: Sender<Request>,
}

impl AudioEngine {
    /// Starts the worker with the native backend of the current platform.
    #[cfg(windows)]
    pub fn new() -> Result<Self, String> {
        Self::with_backend(crate::wasapi::WasapiBackend::new)
    }

    /// Starts the worker with the native backend of the current platform.
    #[cfg(target_os = "linux")]
    pub fn new() -> Result<Self, String> {
        Self::with_backend(crate::pulse::PulseBackend::new)
    }

    /// The backend is created on the worker thread, so it may depend on
    /// thread-local state such as COM apartments.
    pub fn with_backend<B, F>(make: F) -> Result<Self, String>
    where
        B: Backend + 'static,
        F: FnOnce() -> Result<B, String> + Send + 'static,
    {
        let (sender, receiver) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("disc-audio".into())
            .spawn(move || {
                let mut worker = match make() {
                    Ok(backend) => {
                        let _ = ready_tx.send(Ok(()));
                        Worker::new(backend)
                    }
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                loop {
                    worker.tick();
                    match receiver.recv_timeout(Duration::from_millis(25)) {
                        Ok(Request::Devices(reply)) => {
                            let _ = reply.send(worker.devices());
                        }
                        Ok(Request::Action(action, reply)) => {
                            let result = worker.action(action).map(|_| worker.status());
                            let _ = reply.send(result);
                        }
                        Ok(Request::Status(reply)) => {
                            let _ = reply.send(Ok(worker.status()));
                        }
                        Ok(Request::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
                        Err(RecvTimeoutError::Timeout) => {}
                    }
                }
                // Dropping Worker closes both streams, including on window shutdown.
            })
            .map_err(|error| error.to_string())?;
        ready_rx.recv().map_err(|error| error.to_string())??;
        Ok(Self { sender })
    }

    fn request<T>(&self, make: impl FnOnce(Reply<T>) -> Request) -> Result<T, String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        self.sender
            .send(make(sender))
            .map_err(|_| "O motor de áudio foi encerrado. Reinicie o aplicativo.".to_string())?;
        receiver.recv().map_err(|_| {
            "O motor de áudio parou de responder. Reinicie o aplicativo.".to_string()
        })?
    }

    pub fn devices(&self) -> Result<AudioDevices, String> {
        self.request(Request::Devices)
    }

    pub fn status(&self) -> Result<AudioStatus, String> {
        self.request(Request::Status)
    }

    pub fn action(&self, action: AudioAction) -> Result<AudioStatus, String> {
        self.request(|reply| Request::Action(action, reply))
    }

    pub fn shutdown(&self) {
        let _ = self.sender.send(Request::Shutdown);
    }
}

struct DeviceEntry<D> {
    info: AudioDevice,
    device: D,
}

struct Input<S> {
    _stream: S,
    device_id: String,
    started: Instant,
}

struct Output<S> {
    _stream: S,
    device_id: String,
    finished: Arc<AtomicBool>,
    // Allow the backend's final queued buffer to drain before releasing the stream.
    finished_at: Option<Instant>,
}

struct Worker<B: Backend> {
    backend: B,
    inputs: Vec<DeviceEntry<B::Device>>,
    outputs: Vec<DeviceEntry<B::Device>>,
    next_device_id: u64,
    sequence: u64,
    input: Option<Input<B::Stream>>,
    output: Option<Output<B::Stream>>,
    recording: Option<Arc<Mutex<Recording>>>,
    peak: Arc<AtomicU32>,
    errors_tx: SyncSender<(Direction, String)>,
    errors_rx: Receiver<(Direction, String)>,
    error: Option<String>,
}

impl<B: Backend> Worker<B> {
    fn new(backend: B) -> Self {
        let (errors_tx, errors_rx) = mpsc::sync_channel(8);
        Self {
            backend,
            inputs: Vec::new(),
            outputs: Vec::new(),
            next_device_id: 0,
            sequence: 0,
            input: None,
            output: None,
            recording: None,
            peak: Arc::new(AtomicU32::new(0)),
            errors_tx,
            errors_rx,
            error: None,
        }
    }

    fn errors(&self, direction: Direction) -> ErrorSink {
        ErrorSink {
            sender: self.errors_tx.clone(),
            direction,
        }
    }

    fn devices(&mut self) -> Result<AudioDevices, String> {
        let inputs = self.backend.devices(Direction::Input)?;
        let outputs = self.backend.devices(Direction::Output)?;
        self.inputs = reconcile_devices(inputs, &self.inputs, &mut self.next_device_id);
        self.outputs = reconcile_devices(outputs, &self.outputs, &mut self.next_device_id);
        if self.input.as_ref().is_some_and(|active| {
            !self
                .inputs
                .iter()
                .any(|entry| entry.info.id == active.device_id)
        }) {
            self.input = None;
            self.error = Some("O microfone foi desconectado. Selecione outro dispositivo.".into());
        }
        if self.output.as_ref().is_some_and(|active| {
            !self
                .outputs
                .iter()
                .any(|entry| entry.info.id == active.device_id)
        }) {
            self.output = None;
            self.error =
                Some("A saída de áudio foi desconectada. Selecione outro dispositivo.".into());
        }
        Ok(AudioDevices {
            inputs: self.inputs.iter().map(|entry| entry.info.clone()).collect(),
            outputs: self
                .outputs
                .iter()
                .map(|entry| entry.info.clone())
                .collect(),
        })
    }

    fn tick(&mut self) {
        while let Ok((direction, error)) = self.errors_rx.try_recv() {
            match direction {
                Direction::Input => self.input = None,
                Direction::Output => self.output = None,
            }
            self.error = Some(format!("O dispositivo interrompeu o teste: {error}"));
        }
        if self.input.as_ref().is_some_and(|input| {
            input.started.elapsed() >= Duration::from_secs(MAX_RECORDING_SECONDS as u64)
        }) {
            self.input = None;
        }
        if let Some(output) = &mut self.output {
            if output.finished.load(Ordering::Relaxed) {
                let finished = output.finished_at.get_or_insert_with(Instant::now);
                if finished.elapsed() >= Duration::from_millis(250) {
                    self.output = None;
                }
            }
        }
    }

    fn status(&mut self) -> AudioStatus {
        self.sequence += 1;
        let (seconds, sample_rate) = self
            .recording
            .as_ref()
            .and_then(|recording| recording.lock().ok())
            .map(|recording| (recording.seconds(), Some(recording.sample_rate)))
            .unwrap_or((0.0, None));
        let peak = f32::from_bits(self.peak.swap(0, Ordering::Relaxed));
        AudioStatus {
            sequence: self.sequence,
            input_active: self.input.is_some(),
            output_active: self.output.is_some(),
            peak: if self.input.is_some() { peak } else { 0.0 },
            recorded_seconds: seconds,
            recording_ready: self.input.is_none() && seconds > 0.0,
            sample_rate,
            error: self.error.clone(),
        }
    }

    fn action(&mut self, action: AudioAction) -> Result<(), String> {
        self.error = None;
        match action {
            AudioAction::StartMicrophone { device_id } => self.start_input(&device_id),
            AudioAction::StopMicrophone => {
                self.input = None;
                Ok(())
            }
            AudioAction::PlayTone { device_id, volume } => {
                self.start_output(&device_id, volume, false)
            }
            AudioAction::PlayRecording { device_id, volume } => {
                self.start_output(&device_id, volume, true)
            }
            AudioAction::StopOutput => {
                self.output = None;
                Ok(())
            }
            AudioAction::StopAll => {
                self.input = None;
                self.output = None;
                Ok(())
            }
        }
    }

    fn start_input(&mut self, id: &str) -> Result<(), String> {
        self.input = None;
        self.output = None;
        let errors = self.errors(Direction::Input);
        let device = &self
            .inputs
            .iter()
            .find(|entry| entry.info.id == id)
            .ok_or("Microfone indisponível. Atualize a lista de dispositivos.")?
            .device;
        let peak = self.peak.clone();
        let mut created = None;
        let stream = self.backend.open_input(
            device,
            |sample_rate| {
                let recording = Arc::new(Mutex::new(Recording::new(sample_rate)));
                peak.store(0, Ordering::Relaxed);
                created = Some(recording.clone());
                InputSink { recording, peak }
            },
            errors,
        )?;
        // Only replace the previous recording once capture actually started.
        if let Some(recording) = created {
            self.recording = Some(recording);
        }
        self.input = Some(Input {
            _stream: stream,
            device_id: id.into(),
            started: Instant::now(),
        });
        Ok(())
    }

    fn start_output(&mut self, id: &str, volume: f32, recorded: bool) -> Result<(), String> {
        if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
            return Err("O volume deve estar entre 0 e 100%.".into());
        }
        self.input = None;
        self.output = None;
        let errors = self.errors(Direction::Output);
        let device = &self
            .outputs
            .iter()
            .find(|entry| entry.info.id == id)
            .ok_or("Saída indisponível. Atualize a lista de dispositivos.")?
            .device;
        let finished = Arc::new(AtomicBool::new(false));
        let recording = &self.recording;
        let stream = self.backend.open_output(
            device,
            |sample_rate| {
                let playback = if recorded {
                    let recording = recording
                        .as_ref()
                        .ok_or("Grave um trecho do microfone primeiro.")?
                        .lock()
                        .map_err(|_| "Não foi possível acessar a gravação.")?;
                    if recording.samples.is_empty() {
                        return Err("A gravação está vazia. Teste o microfone novamente.".into());
                    }
                    Playback::recording(&recording, sample_rate, volume)
                } else {
                    Playback::tone(sample_rate, volume)
                };
                Ok(OutputSource {
                    playback,
                    finished: finished.clone(),
                })
            },
            errors,
        )?;
        self.output = Some(Output {
            _stream: stream,
            device_id: id.into(),
            finished,
            finished_at: None,
        });
        Ok(())
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
                    format!("audio-{next_id}")
                });
            DeviceEntry {
                info: AudioDevice {
                    id,
                    name: found.name,
                    is_default: found.is_default,
                },
                device: found.device,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};

    #[derive(Default)]
    struct State {
        inputs: Vec<(u32, &'static str, bool)>,
        outputs: Vec<(u32, &'static str, bool)>,
        fail_open: Option<String>,
        sinks: Vec<InputSink>,
        sources: Vec<OutputSource>,
        errors: Vec<ErrorSink>,
        open_streams: usize,
    }

    /// Tracks open streams through Drop, like a real native stream would.
    struct FakeStream(Rc<RefCell<State>>);

    impl Drop for FakeStream {
        fn drop(&mut self) {
            self.0.borrow_mut().open_streams -= 1;
        }
    }

    #[derive(Clone)]
    struct FakeBackend(Rc<RefCell<State>>);

    impl FakeBackend {
        fn open(&self) -> Result<FakeStream, String> {
            let mut state = self.0.borrow_mut();
            if let Some(error) = state.fail_open.clone() {
                return Err(error);
            }
            state.open_streams += 1;
            Ok(FakeStream(self.0.clone()))
        }
    }

    impl Backend for FakeBackend {
        type Device = u32;
        type Stream = FakeStream;

        fn devices(&mut self, direction: Direction) -> Result<Vec<BackendDevice<u32>>, String> {
            let state = self.0.borrow();
            let list = match direction {
                Direction::Input => &state.inputs,
                Direction::Output => &state.outputs,
            };
            Ok(list
                .iter()
                .map(|&(device, name, is_default)| BackendDevice {
                    device,
                    name: name.into(),
                    is_default,
                })
                .collect())
        }

        fn open_input(
            &mut self,
            _device: &u32,
            sink: impl FnOnce(u32) -> InputSink,
            errors: ErrorSink,
        ) -> Result<FakeStream, String> {
            let stream = self.open()?;
            let sink = sink(10);
            let mut state = self.0.borrow_mut();
            state.sinks.push(sink);
            state.errors.push(errors);
            Ok(stream)
        }

        fn open_output(
            &mut self,
            _device: &u32,
            source: impl FnOnce(u32) -> Result<OutputSource, String>,
            errors: ErrorSink,
        ) -> Result<FakeStream, String> {
            let source = source(20)?;
            let stream = self.open()?;
            let mut state = self.0.borrow_mut();
            state.sources.push(source);
            state.errors.push(errors);
            Ok(stream)
        }
    }

    fn worker() -> (Worker<FakeBackend>, Rc<RefCell<State>>) {
        let state = Rc::new(RefCell::new(State {
            inputs: vec![(1, "Mic", true), (2, "Mic", false)],
            outputs: vec![(3, "Fone", true)],
            ..State::default()
        }));
        let mut worker = Worker::new(FakeBackend(state.clone()));
        worker.devices().unwrap();
        (worker, state)
    }

    fn start_mic(worker: &mut Worker<FakeBackend>, id: &str) -> Result<(), String> {
        worker.action(AudioAction::StartMicrophone {
            device_id: id.into(),
        })
    }

    #[test]
    fn device_ids_follow_native_identity_not_names_or_order() {
        let (mut worker, state) = worker();
        let first = worker.devices().unwrap();
        assert_eq!(
            first.inputs,
            vec![
                AudioDevice {
                    id: "audio-1".into(),
                    name: "Mic".into(),
                    is_default: true
                },
                AudioDevice {
                    id: "audio-2".into(),
                    name: "Mic".into(),
                    is_default: false
                },
            ]
        );
        assert_eq!(first.outputs[0].id, "audio-3");

        state.borrow_mut().inputs = vec![(4, "USB", false), (2, "Mic", true)];
        let second = worker.devices().unwrap();
        let ids: Vec<_> = second
            .inputs
            .iter()
            .map(|device| device.id.as_str())
            .collect();
        assert_eq!(ids, ["audio-4", "audio-2"]);
        assert!(second.inputs[1].is_default);
    }

    #[test]
    fn capture_records_and_reports_peak_once_per_status() {
        let (mut worker, state) = worker();
        start_mic(&mut worker, "audio-1").unwrap();
        state.borrow().sinks[0].capture([[0.5, -0.9], [0.1, 0.1]]);

        let status = worker.status();
        assert!(status.input_active);
        assert!((status.peak - 0.9).abs() < 1e-6);
        assert_eq!(status.sample_rate, Some(10));
        assert!((status.recorded_seconds - 0.2).abs() < 1e-9);
        assert!(!status.recording_ready);
        assert_eq!(worker.status().peak, 0.0);

        worker.action(AudioAction::StopMicrophone).unwrap();
        let status = worker.status();
        assert!(status.recording_ready);
        assert_eq!(state.borrow().open_streams, 0);
    }

    #[test]
    fn input_and_output_are_mutually_exclusive() {
        let (mut worker, state) = worker();
        start_mic(&mut worker, "audio-1").unwrap();
        state.borrow().sinks[0].capture([[0.5]]);
        worker
            .action(AudioAction::PlayRecording {
                device_id: "audio-3".into(),
                volume: 1.0,
            })
            .unwrap();
        let status = worker.status();
        assert!(!status.input_active && status.output_active);
        assert_eq!(state.borrow().open_streams, 1);

        start_mic(&mut worker, "audio-2").unwrap();
        let status = worker.status();
        assert!(status.input_active && !status.output_active);
        assert_eq!(state.borrow().open_streams, 1);
    }

    #[test]
    fn output_validates_volume_and_recording_before_opening() {
        let (mut worker, state) = worker();
        for volume in [-0.1, 1.1, f32::NAN] {
            let error = worker
                .action(AudioAction::PlayTone {
                    device_id: "audio-3".into(),
                    volume,
                })
                .unwrap_err();
            assert_eq!(error, "O volume deve estar entre 0 e 100%.");
        }
        let error = worker
            .action(AudioAction::PlayRecording {
                device_id: "audio-3".into(),
                volume: 1.0,
            })
            .unwrap_err();
        assert_eq!(error, "Grave um trecho do microfone primeiro.");

        start_mic(&mut worker, "audio-1").unwrap();
        let error = worker
            .action(AudioAction::PlayRecording {
                device_id: "audio-3".into(),
                volume: 1.0,
            })
            .unwrap_err();
        assert_eq!(error, "A gravação está vazia. Teste o microfone novamente.");
        assert_eq!(state.borrow().open_streams, 0);

        let error = worker
            .action(AudioAction::PlayTone {
                device_id: "audio-9".into(),
                volume: 1.0,
            })
            .unwrap_err();
        assert_eq!(
            error,
            "Saída indisponível. Atualize a lista de dispositivos."
        );
    }

    #[test]
    fn failed_capture_keeps_previous_recording() {
        let (mut worker, state) = worker();
        start_mic(&mut worker, "audio-1").unwrap();
        state.borrow().sinks[0].capture([[0.5], [0.5]]);
        worker.action(AudioAction::StopMicrophone).unwrap();

        state.borrow_mut().fail_open = Some("ocupado".into());
        assert_eq!(start_mic(&mut worker, "audio-2").unwrap_err(), "ocupado");
        let status = worker.status();
        assert!(!status.input_active);
        assert!(status.recording_ready);
        assert!((status.recorded_seconds - 0.2).abs() < 1e-9);
    }

    #[test]
    fn stream_errors_stop_only_their_direction() {
        let (mut worker, state) = worker();
        worker
            .action(AudioAction::PlayTone {
                device_id: "audio-3".into(),
                volume: 0.5,
            })
            .unwrap();
        state.borrow().errors[0].report("falhou");
        worker.tick();
        let status = worker.status();
        assert!(!status.output_active);
        assert_eq!(
            status.error.as_deref(),
            Some("O dispositivo interrompeu o teste: falhou")
        );
        assert_eq!(state.borrow().open_streams, 0);
    }

    #[test]
    fn disconnected_device_closes_its_stream() {
        let (mut worker, state) = worker();
        start_mic(&mut worker, "audio-2").unwrap();
        state
            .borrow_mut()
            .inputs
            .retain(|&(device, _, _)| device != 2);
        worker.devices().unwrap();
        let status = worker.status();
        assert!(!status.input_active);
        assert_eq!(
            status.error.as_deref(),
            Some("O microfone foi desconectado. Selecione outro dispositivo.")
        );
        assert_eq!(state.borrow().open_streams, 0);
    }

    #[test]
    fn finished_playback_is_released_after_drain() {
        let (mut worker, state) = worker();
        worker
            .action(AudioAction::PlayTone {
                device_id: "audio-3".into(),
                volume: 0.5,
            })
            .unwrap();
        {
            let mut state = state.borrow_mut();
            let source = &mut state.sources[0];
            // 3 s tone at 20 Hz = 60 frames.
            for _ in 0..60 {
                source.next_frame();
            }
            source.end_buffer();
        }
        worker.tick();
        assert!(worker.status().output_active);
        if let Some(output) = &mut worker.output {
            output.finished_at = Some(Instant::now() - Duration::from_millis(250));
        }
        worker.tick();
        assert!(!worker.status().output_active);
    }

    #[test]
    fn actions_deserialize_from_frontend_json() {
        let action: AudioAction =
            serde_json::from_str(r#"{"type":"playTone","deviceId":"audio-3","volume":0.4}"#)
                .unwrap();
        assert!(matches!(
            action,
            AudioAction::PlayTone { ref device_id, volume } if device_id == "audio-3" && volume == 0.4
        ));
        let action: AudioAction = serde_json::from_str(r#"{"type":"stopAll"}"#).unwrap();
        assert!(matches!(action, AudioAction::StopAll));
    }

    #[test]
    fn engine_reports_backend_startup_failure() {
        let result = AudioEngine::with_backend(|| -> Result<FakeBackend, String> {
            Err("sem áudio".into())
        });
        assert_eq!(result.err().as_deref(), Some("sem áudio"));
    }
}
