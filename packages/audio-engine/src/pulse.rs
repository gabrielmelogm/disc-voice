//! Linux backend over the PulseAudio client API.
//!
//! On current distributions the server is usually PipeWire (`pipewire-pulse`),
//! which implements the same protocol. Introspection uses an async context on
//! the worker thread; each stream runs blocking `pa_simple` I/O on its own
//! thread, so the worker never waits on audio buffers.

use crate::backend::{Backend, BackendDevice, Direction, ErrorSink, InputSink, OutputSource};
use libpulse_binding::{
    callbacks::ListResult,
    context::{Context, FlagSet as ContextFlags, State as ContextState},
    def::BufferAttr,
    mainloop::standard::{IterateResult, Mainloop},
    operation::{Operation, State as OperationState},
    sample::{Format, Spec},
    stream::Direction as StreamDirection,
};
use libpulse_simple_binding::Simple;
use std::{
    cell::RefCell,
    rc::Rc,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const APP_NAME: &str = "Disc Voice";
const UNAVAILABLE: &str = "Não foi possível conectar ao servidor de áudio (PipeWire/PulseAudio). \
                           Verifique se ele está em execução.";
const NOT_RESPONDING: &str = "O servidor de áudio não respondeu. Tente novamente.";
const SERVER_TIMEOUT: Duration = Duration::from_secs(3);
const FALLBACK_RATE: u32 = 48_000;
const SAMPLE_BYTES: usize = std::mem::size_of::<f32>();

/// A sink (output) or non-monitor source (input) known to the server.
#[derive(Clone, Debug)]
pub struct PulseDevice {
    name: String,
    rate: u32,
    channels: u8,
}

/// The server-side name is the stable identity; the format is only a hint
/// that may change while the device keeps its identity.
impl PartialEq for PulseDevice {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name
    }
}

pub struct PulseBackend {
    // Declared before the mainloop so it is dropped first.
    context: Option<Context>,
    mainloop: Mainloop,
}

impl PulseBackend {
    /// Does not connect yet: a missing audio server must not stop the app
    /// from opening, it only makes device listing report an error.
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            context: None,
            mainloop: Mainloop::new().ok_or(UNAVAILABLE)?,
        })
    }

    fn connect(&mut self) -> Result<&Context, String> {
        let ready = self
            .context
            .as_ref()
            .is_some_and(|context| context.get_state() == ContextState::Ready);
        if !ready {
            self.context = None;
            let mut context = Context::new(&self.mainloop, APP_NAME).ok_or(UNAVAILABLE)?;
            context
                .connect(None, ContextFlags::NOAUTOSPAWN, None)
                .map_err(|_| UNAVAILABLE)?;
            let deadline = Instant::now() + SERVER_TIMEOUT;
            loop {
                match context.get_state() {
                    ContextState::Ready => break,
                    ContextState::Failed | ContextState::Terminated => {
                        return Err(UNAVAILABLE.into())
                    }
                    _ => self.iterate(deadline)?,
                }
            }
            self.context = Some(context);
        }
        Ok(self.context.as_ref().expect("context connected above"))
    }

    fn iterate(&mut self, deadline: Instant) -> Result<(), String> {
        match self.mainloop.iterate(false) {
            IterateResult::Success(0) => thread::sleep(Duration::from_millis(1)),
            IterateResult::Success(_) => {}
            IterateResult::Quit(_) | IterateResult::Err(_) => {
                self.context = None;
                return Err(UNAVAILABLE.into());
            }
        }
        if Instant::now() >= deadline {
            self.context = None;
            return Err(NOT_RESPONDING.into());
        }
        Ok(())
    }

    fn wait<T: ?Sized>(&mut self, operation: Operation<T>) -> Result<(), String> {
        let deadline = Instant::now() + SERVER_TIMEOUT;
        while operation.get_state() == OperationState::Running {
            self.iterate(deadline)?;
        }
        match operation.get_state() {
            OperationState::Done => Ok(()),
            _ => {
                self.context = None;
                Err(UNAVAILABLE.into())
            }
        }
    }

    fn default_name(&mut self, direction: Direction) -> Result<Option<String>, String> {
        let found = Rc::new(RefCell::new(None));
        let sink = found.clone();
        let operation = self.connect()?.introspect().get_server_info(move |info| {
            let name = match direction {
                Direction::Input => &info.default_source_name,
                Direction::Output => &info.default_sink_name,
            };
            *sink.borrow_mut() = name.as_ref().map(|name| name.to_string());
        });
        self.wait(operation)?;
        let name = found.borrow_mut().take();
        Ok(name)
    }
}

