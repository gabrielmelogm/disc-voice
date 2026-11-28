//! The computer's audio, for sharing it with a screen.
//!
//! Everything this process plays (the call itself, notification sounds) is
//! left out, so the people in the call never hear themselves back:
//!
//! - Windows: WASAPI process loopback excluding our WebView2 browser
//!   process and its children, among them the audio service that plays the
//!   call (see `system_windows::excluded_process`).
//! - Linux: one PulseAudio monitor per playback stream of other applications,
//!   mixed together (what pavucontrol does for its per-stream meters).
//!
//! Audio comes out as 48 kHz stereo, interleaved `f32`, in steady 10 ms
//! chunks; silence fills the gaps while nothing plays, so encoders downstream
//! always see a continuous stream.

use std::{
    collections::{HashMap, VecDeque},
    time::{Duration, Instant},
};

pub const RATE: u32 = 48_000;
pub const CHANNELS: usize = 2;
/// 10 ms of audio, in frames and in interleaved samples.
pub const CHUNK_FRAMES: usize = RATE as usize / 100;
pub const CHUNK_SAMPLES: usize = CHUNK_FRAMES * CHANNELS;

/// Receives every chunk of `CHUNK_SAMPLES` interleaved samples.
pub type ChunkSink = Box<dyn FnMut(&[f32]) + Send>;

/// Whether this build can capture the computer's audio at all (the system
/// may still refuse at runtime, with a message saying why).
pub const fn supported() -> bool {
    cfg!(any(windows, target_os = "linux"))
}

/// A running capture; dropping it stops it.
pub struct SystemAudio {
    #[cfg(windows)]
    _capture: crate::system_windows::Capture,
    #[cfg(target_os = "linux")]
    _capture: crate::system_pulse::Capture,
}

impl SystemAudio {
    #[cfg(windows)]
    pub fn start(sink: impl FnMut(&[f32]) + Send + 'static) -> Result<Self, String> {
        Ok(Self {
            _capture: crate::system_windows::Capture::start(Box::new(sink))?,
        })
    }

    #[cfg(target_os = "linux")]
    pub fn start(sink: impl FnMut(&[f32]) + Send + 'static) -> Result<Self, String> {
        Ok(Self {
            _capture: crate::system_pulse::Capture::start(Box::new(sink))?,
        })
    }

    #[cfg(not(any(windows, target_os = "linux")))]
    pub fn start(_sink: impl FnMut(&[f32]) + Send + 'static) -> Result<Self, String> {
        Err("A captura do áudio do computador não está disponível neste sistema.".into())
    }
}

/// Silence is added once nothing arrived for this long...
#[cfg_attr(not(windows), allow(dead_code))]
const GAP: Duration = Duration::from_millis(60);
/// ...and the clock is re-anchored when real audio runs this far ahead of it.
#[cfg_attr(not(windows), allow(dead_code))]
const AHEAD: Duration = Duration::from_millis(100);

fn frames(duration: Duration) -> u64 {
    (duration.as_secs_f64() * f64::from(RATE)) as u64
}

/// Turns irregular captured audio into steady chunks, filling silence while
/// nothing plays.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) struct Pacer {
    sink: ChunkSink,
    pending: Vec<f32>,
    anchor: Instant,
    /// Frames sent since `anchor`.
    sent: u64,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl Pacer {
    pub fn new(sink: ChunkSink, now: Instant) -> Self {
        Self {
            sink,
            pending: Vec::with_capacity(CHUNK_SAMPLES * 4),
            anchor: now,
            sent: 0,
        }
    }

    /// Captured interleaved stereo samples.
    pub fn push(&mut self, samples: &[f32], now: Instant) {
        self.pending.extend(samples.iter().map(|&sample| {
            if sample.is_finite() {
                sample.clamp(-1.0, 1.0)
            } else {
                0.0
            }
        }));
        let whole = self.pending.len() / CHUNK_SAMPLES * CHUNK_SAMPLES;
        for chunk in self.pending[..whole].chunks_exact(CHUNK_SAMPLES) {
            (self.sink)(chunk);
            self.sent += CHUNK_FRAMES as u64;
        }
        self.pending.drain(..whole);
        let expected = frames(now.saturating_duration_since(self.anchor));
        if self.sent > expected + frames(AHEAD) {
            // The device delivered late audio after we filled silence:
            // follow the audio instead of building up delay.
            self.anchor = now;
            self.sent = 0;
        }
    }

    /// Called regularly: sends silence while nothing is being captured.
    pub fn tick(&mut self, now: Instant) {
        let expected = frames(now.saturating_duration_since(self.anchor));
        if expected < self.sent + frames(GAP) {
            return;
        }
        // Keep a little behind the clock, so audio arriving now is not late.
        let target = expected - frames(GAP) / 2;
        let silence = [0.0_f32; CHUNK_SAMPLES];
        self.pending.clear();
        while self.sent + CHUNK_FRAMES as u64 <= target {
            (self.sink)(&silence);
            self.sent += CHUNK_FRAMES as u64;
        }
    }
}

