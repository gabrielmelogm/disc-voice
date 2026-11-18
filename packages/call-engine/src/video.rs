//! Shared screens as H.264 (OpenH264, built from source): ours is encoded
//! once, straight from the capture's I420 frames, for every peer; each
//! peer's is reassembled from RTP, decoded, and compressed to JPEG for the
//! UI on a second thread, so decoding and compressing overlap.

use crate::{
    engine::{CallEvent, FrameSource, Shared},
    hub::{EncodedFrame, Kind},
};
use bytes::Bytes;
use disc_video::RawFrame;
use openh264::{
    decoder::Decoder,
    encoder::{BitRate, Encoder, EncoderConfig, FrameRate, RateControlMode, UsageType},
    formats::{YUVSlices, YUVSource},
    OpenH264API,
};
use rtc::{
    media::io::sample_builder::SampleBuilder,
    rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication,
    rtp::codec::h264::H264Packet,
};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tokio::sync::mpsc::UnboundedSender;
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};

/// Upload per participant, as the browser client: sharp enough for text.
const BITRATE: u32 = 2_500_000;
const FRAME_WAIT: Duration = Duration::from_millis(250);
/// Screens only produce frames when their content changes; the last one is
/// sent again this often so a still screen keeps flowing.
const REPEAT: Duration = Duration::from_secs(1);
/// How often we may ask a peer for a keyframe while we cannot decode.
const PLI_EVERY: Duration = Duration::from_secs(1);
/// What the UI draws: fast to compress, still sharp for text.
const JPEG_QUALITY: u8 = 80;

/// Owners of the frame slots, unique per receiver.
static NEXT_OWNER: AtomicU64 = AtomicU64::new(1);

/// A raw capture frame as the encoder reads it, without copying.
pub(crate) fn planes(frame: &RawFrame) -> YUVSlices<'_> {
    let (width, height) = (frame.width as usize, frame.height as usize);
    let (y, chroma) = frame.i420.split_at(width * height);
    let (u, v) = chroma.split_at(width * height / 4);
    YUVSlices::new((y, u, v), (width, height), (width, width / 2, width / 2))
}

pub(crate) struct ScreenEncoder {
    pub(crate) encoder: Encoder,
    size: (usize, usize),
}

impl ScreenEncoder {
    pub(crate) fn new(frame_rate: u32, size: (usize, usize)) -> Result<Self, String> {
        let config = EncoderConfig::new()
            .bitrate(BitRate::from_bps(BITRATE))
            .max_frame_rate(FrameRate::from_hz(frame_rate.max(1) as f32))
            .rate_control_mode(RateControlMode::Bitrate)
            .usage_type(UsageType::ScreenContentRealTime)
            // With skipping on, every keyframe (~250 KB at 1080p) made the
            // rate control drop ~15 frames to stay on budget: the screen
            // froze for half a second. Without it the average stays the
            // same and only the keyframe itself goes over.
            .skip_frames(false);
        let encoder = Encoder::with_api_config(OpenH264API::from_source(), config)
            .map_err(|error| format!("Não foi possível iniciar o codificador de vídeo: {error}"))?;
        Ok(Self { encoder, size })
    }
}