type Found = Rc<RefCell<Result<Vec<(PulseDevice, String)>, ()>>>;

fn collect(found: &Found, name: Option<&str>, description: Option<&str>, spec: &Spec) {
    if let (Ok(list), Some(name)) = (&mut *found.borrow_mut(), name) {
        let label = description
            .filter(|label| !label.is_empty())
            .unwrap_or(name);
        list.push((
            PulseDevice {
                name: name.into(),
                rate: if spec.rate > 0 {
                    spec.rate
                } else {
                    FALLBACK_RATE
                },
                channels: spec.channels.max(1),
            },
            label.into(),
        ));
    }
}

impl Backend for PulseBackend {
    type Device = PulseDevice;
    type Stream = PulseStream;

    fn devices(&mut self, direction: Direction) -> Result<Vec<BackendDevice<PulseDevice>>, String> {
        let default = self.default_name(direction)?;
        let found: Found = Rc::new(RefCell::new(Ok(Vec::new())));
        let sink = found.clone();
        let introspect = self.connect()?.introspect();
        match direction {
            Direction::Input => {
                let operation = introspect.get_source_info_list(move |result| match result {
                    // Monitors capture what a sink plays, not a microphone.
                    ListResult::Item(info) if info.monitor_of_sink.is_none() => collect(
                        &sink,
                        info.name.as_deref(),
                        info.description.as_deref(),
                        &info.sample_spec,
                    ),
                    ListResult::Item(_) | ListResult::End => {}
                    ListResult::Error => *sink.borrow_mut() = Err(()),
                });
                self.wait(operation)?;
            }
            Direction::Output => {
                let operation = introspect.get_sink_info_list(move |result| match result {
                    ListResult::Item(info) => collect(
                        &sink,
                        info.name.as_deref(),
                        info.description.as_deref(),
                        &info.sample_spec,
                    ),
                    ListResult::End => {}
                    ListResult::Error => *sink.borrow_mut() = Err(()),
                });
                self.wait(operation)?;
            }
        }
        let list = found
            .replace(Ok(Vec::new()))
            .map_err(|_| "Não foi possível listar os dispositivos de áudio.".to_string())?;
        Ok(list
            .into_iter()
            .map(|(device, name)| BackendDevice {
                is_default: default.as_deref() == Some(device.name.as_str()),
                name,
                device,
            })
            .collect())
    }

    fn open_input(
        &mut self,
        device: &PulseDevice,
        sink: impl FnOnce(u32) -> InputSink,
        errors: ErrorSink,
    ) -> Result<PulseStream, String> {
        // ~20 ms fragments keep the level meter responsive.
        let channels = device.channels as usize;
        let frame_bytes = channels * SAMPLE_BYTES;
        let frames = (device.rate / 50).max(1) as usize;
        let attr = BufferAttr {
            maxlength: u32::MAX,
            tlength: u32::MAX,
            prebuf: u32::MAX,
            minreq: u32::MAX,
            fragsize: (frames * frame_bytes) as u32,
        };
        let simple = open(device, StreamDirection::Record, "Teste de microfone", &attr)
            .map_err(|error| format!("Não foi possível abrir o microfone: {error}"))?;
        let sink = sink(device.rate);
        PulseStream::spawn("disc-audio-input", move |stop| {
            let mut bytes = vec![0_u8; frames * frame_bytes];
            while !stop.load(Ordering::Relaxed) {
                if let Err(error) = simple.read(&mut bytes) {
                    errors.report(format!("{error}"));
                    return;
                }
                // Native channels, downmixed by `Recording` exactly as on
                // Windows instead of by the server's remixer.
                sink.capture(bytes.chunks_exact(frame_bytes).map(|frame| {
                    frame.chunks_exact(SAMPLE_BYTES).map(|sample| {
                        f32::from_ne_bytes(sample.try_into().expect("chunk of 4 bytes"))
                    })
                }));
            }
        })
    }

