//! Linux webcam capture through the camera portal and PipeWire.
//!
//! WebKitGTK's own capture runs `pipewiresrc` with `use-bufferpool=false`,
//! which hands out frames whose memory becomes invalid (garbled preview and
//! crashes in the web process). This engine owns its pipeline instead: it asks
//! the portal for a PipeWire remote (the same path a Flatpak sandbox uses),
//! keeps the buffer pool on, and hands JPEG frames to the UI.

use crate::format::{self, Encoding, Mode};
use gio::{glib, prelude::*};
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use serde::Serialize;
use std::{
    cell::Cell,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    rc::Rc,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

const PORTAL_BUS_NAME: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const CAMERA_INTERFACE: &str = "org.freedesktop.portal.Camera";
const REQUEST_INTERFACE: &str = "org.freedesktop.portal.Request";
const PORTAL_CALL_TIMEOUT_MS: i32 = 5_000;
/// The portal may show a permission dialog; give the user time to answer.
const ACCESS_TIMEOUT: Duration = Duration::from_secs(60);
const JPEG_QUALITY: i32 = 85;

const NO_PORTAL: &str = "O portal de câmera do sistema não está disponível. \
                         Verifique se o xdg-desktop-portal está em execução.";
const DENIED: &str = "Acesso à câmera negado. Permita a câmera para o DiscVoice nas \
                      configurações de privacidade do sistema.";
const NO_PROVIDER: &str = "O suporte do GStreamer ao PipeWire não está instalado \
                           (pacote pipewire-gstreamer).";
const NOT_FOUND: &str = "A câmera selecionada não está disponível. Atualize os dispositivos.";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraDevice {
    /// PipeWire node name: stable across sessions and reconnections.
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraInfo {
    pub device_id: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
    /// `true` when the camera's own MJPEG is forwarded without re-encoding.
    pub passthrough: bool,
}

/// Latest frame, shared between the GStreamer streaming thread and readers.
#[derive(Default)]
struct Frames {
    /// Increments on every start, so late frames of a stopped session are ignored.
    generation: u64,
    sequence: u64,
    delivered: u64,
    latest: Option<Arc<Vec<u8>>>,
    error: Option<String>,
    running: bool,
}

struct Shared {
    frames: Mutex<Frames>,
    changed: Condvar,
}

impl Shared {
    fn publish(&self, generation: u64, frame: Vec<u8>) {
        let Ok(mut frames) = self.frames.lock() else {
            return;
        };
        if frames.generation != generation || !frames.running {
            return;
        }
        frames.sequence += 1;
        frames.latest = Some(Arc::new(frame));
        self.changed.notify_all();
    }

    fn fail(&self, generation: u64, error: String) {
        let Ok(mut frames) = self.frames.lock() else {
            return;
        };
        if frames.generation == generation && frames.running && frames.error.is_none() {
            frames.error = Some(error);
            self.changed.notify_all();
        }
    }
}

/// An open capture. Dropping it stops the pipeline before the PipeWire
/// remote it uses is closed.
struct Session {
    pipeline: gst::Pipeline,
    _remote: OwnedFd,
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

struct Inner {
    shared: Arc<Shared>,
    session: Mutex<Option<Session>>,
    access_granted: AtomicBool,
}

/// Thread-safe handle; every method may block briefly and should run off
/// the UI thread.
#[derive(Clone)]
pub struct CameraEngine {
    inner: Arc<Inner>,
}

impl Default for CameraEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl CameraEngine {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                shared: Arc::new(Shared {
                    frames: Mutex::new(Frames::default()),
                    changed: Condvar::new(),
                }),
                session: Mutex::new(None),
                access_granted: AtomicBool::new(false),
            }),
        }
    }

    pub fn devices(&self) -> Result<Vec<CameraDevice>, String> {
        let remote = self.open_remote()?;
        let devices = video_sources(&remote)?;
        Ok(devices
            .iter()
            .filter_map(|device| {
                Some(CameraDevice {
                    id: node_name(device)?,
                    name: device.display_name().to_string(),
                })
            })
            .collect())
    }

    /// Starts capture on `device_id` (or the first camera when empty),
    /// replacing any running capture.
    pub fn start(&self, device_id: &str) -> Result<CameraInfo, String> {
        self.stop();
        let remote = self.open_remote()?;
        let devices = video_sources(&remote)?;
        let device = devices
            .iter()
            .find(|device| device_id.is_empty() || node_name(device).as_deref() == Some(device_id))
            .ok_or(NOT_FOUND)?;
        let node = node_name(device).ok_or(NOT_FOUND)?;
        let mode = device
            .caps()
            .and_then(|caps| format::choose(&modes(&caps)))
            .ok_or("A câmera não oferece um formato de vídeo compatível.")?;

        let generation = {
            let mut frames = self.lock_frames();
            frames.generation += 1;
            frames.sequence = 0;
            frames.delivered = 0;
            frames.latest = None;
            frames.error = None;
            frames.running = true;
            frames.generation
        };
        let pipeline = build_pipeline(&remote, &node, &mode, &self.inner.shared, generation)
            .inspect_err(|_| self.lock_frames().running = false)?;
        let session = Session {
            pipeline,
            _remote: remote,
        };
        if session.pipeline.set_state(gst::State::Playing).is_err() {
            self.lock_frames().running = false;
            return Err(
                "Não foi possível iniciar a webcam. Verifique se outro aplicativo \
                        está usando a câmera."
                    .into(),
            );
        }
        *self.inner.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(session);
        Ok(CameraInfo {
            device_id: node,
            width: mode.width,
            height: mode.height,
            frame_rate: mode.fps(),
            passthrough: mode.encoding == Encoding::Jpeg,
        })
    }

    pub fn stop(&self) {
        {
            let mut frames = self.lock_frames();
            frames.running = false;
            frames.latest = None;
            self.inner.shared.changed.notify_all();
        }
        let session = self
            .inner
            .session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        drop(session);
    }

    /// Waits up to `timeout` for a frame newer than the last one returned.
    /// `Ok(None)` means no new frame (timeout or not capturing); an error
    /// means the capture stopped and should be shown to the user.
    pub fn next_frame(&self, timeout: Duration) -> Result<Option<Arc<Vec<u8>>>, String> {
        let shared = &self.inner.shared;
        let frames = self.lock_frames();
        let (mut frames, _) = shared
            .changed
            .wait_timeout_while(frames, timeout, |frames| {
                frames.running && frames.error.is_none() && frames.sequence == frames.delivered
            })
            .unwrap_or_else(|e| e.into_inner());
        if let Some(error) = frames.error.clone() {
            return Err(error);
        }
        if !frames.running || frames.sequence == frames.delivered {
            return Ok(None);
        }
        frames.delivered = frames.sequence;
        Ok(frames.latest.clone())
    }

    fn lock_frames(&self) -> std::sync::MutexGuard<'_, Frames> {
        self.inner
            .shared
            .frames
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    fn open_remote(&self) -> Result<OwnedFd, String> {
        init()?;
        let connection = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE)
            .map_err(|error| format!("{NO_PORTAL} ({error})"))?;
        if !self.inner.access_granted.load(Ordering::Relaxed) {
            access_camera(&connection)?;
            self.inner.access_granted.store(true, Ordering::Relaxed);
        }
        open_pipewire_remote(&connection)
    }
}

