//! System audio on Linux, over the PulseAudio client API (PipeWire's
//! `pipewire-pulse` included).
//!
//! A sink's monitor carries everything it plays, our call included. So we
//! record each playback stream (sink input) of other processes on its own,
//! with `pa_stream_set_monitor_stream`, and mix them. New and closed streams
//! are followed through server events. Everything runs on one thread, with
//! a standard (non-threaded) mainloop: callbacks only queue events.

use crate::system::{parent_from_stat, ChunkSink, Mixer, CHANNELS, CHUNK_SAMPLES, RATE};
use libpulse_binding::{
    callbacks::ListResult,
    context::{
        introspect::{SinkInfo, SinkInputInfo},
        subscribe::{Facility, InterestMaskSet, Operation as Change},
        Context, FlagSet as ContextFlags, State as ContextState,
    },
    def::BufferAttr,
    mainloop::standard::{IterateResult, Mainloop},
    sample::{Format, Spec},
    stream::{FlagSet as StreamFlags, PeekResult, State as StreamState, Stream},
};
use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
    rc::Rc,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const APP_NAME: &str = "Disc Voice";
const UNAVAILABLE: &str = "Não foi possível capturar o áudio do computador: o servidor de áudio \
                           (PipeWire/PulseAudio) não está disponível. A tela será compartilhada sem áudio.";
const SERVER_TIMEOUT: Duration = Duration::from_secs(3);
const POLL: Duration = Duration::from_millis(5);
const SAMPLE_BYTES: usize = std::mem::size_of::<f32>();
const PROCESS_ID: &str = "application.process.id";

enum Event {
    /// A sink input appeared or changed: look it up.
    Query(u32),
    Input {
        index: u32,
        sink: u32,
        pid: Option<u32>,
    },
    Removed(u32),
    Monitor {
        sink: u32,
        source: String,
    },
}

type Events = Rc<RefCell<VecDeque<Event>>>;

/// Whether `pid` is this process or one it started (WebKit's web process
/// plays the notification sounds).
fn ours(pid: Option<u32>) -> bool {
    let Some(mut pid) = pid else {
        return false;
    };
    let me = std::process::id();
    for _ in 0..32 {
        if pid == me {
            return true;
        }
        match std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .as_deref()
            .and_then(parent_from_stat)
        {
            Some(parent) if parent > 1 => pid = parent,
            _ => return false,
        }
    }
    false
}

fn input_event(info: &SinkInputInfo) -> Event {
    Event::Input {
        index: info.index,
        sink: info.sink,
        pid: info
            .proplist
            .get_str(PROCESS_ID)
            .and_then(|pid| pid.trim().parse().ok()),
    }
}

fn open_stream(context: &mut Context, input: u32, monitor: &str) -> Option<Stream> {
    let spec = Spec {
        format: Format::FLOAT32NE,
        rate: RATE,
        channels: CHANNELS as u8,
    };
    let mut stream = Stream::new(context, "Áudio compartilhado com a tela", &spec, None)?;
    stream.set_monitor_stream(input).ok()?;
    let attr = BufferAttr {
        maxlength: u32::MAX,
        tlength: u32::MAX,
        prebuf: u32::MAX,
        minreq: u32::MAX,
        fragsize: (CHUNK_SAMPLES * SAMPLE_BYTES) as u32,
    };
    // A stream that moves to another sink fails here and is opened again
    // on the new sink by its change event.
    stream
        .connect_record(
            Some(monitor),
            Some(&attr),
            StreamFlags::ADJUST_LATENCY | StreamFlags::DONT_MOVE,
        )
        .ok()?;
    Some(stream)
}

struct Recorded {
    stream: Stream,
    sink: u32,
}

impl Drop for Recorded {
    fn drop(&mut self) {
        let _ = self.stream.disconnect();
    }
}

/// Fields drop in order: streams, then the context, then its mainloop.
struct Session {
    streams: HashMap<u32, Recorded>,
    context: Context,
    mainloop: Mainloop,
    events: Events,
    monitors: HashMap<u32, String>,
    /// Sink inputs waiting for their sink's monitor name.
    waiting: Vec<(u32, u32)>,
    mixer: Mixer,
    bytes: Vec<f32>,
}

impl Session {
    fn connect() -> Result<Self, String> {
        let mut mainloop = Mainloop::new().ok_or(UNAVAILABLE)?;
        let mut context = Context::new(&mainloop, APP_NAME).ok_or(UNAVAILABLE)?;
        context
            .connect(None, ContextFlags::NOAUTOSPAWN, None)
            .map_err(|_| UNAVAILABLE)?;
        let deadline = Instant::now() + SERVER_TIMEOUT;
        loop {
            match context.get_state() {
                ContextState::Ready => break,
                ContextState::Failed | ContextState::Terminated => return Err(UNAVAILABLE.into()),
                _ => {}
            }
            match mainloop.iterate(false) {
                IterateResult::Success(0) => thread::sleep(Duration::from_millis(1)),
                IterateResult::Success(_) => {}
                IterateResult::Quit(_) | IterateResult::Err(_) => return Err(UNAVAILABLE.into()),
            }
            if Instant::now() >= deadline {
                return Err(UNAVAILABLE.into());
            }
        }
        let events: Events = Rc::default();
        let queue = events.clone();
        context.set_subscribe_callback(Some(Box::new(move |facility, change, index| {
            if facility != Some(Facility::SinkInput) {
                return;
            }
            let event = match change {
                Some(Change::New) | Some(Change::Changed) => Event::Query(index),
                Some(Change::Removed) => Event::Removed(index),
                None => return,
            };
            queue.borrow_mut().push_back(event);
        })));
        context.subscribe(InterestMaskSet::SINK_INPUT, |_| {});
        let queue = events.clone();
        context
            .introspect()
            .get_sink_input_info_list(move |result| {
                if let ListResult::Item(info) = result {
                    queue.borrow_mut().push_back(input_event(info));
                }
            });
        Ok(Self {
            mainloop,
            context,
            events,
            monitors: HashMap::new(),
            waiting: Vec::new(),
            streams: HashMap::new(),
            mixer: Mixer::new(Instant::now()),
            bytes: Vec::with_capacity(CHUNK_SAMPLES * 4),
        })
    }

