//! Windows screen capture: Windows.Graphics.Capture.
//!
//! The system picker (`GraphicsCapturePicker`, owned by the app window)
//! chooses a screen or window, like the ScreenCast portal on Linux. Frames
//! arrive as Direct3D 11 textures on a free-threaded frame pool; each one
//! admitted by the frame-rate limit is copied to CPU memory and handed to an
//! encoder thread that scales it down and encodes it to JPEG with WIC. Only
//! the newest frame waits for the encoder, so a slow encode drops frames
//! instead of adding latency.

use crate::backend::FrameSink;
use crate::screen::{
    fit, CancelToken, ScreenBackend, ScreenRequest, ScreenSource, SourceKind, Throttle,
};
use std::{
    ffi::c_void,
    sync::{Arc, Condvar, Mutex, MutexGuard},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use windows::{
    core::{AgileReference, Interface, PWSTR},
    Foundation::TypedEventHandler,
    Graphics::{
        Capture::{
            Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCapturePicker,
            GraphicsCaptureSession,
        },
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
        SizeInt32,
    },
    Win32::{
        Foundation::{HMODULE, HWND, RPC_E_CHANGED_MODE},
        Graphics::{
            Direct3D::{D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP},
            Direct3D11::{
                D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BOX,
                D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
                D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
            },
            Dxgi::{Common::DXGI_FORMAT_B8G8R8A8_UNORM, Common::DXGI_SAMPLE_DESC, IDXGIDevice},
            Imaging::{
                CLSID_WICImagingFactory, GUID_ContainerFormatJpeg, GUID_WICPixelFormat24bppBGR,
                GUID_WICPixelFormat32bppBGR, IWICBitmapSource, IWICImagingFactory,
                WICBitmapDitherTypeNone, WICBitmapEncoderNoCache, WICBitmapInterpolationModeFant,
                WICBitmapPaletteTypeCustom,
            },
        },
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, StructuredStorage::PROPBAG2,
                CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, STREAM_SEEK_END, STREAM_SEEK_SET,
            },
            Variant::{VARIANT, VT_R4},
            WinRT::{
                Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
                RoInitialize, RO_INIT_MULTITHREADED,
            },
        },
        UI::Shell::{IInitializeWithWindow, SHCreateMemStream},
    },
};
use windows_future::AsyncStatus;

/// Two buffers let the next frame arrive while one is being copied.
const POOL_BUFFERS: i32 = 2;
/// How often a pending picker checks whether the UI cancelled it.
const PICK_POLL: Duration = Duration::from_millis(25);
/// Screens carry text; a lower quality smears it (same as Linux).
const JPEG_QUALITY: f32 = 0.8;

const UNSUPPORTED: &str = "Esta versão do Windows não oferece captura de tela \
                           (requer Windows 10 versão 1903 ou mais recente).";
const NO_DEVICE: &str = "Não foi possível acessar o Direct3D para capturar a tela.";
const PICKER_FAILED: &str = "Não foi possível abrir o seletor de tela do Windows.";
const BUILD_FAILED: &str = "Não foi possível iniciar a captura da tela.";
const ENDED: &str = "O compartilhamento de tela foi encerrado.";
const NO_ENCODER: &str = "O codificador de imagens do Windows (WIC) não está disponível.";

fn error(context: &str, cause: windows::core::Error) -> String {
    format!("{context} ({cause})")
}

/// Owns the Direct3D device every capture uses. Lives on the screen worker
/// thread, which joins the multithreaded apartment.
pub struct WgcBackend {
    owner: isize,
    d3d: ID3D11Device,
    device: IDirect3DDevice,
}

