//! Linux screen capture: the ScreenCast portal plus PipeWire, through
//! GStreamer.
//!
//! The portal shows the desktop's own picker (GNOME, KDE, wlroots...) and
//! works the same on X11, Wayland and inside a Flatpak sandbox. Its session
//! hands out a PipeWire node that `pipewiresrc` reads with the buffer pool
//! on, the setting that keeps camera frames valid (see `pipewire.rs`).
//! Frames are scaled down, rate limited and encoded to JPEG for the UI.

use crate::backend::FrameSink;
use crate::pipewire::{element, init};
use crate::portal::{self, Outcome};
use crate::screen::{CancelToken, ScreenBackend, ScreenRequest, ScreenSource, SourceKind};
use gio::{glib, prelude::*};
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use std::{
    os::fd::{AsRawFd, OwnedFd},
    sync::Mutex,
    time::{Duration, Instant},
};

const SCREENCAST_INTERFACE: &str = "org.freedesktop.portal.ScreenCast";
/// `types` bits of `SelectSources`.
const SOURCE_MONITOR: u32 = 1;
const SOURCE_WINDOW: u32 = 2;
const SOURCE_VIRTUAL: u32 = 4;
/// `cursor_mode` bits of `SelectSources`.
const CURSOR_HIDDEN: u32 = 1;
const CURSOR_EMBEDDED: u32 = 2;
/// Session setup needs no user interaction.
const SETUP_TIMEOUT: Duration = Duration::from_secs(30);
/// The user picks a screen or window in the system dialog meanwhile.
const PICK_TIMEOUT: Duration = Duration::from_secs(300);
/// Screens carry text; a lower quality smears it.
const JPEG_QUALITY: i32 = 80;
/// Scaling and conversion of large screens are split across threads.
const CONVERT_THREADS: u32 = 4;

const NO_PORTAL: &str = "O portal de compartilhamento de tela do sistema não está disponível. \
                         Verifique se o xdg-desktop-portal está em execução.";
const DENIED: &str = "O sistema recusou o compartilhamento de tela.";
const NO_ANSWER: &str = "O sistema não respondeu ao pedido de compartilhamento de tela.";
const NOTHING_PICKED: &str = "Nenhuma tela ou janela foi selecionada.";
const NO_PROVIDER: &str = "O suporte do GStreamer ao PipeWire não está instalado \
                           (pacote pipewire-gstreamer).";
const BUILD_FAILED: &str = "Não foi possível montar a captura da tela.";
const ENDED: &str = "O compartilhamento de tela foi encerrado.";

/// Stateless: every capture runs its own portal session, so the user picks
/// what to share each time.
pub struct ScreenCastBackend;

impl ScreenCastBackend {
    /// Does not touch the portal yet: a missing portal must not stop the app
    /// from opening, it only makes starting a capture report an error.
    pub fn new() -> Result<Self, String> {
        Ok(Self)
    }
}

impl ScreenBackend for ScreenCastBackend {
    type Stream = ScreenCastStream;

    fn open(
        &mut self,
        request: &ScreenRequest,
        cancel: &CancelToken,
        sink: FrameSink,
    ) -> Result<Option<(ScreenCastStream, ScreenSource)>, String> {
        init()?;
        let connection = portal::session_bus().map_err(|error| format!("{NO_PORTAL} ({error})"))?;
        let cancelled = || cancel.is_cancelled();
        let Some(session) = Session::create(&connection, &cancelled)? else {
            return Ok(None);
        };
        if !session.select_sources(request.cursor, &cancelled)? {
            return Ok(None);
        }
        let Some(stream) = session.start(&cancelled)? else {
            return Ok(None);
        };
        let remote =
            portal::open_pipewire_remote(&connection, SCREENCAST_INTERFACE, &[session.handle()?])
                .map_err(|error| format!("{DENIED} ({error})"))?;
        let pipeline = build_pipeline(Some(&remote), stream.node_id, request, sink)?;
        let capture = ScreenCastStream {
            pipeline,
            _remote: remote,
            _session: session,
        };
        capture
            .pipeline
            .set_state(gst::State::Playing)
            .map_err(|_| "Não foi possível iniciar a captura da tela.".to_string())?;
        Ok(Some((capture, stream.source)))
    }
}

