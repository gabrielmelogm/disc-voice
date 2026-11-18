//! Linux backend: the camera portal plus PipeWire, through GStreamer.
//!
//! WebKitGTK's own capture runs `pipewiresrc` with `use-bufferpool=false`,
//! which hands out frames whose memory becomes invalid (garbled preview and
//! crashes in the web process). This backend owns its pipeline instead: it
//! asks the portal for a PipeWire remote (the same path a Flatpak sandbox
//! uses), keeps the buffer pool on and delivers JPEG frames.

use crate::backend::{Backend, BackendDevice, FrameSink, RawSize};
use crate::format::{Encoding, Mode};
use crate::portal::{self, Outcome};
use gio::glib;
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use std::{
    os::fd::{AsRawFd, OwnedFd},
    sync::OnceLock,
    time::Duration,
};

const CAMERA_INTERFACE: &str = "org.freedesktop.portal.Camera";
/// The portal may show a permission dialog; give the user time to answer.
const ACCESS_TIMEOUT: Duration = Duration::from_secs(60);
const JPEG_QUALITY: i32 = 85;

const NO_PORTAL: &str = "O portal de câmera do sistema não está disponível. \
                         Verifique se o xdg-desktop-portal está em execução.";
const DENIED: &str = "Acesso à câmera negado. Permita a câmera para o DiscVoice nas \
                      configurações de privacidade do sistema.";
const NO_PROVIDER: &str = "O suporte do GStreamer ao PipeWire não está instalado \
                           (pacote pipewire-gstreamer).";
const BUILD_FAILED: &str = "Não foi possível montar a captura da webcam.";

/// A PipeWire video source, identified by its node name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PipeWireDevice {
    node: String,
}

pub struct PipeWireBackend {
    access_granted: bool,
}

impl PipeWireBackend {
    /// Does not touch the portal yet: a missing portal must not stop the app
    /// from opening, it only makes listing cameras report an error.
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            access_granted: false,
        })
    }

    fn open_remote(&mut self) -> Result<OwnedFd, String> {
        init()?;
        let connection = portal::session_bus().map_err(|error| format!("{NO_PORTAL} ({error})"))?;
        if !self.access_granted {
            access_camera(&connection)?;
            self.access_granted = true;
        }
        portal::open_pipewire_remote(&connection, CAMERA_INTERFACE, &[])
            .map_err(|error| format!("{DENIED} ({error})"))
    }
}

impl Backend for PipeWireBackend {
    type Device = PipeWireDevice;
    type Stream = PipeWireStream;

    fn devices(&mut self) -> Result<Vec<BackendDevice<PipeWireDevice>>, String> {
        let remote = self.open_remote()?;
        Ok(video_sources(&remote)?
            .iter()
            .filter_map(|device| {
                Some(BackendDevice {
                    device: PipeWireDevice {
                        node: node_name(device)?,
                    },
                    name: device.display_name().to_string(),
                    modes: device.caps().map(|caps| modes(&caps)).unwrap_or_default(),
                })
            })
            .collect())
    }

    fn open(
        &mut self,
        device: &PipeWireDevice,
        mode: &Mode,
        sink: FrameSink,
        raw: Option<RawSize>,
    ) -> Result<PipeWireStream, String> {
        let remote = self.open_remote()?;
        let pipeline = build_pipeline(&remote, &device.node, mode, sink, raw)?;
        let stream = PipeWireStream {
            pipeline,
            _remote: remote,
        };
        stream
            .pipeline
            .set_state(gst::State::Playing)
            .map_err(|_| {
                "Não foi possível iniciar a webcam. Verifique se outro aplicativo está \
                 usando a câmera."
                    .to_string()
            })?;
        Ok(stream)
    }
}

/// A running capture. Dropping it stops the pipeline before the PipeWire
/// remote it uses is closed.
pub struct PipeWireStream {
    pipeline: gst::Pipeline,
    _remote: OwnedFd,
}

