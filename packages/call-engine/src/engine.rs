//! The engine the app manages: at most one call at a time, driven by the UI.

use crate::{
    audio::{Capture, Levels, Mixer, Playback},
    frames::Frames,
    hub::{EncodedFrame, MediaHub},
    peer::{self, PeerCommand, PeerHandle},
    video::ScreenSender,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{sync::mpsc, task::JoinHandle};
use webrtc::peer_connection::RTCIceServer;

/// How often the speaking indicators are recomputed (as in the browser).
const SPEAKING_INTERVAL: Duration = Duration::from_millis(150);

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum IceUrls {
    One(String),
    Many(Vec<String>),
}

/// An `RTCIceServer` as the API sends it to the clients.
#[derive(Clone, Debug, Deserialize)]
pub struct IceServer {
    pub urls: IceUrls,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallConfig {
    pub ice_servers: Vec<IceServer>,
    /// PulseAudio source name; empty for the system default.
    #[serde(default)]
    pub input_id: String,
    /// PulseAudio sink name; empty for the system default.
    #[serde(default)]
    pub output_id: String,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub deafened: bool,
}

/// What the engine tells the UI. Peer IDs are the API's call peer IDs.
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CallEvent {
    /// To relay as `voice.signal`: `{ description }` or `{ candidate }`,
    /// in the browser's JSON format.
    Signal {
        peer_id: String,
        data: serde_json::Value,
    },
    /// `RTCPeerConnectionState` of one peer, as the browser names it.
    PeerState { peer_id: String, state: String },
    /// Who is speaking now; includes our own peer ID while unmuted.
    Speaking { peer_ids: Vec<String> },
    /// A peer's screen started (first picture decoded) or ended.
    Screen { peer_id: String, active: bool },
    /// Our screen capture ended by itself (stopped from the system UI...).
    ScreenEnded { message: String },
    /// The call cannot go on (the microphone or speakers failed...).
    Error { message: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct CallDevices {
    pub inputs: Vec<CallDevice>,
    pub outputs: Vec<CallDevice>,
}

pub type EventSink = Arc<dyn Fn(CallEvent) + Send + Sync>;
/// Pulls the next raw (I420) frame of the screen being shared, waiting at
/// most the given time (`None`: no new frame). An error means the capture
/// ended. Our own preview is drawn by the UI from the capture's JPEGs.
pub type FrameSource =
    Box<dyn FnMut(Duration) -> Result<Option<Arc<disc_video::RawFrame>>, String> + Send>;

/// State shared by everything that runs for one call.
pub(crate) struct Shared {
    alive: AtomicBool,
    events: EventSink,
    pub hub: MediaHub,
    pub mixer: Mixer,
    pub levels: Levels,
    pub frames: Frames,
    /// Set when a new peer connects: the next screen frame is a keyframe.
    pub keyframe: AtomicBool,
    pub muted: AtomicBool,
    pub deafened: AtomicBool,
}

impl Shared {
    pub fn emit(&self, event: CallEvent) {
        if self.alive.load(Ordering::Acquire) {
            (self.events)(event);
        }
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    /// A call without audio devices, for tests of the network side.
    #[cfg(test)]
    pub fn detached(events: EventSink) -> Arc<Self> {
        Arc::new(Self {
            alive: AtomicBool::new(true),
            events,
            hub: MediaHub::default(),
            mixer: Mixer::default(),
            levels: Levels::default(),
            frames: Frames::default(),
            keyframe: AtomicBool::new(true),
            muted: AtomicBool::new(false),
            deafened: AtomicBool::new(false),
        })
    }
}

struct Session {
    id: u64,
    shared: Arc<Shared>,
    ice_servers: Vec<RTCIceServer>,
    self_id: String,
    peers: HashMap<String, PeerHandle>,
    encoded: mpsc::UnboundedSender<EncodedFrame>,
    capture: Option<Capture>,
    playback: Option<Playback>,
    screen: Option<ScreenSender>,
    tasks: Vec<JoinHandle<()>>,
}

impl Session {
    fn close(mut self) {
        self.shared.alive.store(false, Ordering::Release);
        // Stopping the threads first keeps them from feeding closing peers.
        self.screen = None;
        self.capture = None;
        self.playback = None;
        for (_, peer) in self.peers.drain() {
            peer.send(PeerCommand::Close);
        }
        for task in self.tasks.drain(..) {
            task.abort();
        }
        self.shared.frames.clear();
    }
}

struct Inner {
    runtime: tokio::runtime::Runtime,
    session: Mutex<Option<Session>>,
    next_id: AtomicU64,
}

/// Cheap to clone; every clone drives the same call.
#[derive(Clone)]
pub struct CallEngine {
    inner: Arc<Inner>,
}

impl CallEngine {
    pub fn new() -> Result<Self, String> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("disc-call")
            .enable_all()
            .build()
            .map_err(|error| format!("Não foi possível iniciar o motor de chamadas: {error}"))?;
        Ok(Self {
            inner: Arc::new(Inner {
                runtime,
                session: Mutex::new(None),
                next_id: AtomicU64::new(1),
            }),
        })
    }

    fn session(&self) -> std::sync::MutexGuard<'_, Option<Session>> {
        self.inner
            .session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Opens the microphone and speakers for a new call, ending any previous
    /// one. Returns the call's ID, for [`CallEngine::leave`].
    pub fn join(&self, config: CallConfig, events: EventSink) -> Result<u64, String> {
        self.leave(None);
        let shared = Arc::new(Shared {
            alive: AtomicBool::new(true),
            events,
            hub: MediaHub::default(),
            mixer: Mixer::default(),
            levels: Levels::default(),
            frames: Frames::default(),
            keyframe: AtomicBool::new(true),
            muted: AtomicBool::new(config.muted || config.deafened),
            deafened: AtomicBool::new(config.deafened),
        });
        let (encoded, frames) = mpsc::unbounded_channel();
        let capture = Capture::start(&config.input_id, shared.clone(), encoded.clone())?;
        let playback = Playback::start(&config.output_id, shared.clone())?;
        let _guard = self.inner.runtime.enter();
        let tasks = vec![
            tokio::spawn(shared.hub.clone().run(frames)),
            tokio::spawn(speaking(shared.clone())),
        ];
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        *self.session() = Some(Session {
            id,
            shared,
            ice_servers: config.ice_servers.iter().map(ice_server).collect(),
            self_id: String::new(),
            peers: HashMap::new(),
            encoded,
            capture: Some(capture),
            playback: Some(playback),
            screen: None,
            tasks,
        });
        Ok(id)
    }

    /// Ends the call `id` (any call when `None`). A late `leave` from an
    /// abandoned join never ends the call that replaced it.
    pub fn leave(&self, id: Option<u64>) {
        let session = {
            let mut current = self.session();
            match &*current {
                Some(session) if id.is_none_or(|id| id == session.id) => current.take(),
                _ => None,
            }
        };
        if let Some(session) = session {
            let _guard = self.inner.runtime.enter();
            session.close();
        }
    }

    /// Connects to exactly these peers (everyone else in the call).
    pub fn set_peers(&self, self_id: &str, peer_ids: &[String]) {
        let mut current = self.session();
        let Some(session) = current.as_mut() else {
            return;
        };
        let _guard = self.inner.runtime.enter();
        if session.self_id != self_id {
            // A new call peer ID: every connection belongs to the old one.
            for (_, peer) in session.peers.drain() {
                peer.send(PeerCommand::Close);
            }
            session.self_id = self_id.to_owned();
            session.shared.levels.set_local(self_id);
        }
        let wanted: HashSet<&str> = peer_ids.iter().map(String::as_str).collect();
        session.peers.retain(|id, peer| {
            let keep = wanted.contains(id.as_str());
            if !keep {
                peer.send(PeerCommand::Close);
            }
            keep
        });
        for id in peer_ids {
            if id == self_id || session.peers.contains_key(id) {
                continue;
            }
            let peer = peer::spawn(
                id.clone(),
                self_id.to_owned(),
                session.ice_servers.clone(),
                session.shared.clone(),
            );
            session.peers.insert(id.clone(), peer);
        }
    }

    /// A `voice.signal` payload a peer sent us.
    pub fn signal(&self, peer_id: &str, data: serde_json::Value) {
        if let Some(peer) = self
            .session()
            .as_ref()
            .and_then(|session| session.peers.get(peer_id))
        {
            peer.send(PeerCommand::Remote(data));
        }
    }

    pub fn set_muted(&self, muted: bool) {
        if let Some(session) = &*self.session() {
            session.shared.muted.store(muted, Ordering::Relaxed);
        }
    }

    pub fn set_deafened(&self, deafened: bool) {
        if let Some(session) = &*self.session() {
            session.shared.deafened.store(deafened, Ordering::Relaxed);
            if deafened {
                session.shared.mixer.clear();
            }
        }
    }

    /// Switches the microphone; the previous one keeps working on failure.
    pub fn set_input(&self, input_id: &str) -> Result<(), String> {
        let mut current = self.session();
        let Some(session) = current.as_mut() else {
            return Ok(());
        };
        let capture = Capture::start(input_id, session.shared.clone(), session.encoded.clone())?;
        session.capture = Some(capture);
        Ok(())
    }

    /// Switches the speakers; the previous ones keep working on failure.
    pub fn set_output(&self, output_id: &str) -> Result<(), String> {
        let mut current = self.session();
        let Some(session) = current.as_mut() else {
            return Ok(());
        };
        let playback = Playback::start(output_id, session.shared.clone())?;
        session.playback = Some(playback);
        Ok(())
    }

    /// Sends the frames of `source` to everyone in the call.
    pub fn start_screen(&self, source: FrameSource, frame_rate: u32) -> Result<(), String> {
        let mut current = self.session();
        let session = current
            .as_mut()
            .ok_or("Entre em um canal de voz para compartilhar a tela.")?;
        session.screen = None;
        session.shared.keyframe.store(true, Ordering::Relaxed);
        session.screen = Some(ScreenSender::start(
            source,
            frame_rate,
            session.shared.clone(),
            session.encoded.clone(),
        )?);
        Ok(())
    }

    pub fn stop_screen(&self) {
        if let Some(session) = self.session().as_mut() {
            session.screen = None;
        }
    }

    /// The next picture of a peer's screen as JPEG. `None` when no new one
    /// arrived in time.
    pub fn screen_frame(&self, peer_id: &str, timeout: Duration) -> Option<Vec<u8>> {
        let shared = self.session().as_ref()?.shared.clone();
        shared.frames.next(peer_id, timeout)
    }

    /// Microphones and speakers, identified by their PulseAudio names.
    pub fn devices(&self) -> Result<CallDevices, String> {
        use disc_audio::backend::{Backend, Direction};
        let mut backend = disc_audio::PulseBackend::new()?;
        let list = |backend: &mut disc_audio::PulseBackend, direction| {
            backend.devices(direction).map(|devices| {
                devices
                    .into_iter()
                    .map(|found| CallDevice {
                        id: found.device.name().to_owned(),
                        name: found.name,
                        is_default: found.is_default,
                    })
                    .collect()
            })
        };
        Ok(CallDevices {
            inputs: list(&mut backend, Direction::Input)?,
            outputs: list(&mut backend, Direction::Output)?,
        })
    }

    /// Ends the call; for the app's shutdown.
    pub fn shutdown(&self) {
        self.leave(None);
    }
}

fn ice_server(server: &IceServer) -> RTCIceServer {
    RTCIceServer {
        urls: match &server.urls {
            IceUrls::One(url) => vec![url.clone()],
            IceUrls::Many(urls) => urls.clone(),
        },
        username: server.username.clone().unwrap_or_default(),
        credential: server.credential.clone().unwrap_or_default(),
    }
}

async fn speaking(shared: Arc<Shared>) {
    let mut interval = tokio::time::interval(SPEAKING_INTERVAL);
    let mut previous: Vec<String> = Vec::new();
    loop {
        interval.tick().await;
        let muted = shared.muted.load(Ordering::Relaxed);
        let now = shared.levels.speaking(muted);
        if now != previous {
            shared.emit(CallEvent::Speaking {
                peer_ids: now.clone(),
            });
            previous = now;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_accepts_the_browser_ice_server_shapes() {
        let config: CallConfig = serde_json::from_value(serde_json::json!({
            "iceServers": [
                { "urls": "stun:stun.example.com:3478" },
                { "urls": ["turn:turn.example.com:3478?transport=udp"], "username": "u", "credential": "c" }
            ],
            "inputId": "alsa_input.usb",
            "muted": true
        }))
        .unwrap();
        let servers: Vec<RTCIceServer> = config.ice_servers.iter().map(ice_server).collect();
        assert_eq!(servers[0].urls, ["stun:stun.example.com:3478"]);
        assert_eq!(servers[1].username, "u");
        assert_eq!(servers[1].credential, "c");
        assert_eq!(config.input_id, "alsa_input.usb");
        assert_eq!(config.output_id, "");
        assert!(config.muted && !config.deafened);
    }

    #[test]
    fn events_use_the_ui_names() {
        let event = serde_json::to_value(CallEvent::PeerState {
            peer_id: "p1".into(),
            state: "connected".into(),
        })
        .unwrap();
        assert_eq!(
            event,
            serde_json::json!({ "type": "peerState", "peerId": "p1", "state": "connected" })
        );
        let event = serde_json::to_value(CallEvent::Speaking {
            peer_ids: vec!["p1".into()],
        })
        .unwrap();
        assert_eq!(
            event,
            serde_json::json!({ "type": "speaking", "peerIds": ["p1"] })
        );
    }
}