    fn open_output(
        &mut self,
        device: &PulseDevice,
        source: impl FnOnce(u32) -> Result<OutputSource, String>,
        errors: ErrorSink,
    ) -> Result<PulseStream, String> {
        // Validate the request before opening anything on the server.
        let mut source = source(device.rate)?;
        let channels = device.channels as usize;
        let frames = (device.rate / 100).max(1) as usize;
        let attr = BufferAttr {
            maxlength: u32::MAX,
            // ~50 ms of queued audio: low latency without underruns.
            tlength: (frames * 5 * channels * SAMPLE_BYTES) as u32,
            prebuf: u32::MAX,
            minreq: u32::MAX,
            fragsize: u32::MAX,
        };
        let simple = open(device, StreamDirection::Playback, "Teste de saída", &attr)
            .map_err(|error| format!("Não foi possível abrir a saída de áudio: {error}"))?;
        PulseStream::spawn("disc-audio-output", move |stop| {
            let mut bytes = Vec::with_capacity(frames * channels * SAMPLE_BYTES);
            while !stop.load(Ordering::Relaxed) {
                bytes.clear();
                for _ in 0..frames {
                    // Same mono signal on every channel, as on Windows.
                    let sample = source.next_frame().to_ne_bytes();
                    for _ in 0..channels {
                        bytes.extend_from_slice(&sample);
                    }
                }
                if let Err(error) = simple.write(&bytes) {
                    errors.report(format!("{error}"));
                    return;
                }
                if source.finished() {
                    // Wait until the server played everything, so the end of
                    // the recording is not cut when the worker drops the stream.
                    if let Err(error) = simple.drain() {
                        errors.report(format!("{error}"));
                    }
                    source.end_buffer();
                    return;
                }
            }
        })
    }
}

fn open(
    device: &PulseDevice,
    direction: StreamDirection,
    stream_name: &str,
    attr: &BufferAttr,
) -> Result<Simple, String> {
    let spec = Spec {
        format: Format::FLOAT32NE,
        rate: device.rate,
        channels: device.channels,
    };
    if !spec.is_valid() {
        return Err(format!(
            "formato inválido ({} Hz, {} canais)",
            device.rate, device.channels
        ));
    }
    Simple::new(
        None,
        APP_NAME,
        direction,
        Some(&device.name),
        stream_name,
        &spec,
        None,
        Some(attr),
    )
    .map_err(|error| format!("{error}"))
}

/// A stream thread. Dropping it asks the thread to stop and waits briefly;
/// the thread owns the `pa_simple` connection and closes it on exit.
pub struct PulseStream {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl PulseStream {
    fn spawn(
        name: &str,
        run: impl FnOnce(Arc<AtomicBool>) + Send + 'static,
    ) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let thread = thread::Builder::new()
            .name(name.into())
            .spawn(move || run(flag))
            .map_err(|error| error.to_string())?;
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}

impl Drop for PulseStream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let Some(thread) = self.thread.take() else {
            return;
        };
        // A blocked read/write returns within one buffer (~20-50 ms). If the
        // server stalls, detach instead of freezing the worker; the thread
        // still exits and closes its connection once the call returns.
        let deadline = Instant::now() + Duration::from_millis(300);
        while !thread.is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(2));
        }
        if thread.is_finished() {
            let _ = thread.join();
        }
    }
}

