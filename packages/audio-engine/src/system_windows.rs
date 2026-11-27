//! System audio on Windows: WASAPI process loopback of everything except what
//! this app plays (Windows 10 build 20348 / Windows 11 and later).

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
        Foundation::CloseHandle,
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
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
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

const WEBVIEW_BROWSER: &str = "msedgewebview2.exe";

/// A running process: its ID, its parent's and its executable's name.
type ProcessEntry = (u32, u32, String);

/// Every running process; empty when Windows does not list them.
fn processes() -> Vec<ProcessEntry> {
    let mut list = Vec::new();
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return list;
    };
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
    while more {
        let name = &entry.szExeFile;
        let len = name.iter().position(|&c| c == 0).unwrap_or(name.len());
        list.push((
            entry.th32ProcessID,
            entry.th32ParentProcessID,
            String::from_utf16_lossy(&name[..len]),
        ));
        more = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
    }
    let _ = unsafe { CloseHandle(snapshot) };
    list
}

/// Our WebView2 browser process: the child of `own` that runs WebView2.
fn webview_browser(own: u32, processes: &[ProcessEntry]) -> Option<u32> {
    processes
        .iter()
        .find(|(pid, parent, name)| {
            *parent == own && *pid != own && name.eq_ignore_ascii_case(WEBVIEW_BROWSER)
        })
        .map(|(pid, ..)| *pid)
}

/// The process whose tree the capture leaves out.
///
/// Process loopback only leaves out the target and its direct children, not
/// their children. Everything this app plays (the call, its sounds) comes
/// from WebView2's audio service, a child of the WebView2 browser process,
/// which is in turn our child: so the browser process is the target. Without
/// one (no webview yet), ourselves.
fn excluded_process() -> u32 {
    let own = std::process::id();
    webview_browser(own, &processes()).unwrap_or(own)
}

fn activate() -> Result<IAudioClient, String> {
    let fail = |error: windows::core::Error| format!("{UNSUPPORTED} ({})", error.message());
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: excluded_process(),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(pid: u32, parent: u32, name: &str) -> ProcessEntry {
        (pid, parent, name.into())
    }

    #[test]
    fn targets_our_webview_browser() {
        let list = [
            entry(10, 1, "disc-voice-desktop.exe"),
            entry(20, 5, "msedgewebview2.exe"), // another app's webview
            entry(30, 10, "conhost.exe"),
            entry(40, 10, "MsEdgeWebView2.exe"),
            entry(50, 40, "msedgewebview2.exe"), // its audio service
        ];
        assert_eq!(webview_browser(10, &list), Some(40));
    }

    #[test]
    fn without_a_webview_there_is_no_browser() {
        let list = [
            entry(10, 1, "disc-voice-desktop.exe"),
            entry(30, 10, "conhost.exe"),
        ];
        assert_eq!(webview_browser(10, &list), None);
    }

    #[test]
    fn lists_this_process() {
        let own = std::process::id();
        assert!(processes().iter().any(|(pid, ..)| *pid == own));
    }
}
