//! Fans every encoded frame (encoded once) out to every connected peer: in a
//! P2P mesh each participant gets its own copy.

use bytes::Bytes;
use rtc::media::Sample;
use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};
use tokio::sync::mpsc::UnboundedReceiver;
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Audio,
    Screen,
    Camera,
    /// The computer's audio, sent with the screen.
    ScreenAudio,
}

/// An Opus packet or an H.264 access unit (Annex B).
pub(crate) struct EncodedFrame {
    pub kind: Kind,
    pub data: Bytes,
    pub duration: Duration,
}

/// Where one of our tracks is written for one peer: the track (one per
/// connection), its SSRC and the payload type the peer negotiated.
#[derive(Clone)]
pub(crate) struct Sink {
    pub track: Arc<TrackLocalStaticSample>,
    pub ssrc: u32,
    pub payload_type: u8,
}

#[derive(Clone, Default)]
pub(crate) struct PeerSinks {
    pub audio: Option<Sink>,
    pub screen: Option<Sink>,
    pub camera: Option<Sink>,
    pub screen_audio: Option<Sink>,
}

impl PeerSinks {
    fn get(&self, kind: Kind) -> Option<&Sink> {
        match kind {
            Kind::Audio => self.audio.as_ref(),
            Kind::Screen => self.screen.as_ref(),
            Kind::Camera => self.camera.as_ref(),
            Kind::ScreenAudio => self.screen_audio.as_ref(),
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct MediaHub {
    sinks: Arc<RwLock<HashMap<String, PeerSinks>>>,
}

impl MediaHub {
    pub fn set(&self, peer: &str, sinks: PeerSinks) {
        if let Ok(mut all) = self.sinks.write() {
            all.insert(peer.to_owned(), sinks);
        }
    }

    pub fn remove(&self, peer: &str) {
        if let Ok(mut all) = self.sinks.write() {
            all.remove(peer);
        }
    }

    pub async fn run(self, mut frames: UnboundedReceiver<EncodedFrame>) {
        while let Some(frame) = frames.recv().await {
            if frame.data.is_empty() {
                continue;
            }
            let targets: Vec<Sink> = match self.sinks.read() {
                Ok(all) => all
                    .values()
                    .filter_map(|sinks| sinks.get(frame.kind).cloned())
                    .collect(),
                Err(_) => return,
            };
            let sample = Sample {
                data: frame.data,
                duration: frame.duration,
                ..Sample::new(Instant::now())
            };
            for sink in targets {
                // A peer that is going away fails here; the others go on.
                let _ = sink
                    .track
                    .write_sample(sink.ssrc, sink.payload_type, &sample, &[])
                    .await;
            }
        }
    }
}