/// Audio a source must have buffered before it joins the mix, so the
/// irregular fragments it is delivered in never run dry mid-chunk.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const CUSHION: usize = CHUNK_SAMPLES * 3;
/// More than this buffered for one source means it stalled or runs fast:
/// its backlog drops back to the cushion.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const MAX_BACKLOG: usize = CHUNK_SAMPLES * 20;
/// The mixer jumps ahead instead of catching up after a stall this long
/// (a burst would only arrive late anyway).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const STALL: Duration = Duration::from_millis(200);

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Default)]
struct Source {
    buffer: VecDeque<f32>,
    /// In the mix; a source that runs dry waits for its cushion again.
    playing: bool,
}

/// Audio from several applications, summed, sent as one steady 10 ms chunk
/// per 10 ms of clock. The clock decides when a chunk goes out, never the
/// sources: they deliver at their own pace and out of step with each other,
/// and draining them as they arrive would send their audio one after the
/// other, several times faster than real time.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) struct Mixer {
    sources: HashMap<u32, Source>,
    anchor: Instant,
    /// Frames sent since `anchor`.
    sent: u64,
    chunk: Vec<f32>,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
impl Mixer {
    pub fn new(now: Instant) -> Self {
        Self {
            sources: HashMap::new(),
            anchor: now,
            sent: 0,
            chunk: vec![0.0; CHUNK_SAMPLES],
        }
    }

    /// Interleaved stereo samples captured from `source`.
    pub fn push(&mut self, source: u32, samples: &[f32]) {
        let buffer = &mut self.sources.entry(source).or_default().buffer;
        buffer.extend(
            samples
                .iter()
                .map(|&sample| if sample.is_finite() { sample } else { 0.0 }),
        );
        if buffer.len() > MAX_BACKLOG {
            let excess = (buffer.len() - CUSHION) / CHANNELS * CHANNELS;
            buffer.drain(..excess);
        }
    }

    pub fn remove(&mut self, source: u32) {
        self.sources.remove(&source);
    }

    /// Called regularly: sends every chunk the clock is due, silence
    /// included while nothing plays.
    pub fn tick(&mut self, now: Instant, sink: &mut impl FnMut(&[f32])) {
        let expected = frames(now.saturating_duration_since(self.anchor));
        if expected > self.sent + frames(STALL) {
            self.anchor = now;
            self.sent = 0;
            return;
        }
        while self.sent + CHUNK_FRAMES as u64 <= expected {
            self.mix();
            sink(&self.chunk);
            self.sent += CHUNK_FRAMES as u64;
        }
    }

    /// The next chunk: up to 10 ms from every playing source, summed.
    fn mix(&mut self) {
        self.chunk.fill(0.0);
        for source in self.sources.values_mut() {
            if !source.playing {
                if source.buffer.len() < CUSHION {
                    continue;
                }
                source.playing = true;
            }
            let take = source.buffer.len().min(CHUNK_SAMPLES) / CHANNELS * CHANNELS;
            for (slot, sample) in self.chunk.iter_mut().zip(source.buffer.drain(..take)) {
                *slot += sample;
            }
            if take < CHUNK_SAMPLES {
                source.playing = false;
            }
        }
        for sample in &mut self.chunk {
            *sample = sample.clamp(-1.0, 1.0);
        }
    }
}

