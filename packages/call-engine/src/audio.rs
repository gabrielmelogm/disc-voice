//! Call audio over PulseAudio (PipeWire on current distributions): the
//! microphone is encoded to Opus for every peer, and what peers send is
//! decoded, buffered per peer and mixed into one playback stream.
//!
//! Both streams are mono 48 kHz; the server converts from and to whatever the
//! devices use. Each runs blocking `pa_simple` I/O on its own thread.

use crate::{
    engine::{CallEvent, Shared},
    hub::{EncodedFrame, Kind},
};
use bytes::Bytes;
use libpulse_binding::{
    def::BufferAttr,
    sample::{Format, Spec},
    stream::Direction,
};
use libpulse_simple_binding::Simple;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tokio::sync::mpsc::UnboundedSender;

pub(crate) const RATE: u32 = 48_000;
/// One Opus packet: 20 ms, what browsers send.
pub(crate) const PACKET: usize = RATE as usize / 50;
/// Pulse reads and writes in 10 ms steps.
const CHUNK: usize = RATE as usize / 100;
const SAMPLE_BYTES: usize = std::mem::size_of::<f32>();
/// Voice at this rate is clear; the browsers default to about the same.
const OPUS_BITRATE: i32 = 40_000;
/// A peer starts (or resumes) playing once this much is buffered...
const PRIME: usize = PACKET * 3;
/// ...and is trimmed back to it past this, so delay never builds up.
const MAX_BUFFERED: usize = RATE as usize / 5;
/// RMS above this counts as speaking (the browser client uses the same).
const SPEAKING_RMS: f32 = 0.015;
/// How long someone keeps "speaking" after the last loud packet.
const SPEAKING_HOLD: Duration = Duration::from_millis(300);
const APP_NAME: &str = "Disc Voice";

fn open(
    direction: Direction,
    device: &str,
    name: &str,
    attr: &BufferAttr,
) -> Result<Simple, String> {
    let spec = Spec {
        format: Format::FLOAT32NE,
        rate: RATE,
        channels: 1,
    };
    let connect = |device: Option<&str>| {
        Simple::new(
            None,
            APP_NAME,
            direction,
            device,
            name,
            &spec,
            None,
            Some(attr),
        )
    };
    match connect((!device.is_empty()).then_some(device)) {
        Ok(simple) => Ok(simple),
        // A saved device that is gone: the system default still works.
        Err(_) if !device.is_empty() => connect(None).map_err(|error| format!("{error}")),
        Err(error) => Err(format!("{error}")),
    }
}

/// A stream thread; dropping it stops the thread and waits briefly for it.
struct Worker {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Worker {
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

impl Drop for Worker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let Some(thread) = self.thread.take() else {
            return;
        };
        // Blocking I/O returns within one 10 ms chunk. A stalled server must
        // not freeze the caller: the thread then exits on its own.
        let deadline = Instant::now() + Duration::from_millis(300);
        while !thread.is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(2));
        }
        if thread.is_finished() {
            let _ = thread.join();
        }
    }
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
}

/// The microphone, encoded to Opus packets for the hub.
pub(crate) struct Capture {
    _worker: Worker,
}

impl Capture {
    pub fn start(
        device: &str,
        shared: Arc<Shared>,
        out: UnboundedSender<EncodedFrame>,
    ) -> Result<Self, String> {
        let attr = BufferAttr {
            maxlength: u32::MAX,
            tlength: u32::MAX,
            prebuf: u32::MAX,
            minreq: u32::MAX,
            fragsize: (CHUNK * SAMPLE_BYTES) as u32,
        };
        let simple = open(Direction::Record, device, "Microfone da chamada", &attr)
            .map_err(|error| format!("Não foi possível abrir o microfone: {error}"))?;
        let mut encoder = opus::Encoder::new(RATE, opus::Channels::Mono, opus::Application::Voip)
            .map_err(|error| {
            format!("Não foi possível iniciar o codificador de voz: {error}")
        })?;
        let _ = encoder.set_bitrate(opus::Bitrate::Bits(OPUS_BITRATE));
        let _ = encoder.set_inband_fec(true);
        let worker = Worker::spawn("disc-call-mic", move |stop| {
            let mut bytes = vec![0_u8; CHUNK * SAMPLE_BYTES];
            let mut pending: Vec<f32> = Vec::with_capacity(PACKET);
            let mut packet = vec![0_u8; 1500];
            let silence = [0.0_f32; PACKET];
            while !stop.load(Ordering::Relaxed) {
                if let Err(error) = simple.read(&mut bytes) {
                    if !stop.load(Ordering::Relaxed) {
                        shared.emit(CallEvent::Error {
                            message: format!(
                                "O microfone foi desconectado ({error}). Selecione outro dispositivo e entre novamente."
                            ),
                        });
                    }
                    return;
                }
                pending.extend(bytes.chunks_exact(SAMPLE_BYTES).map(|sample| {
                    let value = f32::from_ne_bytes(sample.try_into().expect("4-byte chunk"));
                    if value.is_finite() {
                        value.clamp(-1.0, 1.0)
                    } else {
                        0.0
                    }
                }));
                if pending.len() < PACKET {
                    continue;
                }
                // Muted still sends (silence, a few bytes per packet) so
                // the stream and its timestamps stay continuous.
                let samples = if shared.muted.load(Ordering::Relaxed) {
                    &silence[..]
                } else {
                    shared.levels.feed_local(rms(&pending));
                    &pending[..]
                };
                if let Ok(size) = encoder.encode_float(samples, &mut packet) {
                    let _ = out.send(EncodedFrame {
                        kind: Kind::Audio,
                        data: Bytes::copy_from_slice(&packet[..size]),
                        duration: Duration::from_millis(20),
                    });
                }
                pending.clear();
            }
        })?;
        Ok(Self { _worker: worker })
    }
}