/// Needs a running PulseAudio/PipeWire server and a null sink, so it never
/// touches real speakers or microphones:
///
/// ```sh
/// pactl load-module module-null-sink sink_name=disc_voice_test
/// cargo test -p disc-audio -- --ignored pulse
/// pactl unload-module module-null-sink
/// ```
#[cfg(test)]
mod tests {
    use super::*;
    use crate::signal::{Playback, Recording};
    use std::sync::{atomic::AtomicU32, mpsc, Mutex};

    const TEST_SINK: &str = "disc_voice_test";

    fn test_sink(backend: &mut PulseBackend) -> PulseDevice {
        backend
            .devices(Direction::Output)
            .unwrap()
            .into_iter()
            .find(|found| found.device.name == TEST_SINK)
            .expect("load module-null-sink sink_name=disc_voice_test first")
            .device
    }

    #[test]
    #[ignore = "needs a PulseAudio/PipeWire server with the disc_voice_test null sink"]
    fn pulse_loopback_through_null_sink() {
        let mut backend = PulseBackend::new().unwrap();
        let sink = test_sink(&mut backend);
        let inputs = backend.devices(Direction::Input).unwrap();
        assert!(
            inputs
                .iter()
                .all(|found| !found.device.name.ends_with(".monitor")),
            "monitor sources must not be listed as microphones"
        );

        let (sender, receiver) = mpsc::sync_channel(8);
        let errors = |direction| ErrorSink {
            sender: sender.clone(),
            direction,
        };
        let monitor = PulseDevice {
            name: format!("{TEST_SINK}.monitor"),
            rate: sink.rate,
            channels: sink.channels,
        };
        let recording = Arc::new(Mutex::new(Recording::new(monitor.rate)));
        let peak = Arc::new(AtomicU32::new(0));
        let input = backend
            .open_input(
                &monitor,
                |_| InputSink {
                    recording: recording.clone(),
                    peak: peak.clone(),
                },
                errors(Direction::Input),
            )
            .unwrap();

        let finished = Arc::new(AtomicBool::new(false));
        let started = Instant::now();
        let output = backend
            .open_output(
                &sink,
                |rate| {
                    Ok(OutputSource {
                        playback: Playback::tone(rate, 1.0),
                        finished: finished.clone(),
                    })
                },
                errors(Direction::Output),
            )
            .unwrap();
        while !finished.load(Ordering::Relaxed) {
            assert!(
                started.elapsed() < Duration::from_secs(6),
                "playback never finished"
            );
            thread::sleep(Duration::from_millis(20));
        }
        // Drain means the server consumed the whole 3 s tone.
        assert!(started.elapsed() >= Duration::from_millis(2_900));
        drop(output);
        drop(input);

        assert!(receiver.try_recv().is_err(), "stream reported an error");
        let recording = recording.lock().unwrap();
        assert!(
            recording.seconds() > 2.0,
            "captured {} s",
            recording.seconds()
        );
        let loudest = recording
            .samples
            .iter()
            .fold(0.0_f32, |max, sample| max.max(sample.abs()));
        // The tone is a 0.2 amplitude sine at full volume.
        assert!((0.15..=0.25).contains(&loudest), "loudest sample {loudest}");
        assert!(f32::from_bits(peak.load(Ordering::Relaxed)) > 0.0);
    }

    #[test]
    #[ignore = "needs a PulseAudio/PipeWire server with the disc_voice_test null sink"]
    fn pulse_stream_stops_promptly_on_drop() {
        let mut backend = PulseBackend::new().unwrap();
        let sink = test_sink(&mut backend);
        let (sender, _receiver) = mpsc::sync_channel(8);
        let output = backend
            .open_output(
                &sink,
                |rate| {
                    Ok(OutputSource {
                        playback: Playback::tone(rate, 0.5),
                        finished: Arc::new(AtomicBool::new(false)),
                    })
                },
                ErrorSink {
                    sender,
                    direction: Direction::Output,
                },
            )
            .unwrap();
        thread::sleep(Duration::from_millis(200));
        let stopping = Instant::now();
        drop(output);
        assert!(stopping.elapsed() < Duration::from_millis(300));
    }
}
