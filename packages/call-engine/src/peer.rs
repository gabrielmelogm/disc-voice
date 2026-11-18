//! One WebRTC connection per participant. Negotiation mirrors the browser
//! client (`voice.ts`), so both kinds of peers agree on who does what:
//!
//! - the peer with the smaller ID makes the first offer;
//! - later renegotiations (a screen being added) may come from either side,
//!   and a collision is settled by "perfect negotiation": the peer with the
//!   larger ID is polite and rolls its own offer back.
//!
//! Every connection carries our audio and a video track from the start. The
//! video track is only written to while we share the screen, so starting and
//! stopping never needs a renegotiation from this side.

use crate::{
    audio::Decoder,
    engine::{CallEvent, Shared},
    hub::{PeerSinks, Sink},
    keyframes::{asks_keyframe, KeyframeRequests},
    video,
};
use rtc::{
    interceptor::Slot,
    media_stream::MediaStreamTrack,
    peer_connection::transport::RTCDtlsRole,
    rtp_transceiver::rtp_sender::{
        RTCPFeedback, RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters,
        RTCRtpEncodingParameters, RtpCodecKind,
    },
};
use serde_json::{json, Value};
use std::{
    collections::hash_map::RandomState,
    hash::BuildHasher,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Instant,
};
use tokio::{
    sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender},
    task::JoinHandle,
};
use webrtc::{
    media_stream::{
        track_local::{static_sample::TrackLocalStaticSample, TrackLocal, TrackLocalEvent},
        track_remote::{TrackRemote, TrackRemoteEvent},
    },
    peer_connection::{
        register_default_interceptors, MediaEngine, PeerConnection, PeerConnectionBuilder,
        PeerConnectionEventHandler, RTCConfigurationBuilder, RTCIceCandidateInit, RTCIceServer,
        RTCPeerConnectionIceEvent, RTCPeerConnectionState, RTCSdpType, RTCSessionDescription,
        Registry, SettingEngineBuilder,
    },
    rtp_transceiver::RtpSender,
};

const MIME_OPUS: &str = "audio/opus";
const MIME_H264: &str = "video/H264";
/// Constrained Baseline, what every browser decodes (and OpenH264 makes).
const H264_FMTP: &str = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f";

pub(crate) enum PeerCommand {
    /// A `voice.signal` payload from the peer.
    Remote(Value),
    NegotiationNeeded,
    LocalCandidate(RTCIceCandidateInit),
    State(RTCPeerConnectionState),
    Track(Arc<dyn TrackRemote>),
    Close,
}

pub(crate) struct PeerHandle {
    commands: UnboundedSender<PeerCommand>,
}

impl PeerHandle {
    pub fn send(&self, command: PeerCommand) {
        let _ = self.commands.send(command);
    }
}

/// Starts the connection's task; must be called inside the engine's runtime.
pub(crate) fn spawn(
    id: String,
    self_id: String,
    ice_servers: Vec<RTCIceServer>,
    shared: Arc<Shared>,
) -> PeerHandle {
    let (commands, receiver) = unbounded_channel();
    tokio::spawn(run(
        id,
        self_id,
        ice_servers,
        shared,
        commands.clone(),
        receiver,
    ));
    PeerHandle { commands }
}

fn opus() -> RTCRtpCodec {
    RTCRtpCodec {
        mime_type: MIME_OPUS.to_owned(),
        clock_rate: 48_000,
        channels: 2,
        sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
        rtcp_feedback: vec![],
    }
}

fn h264() -> RTCRtpCodec {
    let feedback = |typ: &str, parameter: &str| RTCPFeedback {
        typ: typ.to_owned(),
        parameter: parameter.to_owned(),
    };
    RTCRtpCodec {
        mime_type: MIME_H264.to_owned(),
        clock_rate: 90_000,
        channels: 0,
        sdp_fmtp_line: H264_FMTP.to_owned(),
        rtcp_feedback: vec![
            feedback("nack", ""),
            feedback("nack", "pli"),
            feedback("ccm", "fir"),
        ],
    }
}