/// A running capture. Fields drop in order: the pipeline stops (in `Drop`)
/// before its PipeWire remote closes, and the portal session ends last,
/// which also removes the desktop's sharing indicator.
pub struct ScreenCastStream {
    pipeline: gst::Pipeline,
    _remote: OwnedFd,
    _session: Session,
}

impl Drop for ScreenCastStream {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// A portal ScreenCast session, closed on drop.
struct Session {
    connection: gio::DBusConnection,
    path: String,
}

/// One PipeWire stream of a started session.
#[derive(Debug, PartialEq, Eq)]
struct PortalStream {
    node_id: u32,
    source: ScreenSource,
}

impl Session {
    fn create(
        connection: &gio::DBusConnection,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Option<Self>, String> {
        let token = portal::token();
        let outcome = portal::request(
            connection,
            SCREENCAST_INTERFACE,
            "CreateSession",
            &[],
            &[("session_handle_token", token.to_variant())],
            SETUP_TIMEOUT,
            cancelled,
        )
        .map_err(|error| format!("{NO_PORTAL} ({error})"))?;
        let results = granted(outcome)?;
        let Some(results) = results else {
            return Ok(None);
        };
        // `session_handle` is a string in the spec, but some portals send an
        // object path; both read as text. Fall back to the documented path.
        let path = match results
            .lookup_value("session_handle", None)
            .and_then(|value| value.str().map(str::to_owned))
        {
            Some(path) => path,
            None => portal::session_path(connection, &token)?,
        };
        Ok(Some(Self {
            connection: connection.clone(),
            path,
        }))
    }

    fn handle(&self) -> Result<glib::Variant, String> {
        portal::object_path(&self.path)
    }

    /// Monitors and windows, one at a time, with the pointer drawn in when
    /// asked and supported. Returns `false` when cancelled.
    fn select_sources(&self, cursor: bool, cancelled: &dyn Fn() -> bool) -> Result<bool, String> {
        let available = |name| {
            portal::property(&self.connection, SCREENCAST_INTERFACE, name)
                .and_then(|value| value.get::<u32>())
        };
        let mut options = vec![("multiple", false.to_variant())];
        let types = available("AvailableSourceTypes")
            .map_or(SOURCE_MONITOR | SOURCE_WINDOW, |types| {
                types & (SOURCE_MONITOR | SOURCE_WINDOW)
            });
        if types != 0 {
            options.push(("types", types.to_variant()));
        }
        if let Some(mode) = cursor_mode(cursor, available("AvailableCursorModes")) {
            options.push(("cursor_mode", mode.to_variant()));
        }
        let outcome = portal::request(
            &self.connection,
            SCREENCAST_INTERFACE,
            "SelectSources",
            &[self.handle()?],
            &options,
            SETUP_TIMEOUT,
            cancelled,
        )
        .map_err(|error| format!("{NO_PORTAL} ({error})"))?;
        Ok(granted(outcome)?.is_some())
    }

    /// Shows the picker and returns the stream of what the user chose.
    fn start(&self, cancelled: &dyn Fn() -> bool) -> Result<Option<PortalStream>, String> {
        let outcome = portal::request(
            &self.connection,
            SCREENCAST_INTERFACE,
            "Start",
            // No parent window: the app does not export a window handle.
            &[self.handle()?, "".to_variant()],
            &[],
            PICK_TIMEOUT,
            cancelled,
        )
        .map_err(|error| format!("{NO_PORTAL} ({error})"))?;
        let Some(results) = granted(outcome)? else {
            return Ok(None);
        };
        let streams = results
            .lookup_value("streams", None)
            .map(|streams| parse_streams(&streams))
            .unwrap_or_default();
        streams
            .into_iter()
            .next()
            .map(Some)
            .ok_or_else(|| NOTHING_PICKED.to_string())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        portal::close_session(&self.connection, &self.path);
    }
}

/// The results of a granted request, `None` when cancelled.
fn granted(outcome: Outcome) -> Result<Option<glib::VariantDict>, String> {
    match outcome {
        Outcome::Granted(results) => Ok(Some(results)),
        Outcome::Cancelled => Ok(None),
        Outcome::Denied => Err(DENIED.into()),
        Outcome::TimedOut => Err(NO_ANSWER.into()),
    }
}

/// Embedded pointer when wanted, hidden otherwise. Without the portal's
/// list of modes the option is left out (the portal default applies);
/// an unsupported mode would make `SelectSources` fail.
fn cursor_mode(cursor: bool, available: Option<u32>) -> Option<u32> {
    let wanted = if cursor {
        CURSOR_EMBEDDED
    } else {
        CURSOR_HIDDEN
    };
    available
        .filter(|modes| modes & wanted != 0)
        .map(|_| wanted)
}

/// Reads the `streams` result of `Start`: `a(ua{sv})` with the PipeWire
/// node ID and its properties.
fn parse_streams(streams: &glib::Variant) -> Vec<PortalStream> {
    streams
        .iter()
        .filter_map(|stream| {
            let node_id = stream.try_child_value(0)?.get::<u32>()?;
            let properties = glib::VariantDict::new(Some(&stream.try_child_value(1)?));
            let kind = match properties
                .lookup_value("source_type", None)
                .and_then(|value| value.get::<u32>())
            {
                Some(SOURCE_MONITOR) => SourceKind::Monitor,
                Some(SOURCE_WINDOW) => SourceKind::Window,
                Some(SOURCE_VIRTUAL) => SourceKind::Virtual,
                _ => SourceKind::Unknown,
            };
            let size = properties
                .lookup_value("size", None)
                .and_then(|value| value.get::<(i32, i32)>())
                .and_then(|(width, height)| {
                    Some((u32::try_from(width).ok()?, u32::try_from(height).ok()?))
                })
                .filter(|&(width, height)| width > 0 && height > 0);
            Some(PortalStream {
                node_id,
                source: ScreenSource { kind, size },
            })
        })
        .collect()
}

/// Lets through at most one frame per `interval` on average. Screen casts
/// send frames when the screen changes, at up to the display's refresh
/// rate, so a 144 Hz monitor must not cost 144 encodes per second.
struct Throttle {
    interval: Duration,
    /// When the next frame is due; frames slightly early still pass, so
    /// a 60 Hz source is not halved to 20 fps by timing jitter.
    next: Option<Instant>,
}

impl Throttle {
    fn new(frame_rate: u32) -> Self {
        Self {
            interval: Duration::from_secs(1) / frame_rate.max(1),
            next: None,
        }
    }