fn init() -> Result<(), String> {
    static INIT: OnceLock<Result<(), String>> = OnceLock::new();
    INIT.get_or_init(|| gst::init().map_err(|error| format!("GStreamer indisponível: {error}")))
        .clone()
}

fn options(entries: &[(&str, glib::Variant)]) -> glib::Variant {
    let dict = glib::VariantDict::new(None);
    for (key, value) in entries {
        dict.insert_value(key, value);
    }
    // A `(a{sv})` tuple; `(variant,).to_variant()` would box it as `(v)`.
    glib::Variant::tuple_from_iter([dict.end()])
}

/// Asks the portal for camera access, waiting for its `Response` signal.
/// Outside a sandbox this answers immediately; inside one the desktop may
/// show a permission dialog first.
fn access_camera(connection: &gio::DBusConnection) -> Result<(), String> {
    let token = format!("discvoice{}", std::process::id());
    let sender = connection
        .unique_name()
        .ok_or(NO_PORTAL)?
        .trim_start_matches(':')
        .replace('.', "_");
    let request_path = format!("{PORTAL_PATH}/request/{sender}/{token}");

    let context = glib::MainContext::new();
    context
        .with_thread_default(|| {
            let response: Rc<Cell<Option<u32>>> = Rc::new(Cell::new(None));
            let slot = response.clone();
            // Subscribed before the call so a fast answer is not missed.
            let subscription = connection.signal_subscribe(
                Some(PORTAL_BUS_NAME),
                Some(REQUEST_INTERFACE),
                Some("Response"),
                Some(&request_path),
                None,
                gio::DBusSignalFlags::NONE,
                move |_, _, _, _, _, parameters| {
                    let code = parameters.child_value(0).get::<u32>().unwrap_or(2);
                    slot.set(Some(code));
                },
            );
            let call = connection.call_sync(
                Some(PORTAL_BUS_NAME),
                PORTAL_PATH,
                CAMERA_INTERFACE,
                "AccessCamera",
                Some(&options(&[("handle_token", token.to_variant())])),
                None,
                gio::DBusCallFlags::NONE,
                PORTAL_CALL_TIMEOUT_MS,
                gio::Cancellable::NONE,
            );
            let deadline = Instant::now() + ACCESS_TIMEOUT;
            while call.is_ok() && response.get().is_none() && Instant::now() < deadline {
                if !context.iteration(false) {
                    thread::sleep(Duration::from_millis(5));
                }
            }
            connection.signal_unsubscribe(subscription);
            call.map_err(|error| format!("{NO_PORTAL} ({error})"))?;
            match response.get() {
                // 0 means the user (or the policy) allowed the camera.
                Some(0) => Ok(()),
                Some(_) => Err(DENIED.to_string()),
                None => Err("O sistema não respondeu ao pedido de acesso à câmera.".to_string()),
            }
        })
        .map_err(|error| format!("{NO_PORTAL} ({error})"))?
}