/// Everyone's voice, mixed and played on one output device.
pub(crate) struct Playback {
    _worker: Worker,
}

impl Playback {
    pub fn start(device: &str, shared: Arc<Shared>) -> Result<Self, String> {
        let attr = BufferAttr {
            maxlength: u32::MAX,
            // ~40 ms queued on the server: low latency without underruns.
            tlength: (CHUNK * 4 * SAMPLE_BYTES) as u32,
            prebuf: u32::MAX,
            minreq: u32::MAX,
            fragsize: u32::MAX,
        };
        let simple = open(Direction::Playback, device, "Chamada de voz", &attr)
            .map_err(|error| format!("Não foi possível abrir a saída de áudio: {error}"))?;
        let worker = Worker::spawn("disc-call-speakers", move |stop| {
            let mut chunk = [0.0_f32; CHUNK];
            let mut bytes = Vec::with_capacity(CHUNK * SAMPLE_BYTES);
            while !stop.load(Ordering::Relaxed) {
                chunk.fill(0.0);
                shared.mixer.mix(&mut chunk);
                shared.screen_mixer.mix(&mut chunk);
                if shared.deafened.load(Ordering::Relaxed) {
                    chunk.fill(0.0);
                }
                bytes.clear();
                for sample in chunk {
                    bytes.extend_from_slice(&sample.to_ne_bytes());
                }
                if let Err(error) = simple.write(&bytes) {
                    if !stop.load(Ordering::Relaxed) {
                        shared.emit(CallEvent::Error {
                            message: format!(
                                "A saída de áudio foi desconectada ({error}). Selecione outro dispositivo e entre novamente."
                            ),
                        });
                    }
                    return;
                }
            }
        })?;
        Ok(Self { _worker: worker })
    }
}

#[derive(Default)]
struct Jitter {
    samples: VecDeque<f32>,
    playing: bool,
}

/// Per-peer buffers between the network (bursty) and the speakers (steady).
#[derive(Default)]
pub(crate) struct Mixer {
    peers: Mutex<HashMap<String, Jitter>>,
    /// Local volume per peer (1 when unset); kept while a peer's audio
    /// stops and starts again.
    gains: Mutex<HashMap<String, f32>>,
}

impl Mixer {
    fn peers(&self) -> std::sync::MutexGuard<'_, HashMap<String, Jitter>> {
        self.peers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn push(&self, peer: &str, samples: &[f32]) {
        let mut peers = self.peers();
        let jitter = peers.entry(peer.to_owned()).or_default();
        jitter.samples.extend(samples);
        if jitter.samples.len() > MAX_BUFFERED {
            let excess = jitter.samples.len() - PRIME;
            jitter.samples.drain(..excess);
        }
    }

    fn gains(&self) -> std::sync::MutexGuard<'_, HashMap<String, f32>> {
        self.gains
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The local volume of one peer, from 0 (muted) to 1.
    pub fn set_gain(&self, peer: &str, gain: f32) {
        let gain = if gain.is_finite() {
            gain.clamp(0.0, 1.0)
        } else {
            1.0
        };
        self.gains().insert(peer.to_owned(), gain);
    }

