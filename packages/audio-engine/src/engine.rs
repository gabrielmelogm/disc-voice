use crate::signal::{sanitize, Playback, Recording, MAX_RECORDING_SECONDS};
use cpal::{
    platform::{WasapiDevice as Device, WasapiHost as Host, WasapiStream as Stream},
    traits::{DeviceTrait, HostTrait, StreamTrait},
    FromSample, Sample, SampleFormat, SizedSample, StreamConfig,
};
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Serialize)]
pub struct AudioDevices {
    pub inputs: Vec<AudioDevice>,
    pub outputs: Vec<AudioDevice>,
}

#[derive(Clone, Serialize)]
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

#[derive(Deserialize)]
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

/// WASAPI devices and streams are owned by one worker, never by Tauri's
/// async executor. Calls are serialized and callbacks never invoke IPC.
#[derive(Clone)]
pub struct AudioEngine {
    sender: Sender<Request>,
}

impl AudioEngine {
    pub fn new() -> Result<Self, String> {
        let (sender, receiver) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("disc-audio".into())
            .spawn(move || {
                let mut worker = match Worker::new() {
                    Ok(worker) => {
                        let _ = ready_tx.send(Ok(()));
                        worker
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

struct DeviceEntry {
    info: AudioDevice,
    device: Device,
}

struct Input {
    _stream: Stream,
    device_id: String,
    started: Instant,
}

struct Output {
    _stream: Stream,
    device_id: String,
    finished: Arc<AtomicBool>,
    // Allow WASAPI's final queued buffer to drain before releasing the stream.
    finished_at: Option<Instant>,
}

struct Worker {
    host: Host,
    inputs: Vec<DeviceEntry>,
    outputs: Vec<DeviceEntry>,
    next_device_id: u64,
    sequence: u64,
    input: Option<Input>,
    output: Option<Output>,
    recording: Option<Arc<Mutex<Recording>>>,
    peak: Arc<AtomicU32>,
    errors_tx: SyncSender<(bool, String)>,
    errors_rx: Receiver<(bool, String)>,
    error: Option<String>,
}

impl Worker {
    fn new() -> Result<Self, String> {
        let (errors_tx, errors_rx) = mpsc::sync_channel(8);
        Ok(Self {
            host: Host::new().map_err(|error| error.to_string())?,
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
        })
    }

    fn devices(&mut self) -> Result<AudioDevices, String> {
        let inputs = self
            .host
            .input_devices()
            .map_err(|error| error.to_string())?;
        let outputs = self
            .host
            .output_devices()
            .map_err(|error| error.to_string())?;
        self.inputs = reconcile_devices(
            inputs,
            &self.inputs,
            self.host.default_input_device(),
            &mut self.next_device_id,
        );
        self.outputs = reconcile_devices(
            outputs,
            &self.outputs,
            self.host.default_output_device(),
            &mut self.next_device_id,
        );
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
        while let Ok((input, error)) = self.errors_rx.try_recv() {
            if input {
                self.input = None;
            } else {
                self.output = None;
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
        let device = &self
            .inputs
            .iter()
            .find(|entry| entry.info.id == id)
            .ok_or("Microfone indisponível. Atualize a lista de dispositivos.")?
            .device;
        let supported = device
            .default_input_config()
            .map_err(|error| error.to_string())?;
        let config = supported.config();
        let recording = Arc::new(Mutex::new(Recording::new(config.sample_rate.0)));
        self.peak.store(0, Ordering::Relaxed);
        let stream = match supported.sample_format() {
            SampleFormat::F32 => self.input_stream::<f32>(device, &config, recording.clone()),
            SampleFormat::I16 => self.input_stream::<i16>(device, &config, recording.clone()),
            SampleFormat::U8 => self.input_stream::<u8>(device, &config, recording.clone()),
            SampleFormat::I32 => self.input_stream::<i32>(device, &config, recording.clone()),
            SampleFormat::I64 => self.input_stream::<i64>(device, &config, recording.clone()),
            format => Err(format!("Formato de entrada não suportado: {format:?}")),
        }?;
        stream.play().map_err(|error| error.to_string())?;
        self.recording = Some(recording);
        self.input = Some(Input {
            _stream: stream,
            device_id: id.into(),
            started: Instant::now(),
        });
        Ok(())
    }

    fn input_stream<T>(
        &self,
        device: &Device,
        config: &StreamConfig,
        recording: Arc<Mutex<Recording>>,
    ) -> Result<Stream, String>
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        let channels = config.channels as usize;
        let peak = self.peak.clone();
        let errors = self.errors_tx.clone();
        device
            .build_input_stream(
                config,
                move |samples: &[T], _| {
                    let mut level = 0.0_f32;
                    // The worker only briefly reads metadata while capture is active.
                    if let Ok(mut recording) = recording.lock() {
                        for frame in samples.chunks_exact(channels) {
                            recording.push_frame(frame.iter().map(|&sample| {
                                let sample = sanitize(f32::from_sample(sample));
                                level = level.max(sample.abs());
                                sample
                            }));
                        }
                    }
                    // Positive finite floats have the same bit ordering as u32.
                    peak.fetch_max(level.to_bits(), Ordering::Relaxed);
                },
                move |error| {
                    let _ = errors.try_send((true, error.to_string()));
                },
                None,
            )
            .map_err(|error| error.to_string())
    }

    fn start_output(&mut self, id: &str, volume: f32, recorded: bool) -> Result<(), String> {
        if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
            return Err("O volume deve estar entre 0 e 100%.".into());
        }
        self.input = None;
        self.output = None;
        let device = &self
            .outputs
            .iter()
            .find(|entry| entry.info.id == id)
            .ok_or("Saída indisponível. Atualize a lista de dispositivos.")?
            .device;
        let supported = device
            .default_output_config()
            .map_err(|error| error.to_string())?;
        let config = supported.config();
        let playback = if recorded {
            let recording = self
                .recording
                .as_ref()
                .ok_or("Grave um trecho do microfone primeiro.")?
                .lock()
                .map_err(|_| "Não foi possível acessar a gravação.")?;
            if recording.samples.is_empty() {
                return Err("A gravação está vazia. Teste o microfone novamente.".into());
            }
            Playback::recording(&recording, config.sample_rate.0, volume)
        } else {
            Playback::tone(config.sample_rate.0, volume)
        };
        let finished = Arc::new(AtomicBool::new(false));
        let stream = match supported.sample_format() {
            SampleFormat::F32 => {
                self.output_stream::<f32>(device, &config, playback, finished.clone())
            }
            SampleFormat::I16 => {
                self.output_stream::<i16>(device, &config, playback, finished.clone())
            }
            SampleFormat::U8 => {
                self.output_stream::<u8>(device, &config, playback, finished.clone())
            }
            SampleFormat::I32 => {
                self.output_stream::<i32>(device, &config, playback, finished.clone())
            }
            SampleFormat::I64 => {
                self.output_stream::<i64>(device, &config, playback, finished.clone())
            }
            format => Err(format!("Formato de saída não suportado: {format:?}")),
        }?;
        stream.play().map_err(|error| error.to_string())?;
        self.output = Some(Output {
            _stream: stream,
            device_id: id.into(),
            finished,
            finished_at: None,
        });
        Ok(())
    }

    fn output_stream<T>(
        &self,
        device: &Device,
        config: &StreamConfig,
        mut playback: Playback,
        finished: Arc<AtomicBool>,
    ) -> Result<Stream, String>
    where
        T: SizedSample + FromSample<f32>,
    {
        let channels = config.channels as usize;
        let errors = self.errors_tx.clone();
        device
            .build_output_stream(
                config,
                move |samples: &mut [T], _| {
                    for frame in samples.chunks_mut(channels) {
                        let value = T::from_sample(playback.next_frame());
                        frame.fill(value);
                    }
                    if playback.finished() {
                        finished.store(true, Ordering::Relaxed);
                    }
                },
                move |error| {
                    let _ = errors.try_send((false, error.to_string()));
                },
                None,
            )
            .map_err(|error| error.to_string())
    }
}

fn reconcile_devices(
    devices: impl Iterator<Item = Device>,
    previous: &[DeviceEntry],
    default: Option<Device>,
    next_id: &mut u64,
) -> Vec<DeviceEntry> {
    devices
        .map(|device| {
            // WASAPI equality compares endpoint IDs, not names or list indexes.
            // Duplicate names and enumeration reorderings therefore stay distinct.
            let id = previous
                .iter()
                .find(|entry| entry.device == device)
                .map(|entry| entry.info.id.clone())
                .unwrap_or_else(|| {
                    *next_id += 1;
                    format!("audio-{next_id}")
                });
            DeviceEntry {
                info: AudioDevice {
                    id,
                    name: device
                        .name()
                        .unwrap_or_else(|_| "Dispositivo de áudio".into()),
                    is_default: default.as_ref() == Some(&device),
                },
                device,
            }
        })
        .collect()
}