/// Forwards the connection's events to its task.
struct Handler {
    commands: UnboundedSender<PeerCommand>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_negotiation_needed(&self) {
        let _ = self.commands.send(PeerCommand::NegotiationNeeded);
    }

    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Ok(candidate) = event.candidate.to_json() {
            let _ = self.commands.send(PeerCommand::LocalCandidate(candidate));
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        let _ = self.commands.send(PeerCommand::State(state));
    }

    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        let _ = self.commands.send(PeerCommand::Track(track));
    }
}

struct LocalTrack {
    track: Arc<TrackLocalStaticSample>,
    ssrc: u32,
    sender: Arc<dyn RtpSender>,
}

impl LocalTrack {
    /// Where to write, once the peer agreed on a payload type.
    async fn sink(&self) -> Option<Sink> {
        let parameters = self.sender.get_parameters().await.ok()?;
        let payload_type = parameters.rtp_parameters.codecs.first()?.payload_type;
        Some(Sink {
            track: self.track.clone(),
            ssrc: self.ssrc,
            payload_type,
        })
    }
}

fn ssrc() -> u32 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let random = RandomState::new().hash_one(COUNTER.fetch_add(1, Ordering::Relaxed));
    (random as u32).max(1)
}

async fn add_track(
    pc: &Arc<dyn PeerConnection>,
    kind: RtpCodecKind,
    stream: &str,
    codec: RTCRtpCodec,
) -> webrtc::error::Result<LocalTrack> {
    let ssrc = ssrc();
    let track = Arc::new(TrackLocalStaticSample::new(
        Instant::now(),
        MediaStreamTrack::new(
            stream.to_owned(),
            format!("{stream}-track"),
            stream.to_owned(),
            kind,
            vec![RTCRtpEncodingParameters {
                rtp_coding_parameters: RTCRtpCodingParameters {
                    ssrc: Some(ssrc),
                    ..Default::default()
                },
                codec,
                ..Default::default()
            }],
        ),
    )?);
    let sender = pc.add_track(track.clone() as Arc<dyn TrackLocal>).await?;
    Ok(LocalTrack {
        track,
        ssrc,
        sender,
    })
}

struct Connection {
    pc: Arc<dyn PeerConnection>,
    audio: LocalTrack,
    screen: LocalTrack,
}

async fn connect(
    ice_servers: Vec<RTCIceServer>,
    commands: UnboundedSender<PeerCommand>,
) -> webrtc::error::Result<Connection> {
    let mut media = MediaEngine::default();
    media.register_codec(
        RTCRtpCodecParameters {
            rtp_codec: opus(),
            payload_type: 111,
        },
        RtpCodecKind::Audio,
    )?;
    media.register_codec(
        RTCRtpCodecParameters {
            rtp_codec: h264(),
            payload_type: 102,
        },
        RtpCodecKind::Video,
    )?;
    // Closest to the application: it only marks PLI/FIR so they reach our
    // track's events (see `keyframes`).
    let registry = register_default_interceptors(Registry::new(), &mut media)?
        .with(Slot::from(14_000), KeyframeRequests::default());
    let configuration = RTCConfigurationBuilder::new()
        .with_ice_servers(ice_servers)
        .build();
    // webrtc-rs answers every offer with its configured DTLS role, ignoring
    // the one the first exchange settled (browsers then reject the answer:
    // "Failed to set SSL role"). As the server we never change roles with
    // browsers, which always take the client role when they can; between
    // two native peers only the initial offerer restarts ICE (see `state`).
    let settings = SettingEngineBuilder::new()
        .with_answering_dtls_role(RTCDtlsRole::Server)
        .build();
    let pc = PeerConnectionBuilder::new()
        .with_configuration(configuration)
        .with_setting_engine(settings)
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .with_handler(Arc::new(Handler { commands }))
        .with_udp_addrs(vec!["0.0.0.0:0".to_owned()])
        .build()
        .await?;
    let pc: Arc<dyn PeerConnection> = Arc::new(pc);
    let audio = add_track(&pc, RtpCodecKind::Audio, "disc-call-audio", opus()).await?;
    let screen = add_track(&pc, RtpCodecKind::Video, "disc-call-screen", h264()).await?;
    Ok(Connection { pc, audio, screen })
}

fn state_name(state: RTCPeerConnectionState) -> &'static str {
    match state {
        RTCPeerConnectionState::New => "new",
        RTCPeerConnectionState::Connecting => "connecting",
        RTCPeerConnectionState::Connected => "connected",
        RTCPeerConnectionState::Disconnected => "disconnected",
        RTCPeerConnectionState::Failed => "failed",
        RTCPeerConnectionState::Closed => "closed",
        _ => "new",
    }
}