/// Our screen, encoded for the hub.
pub(crate) struct ScreenSender {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl ScreenSender {
    pub fn start(
        mut source: FrameSource,
        frame_rate: u32,
        shared: Arc<Shared>,
        out: UnboundedSender<EncodedFrame>,
    ) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let thread = thread::Builder::new()
            .name("disc-call-screen".into())
            .spawn(move || {
                let mut encoder: Option<ScreenEncoder> = None;
                let mut last: Option<Arc<RawFrame>> = None;
                let mut sent = Instant::now();
                while !flag.load(Ordering::Relaxed) {
                    match source(FRAME_WAIT) {
                        Ok(Some(frame)) => last = Some(frame),
                        Ok(None) if last.is_some() && sent.elapsed() >= REPEAT => {}
                        Ok(None) => continue,
                        Err(message) => {
                            if !flag.load(Ordering::Relaxed) {
                                shared.emit(CallEvent::ScreenEnded { message });
                            }
                            break;
                        }
                    }
                    let Some(frame) = &last else { continue };
                    let yuv = planes(frame);
                    let size = yuv.dimensions();
                    if encoder.as_ref().is_none_or(|current| current.size != size) {
                        match ScreenEncoder::new(frame_rate, size) {
                            Ok(created) => encoder = Some(created),
                            Err(message) => {
                                shared.emit(CallEvent::ScreenEnded { message });
                                break;
                            }
                        }
                        shared.keyframe.store(true, Ordering::Relaxed);
                    }
                    let encoder = &mut encoder.as_mut().expect("created above").encoder;
                    // Keyframes only when needed: a new peer, a new size, or
                    // a peer that lost a picture (PLI/FIR).
                    if shared.keyframe.swap(false, Ordering::Relaxed) {
                        encoder.force_intra_frame();
                    }
                    let Ok(bitstream) = encoder.encode(&yuv) else {
                        continue;
                    };
                    let data = bitstream.to_vec();
                    let duration = sent.elapsed().clamp(Duration::from_millis(1), REPEAT);
                    sent = Instant::now();
                    if !data.is_empty() {
                        let _ = out.send(EncodedFrame {
                            kind: Kind::Screen,
                            data: Bytes::from(data),
                            duration,
                        });
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}

impl Drop for ScreenSender {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // The thread wakes within one frame wait; never block the caller
        // (an IPC command) for longer than that.
        if let Some(thread) = self.thread.take() {
            let deadline = Instant::now() + FRAME_WAIT * 2;
            while !thread.is_finished() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(5));
            }
            if thread.is_finished() {
                let _ = thread.join();
            }
        }
    }
}

/// A decoded picture (RGB24) on its way to the JPEG compressor.
struct Picture {
    width: usize,
    height: usize,
    pixels: Vec<u8>,
}

fn jpeg(picture: &Picture) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(picture.pixels.len() / 10);
    jpeg_encoder::Encoder::new(&mut out, JPEG_QUALITY)
        .encode(
            &picture.pixels,
            u16::try_from(picture.width).ok()?,
            u16::try_from(picture.height).ok()?,
            jpeg_encoder::ColorType::Rgb,
        )
        .ok()?;
    Some(out)
}

/// A one-picture mailbox between the decoder and the compressor.
#[derive(Default)]
struct Latest {
    state: Mutex<(Option<Picture>, bool)>,
    ready: Condvar,
}

impl Latest {
    fn put(&self, picture: Picture) {
        if let Ok(mut state) = self.state.lock() {
            state.0 = Some(picture);
            self.ready.notify_one();
        }
    }

    fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.1 = true;
            self.ready.notify_one();
        }
    }

    /// The next picture; `None` once closed.
    fn take(&self) -> Option<Picture> {
        let mut state = self.state.lock().ok()?;
        loop {
            if let Some(picture) = state.0.take() {
                return Some(picture);
            }
            if state.1 {
                return None;
            }
            state = self.ready.wait(state).ok()?;
        }
    }
}