impl WgcBackend {
    /// `owner` is the HWND of the window the picker belongs to (the app's
    /// main window), as an integer so callers need not share our `windows`
    /// crate version.
    pub fn new(owner: isize) -> Result<Self, String> {
        // S_FALSE (already initialized) is fine; an STA thread keeps its
        // apartment, the picker works from either.
        if let Err(cause) = unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
            if cause.code() != RPC_E_CHANGED_MODE {
                return Err(error(BUILD_FAILED, cause));
            }
        }
        if !GraphicsCaptureSession::IsSupported().unwrap_or(false) {
            return Err(UNSUPPORTED.into());
        }
        let d3d = create_d3d_device()?;
        let device = winrt_device(&d3d).map_err(|cause| error(NO_DEVICE, cause))?;
        Ok(Self { owner, d3d, device })
    }

    /// Shows the system picker and waits for the user, polling `cancel`.
    /// `Ok(None)` when dismissed or cancelled.
    fn pick(&self, cancel: &CancelToken) -> Result<Option<GraphicsCaptureItem>, String> {
        let picker = GraphicsCapturePicker::new().map_err(|cause| error(PICKER_FAILED, cause))?;
        unsafe {
            picker
                .cast::<IInitializeWithWindow>()
                .and_then(|init| init.Initialize(HWND(self.owner as *mut c_void)))
                .map_err(|cause| error(PICKER_FAILED, cause))?;
        }
        let operation = picker
            .PickSingleItemAsync()
            .map_err(|cause| error(PICKER_FAILED, cause))?;
        loop {
            let status = operation
                .Status()
                .map_err(|cause| error(PICKER_FAILED, cause))?;
            if status == AsyncStatus::Started {
                if cancel.is_cancelled() {
                    // Closes the picker; a late answer is discarded.
                    let _ = operation.Cancel();
                    return Ok(None);
                }
                thread::sleep(PICK_POLL);
                continue;
            }
            if status == AsyncStatus::Canceled {
                return Ok(None);
            }
            return match operation.GetResults() {
                Ok(item) => Ok(Some(item)),
                // A dismissed picker completes with a null item.
                Err(cause) if cause.code().is_ok() => Ok(None),
                Err(cause) => Err(error(PICKER_FAILED, cause)),
            };
        }
    }
}

impl ScreenBackend for WgcBackend {
    type Stream = WgcStream;

    fn open(
        &mut self,
        request: &ScreenRequest,
        cancel: &CancelToken,
        sink: FrameSink,
    ) -> Result<Option<(WgcStream, ScreenSource)>, String> {
        let Some(item) = self.pick(cancel)? else {
            return Ok(None);
        };
        // The picker does not say whether a monitor or a window was chosen.
        let size = item.Size().ok().and_then(positive);
        let stream = WgcStream::start(&self.d3d, &self.device, item, request, sink)
            .map_err(|cause| error(BUILD_FAILED, cause))?;
        Ok(Some((
            stream,
            ScreenSource {
                kind: SourceKind::Unknown,
                size,
            },
        )))
    }
}

fn positive(size: SizeInt32) -> Option<(u32, u32)> {
    let width = u32::try_from(size.Width).ok().filter(|&w| w > 0)?;
    let height = u32::try_from(size.Height).ok().filter(|&h| h > 0)?;
    Some((width, height))
}

fn create_d3d_device() -> Result<ID3D11Device, String> {
    let create = |driver: D3D_DRIVER_TYPE| {
        let mut device = None;
        unsafe {
            D3D11CreateDevice(
                None,
                driver,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
        }
        .and_then(|()| device.ok_or_else(windows::core::Error::empty))
    };
    // WARP (software) keeps capture working without a usable GPU driver,
    // e.g. in virtual machines.
    create(D3D_DRIVER_TYPE_HARDWARE)
        .or_else(|_| create(D3D_DRIVER_TYPE_WARP))
        .map_err(|cause| error(NO_DEVICE, cause))
}

fn winrt_device(d3d: &ID3D11Device) -> windows::core::Result<IDirect3DDevice> {
    let dxgi: IDXGIDevice = d3d.cast()?;
    unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }?.cast()
}

/// A frame copied out of the GPU: tightly packed BGRX rows.
struct RawFrame {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

#[derive(Default)]
struct SlotState {
    frame: Option<RawFrame>,
    closed: bool,
}

/// Hands the newest frame to the encoder; an unencoded frame is replaced.
#[derive(Default)]
struct Slot {
    state: Mutex<SlotState>,
    changed: Condvar,
}

impl Slot {
    fn lock(&self) -> MutexGuard<'_, SlotState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn put(&self, frame: RawFrame) {
        let mut state = self.lock();
        if !state.closed {
            state.frame = Some(frame);
            self.changed.notify_one();
        }
    }