/// Whether a local description already sends both of our tracks.
fn carries_our_tracks(sdp: &str) -> bool {
    ["disc-call-audio", "disc-call-screen"]
        .iter()
        .all(|stream| sdp.contains(&format!("a=msid:{stream} ")))
}

/// The ICE username fragment a session description uses.
fn ufrag(sdp: &str) -> Option<&str> {
    sdp.lines()
        .find_map(|line| line.trim_end().strip_prefix("a=ice-ufrag:"))
}

struct Peer {
    id: String,
    shared: Arc<Shared>,
    conn: Connection,
    /// Larger ID: waits for the first offer and yields on collisions.
    polite: bool,
    /// Our offer is out, waiting for the answer.
    offering: bool,
    /// The next offer must carry new ICE credentials.
    restart: bool,
    ignore_offer: bool,
    connected: bool,
    /// Candidates that arrived before the description they belong to.
    candidates: Vec<RTCIceCandidateInit>,
    receivers: Vec<JoinHandle<()>>,
}

impl Peer {
    fn signal(&self, data: Value) {
        self.shared.emit(CallEvent::Signal {
            peer_id: self.id.clone(),
            data,
        });
    }

    async fn send_description(&self) {
        if let Some(description) = self.conn.pc.local_description().await {
            self.signal(json!({ "description": description }));
        }
    }

    async fn negotiate(&mut self) -> webrtc::error::Result<()> {
        if self.offering {
            return Ok(());
        }
        let remote = self.conn.pc.remote_description().await.is_some();
        if !remote && self.polite {
            // The other side makes the first offer.
            return Ok(());
        }
        // We never add tracks later, so once both of ours are negotiated
        // the only reason to offer again is an ICE restart. (The event of
        // the initial `add_track`s arrives late, after the first exchange.)
        let negotiated = self
            .conn
            .pc
            .current_local_description()
            .await
            .is_some_and(|local| carries_our_tracks(&local.sdp));
        if negotiated && !self.restart {
            return Ok(());
        }
        let offer = self.conn.pc.create_offer(None).await?;
        self.conn.pc.set_local_description(offer).await?;
        self.offering = true;
        self.restart = false;
        self.send_description().await;
        Ok(())
    }

    async fn remote(&mut self, data: Value) -> Result<(), String> {
        if let Some(description) = data.get("description") {
            let description: RTCSessionDescription =
                serde_json::from_value(description.clone()).map_err(|error| error.to_string())?;
            self.description(description)
                .await
                .map_err(|error| error.to_string())
        } else if let Some(candidate) = data.get("candidate") {
            let Ok(candidate) = serde_json::from_value::<RTCIceCandidateInit>(candidate.clone())
            else {
                return Ok(());
            };
            if candidate.candidate.is_empty() {
                return Ok(());
            }
            if self.conn.pc.remote_description().await.is_some() {
                // A bad candidate (or one from an ignored offer) only
                // loses that path, never the call.
                let _ = self.conn.pc.add_ice_candidate(candidate).await;
            } else {
                self.candidates.push(candidate);
            }
            Ok(())
        } else {
            Ok(())
        }
    }

    async fn description(
        &mut self,
        description: RTCSessionDescription,
    ) -> webrtc::error::Result<()> {
        let offer = description.sdp_type == RTCSdpType::Offer;
        if !offer && !self.offering {
            // A stale answer (to an offer we rolled back).
            return Ok(());
        }
        let collision = offer && self.offering;
        self.ignore_offer = !self.polite && collision;
        if self.ignore_offer {
            return Ok(());
        }
        if collision {
            // Built through serde: the parsed SDP it carries is private.
            let rollback: RTCSessionDescription =
                serde_json::from_value(json!({ "type": "rollback", "sdp": "" }))
                    .expect("valid rollback description");
            self.conn.pc.set_local_description(rollback).await?;
        }
        let accepted = ufrag(&description.sdp).map(str::to_owned);
        self.conn.pc.set_remote_description(description).await?;
        self.offering = false;
        for candidate in std::mem::take(&mut self.candidates) {
            // Candidates of a rolled-back offer belong to an obsolete ICE
            // generation; keep the ones matching what was accepted.
            if candidate
                .username_fragment
                .as_deref()
                .is_some_and(|fragment| accepted.as_deref().is_some_and(|ok| ok != fragment))
            {
                continue;
            }
            let _ = self.conn.pc.add_ice_candidate(candidate).await;
        }
        if offer {
            let answer = self.conn.pc.create_answer(None).await?;
            self.conn.pc.set_local_description(answer).await?;
            self.send_description().await;
        }
        self.refresh_sinks().await;
        Ok(())
    }