impl Drop for PipeWireStream {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

pub(crate) fn init() -> Result<(), String> {
    static INIT: OnceLock<Result<(), String>> = OnceLock::new();
    INIT.get_or_init(|| gst::init().map_err(|error| format!("GStreamer indisponível: {error}")))
        .clone()
}

/// Asks the portal for camera access. Outside a sandbox this answers
/// immediately; inside one the desktop may show a permission dialog first.
fn access_camera(connection: &gio::DBusConnection) -> Result<(), String> {
    let outcome = portal::request(
        connection,
        CAMERA_INTERFACE,
        "AccessCamera",
        &[],
        &[],
        ACCESS_TIMEOUT,
        &|| false,
    )
    .map_err(|error| format!("{NO_PORTAL} ({error})"))?;
    match outcome {
        Outcome::Granted(_) => Ok(()),
        Outcome::Cancelled | Outcome::Denied => Err(DENIED.to_string()),
        Outcome::TimedOut => {
            Err("O sistema não respondeu ao pedido de acesso à câmera.".to_string())
        }
    }
}

/// Lists PipeWire video sources visible through `remote`.
fn video_sources(remote: &OwnedFd) -> Result<Vec<gst::Device>, String> {
    let provider =
        gst::DeviceProviderFactory::by_name("pipewiredeviceprovider").ok_or(NO_PROVIDER)?;
    if provider.find_property("fd").is_none() {
        return Err(NO_PROVIDER.into());
    }
    provider.set_property("fd", remote.as_raw_fd());
    provider
        .start()
        .map_err(|_| "Não foi possível listar as câmeras do PipeWire.")?;
    let devices = provider
        .devices()
        .into_iter()
        .filter(|device| device.has_classes("Video/Source"))
        .collect();
    provider.stop();
    Ok(devices)
}

fn node_name(device: &gst::Device) -> Option<String> {
    device.properties()?.get::<String>("node.name").ok()
}

/// Converts device caps into capture modes the backend can handle: MJPEG and
/// raw formats in system memory (DMA-BUF and H.264 are skipped).
fn modes(caps: &gst::CapsRef) -> Vec<Mode> {
    caps.iter()
        .filter_map(|structure| {
            let encoding = match structure.name().as_str() {
                "image/jpeg" => Encoding::Jpeg,
                "video/x-raw" => Encoding::Raw,
                _ => return None,
            };
            let raw_format = match encoding {
                Encoding::Jpeg => None,
                Encoding::Raw => {
                    let format = structure.get::<String>("format").ok()?;
                    (format != "DMA_DRM").then_some(format)
                }
            };
            let width = u32::try_from(structure.get::<i32>("width").ok()?).ok()?;
            let height = u32::try_from(structure.get::<i32>("height").ok()?).ok()?;
            let rate = max_frame_rate(structure.value("framerate").ok()?)?;
            Some(Mode {
                encoding,
                raw_format,
                width,
                height,
                fps_numerator: rate.numer(),
                fps_denominator: rate.denom(),
            })
        })
        .collect()
}

fn max_frame_rate(value: &glib::SendValue) -> Option<gst::Fraction> {
    let as_f64 = |rate: &gst::Fraction| f64::from(rate.numer()) / f64::from(rate.denom().max(1));
    if let Ok(rate) = value.get::<gst::Fraction>() {
        return Some(rate);
    }
    if let Ok(list) = value.get::<gst::List>() {
        return list
            .iter()
            .filter_map(|value| value.get::<gst::Fraction>().ok())
            .max_by(|a, b| as_f64(a).total_cmp(&as_f64(b)));
    }
    if let Ok(range) = value.get::<gst::FractionRange>() {
        return Some(range.max());
    }
    None
}

pub(crate) fn element(name: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(name)
        .build()
        .map_err(|_| format!("O elemento GStreamer \"{name}\" não está instalado."))
}

fn build_pipeline(
    remote: &OwnedFd,
    node: &str,
    mode: &Mode,
    sink: FrameSink,
    raw: Option<RawSize>,
) -> Result<gst::Pipeline, String> {
    let pipeline = gst::Pipeline::new();
    let source = gst::ElementFactory::make("pipewiresrc")
        .property("fd", remote.as_raw_fd())
        .property("target-object", node)
        // The pool keeps buffer memory valid while frames are used downstream;
        // without it pipewiresrc hands out frames that get corrupted.
        .property("use-bufferpool", true)
        .property("do-timestamp", true)
        .build()
        .map_err(|_| NO_PROVIDER)?;
    let rate = gst::Fraction::new(mode.fps_numerator, mode.fps_denominator);
    let caps = match mode.encoding {
        Encoding::Jpeg => gst::Caps::builder("image/jpeg"),
        Encoding::Raw => gst::Caps::builder("video/x-raw")
            .field("format", mode.raw_format.as_deref().unwrap_or("YUY2")),
    }
    .field("width", mode.width as i32)
    .field("height", mode.height as i32)
    .field("framerate", rate)
    .build();
    let filter = gst::ElementFactory::make("capsfilter")
        .property("caps", &caps)
        .build()
        .map_err(|_| NO_PROVIDER)?;
    let sink_element = || {
        gst_app::AppSink::builder()
            .max_buffers(1)
            .drop(true)
            .sync(false)
            .build()
    };
    let appsink = sink_element();

    // The JPEG branch: the preview (and our own tile in a call).
    let mut jpeg_branch = Vec::new();
    if mode.encoding == Encoding::Raw {
        jpeg_branch.push(element("videoconvert")?);
        let encoder = element("jpegenc")?;
        encoder.set_property("quality", JPEG_QUALITY);
        jpeg_branch.push(encoder);
    }
    jpeg_branch.push(appsink.clone().upcast());

    let refused = "A câmera recusou o formato escolhido.";
    let head = [source, filter];
    pipeline.add_many(&head).map_err(|_| BUILD_FAILED)?;
    gst::Element::link_many(&head).map_err(|_| refused)?;
    match raw {
        None => {
            pipeline.add_many(&jpeg_branch).map_err(|_| BUILD_FAILED)?;
            head[1].link(&jpeg_branch[0]).map_err(|_| refused)?;
            gst::Element::link_many(&jpeg_branch).map_err(|_| refused)?;
        }
        Some(size) => {
            // A call also needs I420 at its own size for the H.264 encoder.
            // Each branch drops frames on its own, so a slow preview never
            // slows the call down (or the reverse).
            let branch_queue = || {
                gst::ElementFactory::make("queue")
                    .property("max-size-buffers", 1u32)
                    .property("max-size-bytes", 0u32)
                    .property("max-size-time", 0u64)
                    .property_from_str("leaky", "downstream")
                    .build()
                    .map_err(|_| BUILD_FAILED)
            };
            let tee = element("tee")?;
            let raw_sink = sink_element();
            let mut raw_branch = vec![branch_queue()?];
            if mode.encoding == Encoding::Jpeg {
                raw_branch.push(element("jpegdec")?);
            }
            raw_branch.push(element("videoconvert")?);
            raw_branch.push(element("videoscale")?);
            raw_branch.push(
                gst::ElementFactory::make("capsfilter")
                    .property(
                        "caps",
                        gst::Caps::builder("video/x-raw")
                            .field("format", "I420")
                            .field("width", size.width as i32)
                            .field("height", size.height as i32)
                            .field("pixel-aspect-ratio", gst::Fraction::new(1, 1))
                            .build(),
                    )
                    .build()
                    .map_err(|_| BUILD_FAILED)?,
            );
            raw_branch.push(raw_sink.clone().upcast());
            jpeg_branch.insert(0, branch_queue()?);
            pipeline.add(&tee).map_err(|_| BUILD_FAILED)?;
            pipeline.add_many(&jpeg_branch).map_err(|_| BUILD_FAILED)?;
            pipeline.add_many(&raw_branch).map_err(|_| BUILD_FAILED)?;
            head[1].link(&tee).map_err(|_| refused)?;
            for branch in [&jpeg_branch, &raw_branch] {
                tee.link(&branch[0]).map_err(|_| BUILD_FAILED)?;
                gst::Element::link_many(branch.as_slice()).map_err(|_| refused)?;
            }
            let raw_frames = sink.clone();
            raw_sink.set_callbacks(
                gst_app::AppSinkCallbacks::builder()
                    .new_sample(move |appsink| {
                        let sample = appsink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                        if let Some((width, height, i420)) = crate::screencast::packed_i420(&sample)
                        {
                            raw_frames.publish_raw(width, height, i420);
                        }
                        Ok(gst::FlowSuccess::Ok)
                    })
                    .build(),
            );
        }
    }

    let frames = sink.clone();
    appsink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |appsink| {
                let sample = appsink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                if let Some(map) = sample
                    .buffer()
                    .and_then(|buffer| buffer.map_readable().ok())
                {
                    frames.publish(map.as_slice());
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    // Errors are reported to the worker; every other message is dropped so
    // the bus never fills up (nothing iterates a main loop for this pipeline).
    pipeline
        .bus()
        .ok_or(BUILD_FAILED)?
        .set_sync_handler(move |_, message| {
            if let gst::MessageView::Error(error) = message.view() {
                sink.fail(format!("A webcam parou de enviar vídeo: {}", error.error()));
            }
            gst::BusSyncReply::Drop
        });
    Ok(pipeline)
}

#[cfg(test)]
mod tests {
    use crate::{format, CameraEngine};
    use std::time::{Duration, Instant};

    /// Needs a camera and the desktop camera portal; frames are discarded.
    #[test]
    #[ignore = "needs a webcam and xdg-desktop-portal with PipeWire"]
    fn captures_valid_jpeg_frames_from_the_portal() {
        let engine = CameraEngine::new().unwrap();
        let devices = engine.devices().unwrap();
        assert!(!devices.is_empty(), "no camera found");
        let info = engine.start(&devices[0].id).unwrap();
        assert!(info.width > 0 && info.width <= format::MAX_WIDTH);

        let started = Instant::now();
        let mut frames = 0;
        while started.elapsed() < Duration::from_secs(4) {
            if let Some(frame) = engine.next_frame(Duration::from_millis(500)).unwrap() {
                assert!(format::is_complete_jpeg(&frame));
                frames += 1;
            }
        }
        let fps = frames as f64 / started.elapsed().as_secs_f64();
        println!("{info:?}: {frames} frames, {fps:.1} fps");
        assert!(frames >= 20, "only {frames} frames in 4 s");

        engine.stop();
        assert_eq!(engine.next_frame(Duration::from_millis(50)), Ok(None));
        engine.shutdown();
    }

    /// A call also gets raw I420 frames at its quality, beside the JPEGs.
    #[test]
    #[ignore = "needs a webcam and xdg-desktop-portal with PipeWire"]
    fn captures_raw_frames_for_a_call() {
        let engine = CameraEngine::new().unwrap();
        let devices = engine.devices().unwrap();
        assert!(!devices.is_empty(), "no camera found");
        let info = engine.start_for_call(&devices[0].id, 360).unwrap();
        let expected = crate::RawSize::fit(info.width, info.height, 360);

        let started = Instant::now();
        let (mut jpegs, mut raws) = (0, 0);
        while started.elapsed() < Duration::from_secs(4) {
            if let Some(frame) = engine.next_raw_frame(Duration::from_millis(100)).unwrap() {
                assert_eq!(
                    (frame.width, frame.height),
                    (expected.width, expected.height)
                );
                assert_eq!(
                    frame.i420.len(),
                    (frame.width * frame.height * 3 / 2) as usize
                );
                raws += 1;
            }
            if engine.next_frame(Duration::ZERO).unwrap().is_some() {
                jpegs += 1;
            }
        }
        println!("{info:?} -> {expected:?}: {raws} raw, {jpegs} jpeg in 4 s");
        assert!(raws >= 20, "only {raws} raw frames in 4 s");
        assert!(jpegs >= 10, "only {jpegs} jpeg frames in 4 s");
        engine.stop();
        engine.shutdown();
    }
}