    /// Waits for a frame; `None` once closed.
    fn take(&self) -> Option<RawFrame> {
        let mut state = self.lock();
        loop {
            if state.closed {
                return None;
            }
            if let Some(frame) = state.frame.take() {
                return Some(frame);
            }
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
    }

    fn close(&self) {
        self.lock().closed = true;
        self.changed.notify_all();
    }
}

/// What the `FrameArrived` handler needs; it runs on system threads.
struct Copier {
    d3d: ID3D11Device,
    context: ID3D11DeviceContext,
    device: AgileReference<IDirect3DDevice>,
    staging: Option<(ID3D11Texture2D, u32, u32)>,
    pool_size: SizeInt32,
    throttle: Throttle,
}

impl Copier {
    fn frame_arrived(&mut self, pool: &Direct3D11CaptureFramePool, slot: &Slot) {
        // Always take the frame: an unreleased frame keeps its buffer and
        // the pool stops delivering once both are held.
        let Ok(frame) = pool.TryGetNextFrame() else {
            return;
        };
        let Ok(content) = frame.ContentSize() else {
            return;
        };
        if content.Width != self.pool_size.Width || content.Height != self.pool_size.Height {
            // The shared window was resized: later frames use the new size.
            if let Ok(device) = self.device.resolve() {
                if pool
                    .Recreate(
                        &device,
                        DirectXPixelFormat::B8G8R8A8UIntNormalized,
                        POOL_BUFFERS,
                        content,
                    )
                    .is_ok()
                {
                    self.pool_size = content;
                }
            }
        }
        // Throttle on arrival time, before any copy or encode (see the
        // Linux pipeline: limiting after the work skews the rate).
        if !self.throttle.admit(Instant::now()) {
            return;
        }
        let texture = frame
            .Surface()
            .and_then(|surface| surface.cast::<IDirect3DDxgiInterfaceAccess>())
            .and_then(|access| unsafe { access.GetInterface::<ID3D11Texture2D>() });
        if let Ok(texture) = texture {
            if let Ok(raw) = self.read(&texture, content) {
                slot.put(raw);
            }
        }
    }

    /// Copies the visible part of `texture` (the content size, clipped to
    /// the texture) to CPU memory.
    fn read(
        &mut self,
        texture: &ID3D11Texture2D,
        content: SizeInt32,
    ) -> windows::core::Result<RawFrame> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut desc) };
        let width = (content.Width.max(1) as u32).min(desc.Width);
        let height = (content.Height.max(1) as u32).min(desc.Height);
        let staging = self.staging(width, height)?;
        let region = D3D11_BOX {
            left: 0,
            top: 0,
            front: 0,
            right: width,
            bottom: height,
            back: 1,
        };
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            self.context
                .CopySubresourceRegion(&staging, 0, 0, 0, 0, texture, 0, Some(&region));
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        }
        let pixels = unsafe {
            let data = std::slice::from_raw_parts(
                mapped.pData.cast::<u8>(),
                mapped.RowPitch as usize * height as usize,
            );
            pack_rows(
                data,
                mapped.RowPitch as usize,
                width as usize * 4,
                height as usize,
            )
        };
        unsafe { self.context.Unmap(&staging, 0) };
        Ok(RawFrame {
            width,
            height,
            pixels,
        })
    }

    fn staging(&mut self, width: u32, height: u32) -> windows::core::Result<ID3D11Texture2D> {
        if let Some((texture, w, h)) = &self.staging {
            if (*w, *h) == (width, height) {
                return Ok(texture.clone());
            }
        }
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut texture = None;
        unsafe { self.d3d.CreateTexture2D(&desc, None, Some(&mut texture)) }?;
        let texture = texture.ok_or_else(windows::core::Error::empty)?;
        self.staging = Some((texture.clone(), width, height));
        Ok(texture)
    }
}

/// Drops the padding at the end of each mapped row.
fn pack_rows(data: &[u8], pitch: usize, row: usize, height: usize) -> Vec<u8> {
    let mut pixels = Vec::with_capacity(row * height);
    for line in data.chunks(pitch).take(height) {
        pixels.extend_from_slice(&line[..row.min(line.len())]);
    }
    pixels
}

/// A running capture. Dropping it ends the capture session (and the
/// yellow sharing border) and stops the encoder.
pub struct WgcStream {
    item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    frame_token: i64,
    closed_token: i64,
    slot: Arc<Slot>,
    encoder: Option<JoinHandle<()>>,
}

