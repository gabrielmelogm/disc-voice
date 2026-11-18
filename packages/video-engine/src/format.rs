//! Platform-independent choice of the capture mode and frame validation.

/// Largest preview size requested from the camera.
pub const MAX_WIDTH: u32 = 1280;
pub const MAX_HEIGHT: u32 = 720;
/// Below this rate motion looks choppy, so a smaller smooth mode wins.
pub const SMOOTH_FPS: f64 = 24.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    /// Compressed by the camera; frames are forwarded without decoding.
    Jpeg,
    /// Uncompressed in system memory; encoded to JPEG by the engine.
    Raw,
}

/// One size and pixel format a camera offers, with its best frame rate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mode {
    pub encoding: Encoding,
    /// GStreamer raw format name (e.g. `YUY2`); `None` for JPEG.
    pub raw_format: Option<String>,
    pub width: u32,
    pub height: u32,
    /// Frame rate as a fraction, as the caps express it.
    pub fps_numerator: i32,
    pub fps_denominator: i32,
}

impl Mode {
    pub fn fps(&self) -> f64 {
        if self.fps_denominator == 0 {
            0.0
        } else {
            f64::from(self.fps_numerator) / f64::from(self.fps_denominator)
        }
    }

    fn area(&self) -> u64 {
        u64::from(self.width) * u64::from(self.height)
    }

    fn fits(&self) -> bool {
        self.width <= MAX_WIDTH && self.height <= MAX_HEIGHT
    }
}

/// Smoothness first, then JPEG (no conversion), then size, then rate.
/// If every mode is larger than the preview limit, the smallest one wins.
pub fn choose(modes: &[Mode]) -> Option<Mode> {
    let best = modes.iter().filter(|mode| mode.fits()).max_by(|a, b| {
        let key = |mode: &Mode| {
            (
                mode.fps() >= SMOOTH_FPS,
                mode.encoding == Encoding::Jpeg,
                mode.area(),
            )
        };
        key(a).cmp(&key(b)).then(a.fps().total_cmp(&b.fps()))
    });
    best.or_else(|| modes.iter().min_by_key(|mode| mode.area()))
        .cloned()
}

/// Cameras sometimes deliver truncated MJPEG frames; drawing them shows
/// garbage, so they are dropped. Trailing zero padding is allowed.
pub fn is_complete_jpeg(data: &[u8]) -> bool {
    let end = data
        .iter()
        .rposition(|&byte| byte != 0)
        .map_or(0, |index| index + 1);
    data.len() >= 4 && data.starts_with(&[0xFF, 0xD8]) && data[..end].ends_with(&[0xFF, 0xD9])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mode(encoding: Encoding, width: u32, height: u32, fps: i32) -> Mode {
        Mode {
            raw_format: (encoding == Encoding::Raw).then(|| "YUY2".into()),
            encoding,
            width,
            height,
            fps_numerator: fps,
            fps_denominator: 1,
        }
    }

    #[test]
    fn prefers_smooth_jpeg_at_the_preview_limit() {
        // Modes a Logitech C920 offers through PipeWire.
        let modes = [
            mode(Encoding::Raw, 640, 480, 30),
            mode(Encoding::Raw, 1280, 720, 10),
            mode(Encoding::Raw, 1920, 1080, 5),
            mode(Encoding::Jpeg, 640, 480, 30),
            mode(Encoding::Jpeg, 1280, 720, 30),
            mode(Encoding::Jpeg, 1920, 1080, 30),
        ];
        assert_eq!(choose(&modes), Some(mode(Encoding::Jpeg, 1280, 720, 30)));
    }

    #[test]
    fn smoothness_beats_resolution_and_encoding() {
        let modes = [
            mode(Encoding::Jpeg, 1280, 720, 5),
            mode(Encoding::Raw, 1280, 720, 10),
            mode(Encoding::Raw, 640, 480, 30),
        ];
        assert_eq!(choose(&modes), Some(mode(Encoding::Raw, 640, 480, 30)));
    }

    #[test]
    fn raw_only_camera_uses_its_largest_smooth_mode() {
        let modes = [
            mode(Encoding::Raw, 320, 240, 30),
            mode(Encoding::Raw, 800, 448, 30),
            mode(Encoding::Raw, 1280, 720, 10),
        ];
        assert_eq!(choose(&modes), Some(mode(Encoding::Raw, 800, 448, 30)));
    }

    #[test]
    fn falls_back_to_the_smallest_oversized_mode() {
        let modes = [
            mode(Encoding::Jpeg, 3840, 2160, 30),
            mode(Encoding::Jpeg, 1920, 1080, 30),
        ];
        assert_eq!(choose(&modes), Some(mode(Encoding::Jpeg, 1920, 1080, 30)));
        assert_eq!(choose(&[]), None);
    }

    #[test]
    fn detects_truncated_jpeg_frames() {
        assert!(is_complete_jpeg(&[0xFF, 0xD8, 1, 2, 0xFF, 0xD9]));
        assert!(is_complete_jpeg(&[0xFF, 0xD8, 1, 0xFF, 0xD9, 0, 0, 0]));
        assert!(!is_complete_jpeg(&[0xFF, 0xD8, 1, 2, 3]));
        assert!(!is_complete_jpeg(&[0, 0xD8, 0xFF, 0xD9]));
        assert!(!is_complete_jpeg(&[]));
    }
}
