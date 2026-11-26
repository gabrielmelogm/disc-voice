//! System audio on Windows: WASAPI process loopback of everything except our
//! own process tree (Windows 10 build 20348 / Windows 11 and later).

use crate::system::{ChunkSink, Pacer, CHANNELS, RATE};
use std::{
    mem::ManuallyDrop,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use windows::{
    core::{implement, Interface, Ref, HRESULT},
    Win32::{
        Media::Audio::{
            ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
            IActivateAudioInterfaceCompletionHandler,
            IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
            AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK,
            AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
            AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
            PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
        },
        System::{
            Com::{
                CoInitializeEx, CoUninitialize,
                StructuredStorage::{
                    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
                },
                BLOB, COINIT_MULTITHREADED,
            },
            Variant::VT_BLOB,
        },
    },
};

const UNSUPPORTED: &str =
    "A captura do áudio do computador requer o Windows 10 21H2, o Windows 11 \
                           ou mais recente. A tela será compartilhada sem áudio.";
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
/// How long WASAPI may buffer between our reads.
const BUFFER: i64 = 2_000_000; // 200 ms, in 100 ns units
const POLL: Duration = Duration::from_millis(5);
const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(5);

/// Hands the activation result back to the thread that asked for it.
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Activated(Mutex<Option<mpsc::Sender<()>>>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
    fn ActivateCompleted(
        &self,
        _operation: Ref<IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        if let Some(done) = self.0.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = done.send(());
        }
        Ok(())
    }
}

fn activate() -> Result<IAudioClient, String> {
    let fail = |error: windows::core::Error| format!("{UNSUPPORTED} ({})", error.message());
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: std::process::id(),
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    // Not dropped: PROPVARIANT's Drop calls PropVariantClear, which would
    // free the blob, and the blob is `params` on our stack.
    let blob = ManuallyDrop::new(PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 {
                    blob: BLOB {
                        cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                        pBlobData: (&raw mut params).cast(),
                    },
                },
            }),
        },
    });
    let (done, finished) = mpsc::channel();
    let handler: IActivateAudioInterfaceCompletionHandler =
        Activated(Mutex::new(Some(done))).into();
    let operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&raw const *blob),
            &handler,
        )
    }
    .map_err(fail)?;
    finished.recv_timeout(ACTIVATION_TIMEOUT).map_err(|_| {
        "O Windows não respondeu ao iniciar a captura do áudio do computador.".to_string()
    })?;
    let mut result = HRESULT(0);
    let mut client = None;
    unsafe { operation.GetActivateResult(&mut result, &mut client) }.map_err(fail)?;
    result.ok().map_err(fail)?;
    client
        .ok_or_else(|| UNSUPPORTED.to_string())?
        .cast::<IAudioClient>()
        .map_err(fail)
}

fn open() -> Result<(IAudioClient, IAudioCaptureClient), String> {
    let client = activate()?;
    let block = (CHANNELS * std::mem::size_of::<f32>()) as u16;
    // Process loopback has no mix format to ask for: we name ours and let
    // WASAPI convert to it.
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
        nChannels: CHANNELS as u16,
        nSamplesPerSec: RATE,
        nAvgBytesPerSec: RATE * u32::from(block),
        nBlockAlign: block,
        wBitsPerSample: 32,
        cbSize: 0,
    };
    let fail = |error: windows::core::Error| {
        format!(
            "Não foi possível capturar o áudio do computador: {}",
            error.message()
        )
    };
    unsafe {
        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                BUFFER,
                0,
                &format,
                None,
            )
            .map_err(fail)?;
        let capture = client.GetService::<IAudioCaptureClient>().map_err(fail)?;
        client.Start().map_err(fail)?;
        Ok((client, capture))
    }
}

/// Reads everything WASAPI has buffered; `Err` once the stream broke.
fn drain(capture: &IAudioCaptureClient, pacer: &mut Pacer) -> windows::core::Result<()> {
    loop {
        if unsafe { capture.GetNextPacketSize()? } == 0 {
            return Ok(());
        }
        let mut data = std::ptr::null_mut();
        let mut frames = 0;
        let mut flags = 0;
        unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)? };
        let samples = frames as usize * CHANNELS;
        let now = Instant::now();
        if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
            pacer.push(&vec![0.0; samples], now);
        } else {
            // SAFETY: WASAPI hands `frames` frames in the format we asked for.
            let audio = unsafe { std::slice::from_raw_parts(data.cast::<f32>(), samples) };
            pacer.push(audio, now);
        }
        unsafe { capture.ReleaseBuffer(frames)? };
    }
}

pub(crate) struct Capture {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Capture {
    pub fn start(sink: ChunkSink) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let (ready, started) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("disc-system-audio".into())
            .spawn(move || {
                let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
                match open() {
                    Ok((client, capture)) => {
                        let _ = ready.send(Ok(()));
                        let mut pacer = Pacer::new(sink, Instant::now());
                        while !flag.load(Ordering::Relaxed) {
                            if drain(&capture, &mut pacer).is_err() {
                                break;
                            }
                            pacer.tick(Instant::now());
                            thread::sleep(POLL);
                        }
                        let _ = unsafe { client.Stop() };
                    }
                    Err(error) => {
                        let _ = ready.send(Err(error));
                    }
                }
                if initialized {
                    unsafe { CoUninitialize() };
                }
            })
            .map_err(|error| error.to_string())?;
        match started.recv() {
            Ok(Ok(())) => Ok(Self {
                stop,
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => Err("A captura do áudio do computador parou inesperadamente.".into()),
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