impl WgcStream {
    fn start(
        d3d: &ID3D11Device,
        device: &IDirect3DDevice,
        item: GraphicsCaptureItem,
        request: &ScreenRequest,
        sink: FrameSink,
    ) -> windows::core::Result<Self> {
        let size = item.Size()?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            POOL_BUFFERS,
            size,
        )?;
        let session = pool.CreateCaptureSession(&item)?;
        // Missing on older Windows builds: the defaults (cursor shown,
        // border drawn) are acceptable there.
        let _ = session.SetIsCursorCaptureEnabled(request.cursor);
        let _ = session.SetIsBorderRequired(false);

        let slot = Arc::new(Slot::default());
        let copier = Mutex::new(Copier {
            d3d: d3d.clone(),
            context: unsafe { d3d.GetImmediateContext() }?,
            device: AgileReference::new(device)?,
            staging: None,
            pool_size: size,
            throttle: Throttle::new(request.frame_rate),
        });
        let arrived_slot = slot.clone();
        let frame_token = pool.FrameArrived(&TypedEventHandler::new(
            move |pool: windows::core::Ref<Direct3D11CaptureFramePool>, _| {
                if let Some(pool) = pool.as_ref() {
                    copier
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .frame_arrived(pool, &arrived_slot);
                }
                Ok(())
            },
        ))?;
        let closed_sink = sink.clone();
        let closed_token = item.Closed(&TypedEventHandler::new(move |_, _| {
            closed_sink.fail(ENDED);
            Ok(())
        }))?;

        let encoder_slot = slot.clone();
        let max = (request.max_width, request.max_height);
        let encoder = thread::Builder::new()
            .name("disc-screen-encoder".into())
            .spawn(move || encode_frames(&encoder_slot, max, &sink))
            .map_err(|_| windows::core::Error::empty())?;

        let stream = Self {
            item,
            pool,
            session,
            frame_token,
            closed_token,
            slot,
            encoder: Some(encoder),
        };
        stream.session.StartCapture()?;
        Ok(stream)
    }
}

impl Drop for WgcStream {
    fn drop(&mut self) {
        let _ = self.pool.RemoveFrameArrived(self.frame_token);
        let _ = self.item.RemoveClosed(self.closed_token);
        let _ = self.session.Close();
        let _ = self.pool.Close();
        self.slot.close();
        if let Some(encoder) = self.encoder.take() {
            let _ = encoder.join();
        }
    }
}

/// Encoder thread: scales and encodes the newest frame until closed.
fn encode_frames(slot: &Slot, max: (u32, u32), sink: &FrameSink) {
    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    let factory: windows::core::Result<IWICImagingFactory> =
        unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) };
    match factory {
        Ok(factory) => {
            while let Some(frame) = slot.take() {
                // A frame that fails to encode is skipped; the next one
                // replaces it.
                if let Ok(jpeg) = encode_jpeg(&factory, &frame, max) {
                    sink.publish(&jpeg);
                }
            }
        }
        Err(cause) => sink.fail(error(NO_ENCODER, cause)),
    }
    if initialized {
        unsafe { CoUninitialize() };
    }
}