    fn record(&mut self, index: u32, sink: u32) {
        let Some(monitor) = self.monitors.get(&sink).cloned() else {
            self.waiting.push((index, sink));
            let queue = self.events.clone();
            self.context.introspect().get_sink_info_by_index(
                sink,
                move |result: ListResult<&SinkInfo>| {
                    if let ListResult::Item(info) = result {
                        if let Some(source) = &info.monitor_source_name {
                            queue.borrow_mut().push_back(Event::Monitor {
                                sink: info.index,
                                source: source.to_string(),
                            });
                        }
                    }
                },
            );
            return;
        };
        self.streams.remove(&index);
        self.mixer.remove(index);
        if let Some(stream) = open_stream(&mut self.context, index, &monitor) {
            self.streams.insert(index, Recorded { stream, sink });
        }
    }

    fn handle(&mut self) {
        loop {
            let Some(event) = self.events.borrow_mut().pop_front() else {
                return;
            };
            match event {
                Event::Query(index) => {
                    let queue = self.events.clone();
                    self.context
                        .introspect()
                        .get_sink_input_info(index, move |result| {
                            if let ListResult::Item(info) = result {
                                queue.borrow_mut().push_back(input_event(info));
                            }
                        });
                }
                Event::Input { index, sink, pid } => {
                    if ours(pid) {
                        continue;
                    }
                    if self
                        .streams
                        .get(&index)
                        .is_some_and(|recorded| recorded.sink == sink)
                    {
                        continue;
                    }
                    self.record(index, sink);
                }
                Event::Removed(index) => {
                    self.streams.remove(&index);
                    self.mixer.remove(index);
                    self.waiting.retain(|&(input, _)| input != index);
                }
                Event::Monitor { sink, source } => {
                    self.monitors.insert(sink, source);
                    let ready: Vec<_> = self
                        .waiting
                        .iter()
                        .copied()
                        .filter(|&(_, waiting)| waiting == sink)
                        .collect();
                    self.waiting.retain(|&(_, waiting)| waiting != sink);
                    for (index, sink) in ready {
                        self.record(index, sink);
                    }
                }
            }
        }
    }

    /// Moves what every stream recorded into the mixer.
    fn read(&mut self) {
        let mut broken = Vec::new();
        for (&index, recorded) in &mut self.streams {
            match recorded.stream.get_state() {
                StreamState::Ready => {}
                StreamState::Failed | StreamState::Terminated => {
                    broken.push(index);
                    continue;
                }
                _ => continue,
            }
            loop {
                match recorded.stream.peek() {
                    Ok(PeekResult::Data(data)) => {
                        self.bytes.clear();
                        self.bytes
                            .extend(data.chunks_exact(SAMPLE_BYTES).map(|sample| {
                                f32::from_ne_bytes(sample.try_into().expect("4-byte chunk"))
                            }));
                        self.mixer.push(index, &self.bytes);
                        let _ = recorded.stream.discard();
                    }
                    Ok(PeekResult::Hole(_)) => {
                        let _ = recorded.stream.discard();
                    }
                    Ok(PeekResult::Empty) | Err(_) => break,
                }
            }
        }
        for index in broken {
            self.streams.remove(&index);
            self.mixer.remove(index);
        }
    }

    fn run(mut self, mut sink: ChunkSink, stop: &AtomicBool) {
        self.mixer = Mixer::new(Instant::now());
        while !stop.load(Ordering::Relaxed) {
            let busy = match self.mainloop.iterate(false) {
                IterateResult::Success(dispatched) => dispatched > 0,
                IterateResult::Quit(_) | IterateResult::Err(_) => break,
            };
            if !matches!(self.context.get_state(), ContextState::Ready) {
                break;
            }
            self.handle();
            self.read();
            self.mixer.tick(Instant::now(), &mut sink);
            if !busy {
                thread::sleep(POLL);
            }
        }
        self.streams.clear();
        self.context.disconnect();
    }
}

pub(crate) struct Capture {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Capture {
    pub fn start(sink: ChunkSink) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let (ready, started) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("disc-system-audio".into())
            .spawn(move || match Session::connect() {
                Ok(session) => {
                    let _ = ready.send(Ok(()));
                    session.run(sink, &flag);
                }
                Err(error) => {
                    let _ = ready.send(Err(error));
                }
            })
            .map_err(|error| error.to_string())?;
        match started.recv() {
            Ok(Ok(())) => Ok(Self {
                stop,
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => Err(UNAVAILABLE.into()),
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