    fn admit(&mut self, now: Instant) -> bool {
        let slack = self.interval / 4;
        if self.next.is_some_and(|next| now + slack < next) {
            return false;
        }
        // Keep the cadence while frames flow; restart it after a pause so a
        // burst after an idle screen is not let through at full rate.
        let base = self
            .next
            .filter(|&next| now < next + self.interval)
            .unwrap_or(now);
        self.next = Some(base + self.interval);
        true
    }
}

/// The largest size within `max` with the aspect ratio of `source`, never
/// larger than the source. Even dimensions keep 4:2:0 chroma JPEG exact.
fn fit(source: (u32, u32), max: (u32, u32)) -> (u32, u32) {
    let (width, height) = (source.0.max(1), source.1.max(1));
    let scale = (f64::from(max.0) / f64::from(width))
        .min(f64::from(max.1) / f64::from(height))
        .min(1.0);
    let even = |value: f64| ((value.round() as u32) & !1).max(2);
    (
        even(f64::from(width) * scale),
        even(f64::from(height) * scale),
    )
}

/// Fixed output caps for a source of `size`. The size filter must be fixed:
/// with a range, `pipewiresrc` negotiates a 1 x 1 stream and fails.
fn scaled_caps(size: (u32, u32), request: &ScreenRequest) -> gst::Caps {
    let (width, height) = fit(size, (request.max_width, request.max_height));
    gst::Caps::builder("video/x-raw")
        .field("width", width as i32)
        .field("height", height as i32)
        .field("pixel-aspect-ratio", gst::Fraction::new(1, 1))
        .build()
}

/// `remote` is the portal's PipeWire connection; `None` uses the default
/// PipeWire daemon (only for tests against a local node).
fn build_pipeline(
    remote: Option<&OwnedFd>,
    node_id: u32,
    request: &ScreenRequest,
    sink: FrameSink,
) -> Result<gst::Pipeline, String> {
    let pipeline = gst::Pipeline::new();
    let mut source = gst::ElementFactory::make("pipewiresrc")
        // Portal streams are addressed by node ID.
        .property("path", node_id.to_string())
        .property("use-bufferpool", true)
        .property("do-timestamp", true);
    if let Some(remote) = remote {
        source = source.property("fd", remote.as_raw_fd());
    }
    let source = source.build().map_err(|_| NO_PROVIDER)?;
    // Stopping the cast from the desktop removes the node; turn that into a
    // bus error so the UI learns that sharing ended.
    if source.find_property("on-disconnect").is_some() {
        source.set_property_from_str("on-disconnect", "error");
    }
    // System memory only: DMA-BUF frames would need a GPU download step.
    let memory = gst::ElementFactory::make("capsfilter")
        .property("caps", gst::Caps::builder("video/x-raw").build())
        .build()
        .map_err(|_| BUILD_FAILED)?;
    // Decouples the source from scaling and encoding: the source thread
    // only throttles, and a frame still waiting when the next one arrives is
    // replaced, so slow encoding lowers the rate instead of adding latency.
    let queue = gst::ElementFactory::make("queue")
        .property("max-size-buffers", 1u32)
        .property("max-size-bytes", 0u32)
        .property("max-size-time", 0u64)
        .property_from_str("leaky", "downstream")
        .build()
        .map_err(|_| BUILD_FAILED)?;
    let scale = element("videoscale")?;
    // Any size until the source announces its own; see the caps probe below.
    let size = gst::ElementFactory::make("capsfilter")
        .property("caps", gst::Caps::builder("video/x-raw").build())
        .build()
        .map_err(|_| BUILD_FAILED)?;
    let convert = element("videoconvert")?;
    for threaded in [&scale, &convert] {
        if threaded.find_property("n-threads").is_some() {
            threaded.set_property("n-threads", CONVERT_THREADS);
        }
    }
    let encoder = element("jpegenc")?;
    encoder.set_property("quality", JPEG_QUALITY);
    let appsink = gst_app::AppSink::builder()
        .max_buffers(1)
        .drop(true)
        .sync(false)
        .build();

    let chain = [
        source,
        memory.clone(),
        queue,
        scale,
        size.clone(),
        convert,
        encoder,
        appsink.clone().upcast(),
    ];
    pipeline.add_many(&chain).map_err(|_| BUILD_FAILED)?;
    gst::Element::link_many(&chain).map_err(|_| BUILD_FAILED)?;

    // Every time the source announces its size (at start, and again when a
    // shared window is resized), the output size is recomputed from it,
    // before the caps reach the scaler.
    let request_size = request.clone();
    let size_filter = size;
    let source_side = memory.static_pad("src").ok_or(BUILD_FAILED)?;
    source_side
        .add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_, info| {
            if let Some(gst::EventView::Caps(event)) = info.event().map(|event| event.view()) {
                let source_size = event.caps().structure(0).and_then(|structure| {
                    let width = structure.get::<i32>("width").ok()?;
                    let height = structure.get::<i32>("height").ok()?;
                    Some((u32::try_from(width).ok()?, u32::try_from(height).ok()?))
                });
                if let Some(source_size) = source_size {
                    size_filter.set_property("caps", scaled_caps(source_size, &request_size));
                }
            }
            gst::PadProbeReturn::Ok
        })
        .ok_or(BUILD_FAILED)?;
    // Changing the size filter asks upstream to renegotiate. The scaler and
    // converter absorb any change, but `pipewiresrc` would renegotiate the
    // PipeWire stream and fail ("all buffers have been removed"), so the
    // request stops here.
    source_side
        .add_probe(gst::PadProbeType::EVENT_UPSTREAM, |_, info| {
            match info.event().map(|event| event.type_()) {
                Some(gst::EventType::Reconfigure) => gst::PadProbeReturn::Drop,
                _ => gst::PadProbeReturn::Ok,
            }
        })
        .ok_or(BUILD_FAILED)?;