    /// Starts writing our tracks to the peer (again, after a renegotiation
    /// that may have changed what it accepts).
    async fn refresh_sinks(&self) {
        if !self.connected {
            return;
        }
        let sinks = PeerSinks {
            audio: self.conn.audio.sink().await,
            screen: self.conn.screen.sink().await,
        };
        self.shared.hub.set(&self.id, sinks);
    }

    async fn state(&mut self, state: RTCPeerConnectionState) {
        self.shared.emit(CallEvent::PeerState {
            peer_id: self.id.clone(),
            state: state_name(state).to_owned(),
        });
        match state {
            RTCPeerConnectionState::Connected => {
                self.connected = true;
                self.refresh_sinks().await;
                self.shared.keyframe.store(true, Ordering::Relaxed);
            }
            RTCPeerConnectionState::Failed => {
                self.connected = false;
                self.shared.hub.remove(&self.id);
                // Renegotiates with fresh ICE credentials. Browsers restart
                // by themselves; between native peers the initial offerer
                // does, so the DTLS server stays the one that answers.
                if !self.polite && self.conn.pc.restart_ice().await.is_ok() {
                    self.restart = true;
                    if let Err(error) = self.negotiate().await {
                        self.shared.emit(CallEvent::Error {
                            message: format!("Falha ao reconectar o áudio: {error}"),
                        });
                    }
                }
            }
            RTCPeerConnectionState::Closed => {
                self.connected = false;
                self.shared.hub.remove(&self.id);
            }
            _ => {}
        }
    }

    async fn track(&mut self, track: Arc<dyn TrackRemote>) {
        let shared = self.shared.clone();
        let id = self.id.clone();
        let task = match track.kind().await {
            RtpCodecKind::Audio => tokio::spawn(receive_audio(id, track, shared)),
            RtpCodecKind::Video => tokio::spawn(video::receive(id, track, shared)),
            _ => return,
        };
        self.receivers.retain(|task| !task.is_finished());
        self.receivers.push(task);
    }

    async fn close(self) {
        for task in &self.receivers {
            task.abort();
        }
        self.shared.hub.remove(&self.id);
        self.shared.mixer.remove(&self.id);
        self.shared.levels.remove(&self.id);
        if self.shared.frames.release_any(&self.id) {
            self.shared.emit(CallEvent::Screen {
                peer_id: self.id.clone(),
                active: false,
            });
        }
        let _ = self.conn.pc.close().await;
    }
}

async fn receive_audio(peer: String, track: Arc<dyn TrackRemote>, shared: Arc<Shared>) {
    let Ok(mut decoder) = Decoder::new() else {
        return;
    };
    while let Some(event) = track.poll().await {
        match event {
            TrackRemoteEvent::OnRtpPacket(packet) => {
                if packet.payload.is_empty() {
                    continue;
                }
                if let Some(pcm) = decoder.decode(&packet.payload) {
                    shared.levels.feed(&peer, pcm);
                    if !shared.deafened.load(Ordering::Relaxed) {
                        shared.mixer.push(&peer, pcm);
                    }
                }
            }
            TrackRemoteEvent::OnEnded => break,
            _ => {}
        }
    }
    shared.mixer.remove(&peer);
    shared.levels.remove(&peer);
}