    /// Adds every playing peer's next samples to `out`.
    pub fn mix(&self, out: &mut [f32]) {
        let gains = self.gains().clone();
        for (peer, jitter) in self.peers().iter_mut() {
            if !jitter.playing && jitter.samples.len() >= PRIME {
                jitter.playing = true;
            }
            if !jitter.playing {
                continue;
            }
            let gain = gains.get(peer).copied().unwrap_or(1.0);
            for sample in out.iter_mut() {
                match jitter.samples.pop_front() {
                    Some(value) => *sample += value * gain,
                    None => {
                        // Ran dry: wait for a cushion again instead of
                        // playing every late packet as a click.
                        jitter.playing = false;
                        break;
                    }
                }
            }
        }
        for sample in out.iter_mut() {
            *sample = sample.clamp(-1.0, 1.0);
        }
    }

    pub fn remove(&self, peer: &str) {
        self.peers().remove(peer);
    }

    /// Forgets a peer that left the call, volume included.
    pub fn forget(&self, peer: &str) {
        self.remove(peer);
        self.gains().remove(peer);
    }

    pub fn clear(&self) {
        self.peers().clear();
    }
}

/// The computer's audio, shared with our screen: stereo Opus at a music
/// bitrate. Echo-free, since `disc_audio::SystemAudio` leaves out what this
/// process plays (the call itself).
pub(crate) struct ScreenCapture {
    _audio: disc_audio::SystemAudio,
}

/// Enough for music and movies in stereo.
const SCREEN_AUDIO_BITRATE: i32 = 128_000;

impl ScreenCapture {
    pub fn start(out: UnboundedSender<EncodedFrame>) -> Result<Self, String> {
        use disc_audio::system::{CHANNELS, RATE as SYSTEM_RATE};
        debug_assert_eq!(SYSTEM_RATE, RATE);
        let mut encoder =
            opus::Encoder::new(RATE, opus::Channels::Stereo, opus::Application::Audio).map_err(
                |error| format!("Não foi possível iniciar o codificador do áudio da tela: {error}"),
            )?;
        let _ = encoder.set_bitrate(opus::Bitrate::Bits(SCREEN_AUDIO_BITRATE));
        let _ = encoder.set_inband_fec(true);
        let mut pending: Vec<f32> = Vec::with_capacity(PACKET * CHANNELS * 2);
        let mut packet = vec![0_u8; 4000];
        let audio = disc_audio::SystemAudio::start(move |chunk| {
            pending.extend_from_slice(chunk);
            while pending.len() >= PACKET * CHANNELS {
                if let Ok(size) = encoder.encode_float(&pending[..PACKET * CHANNELS], &mut packet) {
                    let _ = out.send(EncodedFrame {
                        kind: Kind::ScreenAudio,
                        data: Bytes::copy_from_slice(&packet[..size]),
                        duration: Duration::from_millis(20),
                    });
                }
                pending.drain(..PACKET * CHANNELS);
            }
        })?;
        Ok(Self { _audio: audio })
    }
}

/// Decodes one peer's Opus packets into the mixer.
pub(crate) struct Decoder {
    decoder: opus::Decoder,
    pcm: Vec<f32>,
}

impl Decoder {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            decoder: opus::Decoder::new(RATE, opus::Channels::Mono)
                .map_err(|error| error.to_string())?,
            // The longest Opus packet is 120 ms.
            pcm: vec![0.0; RATE as usize / 1000 * 120],
        })
    }

    pub fn decode(&mut self, packet: &[u8]) -> Option<&[f32]> {
        let size = self
            .decoder
            .decode_float(packet, &mut self.pcm, false)
            .ok()?;
        Some(&self.pcm[..size])
    }
}

/// Last time each participant was loud enough to count as speaking.
#[derive(Default)]
pub(crate) struct Levels {
    inner: Mutex<LevelState>,
}

#[derive(Default)]
struct LevelState {
    local_id: String,
    local: Option<Instant>,
    peers: HashMap<String, Instant>,
}

impl Levels {
    fn state(&self) -> std::sync::MutexGuard<'_, LevelState> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Our own peer ID, reported for the microphone.
    pub fn set_local(&self, id: &str) {
        id.clone_into(&mut self.state().local_id);
    }

    pub fn feed_local(&self, rms: f32) {
        if rms > SPEAKING_RMS {
            self.state().local = Some(Instant::now());
        }
    }

    pub fn feed(&self, peer: &str, samples: &[f32]) {
        if rms(samples) > SPEAKING_RMS {
            self.state().peers.insert(peer.to_owned(), Instant::now());
        }
    }

    pub fn remove(&self, peer: &str) {
        self.state().peers.remove(peer);
    }