    // On the source thread, timed by arrival, before any processing, so
    // skipped frames cost nothing.
    let throttle = Mutex::new(Throttle::new(request.frame_rate));
    source_side
        .add_probe(gst::PadProbeType::BUFFER, move |_, _| {
            let mut throttle = throttle.lock().unwrap_or_else(|error| error.into_inner());
            if throttle.admit(Instant::now()) {
                gst::PadProbeReturn::Ok
            } else {
                gst::PadProbeReturn::Drop
            }
        })
        .ok_or(BUILD_FAILED)?;

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

    // Errors and end of stream mean the cast is over; every other message
    // is dropped so the bus never fills up.
    pipeline
        .bus()
        .ok_or(BUILD_FAILED)?
        .set_sync_handler(move |_, message| {
            match message.view() {
                gst::MessageView::Error(error) => {
                    // The cause ("all buffers have been removed" when the
                    // desktop stops the cast) means nothing to the user.
                    eprintln!("disc-video: screen cast ended: {}", error.error());
                    sink.fail(ENDED);
                }
                gst::MessageView::Eos(_) => sink.fail(ENDED),
                _ => {}
            }
            gst::BusSyncReply::Drop
        });
    Ok(pipeline)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{format, ScreenEngine};

    fn stream_variant(node: u32, properties: &[(&str, glib::Variant)]) -> glib::Variant {
        glib::Variant::tuple_from_iter([node.to_variant(), portal::dict(properties)])
    }

