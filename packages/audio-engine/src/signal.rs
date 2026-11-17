use std::f32::consts::TAU;

pub const MAX_RECORDING_SECONDS: usize = 10;
pub const TONE_SECONDS: usize = 3;

/// Mono PCM is kept in memory only. Capacity is fixed before capture starts.
pub struct Recording {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    limit: usize,
}

impl Recording {
    pub fn new(sample_rate: u32) -> Self {
        let limit = sample_rate as usize * MAX_RECORDING_SECONDS;
        Self {
            samples: Vec::with_capacity(limit),
            sample_rate,
            limit,
        }
    }

    pub fn push_frame(&mut self, samples: impl Iterator<Item = f32>) {
        if self.full() {
            return;
        }
        let (sum, count) = samples.fold((0.0, 0), |(sum, count), sample| {
            (sum + sanitize(sample), count + 1)
        });
        if count > 0 {
            self.samples.push(sum / count as f32);
        }
    }

    pub fn full(&self) -> bool {
        self.samples.len() >= self.limit
    }

    pub fn seconds(&self) -> f64 {
        self.samples.len() as f64 / self.sample_rate.max(1) as f64
    }
}

pub fn sanitize(sample: f32) -> f32 {
    if sample.is_finite() {
        sample.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

/// Linear interpolation is sufficient for short speech diagnostics.
/// The source position uses the ratio of sample rates, preserving duration.
pub fn resampled(samples: &[f32], position: f64) -> f32 {
    let index = position as usize;
    let Some(&first) = samples.get(index) else {
        return 0.0;
    };
    let second = samples.get(index + 1).copied().unwrap_or(first);
    let fraction = (position - index as f64) as f32;
    sanitize(first + (second - first) * fraction)
}

pub struct Playback {
    samples: Option<Vec<f32>>,
    source_rate: u32,
    output_rate: u32,
    frame: usize,
    frames: usize,
    volume: f32,
}

impl Playback {
    pub fn tone(output_rate: u32, volume: f32) -> Self {
        Self {
            samples: None,
            source_rate: output_rate,
            output_rate,
            frame: 0,
            frames: output_rate as usize * TONE_SECONDS,
            volume,
        }
    }

    pub fn recording(recording: &Recording, output_rate: u32, volume: f32) -> Self {
        Self {
            samples: Some(recording.samples.clone()),
            source_rate: recording.sample_rate,
            output_rate,
            frame: 0,
            frames: (recording.samples.len() as f64 * output_rate as f64
                / recording.sample_rate.max(1) as f64)
                .ceil() as usize,
            volume,
        }
    }

    pub fn next_frame(&mut self) -> f32 {
        if self.finished() {
            return 0.0;
        }
        let sample = if let Some(samples) = &self.samples {
            resampled(
                samples,
                self.frame as f64 * self.source_rate as f64 / self.output_rate as f64,
            )
        } else {
            // A quiet sine with 10 ms fades prevents clicks at the boundaries.
            let fade_frames = (self.output_rate as f32 * 0.01).max(1.0);
            let fade_in = (self.frame as f32 / fade_frames).min(1.0);
            let fade_out = ((self.frames - self.frame - 1) as f32 / fade_frames).min(1.0);
            (TAU * 440.0 * self.frame as f32 / self.output_rate as f32).sin()
                * 0.2
                * fade_in
                * fade_out
        };
        self.frame += 1;
        sanitize(sample * self.volume)
    }

    pub fn finished(&self) -> bool {
        self.frame >= self.frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_downmixes_channels_and_caps_memory_at_ten_seconds() {
        let mut recording = Recording::new(10);
        for _ in 0..120 {
            recording.push_frame([0.8, 0.2].into_iter());
        }
        assert_eq!(recording.samples.len(), 100);
        assert_eq!(recording.seconds(), 10.0);
        assert!(recording.full());
        assert!((recording.samples[0] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn invalid_samples_do_not_propagate_nan_or_infinity() {
        let mut recording = Recording::new(10);
        recording.push_frame([f32::NAN, f32::INFINITY, 4.0, -4.0].into_iter());
        assert_eq!(recording.samples, vec![0.0]);
    }

    #[test]
    fn playback_resamples_and_preserves_recording_duration() {
        let mut recording = Recording::new(2);
        recording.samples = vec![0.0, 1.0];
        let mut playback = Playback::recording(&recording, 4, 0.5);
        assert_eq!(playback.next_frame(), 0.0);
        assert_eq!(playback.next_frame(), 0.25);
        assert_eq!(playback.next_frame(), 0.5);
        assert_eq!(playback.next_frame(), 0.5);
        assert!(playback.finished());
        assert_eq!(playback.next_frame(), 0.0);
    }

    #[test]
    fn tone_is_bounded_fades_and_finishes_after_three_seconds() {
        let rate = 48_000;
        let mut playback = Playback::tone(rate, 0.7);
        let samples: Vec<_> = (0..rate as usize * TONE_SECONDS)
            .map(|_| playback.next_frame())
            .collect();
        assert_eq!(samples[0], 0.0);
        assert_eq!(*samples.last().unwrap(), 0.0);
        assert!(samples.iter().all(|sample| sample.abs() <= 0.140_001));
        assert!(samples.iter().any(|sample| sample.abs() > 0.13));
        assert!(playback.finished());
        assert_eq!(playback.next_frame(), 0.0);
    }

    #[test]
    fn zero_volume_produces_silence() {
        let mut playback = Playback::tone(48_000, 0.0);
        for _ in 0..1000 {
            assert_eq!(playback.next_frame(), 0.0);
        }
    }
}
