//! The app's short sounds (mute, joining a call, messages...). WebView2 plays
//! them with `<audio>`; WebKitGTK plays media through GStreamer, and most
//! distributions install no MP3 decoder for it, so the page stays silent. On
//! Linux the sounds are embedded, decoded in Rust and played over PulseAudio
//! (PipeWire on current distributions), like call audio.

/// Whether the page must ask for sounds here instead of using `<audio>`.
#[tauri::command]
pub fn sound_native() -> bool {
    cfg!(target_os = "linux")
}

#[cfg(target_os = "linux")]
pub mod native {
    use libpulse_binding::{
        def::BufferAttr,
        sample::{Format, Spec},
        stream::Direction,
    };
    use libpulse_simple_binding::Simple;
    use std::{
        collections::HashMap,
        io::Cursor,
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc, Mutex, OnceLock,
        },
        thread,
    };
    use symphonia::core::{
        audio::SampleBuffer, codecs::DecoderOptions, formats::FormatOptions, io::MediaSourceStream,
        meta::MetadataOptions, probe::Hint,
    };

    const APP_NAME: &str = "Disc Voice";
    /// Written in 20 ms steps, so a newer play of the same sound stops it quickly.
    const CHUNK_MS: usize = 20;

    macro_rules! song {
        ($file:literal) => {
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../public/songs/",
                $file
            ))
        };
    }

    const NAMES: [&str; 5] = ["notification", "voice-connect", "mic", "screen", "leave"];

    /// The page names a sound; it cannot pick a file.
    fn bytes(name: &str) -> Option<&'static [u8]> {
        Some(match name {
            "notification" => song!("notification.mp3"),
            "voice-connect" => song!("user-voicecall-connect.mp3"),
            "mic" => song!("mic-control-notification.mp3"),
            "screen" => song!("share-media-voicecall-notification.mp3"),
            "leave" => song!("notification-beep.mp3"),
            _ => return None,
        })
    }

    /// Interleaved samples at the file's own rate; the server resamples.
    struct Pcm {
        rate: u32,
        channels: u8,
        samples: Vec<f32>,
    }

    fn decode(data: &'static [u8]) -> Result<Pcm, String> {
        let source = MediaSourceStream::new(Box::new(Cursor::new(data)), Default::default());
        let mut hint = Hint::new();
        hint.with_extension("mp3");
        let probed = symphonia::default::get_probe()
            .format(
                &hint,
                source,
                &FormatOptions::default(),
                &MetadataOptions::default(),
            )
            .map_err(|error| error.to_string())?;
        let mut format = probed.format;
        let track = format.default_track().ok_or("som sem faixa de áudio")?;
        let track_id = track.id;
        let mut decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .map_err(|error| error.to_string())?;
        let (mut rate, mut channels) = (0, 0);
        let mut samples = Vec::new();
        while let Ok(packet) = format.next_packet() {
            if packet.track_id() != track_id {
                continue;
            }
            // A damaged frame only loses that frame.
            let Ok(decoded) = decoder.decode(&packet) else {
                continue;
            };
            let spec = *decoded.spec();
            rate = spec.rate;
            channels = spec.channels.count() as u8;
            let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
            buffer.copy_interleaved_ref(decoded);
            samples.extend_from_slice(buffer.samples());
        }
        if samples.is_empty() || rate == 0 || channels == 0 {
            return Err("som vazio".into());
        }
        Ok(Pcm {
            rate,
            channels,
            samples,
        })
    }

    struct Sound {
        pcm: OnceLock<Option<Arc<Pcm>>>,
        /// Bumped on every play: an older play of this sound stops (restart, like `<audio>`).
        generation: Arc<AtomicU64>,
    }

    fn sound(name: &'static str) -> Arc<Sound> {
        static SOUNDS: OnceLock<Mutex<HashMap<&'static str, Arc<Sound>>>> = OnceLock::new();
        let mut sounds = SOUNDS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        sounds
            .entry(name)
            .or_insert_with(|| {
                Arc::new(Sound {
                    pcm: OnceLock::new(),
                    generation: Arc::new(AtomicU64::new(0)),
                })
            })
            .clone()
    }

    fn open(pcm: &Pcm, device: Option<&str>) -> Result<Simple, libpulse_binding::error::PAErr> {
        let spec = Spec {
            format: Format::FLOAT32NE,
            rate: pcm.rate,
            channels: pcm.channels,
        };
        let chunk = (pcm.rate as usize * CHUNK_MS / 1000 * pcm.channels as usize * 4) as u32;
        let attr = BufferAttr {
            maxlength: u32::MAX,
            tlength: chunk * 3,
            prebuf: u32::MAX,
            minreq: u32::MAX,
            fragsize: u32::MAX,
        };
        Simple::new(
            None,
            APP_NAME,
            Direction::Playback,
            device,
            "Som do app",
            &spec,
            None,
            Some(&attr),
        )
    }

    fn play_blocking(
        pcm: &Pcm,
        output: &str,
        generation: &AtomicU64,
        mine: u64,
    ) -> Result<(), String> {
        let simple = match open(pcm, (!output.is_empty()).then_some(output)) {
            Ok(simple) => simple,
            // The chosen speakers are gone: the default ones play it.
            Err(_) if !output.is_empty() => open(pcm, None).map_err(|error| format!("{error}"))?,
            Err(error) => return Err(format!("{error}")),
        };
        let step = pcm.rate as usize * CHUNK_MS / 1000 * pcm.channels as usize;
        for chunk in pcm.samples.chunks(step) {
            if generation.load(Ordering::Relaxed) != mine {
                // Replaced by a newer play: cut it off without waiting for the tail.
                let _ = simple.flush();
                return Ok(());
            }
            let bytes: Vec<u8> = chunk
                .iter()
                .flat_map(|sample| sample.to_ne_bytes())
                .collect();
            simple.write(&bytes).map_err(|error| format!("{error}"))?;
        }
        simple.drain().map_err(|error| format!("{error}"))
    }

    /// Plays sound `name` on `output` (a PulseAudio sink name; empty for the
    /// default). Returns at once; a newer play of the same sound restarts it.
    #[tauri::command]
    pub fn play_sound(name: String, output: String) -> Result<(), String> {
        let Some((key, data)) = NAMES
            .into_iter()
            .find(|key| *key == name)
            .and_then(|key| Some((key, bytes(key)?)))
        else {
            return Err(format!("som desconhecido: {name}"));
        };
        let sound = sound(key);
        let mine = sound.generation.fetch_add(1, Ordering::Relaxed) + 1;
        thread::Builder::new()
            .name("disc-sound".into())
            .spawn(move || {
                let pcm = sound.pcm.get_or_init(|| match decode(data) {
                    Ok(pcm) => Some(Arc::new(pcm)),
                    Err(error) => {
                        eprintln!("Disc Voice: não foi possível decodificar o som {key}: {error}");
                        None
                    }
                });
                let Some(pcm) = pcm else { return };
                if let Err(error) = play_blocking(pcm, &output, &sound.generation, mine) {
                    eprintln!("Disc Voice: não foi possível tocar o som {key}: {error}");
                }
            })
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn every_sound_decodes() {
            for name in NAMES {
                let pcm = decode(bytes(name).unwrap()).unwrap();
                assert!(pcm.rate >= 44_100, "{name}");
                assert!(pcm.samples.len() > pcm.rate as usize / 10, "{name}");
            }
        }

        /// Needs an audio server: `cargo test sounds -- --ignored`.
        #[test]
        #[ignore]
        fn plays_on_the_default_speakers() {
            let pcm = decode(bytes("voice-connect").unwrap()).unwrap();
            let generation = AtomicU64::new(1);
            play_blocking(&pcm, "", &generation, 1).unwrap();
        }

        #[test]
        fn unknown_names_are_refused() {
            assert!(play_sound("../../etc/passwd".into(), String::new()).is_err());
        }
    }
}

#[cfg(not(target_os = "linux"))]
pub mod native {
    //! WebView2 plays the sounds with `<audio>`; the UI never calls this here.

    #[tauri::command]
    pub fn play_sound() -> Result<(), String> {
        Err("Os sons nativos não são usados nesta plataforma.".into())
    }
}