    #[test]
    fn parses_the_streams_the_portal_returns() {
        let streams = glib::Variant::array_from_iter_with_type(
            glib::VariantTy::new("(ua{sv})").unwrap(),
            [
                stream_variant(
                    42,
                    &[
                        ("source_type", SOURCE_MONITOR.to_variant()),
                        ("size", (2560i32, 1440i32).to_variant()),
                        ("position", (0i32, 0i32).to_variant()),
                    ],
                ),
                stream_variant(7, &[("source_type", 16u32.to_variant())]),
            ],
        );
        assert_eq!(
            parse_streams(&streams),
            [
                PortalStream {
                    node_id: 42,
                    source: ScreenSource {
                        kind: SourceKind::Monitor,
                        size: Some((2560, 1440)),
                    },
                },
                PortalStream {
                    node_id: 7,
                    source: ScreenSource {
                        kind: SourceKind::Unknown,
                        size: None,
                    },
                },
            ]
        );
    }

    #[test]
    fn fit_scales_down_keeping_the_aspect_ratio() {
        assert_eq!(fit((2560, 1440), (1280, 720)), (1280, 720));
        assert_eq!(fit((3440, 1440), (1920, 1080)), (1920, 804));
        // Portrait windows are limited by height.
        assert_eq!(fit((1000, 1800), (1280, 720)), (400, 720));
        // Smaller sources are never scaled up, but stay even.
        assert_eq!(fit((801, 599), (1280, 720)), (800, 598));
        assert_eq!(fit((1, 1), (1280, 720)), (2, 2));
    }

    #[test]
    fn cursor_mode_only_asks_for_supported_modes() {
        assert_eq!(cursor_mode(true, Some(7)), Some(CURSOR_EMBEDDED));
        assert_eq!(cursor_mode(false, Some(7)), Some(CURSOR_HIDDEN));
        assert_eq!(cursor_mode(true, Some(CURSOR_HIDDEN)), None);
        assert_eq!(cursor_mode(true, None), None);
    }

    /// Frames per second let through when frames arrive at `source_hz`,
    /// measured over ten seconds (early frames may cross a window edge).
    fn admitted_rate(frame_rate: u32, source_hz: u32) -> f64 {
        let mut throttle = Throttle::new(frame_rate);
        let period = Duration::from_secs(1) / source_hz;
        let start = Instant::now();
        let count = (0..)
            .map(|index| start + period * index)
            .take_while(|&time| time < start + Duration::from_secs(10))
            .filter(|&time| throttle.admit(time))
            .count();
        count as f64 / 10.0
    }

    #[test]
    fn throttle_holds_the_requested_rate() {
        let close = |actual: f64, expected: f64| (actual - expected).abs() < 0.15;
        assert!(close(admitted_rate(30, 60), 30.0));
        assert!(close(admitted_rate(30, 144), 30.0));
        assert!(close(admitted_rate(60, 60), 60.0));
        assert!(close(admitted_rate(15, 60), 15.0));
        // A slower source is never held back.
        assert!(close(admitted_rate(60, 24), 24.0));
    }

    #[test]
    fn throttle_restarts_after_an_idle_screen() {
        let mut throttle = Throttle::new(30);
        let start = Instant::now();
        assert!(throttle.admit(start));
        let later = start + Duration::from_secs(5);
        assert!(throttle.admit(later));
        assert!(!throttle.admit(later + Duration::from_millis(5)));
        assert!(throttle.admit(later + Duration::from_millis(34)));
    }