/// Receives one peer's screen until its track ends.
pub(crate) async fn receive(peer: String, track: Arc<dyn TrackRemote>, shared: Arc<Shared>) {
    let owner = NEXT_OWNER.fetch_add(1, Ordering::Relaxed);
    let (units, decode) = mpsc::channel::<Bytes>();
    let (wants_keyframe, mut keyframe_requests) = tokio::sync::mpsc::unbounded_channel::<()>();
    let pictures = Arc::new(Latest::default());
    let compressor = {
        let (pictures, shared, peer) = (pictures.clone(), shared.clone(), peer.clone());
        thread::Builder::new()
            .name("disc-call-jpeg".into())
            .spawn(move || {
                while let Some(picture) = pictures.take() {
                    if let Some(jpeg) = jpeg(&picture) {
                        shared.frames.publish(&peer, owner, jpeg);
                    }
                }
            })
    };
    if compressor.is_err() {
        return;
    }
    let decoder_pictures = pictures.clone();
    let decoder_shared = shared.clone();
    let decoder_peer = peer.clone();
    // Decoding runs on its own thread so it never stalls the network tasks.
    let decoder = thread::Builder::new()
        .name("disc-call-decode".into())
        .spawn(move || {
            let shared = decoder_shared;
            let Ok(mut decoder) = Decoder::new() else {
                return;
            };
            let mut active = false;
            let mut asked: Option<Instant> = None;
            let ask = |asked: &mut Option<Instant>| {
                if asked.is_none_or(|at| at.elapsed() >= PLI_EVERY) {
                    *asked = Some(Instant::now());
                    let _ = wants_keyframe.send(());
                }
            };
            while let Ok(unit) = decode.recv() {
                match decoder.decode(&unit) {
                    Ok(Some(yuv)) => {
                        let (width, height) = yuv.dimensions();
                        let mut pixels = vec![0; width * height * 3];
                        yuv.write_rgb8(&mut pixels);
                        // Replaces a picture the compressor has not taken
                        // yet: a slow UI skips frames instead of lagging.
                        decoder_pictures.put(Picture {
                            width,
                            height,
                            pixels,
                        });
                        if !active {
                            active = true;
                            shared.emit(CallEvent::Screen {
                                peer_id: decoder_peer.clone(),
                                active: true,
                            });
                        }
                    }
                    Ok(None) if !active => ask(&mut asked),
                    Ok(None) => {}
                    Err(_) => ask(&mut asked),
                }
            }
            decoder_pictures.close();
            if shared.frames.release(&decoder_peer, owner) && active {
                shared.emit(CallEvent::Screen {
                    peer_id: decoder_peer,
                    active: false,
                });
            }
        });
    if decoder.is_err() {
        return;
    }

    let mut builder = SampleBuilder::new(512, H264Packet::default(), 90_000)
        .with_max_time_delay(Duration::from_millis(400));
    let mut media_ssrc = 0;
    loop {
        tokio::select! {
            event = track.poll() => {
                match event {
                    Some(TrackRemoteEvent::OnRtpPacket(packet)) => {
                        media_ssrc = packet.header.ssrc;
                        let now = Instant::now();
                        builder.push(now, packet);
                        while let Some(sample) = builder.pop(now) {
                            if units.send(sample.data).is_err() {
                                return;
                            }
                        }
                    }
                    Some(TrackRemoteEvent::OnEnded) | None => break,
                    Some(_) => {}
                }
            }
            Some(()) = keyframe_requests.recv() => {
                if media_ssrc != 0 {
                    let _ = track
                        .write_rtcp(vec![Box::new(PictureLossIndication {
                            sender_ssrc: 0,
                            media_ssrc,
                        })])
                        .await;
                }
            }
        }
        if !shared.alive() {
            break;
        }
    }
    // Dropping the sender ends the decoder thread, which releases the slot.
    drop(units);
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A screen-like test frame: I420 with a moving bar.
    pub(crate) fn raw(width: u32, height: u32, shift: usize) -> RawFrame {
        let (w, h) = (width as usize, height as usize);
        let mut i420 = vec![128; w * h * 3 / 2];
        for (i, luma) in i420[..w * h].iter_mut().enumerate() {
            *luma = if (i % w + shift) % 64 < 8 { 30 } else { 230 };
        }
        RawFrame {
            width,
            height,
            i420,
        }
    }

    #[test]
    fn raw_frames_survive_an_encode_decode_round_trip() {
        let frame = raw(160, 90, 0);
        let yuv = planes(&frame);
        let mut encoder = ScreenEncoder::new(30, yuv.dimensions()).unwrap();
        encoder.encoder.force_intra_frame();
        let mut decoder = Decoder::new().unwrap();
        let mut decoded = None;
        for _ in 0..3 {
            let bits = encoder.encoder.encode(&yuv).unwrap().to_vec();
            if let Ok(Some(picture)) = decoder.decode(&bits) {
                decoded = Some(picture.dimensions());
            }
        }
        assert_eq!(decoded, Some((160, 90)));
    }

    #[test]
    fn keyframes_do_not_make_the_encoder_drop_frames() {
        let frames: Vec<RawFrame> = (0..60).map(|i| raw(1280, 720, i * 4)).collect();
        let mut encoder = ScreenEncoder::new(30, (1280, 720)).unwrap();
        let mut sent = 0;
        for (i, frame) in frames.iter().enumerate() {
            if i % 20 == 0 {
                encoder.encoder.force_intra_frame();
            }
            if !encoder
                .encoder
                .encode(&planes(frame))
                .unwrap()
                .to_vec()
                .is_empty()
            {
                sent += 1;
            }
        }
        assert_eq!(sent, 60);
    }

    #[test]
    fn the_mailbox_keeps_only_the_newest_picture() {
        let latest = Latest::default();
        let picture = |width| Picture {
            width,
            height: 2,
            pixels: vec![0; width * 6],
        };
        latest.put(picture(2));
        latest.put(picture(4));
        assert_eq!(latest.take().map(|p| p.width), Some(4));
        latest.close();
        assert!(latest.take().is_none());
        assert!(jpeg(&picture(4)).is_some_and(|jpeg| jpeg.starts_with(&[0xFF, 0xD8])));
    }
}