fn open_pipewire_remote(connection: &gio::DBusConnection) -> Result<OwnedFd, String> {
    let (reply, fds) = connection
        .call_with_unix_fd_list_sync(
            Some(PORTAL_BUS_NAME),
            PORTAL_PATH,
            CAMERA_INTERFACE,
            "OpenPipeWireRemote",
            Some(&options(&[])),
            Some(glib::VariantTy::new("(h)").expect("valid type")),
            gio::DBusCallFlags::NONE,
            PORTAL_CALL_TIMEOUT_MS,
            gio::UnixFDList::NONE,
            gio::Cancellable::NONE,
        )
        .map_err(|error| format!("{DENIED} ({error})"))?;
    let (glib::variant::Handle(index),) = reply.get().ok_or(NO_PORTAL)?;
    // g_unix_fd_list_get returns a duplicate owned by the caller.
    let fd = fds
        .get(index)
        .map_err(|error| format!("{NO_PORTAL} ({error})"))?;
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
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

/// Converts device caps into capture modes the engine can handle: MJPEG and
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

fn element(name: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(name)
        .build()
        .map_err(|_| format!("O elemento GStreamer \"{name}\" não está instalado."))
}

fn build_pipeline(
    remote: &OwnedFd,
    node: &str,
    mode: &Mode,
    shared: &Arc<Shared>,
    generation: u64,
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
    let sink = gst_app::AppSink::builder()
        .max_buffers(1)
        .drop(true)
        .sync(false)
        .build();

    let mut chain = vec![source, filter];
    if mode.encoding == Encoding::Raw {
        chain.push(element("videoconvert")?);
        let encoder = element("jpegenc")?;
        encoder.set_property("quality", JPEG_QUALITY);
        chain.push(encoder);
    }
    chain.push(sink.clone().upcast());
    pipeline
        .add_many(&chain)
        .map_err(|_| "Não foi possível montar a captura da webcam.")?;
    gst::Element::link_many(&chain).map_err(|_| "A câmera recusou o formato escolhido.")?;

    let frames = Arc::downgrade(shared);
    sink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| {
                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                let Some(shared) = frames.upgrade() else {
                    return Err(gst::FlowError::Flushing);
                };
                if let Some(buffer) = sample.buffer() {
                    if let Ok(map) = buffer.map_readable() {
                        if format::is_complete_jpeg(map.as_slice()) {
                            shared.publish(generation, map.as_slice().to_vec());
                        }
                    }
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    // Errors are recorded for the UI; every other message is dropped so the
    // bus never fills up (nothing iterates a main loop for this pipeline).
    let errors = Arc::downgrade(shared);
    pipeline
        .bus()
        .ok_or("Não foi possível montar a captura da webcam.")?
        .set_sync_handler(move |_, message| {
            if let gst::MessageView::Error(error) = message.view() {
                if let Some(shared) = errors.upgrade() {
                    shared.fail(
                        generation,
                        format!("A webcam parou de enviar vídeo: {}", error.error()),
                    );
                }
            }
            gst::BusSyncReply::Drop
        });
    Ok(pipeline)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs a camera and the desktop camera portal; frames are discarded.
    #[test]
    #[ignore = "needs a webcam and xdg-desktop-portal with PipeWire"]
    fn captures_valid_jpeg_frames_from_the_portal() {
        let engine = CameraEngine::new();
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
    }
}