fn encode_jpeg(
    factory: &IWICImagingFactory,
    frame: &RawFrame,
    max: (u32, u32),
) -> windows::core::Result<Vec<u8>> {
    let (width, height) = fit((frame.width, frame.height), max);
    unsafe {
        let bitmap = factory.CreateBitmapFromMemory(
            frame.width,
            frame.height,
            &GUID_WICPixelFormat32bppBGR,
            frame.width * 4,
            &frame.pixels,
        )?;
        let mut source: IWICBitmapSource = bitmap.cast()?;
        if (width, height) != (frame.width, frame.height) {
            let scaler = factory.CreateBitmapScaler()?;
            scaler.Initialize(&source, width, height, WICBitmapInterpolationModeFant)?;
            source = scaler.cast()?;
        }
        let converter = factory.CreateFormatConverter()?;
        converter.Initialize(
            &source,
            &GUID_WICPixelFormat24bppBGR,
            WICBitmapDitherTypeNone,
            None,
            0.0,
            WICBitmapPaletteTypeCustom,
        )?;

        let stream = SHCreateMemStream(None).ok_or_else(windows::core::Error::empty)?;
        let encoder = factory.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
        let mut target = None;
        let mut options = None;
        encoder.CreateNewFrame(&mut target, &mut options)?;
        let target = target.ok_or_else(windows::core::Error::empty)?;
        if let Some(options) = &options {
            let mut name: Vec<u16> = "ImageQuality\0".encode_utf16().collect();
            let property = PROPBAG2 {
                vt: VT_R4,
                pstrName: PWSTR(name.as_mut_ptr()),
                ..Default::default()
            };
            let value = VARIANT::from(JPEG_QUALITY);
            // Without it the encoder keeps its default quality.
            let _ = options.Write(1, &property, &value);
        }
        target.Initialize(options.as_ref())?;
        target.SetSize(width, height)?;
        let mut format = GUID_WICPixelFormat24bppBGR;
        target.SetPixelFormat(&mut format)?;
        target.WriteSource(&converter, std::ptr::null())?;
        target.Commit()?;
        encoder.Commit()?;

        let mut length = 0u64;
        stream.Seek(0, STREAM_SEEK_END, Some(&mut length))?;
        stream.Seek(0, STREAM_SEEK_SET, None)?;
        let mut jpeg = vec![0u8; length as usize];
        let mut read = 0u32;
        stream
            .Read(jpeg.as_mut_ptr().cast(), length as u32, Some(&mut read))
            .ok()?;
        jpeg.truncate(read as usize);
        Ok(jpeg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format;
    use windows::core::factory;
    use windows::Win32::{
        Foundation::POINT,
        Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY},
        System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop,
    };

    #[test]
    fn rows_lose_their_padding() {
        // 2 x 2 pixels, 4 bytes each, rows padded to 12 bytes.
        let data = [
            1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0, //
            3, 3, 3, 3, 4, 4, 4, 4, 0, 0, 0, 0,
        ];
        assert_eq!(
            pack_rows(&data, 12, 8, 2),
            [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]
        );
    }

    #[test]
    fn slot_keeps_only_the_newest_frame() {
        let slot = Slot::default();
        let frame = |width| RawFrame {
            width,
            height: 1,
            pixels: Vec::new(),
        };
        slot.put(frame(1));
        slot.put(frame(2));
        assert_eq!(slot.take().map(|frame| frame.width), Some(2));
        slot.close();
        slot.put(frame(3));
        assert!(slot.take().is_none());
    }

    /// Width and height from a JPEG's baseline SOF segment.
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

    #[test]
    fn encodes_scaled_jpeg() {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .unwrap();
        let factory: IWICImagingFactory =
            unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }
                .unwrap();
        let frame = RawFrame {
            width: 2560,
            height: 1440,
            pixels: vec![0x80; 2560 * 1440 * 4],
        };
        let jpeg = encode_jpeg(&factory, &frame, (1280, 720)).unwrap();
        assert!(format::is_complete_jpeg(&jpeg));
        assert_eq!(jpeg_size(&jpeg), Some((1280, 720)));
        // Smaller sources keep their size (made even).
        let small = RawFrame {
            width: 801,
            height: 601,
            pixels: vec![0x10; 801 * 601 * 4],
        };
        let jpeg = encode_jpeg(&factory, &small, (1280, 720)).unwrap();
        assert_eq!(jpeg_size(&jpeg), Some((800, 600)));
    }

    /// Captures the primary monitor without the picker, through the same
    /// stream the backend uses. Shows the sharing border for a moment.
    #[test]
    #[ignore = "captures the primary monitor of an interactive desktop"]
    fn captures_valid_jpeg_frames_from_the_primary_monitor() {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.ok();
        let d3d = create_d3d_device().unwrap();
        let device = winrt_device(&d3d).unwrap();
        let monitor = unsafe { MonitorFromPoint(POINT::default(), MONITOR_DEFAULTTOPRIMARY) };
        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().unwrap();
        let item: GraphicsCaptureItem = unsafe { interop.CreateForMonitor(monitor) }.unwrap();
        let engine_frames = Arc::new(crate::backend::Frames::default());
        let sink = engine_frames.begin();
        let request = ScreenRequest {
            frame_rate: 30,
            ..ScreenRequest::default()
        }
        .normalized();
        let stream = WgcStream::start(&d3d, &device, item, &request, sink).unwrap();
        let started = Instant::now();
        let mut frames = 0;
        while started.elapsed() < Duration::from_secs(3) {
            if let Some(frame) = engine_frames.next(Duration::from_millis(500)).unwrap() {
                assert!(format::is_complete_jpeg(&frame));
                let (width, height) = jpeg_size(&frame).unwrap();
                assert!(width <= request.max_width && height <= request.max_height);
                frames += 1;
            }
        }
        drop(stream);
        println!("{frames} frames in 3 s");
        assert!(frames >= 1, "no frame in 3 s");
    }
}
