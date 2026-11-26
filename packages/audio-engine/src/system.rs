//! The computer's audio, for sharing it with a screen.
//!
//! Everything this process plays (the call itself, notification sounds) is
//! left out, so the people in the call never hear themselves back:
//!
//! - Windows: WASAPI process loopback excluding our process tree (the
//!   WebView2 processes that play the call are our children).
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
const GAP: Duration = Duration::from_millis(60);
/// ...and the clock is re-anchored when real audio runs this far ahead of it.
const AHEAD: Duration = Duration::from_millis(100);

fn frames(duration: Duration) -> u64 {
    (duration.as_secs_f64() * f64::from(RATE)) as u64
}

/// Turns irregular captured audio into steady chunks, filling silence while
/// nothing plays.
pub(crate) struct Pacer {
    sink: ChunkSink,
    pending: Vec<f32>,
    anchor: Instant,
    /// Frames sent since `anchor`.
    sent: u64,
}

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

/// Audio from several applications, summed. Each source is drained whole:
/// a source that is behind adds what it has (applications are not in sync
/// with each other anyway).
#[derive(Default)]
pub(crate) struct Sources {
    buffers: HashMap<u32, VecDeque<f32>>,
}

/// More than this buffered for one source means it stalled: drop its backlog.
const MAX_BACKLOG: usize = CHUNK_SAMPLES * 20;

impl Sources {
    #[allow(dead_code)]
    pub fn push(&mut self, source: u32, samples: &[f32]) {
        let buffer = self.buffers.entry(source).or_default();
        buffer.extend(samples);
        if buffer.len() > MAX_BACKLOG {
            let excess = buffer.len() - CHUNK_SAMPLES;
            buffer.drain(..excess);
        }
    }

    #[allow(dead_code)]
    pub fn remove(&mut self, source: u32) {
        self.buffers.remove(&source);
    }

    /// Everything buffered, mixed; empty when no source has audio.
    #[allow(dead_code)]
    pub fn mix(&mut self) -> Vec<f32> {
        let longest = self
            .buffers
            .values()
            .map(|buffer| buffer.len() / CHANNELS * CHANNELS)
            .max()
            .unwrap_or(0);
        let mut out = vec![0.0_f32; longest];
        for buffer in self.buffers.values_mut() {
            let take = buffer.len() / CHANNELS * CHANNELS;
            for (slot, sample) in out.iter_mut().zip(buffer.drain(..take)) {
                *slot += sample;
            }
        }
        for sample in &mut out {
            *sample = sample.clamp(-1.0, 1.0);
        }
        out
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

    #[test]
    fn sources_sum_and_clip() {
        let mut sources = Sources::default();
        assert!(sources.mix().is_empty());
        sources.push(1, &[0.25; 8]);
        sources.push(2, &[0.5; 4]);
        sources.push(3, &[0.9, 0.9]);
        sources.push(3, &[0.9, 0.9]);
        let mixed = sources.mix();
        assert_eq!(mixed.len(), 8);
        assert_eq!(&mixed[..2], &[1.0, 1.0]);
        assert_eq!(&mixed[2..4], &[1.0, 1.0]);
        assert_eq!(&mixed[4..], &[0.25; 4]);
        assert!(sources.mix().is_empty(), "drained");
    }

    #[test]
    fn sources_keep_whole_frames_and_forget_removed_ones() {
        let mut sources = Sources::default();
        sources.push(1, &[0.1, 0.1, 0.1]);
        assert_eq!(sources.mix().len(), 2);
        sources.push(1, &[0.1]);
        assert_eq!(sources.mix().len(), 2, "the odd sample waited");
        sources.push(2, &[0.3; 4]);
        sources.remove(2);
        assert!(sources.mix().is_empty());
    }

    #[test]
    fn sources_drop_a_stalled_backlog() {
        let mut sources = Sources::default();
        sources.push(1, &vec![0.1; MAX_BACKLOG + CHANNELS]);
        assert_eq!(sources.mix().len(), CHUNK_SAMPLES);
    }
}