    /// Who is speaking, sorted; we are left out while muted.
    pub fn speaking(&self, muted: bool) -> Vec<String> {
        let state = self.state();
        let recent = |at: &Instant| at.elapsed() < SPEAKING_HOLD;
        let mut ids: Vec<String> = state
            .peers
            .iter()
            .filter(|(_, at)| recent(at))
            .map(|(id, _)| id.clone())
            .collect();
        if !muted && !state.local_id.is_empty() && state.local.as_ref().is_some_and(recent) {
            ids.push(state.local_id.clone());
        }
        ids.sort();
        ids
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixer_waits_for_a_cushion_and_sums_peers() {
        let mixer = Mixer::default();
        mixer.push("a", &[0.25; PACKET]);
        let mut out = [0.0; CHUNK];
        mixer.mix(&mut out);
        assert!(out.iter().all(|&sample| sample == 0.0), "not primed yet");

        mixer.push("a", &[0.25; PRIME]);
        mixer.push("b", &[0.5; PRIME]);
        let mut out = [0.0; CHUNK];
        mixer.mix(&mut out);
        assert!(out.iter().all(|&sample| (sample - 0.75).abs() < 1e-6));
    }

    #[test]
    fn mixer_trims_delay_and_clips() {
        let mixer = Mixer::default();
        mixer.push("a", &vec![0.9; MAX_BUFFERED + PACKET]);
        mixer.push("b", &vec![0.9; PRIME]);
        assert_eq!(mixer.peers()["a"].samples.len(), PRIME);
        let mut out = [0.0; CHUNK];
        mixer.mix(&mut out);
        assert!(out.iter().all(|&sample| sample == 1.0));
    }

    #[test]
    fn mixer_applies_each_peers_volume() {
        let mixer = Mixer::default();
        mixer.set_gain("a", 0.5);
        mixer.set_gain("muted", 0.0);
        mixer.set_gain("loud", 7.0);
        mixer.push("a", &[0.4; PRIME]);
        mixer.push("muted", &[0.4; PRIME]);
        let mut out = [0.0; CHUNK];
        mixer.mix(&mut out);
        assert!(out.iter().all(|&sample| (sample - 0.2).abs() < 1e-6));
        assert_eq!(mixer.gains()["loud"], 1.0, "never above the original");

        // The volume outlives the peer's audio, not the peer.
        mixer.remove("a");
        assert_eq!(mixer.gains()["a"], 0.5);
        mixer.forget("a");
        assert!(!mixer.gains().contains_key("a"));
    }

    #[test]
    fn stereo_screen_audio_decodes_as_mono() {
        let mut encoder =
            opus::Encoder::new(RATE, opus::Channels::Stereo, opus::Application::Audio).unwrap();
        let mut decoder = Decoder::new().unwrap();
        let tone: Vec<f32> = (0..PACKET)
            .flat_map(|i| {
                let value = 0.3 * (i as f32 * 440.0 * std::f32::consts::TAU / RATE as f32).sin();
                [value, value]
            })
            .collect();
        let mut packet = [0_u8; 4000];
        let mut decoded = 0;
        for _ in 0..10 {
            let size = encoder.encode_float(&tone, &mut packet).unwrap();
            decoded = decoder.decode(&packet[..size]).unwrap().len();
        }
        assert_eq!(decoded, PACKET);
    }

    #[test]
    fn opus_round_trip_keeps_the_level() {
        let mut encoder =
            opus::Encoder::new(RATE, opus::Channels::Mono, opus::Application::Voip).unwrap();
        let mut decoder = Decoder::new().unwrap();
        let tone: Vec<f32> = (0..PACKET)
            .map(|i| 0.3 * (i as f32 * 440.0 * std::f32::consts::TAU / RATE as f32).sin())
            .collect();
        let mut packet = [0_u8; 1500];
        let mut level = 0.0;
        for _ in 0..10 {
            let size = encoder.encode_float(&tone, &mut packet).unwrap();
            level = rms(decoder.decode(&packet[..size]).unwrap());
        }
        assert!((0.15..0.3).contains(&level), "decoded rms {level}");
    }

    #[test]
    fn speaking_includes_us_only_when_unmuted() {
        let levels = Levels::default();
        levels.set_local("me");
        levels.feed_local(0.5);
        levels.feed("peer", &[0.5; 10]);
        levels.feed("quiet", &[0.001; 10]);
        assert_eq!(levels.speaking(false), ["me", "peer"]);
        assert_eq!(levels.speaking(true), ["peer"]);
        levels.remove("peer");
        assert!(levels.speaking(true).is_empty());
    }
}