async fn run(
    id: String,
    self_id: String,
    ice_servers: Vec<RTCIceServer>,
    shared: Arc<Shared>,
    commands: UnboundedSender<PeerCommand>,
    mut receiver: UnboundedReceiver<PeerCommand>,
) {
    let conn = match connect(ice_servers, commands.clone()).await {
        Ok(conn) => conn,
        Err(error) => {
            shared.emit(CallEvent::Error {
                message: format!("Não foi possível criar a conexão de voz: {error}"),
            });
            return;
        }
    };
    let mut peer = Peer {
        polite: self_id > id,
        id,
        shared,
        conn,
        offering: false,
        restart: false,
        ignore_offer: false,
        connected: false,
        candidates: Vec::new(),
        receivers: Vec::new(),
    };
    // The negotiation-needed event of the tracks just added waits in the
    // core until its driver wakes up, which (before ICE starts) is never:
    // ask for the first negotiation ourselves.
    let _ = commands.send(PeerCommand::NegotiationNeeded);
    // A peer that lost a picture of our screen asks for a keyframe.
    let requests = {
        let (track, shared) = (peer.conn.screen.track.clone(), peer.shared.clone());
        tokio::spawn(async move {
            while let Some(event) = track.poll().await {
                if let TrackLocalEvent::OnRtcpPacket(packets) = event {
                    if asks_keyframe(&packets) {
                        shared.keyframe.store(true, Ordering::Relaxed);
                    }
                }
            }
        })
    };
    peer.receivers.push(requests);
    drop(commands);
    while let Some(command) = receiver.recv().await {
        match command {
            PeerCommand::Close => break,
            PeerCommand::NegotiationNeeded => {
                if let Err(error) = peer.negotiate().await {
                    peer.shared.emit(CallEvent::Error {
                        message: format!("Falha ao negociar o áudio: {error}"),
                    });
                }
            }
            PeerCommand::Remote(data) => {
                if let Err(error) = peer.remote(data).await {
                    if !peer.ignore_offer {
                        peer.shared.emit(CallEvent::Error {
                            message: format!("Falha ao negociar o áudio: {error}"),
                        });
                    }
                }
            }
            PeerCommand::LocalCandidate(candidate) => {
                peer.signal(json!({ "candidate": candidate }))
            }
            PeerCommand::State(state) => peer.state(state).await,
            PeerCommand::Track(track) => peer.track(track).await,
        }
    }
    peer.close().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_use_the_browser_json_names() {
        let browser = json!({
            "candidate": "candidate:1 1 udp 2122260223 192.168.0.2 50000 typ host",
            "sdpMid": "0",
            "sdpMLineIndex": 0,
            "usernameFragment": "abcd"
        });
        let candidate: RTCIceCandidateInit = serde_json::from_value(browser.clone()).unwrap();
        assert_eq!(candidate.sdp_mline_index, Some(0));
        assert_eq!(candidate.username_fragment.as_deref(), Some("abcd"));
        assert_eq!(serde_json::to_value(&candidate).unwrap(), browser);
    }

    #[test]
    fn descriptions_use_the_browser_json_names() {
        let description: RTCSessionDescription =
            serde_json::from_value(json!({ "type": "offer", "sdp": "v=0\r\n" })).unwrap();
        assert_eq!(description.sdp_type, RTCSdpType::Offer);
        assert_eq!(
            serde_json::to_value(&description).unwrap(),
            json!({ "type": "offer", "sdp": "v=0\r\n" })
        );
    }

    #[test]
    fn recognizes_a_description_with_our_tracks() {
        let sdp = "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=msid:disc-call-audio disc-call-audio-track\r\n\
                   m=video 9 UDP/TLS/RTP/SAVPF 102\r\na=msid:disc-call-screen disc-call-screen-track\r\n";
        assert!(carries_our_tracks(sdp));
        assert!(!carries_our_tracks(
            "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=msid:disc-call-audio x\r\n"
        ));
    }

    #[test]
    fn reads_the_ice_username_fragment() {
        assert_eq!(
            ufrag("v=0\r\na=ice-ufrag:Xy12\r\na=ice-pwd:p\r\n"),
            Some("Xy12")
        );
        assert_eq!(ufrag("v=0\r\n"), None);
    }

    use crate::hub::{EncodedFrame, Kind};
    use bytes::Bytes;
    use std::time::Duration;

    /// Two native peers in one process, signaling through each other's
    /// events exactly as the UI relays them over the socket.
    #[test]
    fn two_native_peers_connect_and_exchange_voice_and_screen() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (to_test, mut events) = unbounded_channel::<(&'static str, CallEvent)>();
            let sink = |name: &'static str| {
                let to_test = to_test.clone();
                Arc::new(move |event| {
                    let _ = to_test.send((name, event));
                }) as crate::engine::EventSink
            };
            let a = Shared::detached(sink("a"));
            let b = Shared::detached(sink("b"));
            let peer_a = spawn("b".into(), "a".into(), vec![], a.clone());
            let peer_b = spawn("a".into(), "b".into(), vec![], b.clone());

            let (frames_a, from_a) = unbounded_channel::<EncodedFrame>();
            tokio::spawn(a.hub.clone().run(from_a));
            let mut encoder =
                opus::Encoder::new(48_000, opus::Channels::Mono, opus::Application::Voip).unwrap();
            let tone: Vec<f32> = (0..960)
                .map(|i| 0.3 * (i as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin())
                .collect();
            let mut packet = [0_u8; 1500];

            let mut connected = (false, false);
            let mut descriptions = 0;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
            let mut ticker = tokio::time::interval(Duration::from_millis(20));
            loop {
                tokio::select! {
                    Some((from, event)) = events.recv() => match (from, event) {
                        (_, CallEvent::Signal { ref data, .. }) if data.get("description").is_some() => {
                            descriptions += 1;
                            let data = data.clone();
                            if from == "a" { peer_b.send(PeerCommand::Remote(data)) } else { peer_a.send(PeerCommand::Remote(data)) }
                        }
                        ("a", CallEvent::Signal { data, .. }) => peer_b.send(PeerCommand::Remote(data)),
                        ("b", CallEvent::Signal { data, .. }) => peer_a.send(PeerCommand::Remote(data)),
                        ("a", CallEvent::PeerState { state, .. }) => connected.0 |= state == "connected",
                        ("b", CallEvent::PeerState { state, .. }) => connected.1 |= state == "connected",
                        (_, CallEvent::Error { message }) => panic!("call error: {message}"),
                        _ => {}
                    },
                    _ = ticker.tick() => {
                        let size = encoder.encode_float(&tone, &mut packet).unwrap();
                        let _ = frames_a.send(EncodedFrame {
                            kind: Kind::Audio,
                            data: Bytes::copy_from_slice(&packet[..size]),
                            duration: Duration::from_millis(20),
                        });
                        if connected == (true, true) && b.levels.speaking(true) == ["a"] {
                            // Offer and answer, without a needless second round.
                            assert_eq!(descriptions, 2);
                            break;
                        }
                    }
                    _ = tokio::time::sleep_until(deadline) => {
                        panic!("timed out: connected {connected:?}, b hears {:?}", b.levels.speaking(true));
                    }
                }
            }

            // Now a's screen, starting mid-stream: b cannot decode P-frames
            // without the keyframe, asks for one (PLI), and a sends it.
            let frame = crate::video::tests::raw(320, 180, 0);
            let mut encoder = crate::video::ScreenEncoder::new(30, (320, 180)).unwrap();
            let _missed_keyframe = encoder.encoder.encode(&crate::video::planes(&frame)).unwrap().to_vec();
            a.keyframe.store(false, Ordering::Relaxed);
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            let mut ticker = tokio::time::interval(Duration::from_millis(33));
            let mut shift = 0;
            loop {
                tokio::select! {
                    Some((from, event)) = events.recv() => {
                        if let ("b", CallEvent::Screen { peer_id, active: true }) = (from, event) {
                            assert_eq!(peer_id, "a");
                            break;
                        }
                    },
                    _ = ticker.tick() => {
                        shift += 2;
                        if a.keyframe.swap(false, Ordering::Relaxed) {
                            encoder.encoder.force_intra_frame();
                        }
                        let frame = crate::video::tests::raw(320, 180, shift);
                        let bits = encoder.encoder.encode(&crate::video::planes(&frame)).unwrap().to_vec();
                        let _ = frames_a.send(EncodedFrame {
                            kind: Kind::Screen,
                            data: Bytes::from(bits),
                            duration: Duration::from_millis(33),
                        });
                    }
                    _ = tokio::time::sleep_until(deadline) => panic!("b never decoded a's screen (no PLI round trip?)"),
                }
            }
            let jpeg = b.frames.next("a", Duration::from_secs(1)).expect("a decoded picture");
            assert!(jpeg.starts_with(&[0xFF, 0xD8]));

            peer_a.send(PeerCommand::Close);
            peer_b.send(PeerCommand::Close);
        });
    }
}