/// The parent process ID in a `/proc/<pid>/stat` line. The command name
/// in parentheses may itself hold spaces and parentheses.
#[allow(dead_code)]
pub(crate) fn parent_from_stat(stat: &str) -> Option<u32> {
    stat.rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

/// The sandbox instance in a `/.flatpak-info` file (`instance-id` in the
/// `[Instance]` group), the same id PipeWire puts on the instance's streams.
#[allow(dead_code)]
pub(crate) fn flatpak_instance(info: &str) -> Option<String> {
    let mut group = "";
    for line in info.lines().map(str::trim) {
        if line.starts_with('[') {
            group = line;
        } else if group == "[Instance]" {
            if let Some(("instance-id", value)) =
                line.split_once('=').map(|(k, v)| (k.trim(), v.trim()))
            {
                return (!value.is_empty()).then(|| value.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Needs a real audio system: `cargo test -p disc-audio -- --ignored`.
    #[test]
    #[ignore]
    fn captures_the_computer_audio() {
        let (sink, chunks) = recorder();
        let capture = SystemAudio::start(sink).expect("capture starts");
        std::thread::sleep(Duration::from_millis(500));
        drop(capture);
        let count = chunks.lock().unwrap().len();
        // Silence fills in while nothing plays: about 50 chunks in 500 ms.
        assert!((35..=60).contains(&count), "{count} chunks");
    }

    #[test]
    fn reads_the_parent_from_proc_stat() {
        assert_eq!(
            parent_from_stat("1234 (disc-voice) S 987 1234 1234 0"),
            Some(987)
        );
        assert_eq!(parent_from_stat("55 (Web (Content)) R 54 55"), Some(54));
        assert_eq!(parent_from_stat("garbage"), None);
    }

    #[test]
    fn reads_the_flatpak_instance() {
        let info = "[Application]\nname=dev.discvoice.desktop\n\n[Instance]\ninstance-id=4156316714\ninstance-path=/home/u/.var/app/dev.discvoice.desktop\n";
        assert_eq!(flatpak_instance(info).as_deref(), Some("4156316714"));
        assert_eq!(flatpak_instance("[Application]\ninstance-id=1\n"), None);
        assert_eq!(flatpak_instance(""), None);
    }

    fn recorder() -> (ChunkSink, Arc<Mutex<Vec<Vec<f32>>>>) {
        let chunks = Arc::new(Mutex::new(Vec::new()));
        let sink = chunks.clone();
        (
            Box::new(move |chunk: &[f32]| sink.lock().unwrap().push(chunk.to_vec())),
            chunks,
        )
    }

    #[test]
    fn pacer_sends_whole_chunks_and_keeps_the_rest() {
        let (sink, chunks) = recorder();
        let start = Instant::now();
        let mut pacer = Pacer::new(sink, start);
        pacer.push(&vec![0.5; CHUNK_SAMPLES + 10], start);
        assert_eq!(chunks.lock().unwrap().len(), 1);
        pacer.push(&vec![0.5; CHUNK_SAMPLES - 10], start);
        let chunks = chunks.lock().unwrap();
        assert_eq!(chunks.len(), 2);
        assert!(chunks.iter().all(|chunk| chunk.len() == CHUNK_SAMPLES));
    }

    #[test]
    fn pacer_clamps_and_drops_invalid_samples() {
        let (sink, chunks) = recorder();
        let start = Instant::now();
        let mut pacer = Pacer::new(sink, start);
        let mut samples = vec![2.0; CHUNK_SAMPLES];
        samples[0] = f32::NAN;
        pacer.push(&samples, start);
        let chunk = &chunks.lock().unwrap()[0];
        assert_eq!(chunk[0], 0.0);
        assert!(chunk[1..].iter().all(|&sample| sample == 1.0));
    }

    #[test]
    fn pacer_fills_silence_only_after_a_gap() {
        let (sink, chunks) = recorder();
        let start = Instant::now();
        let mut pacer = Pacer::new(sink, start);
        pacer.tick(start + Duration::from_millis(30));
        assert!(chunks.lock().unwrap().is_empty(), "short gaps are normal");
        pacer.tick(start + Duration::from_millis(200));
        let chunks = chunks.lock().unwrap();
        // 200 ms minus half the gap, in 10 ms chunks.
        assert_eq!(chunks.len(), 17);
        assert!(chunks.iter().flatten().all(|&sample| sample == 0.0));
    }

    #[test]
    fn pacer_follows_audio_that_runs_ahead() {
        let (sink, _chunks) = recorder();
        let start = Instant::now();
        let mut pacer = Pacer::new(sink, start);
        // 300 ms of audio delivered at once, 10 ms in.
        pacer.push(
            &vec![0.1; CHUNK_SAMPLES * 30],
            start + Duration::from_millis(10),
        );
        assert_eq!(pacer.sent, 0, "re-anchored");
        let (sink, chunks) = recorder();
        pacer.sink = sink;
        pacer.tick(start + Duration::from_millis(50));
        assert!(chunks.lock().unwrap().is_empty(), "no silence right after");
    }

    /// Drives a mixer for `ms` milliseconds of clock, `step` at a time.
    fn run_for(mixer: &mut Mixer, start: Instant, ms: u64, out: &mut Vec<Vec<f32>>) {
        for at in (0..=ms).step_by(5) {
            mixer.tick(start + Duration::from_millis(at), &mut |chunk: &[f32]| {
                out.push(chunk.to_vec())
            });
        }
    }

    #[test]
    fn mixer_sends_real_time_whatever_the_sources_deliver() {
        let start = Instant::now();
        let mut mixer = Mixer::new(start);
        let mut out = Vec::new();
        // Three applications delivering 10 ms each, at different moments.
        for step in 0..100_u64 {
            for source in 0..3 {
                mixer.push(source, &[0.1; CHUNK_SAMPLES]);
            }
            for at in [step * 10 + 1, step * 10 + 4, step * 10 + 7] {
                mixer.tick(start + Duration::from_millis(at), &mut |chunk: &[f32]| {
                    out.push(chunk.to_vec())
                });
            }
        }
        // One chunk per 10 ms of clock, not one per source.
        assert!((99..=100).contains(&out.len()), "{} chunks", out.len());
        assert!(out.iter().all(|chunk| chunk.len() == CHUNK_SAMPLES));
    }

    #[test]
    fn mixer_sums_sources_that_arrive_out_of_step() {
        let start = Instant::now();
        let mut mixer = Mixer::new(start);
        mixer.push(1, &vec![0.25; CUSHION]);
        mixer.push(2, &vec![0.5; CUSHION + CHUNK_SAMPLES]);
        let mut out = Vec::new();
        run_for(&mut mixer, start, 10, &mut out);
        assert_eq!(out.len(), 1);
        assert!(out[0].iter().all(|&sample| (sample - 0.75).abs() < 1e-6));
    }

    #[test]
    fn mixer_waits_for_a_cushion_and_clips() {
        let start = Instant::now();
        let mut mixer = Mixer::new(start);
        mixer.push(1, &[0.9; CHUNK_SAMPLES]);
        mixer.push(2, &vec![0.9; CUSHION]);
        mixer.push(3, &vec![0.9; CUSHION]);
        let mut out = Vec::new();
        run_for(&mut mixer, start, 10, &mut out);
        // Source 1 is still filling its cushion; 2 and 3 clip together.
        assert!(out[0].iter().all(|&sample| sample == 1.0));
    }

    #[test]
    fn mixer_sends_silence_while_nothing_plays() {
        let start = Instant::now();
        let mut mixer = Mixer::new(start);
        let mut out = Vec::new();
        run_for(&mut mixer, start, 100, &mut out);
        assert_eq!(out.len(), 10);
        assert!(out.iter().flatten().all(|&sample| sample == 0.0));
    }

    #[test]
    fn mixer_drops_invalid_samples_and_removed_sources() {
        let start = Instant::now();
        let mut mixer = Mixer::new(start);
        let mut samples = vec![0.5; CUSHION];
        samples[0] = f32::NAN;
        mixer.push(1, &samples);
        mixer.push(2, &vec![0.3; CUSHION]);
        mixer.remove(2);
        let mut out = Vec::new();
        run_for(&mut mixer, start, 10, &mut out);
        assert_eq!(out[0][0], 0.0);
        assert!(out[0][1..].iter().all(|&sample| sample == 0.5));
    }

    #[test]
    fn mixer_trims_a_backlog_to_the_cushion() {
        let start = Instant::now();
        let mut mixer = Mixer::new(start);
        mixer.push(1, &vec![0.1; MAX_BACKLOG + CHANNELS]);
        assert_eq!(mixer.sources[&1].buffer.len(), CUSHION);
    }

    #[test]
    fn mixer_skips_ahead_after_a_stall() {
        let start = Instant::now();
        let mut mixer = Mixer::new(start);
        let mut out = Vec::new();
        mixer.tick(start + Duration::from_secs(2), &mut |chunk: &[f32]| {
            out.push(chunk.to_vec())
        });
        assert!(out.is_empty(), "no burst of 200 chunks");
        mixer.tick(
            start + Duration::from_millis(2010),
            &mut |chunk: &[f32]| out.push(chunk.to_vec()),
        );
        assert_eq!(out.len(), 1);
    }
}