    /// Reads a local PipeWire video node through the real pipeline, e.g.
    /// `gst-launch-1.0 videotestsrc is-live=true !
    /// video/x-raw,width=2560,height=1440,framerate=60/1 ! pipewiresink
    /// mode=provide` and its node ID (from `pw-dump`) in DISCVOICE_TEST_NODE.
    #[test]
    #[ignore = "needs a PipeWire video node in DISCVOICE_TEST_NODE"]
    fn scales_and_throttles_a_pipewire_node() {
        use crate::backend::Frames;
        use std::sync::Arc;

        let node: u32 = std::env::var("DISCVOICE_TEST_NODE")
            .expect("DISCVOICE_TEST_NODE")
            .parse()
            .unwrap();
        init().unwrap();
        let frame_rate = std::env::var("DISCVOICE_TEST_FPS")
            .ok()
            .and_then(|rate| rate.parse().ok())
            .unwrap_or(15);
        let frames = Arc::new(Frames::default());
        let request = ScreenRequest {
            frame_rate,
            ..ScreenRequest::default()
        };
        let pipeline = build_pipeline(None, node, &request, frames.begin()).unwrap();
        pipeline.set_state(gst::State::Playing).unwrap();
        // Timed from the first frame, so start-up does not count.
        let mut last = frames.next(Duration::from_secs(5)).unwrap();
        assert!(last.is_some(), "no frame in 5 s");
        let started = Instant::now();
        let mut count = 0;
        while started.elapsed() < Duration::from_secs(4) {
            if let Some(frame) = frames.next(Duration::from_millis(500)).unwrap() {
                count += 1;
                last = Some(frame);
            }
        }
        pipeline.set_state(gst::State::Null).unwrap();
        let fps = f64::from(count) / started.elapsed().as_secs_f64();
        let frame = last.unwrap();
        assert!(format::is_complete_jpeg(&frame));
        let size = jpeg_size(&frame).expect("no SOF marker");
        println!("{frame_rate} fps requested: {count} frames, {fps:.1} fps, {size:?}");
        assert!(size.0 <= 1280 && size.1 <= 720, "{size:?}");
        assert!(size.0 > 1 && size.1 > 1, "{size:?}");
        let expected = f64::from(frame_rate);
        assert!(
            (expected * 0.8..=expected * 1.1).contains(&fps),
            "{fps:.1} fps"
        );
    }

    /// Width and height from a JPEG's baseline/progressive SOF segment.
    fn jpeg_size(jpeg: &[u8]) -> Option<(u32, u32)> {
        let mut index = 2;
        while index + 9 < jpeg.len() {
            if jpeg[index] != 0xFF {
                return None;
            }
            let marker = jpeg[index + 1];
            let length = usize::from(u16::from_be_bytes([jpeg[index + 2], jpeg[index + 3]]));
            if matches!(marker, 0xC0..=0xC2) {
                let height = u16::from_be_bytes([jpeg[index + 5], jpeg[index + 6]]);
                let width = u16::from_be_bytes([jpeg[index + 7], jpeg[index + 8]]);
                return Some((u32::from(width), u32::from(height)));
            }
            index += 2 + length;
        }
        None
    }

    /// Needs a desktop with the ScreenCast portal; pick a screen in the
    /// dialog that opens. Frames are discarded.
    #[test]
    #[ignore = "needs xdg-desktop-portal and a user to pick a screen"]
    fn captures_valid_jpeg_frames_from_the_portal() {
        let engine = ScreenEngine::new().unwrap();
        let info = engine
            .start(ScreenRequest::default())
            .unwrap()
            .expect("picker dismissed");
        println!("{info:?}");
        let started = Instant::now();
        let mut frames = 0;
        while started.elapsed() < Duration::from_secs(4) {
            if let Some(frame) = engine.next_frame(Duration::from_millis(500)).unwrap() {
                assert!(format::is_complete_jpeg(&frame));
                frames += 1;
            }
        }
        println!("{frames} frames in 4 s");
        assert!(frames >= 1, "no frame in 4 s");
        engine.stop();
        assert_eq!(engine.next_frame(Duration::from_millis(50)), Ok(None));
        engine.shutdown();
    }
}
