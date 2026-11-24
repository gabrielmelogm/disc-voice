//! Rich Presence: shows on Discord that the user is in a Disc Voice call.
//!
//! Discord's HTTP API cannot set another user's presence; its desktop client
//! accepts it over a local socket instead (`discord-ipc-N`: a named pipe on
//! Windows, a Unix socket on Linux). Frames are `[op u32 LE][len u32 LE][json]`:
//! a handshake (op 0) with the application id, then `SET_ACTIVITY` commands
//! (op 1). Closing the connection clears the activity.
//!
//! A thread owns the connection. Discord may be closed, opened later or
//! restarted, so it keeps trying while there is something to show; failures
//! never reach the interface.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{self, Read, Write},
    sync::{
        mpsc::{self, RecvTimeoutError},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Manager, Runtime, State};

/// How often to retry connecting while Discord is not reachable.
const RETRY: Duration = Duration::from_secs(15);
/// How often to send the activity again, which also notices a restarted Discord.
const REFRESH: Duration = Duration::from_secs(60);
const MAX_FRAME: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CallPresence {
    pub channel: String,
    pub server: String,
    /// When the user joined, in milliseconds since the epoch.
    pub started_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
struct Desired {
    client_id: String,
    activity: Value,
}

pub struct DiscordPresence(Mutex<mpsc::Sender<Option<Desired>>>);

pub fn manage<R: Runtime>(app: &tauri::App<R>) {
    let (sender, receiver) = mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("discord-rpc".into())
        .spawn(move || worker(receiver));
    if let Err(error) = spawned {
        eprintln!("Rich Presence do Discord indisponível: {error}");
    }
    app.manage(DiscordPresence(Mutex::new(sender)));
}

/// Clears the activity when the app closes.
pub fn shutdown<R: Runtime>(window: &tauri::Window<R>) {
    if let Some(state) = window.try_state::<DiscordPresence>() {
        let _ = state.0.lock().map(|sender| sender.send(None));
    }
}

/// Shows (or, with no call, clears) the call on Discord.
#[tauri::command]
pub fn discord_presence(
    state: State<'_, DiscordPresence>,
    client_id: Option<String>,
    presence: Option<CallPresence>,
) {
    let desired = client_id
        .filter(|id| snowflake(id))
        .zip(presence)
        .map(|(client_id, call)| Desired {
            client_id,
            activity: activity_payload(&call),
        });
    if let Ok(sender) = state.0.lock() {
        let _ = sender.send(desired);
    }
}

fn snowflake(value: &str) -> bool {
    !value.is_empty() && value.len() <= 20 && value.bytes().all(|b| b.is_ascii_digit())
}

/// Discord accepts 2 to 128 characters in each text field.
fn field(text: &str) -> Option<String> {
    let text: String = text.chars().filter(|c| !c.is_control()).take(128).collect();
    let text = text.trim();
    (text.chars().count() >= 2).then(|| text.to_owned())
}

/// The activity shown on Discord: "Disc Voice · Em um canal de voz ·
/// Sala · Servidor", with the elapsed time.
pub(crate) fn activity_payload(call: &CallPresence) -> Value {
    let mut activity = json!({
        "details": "Em um canal de voz",
        "assets": { "large_image": "logo", "large_text": "Disc Voice" },
        "instance": false,
    });
    let place = [call.channel.trim(), call.server.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    if let Some(state) = field(&place) {
        activity["state"] = json!(state);
    }
    if let Some(start) = call.started_at.filter(|start| *start > 0) {
        activity["timestamps"] = json!({ "start": start });
    }
    activity
}

trait Pipe: Read + Write + Send {}
impl<T: Read + Write + Send> Pipe for T {}

struct Connection {
    pipe: Box<dyn Pipe>,
    client_id: String,
    nonce: u64,
}

impl Connection {
    fn open(client_id: &str) -> io::Result<Self> {
        let mut last = io::Error::new(io::ErrorKind::NotFound, "Discord não está aberto");
        for pipe in candidates() {
            match handshake(pipe, client_id) {
                Ok(pipe) => {
                    return Ok(Self {
                        pipe,
                        client_id: client_id.to_owned(),
                        nonce: 0,
                    })
                }
                Err(error) => last = error,
            }
        }
        Err(last)
    }

    fn set_activity(&mut self, activity: Option<&Value>) -> io::Result<()> {
        self.nonce += 1;
        let command = json!({
            "cmd": "SET_ACTIVITY",
            "args": { "pid": std::process::id(), "activity": activity },
            "nonce": self.nonce.to_string(),
        });
        write_frame(&mut self.pipe, 1, &command)?;
        let answer = read_answer(&mut self.pipe)?;
        if answer["evt"] == "ERROR" {
            // Discord refused this activity; the connection still works.
            eprintln!(
                "O Discord recusou a Rich Presence: {}",
                answer["data"]["message"]
            );
        }
        Ok(())
    }
}

fn handshake(mut pipe: Box<dyn Pipe>, client_id: &str) -> io::Result<Box<dyn Pipe>> {
    write_frame(&mut pipe, 0, &json!({ "v": 1, "client_id": client_id }))?;
    let ready = read_answer(&mut pipe)?;
    if ready["evt"] != "READY" {
        return Err(io::Error::other("handshake recusado pelo Discord"));
    }
    Ok(pipe)
}

#[cfg(windows)]
fn candidates() -> impl Iterator<Item = Box<dyn Pipe>> {
    (0..10).filter_map(|i| {
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(format!(r"\\.\pipe\discord-ipc-{i}"))
            .ok()
            .map(|file| Box::new(file) as Box<dyn Pipe>)
    })
}

#[cfg(target_os = "linux")]
fn candidates() -> impl Iterator<Item = Box<dyn Pipe>> {
    use std::{os::unix::net::UnixStream, path::PathBuf};
    let mut roots: Vec<PathBuf> = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
        .iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .collect();
    roots.push("/tmp".into());
    // Regular, Flatpak and Snap installs of Discord.
    let folders = ["", "app/com.discordapp.Discord", "snap.discord"];
    let paths: Vec<PathBuf> = roots
        .iter()
        .flat_map(|root| folders.iter().map(move |folder| root.join(folder)))
        .flat_map(|dir| (0..10).map(move |i| dir.join(format!("discord-ipc-{i}"))))
        .collect();
    paths.into_iter().filter_map(|path| {
        let stream = UnixStream::connect(path).ok()?;
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        Some(Box::new(stream) as Box<dyn Pipe>)
    })
}

fn encode(op: u32, payload: &Value) -> Vec<u8> {
    let body = payload.to_string();
    let mut frame = Vec::with_capacity(8 + body.len());
    frame.extend_from_slice(&op.to_le_bytes());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(body.as_bytes());
    frame
}

fn write_frame(pipe: &mut impl Write, op: u32, payload: &Value) -> io::Result<()> {
    pipe.write_all(&encode(op, payload))?;
    pipe.flush()
}

fn read_frame(pipe: &mut impl Read) -> io::Result<(u32, Value)> {
    let mut header = [0u8; 8];
    pipe.read_exact(&mut header)?;
    let op = u32::from_le_bytes(header[..4].try_into().unwrap());
    let len = u32::from_le_bytes(header[4..].try_into().unwrap()) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "quadro grande demais",
        ));
    }
    let mut body = vec![0u8; len];
    pipe.read_exact(&mut body)?;
    let payload = serde_json::from_slice(&body).unwrap_or(Value::Null);
    Ok((op, payload))
}

/// The next answer from Discord, replying to pings on the way.
fn read_answer<P: Read + Write + ?Sized>(pipe: &mut Box<P>) -> io::Result<Value> {
    loop {
        match read_frame(pipe)? {
            (1, payload) => return Ok(payload),
            // Close.
            (2, payload) => {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    payload["message"]
                        .as_str()
                        .unwrap_or("fechado pelo Discord")
                        .to_owned(),
                ))
            }
            // Ping → pong.
            (3, payload) => write_frame(pipe, 4, &payload)?,
            _ => {}
        }
    }
}

fn worker(receiver: mpsc::Receiver<Option<Desired>>) {
    let mut desired: Option<Desired> = None;
    let mut connection: Option<Connection> = None;
    // What Discord shows now, and when it was sent.
    let mut shown: Option<(Desired, Instant)> = None;
    loop {
        match receiver.recv_timeout(RETRY) {
            Ok(next) => desired = next,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        // Only the latest state matters.
        while let Ok(next) = receiver.try_recv() {
            desired = next;
        }
        let Some(want) = desired.clone() else {
            // Nothing to show: clearing and closing removes it from Discord.
            if let Some(mut open) = connection.take() {
                let _ = open.set_activity(None);
            }
            shown = None;
            continue;
        };
        let fresh = shown
            .as_ref()
            .is_some_and(|(sent, at)| *sent == want && at.elapsed() < REFRESH);
        if fresh {
            continue;
        }
        if connection
            .as_ref()
            .is_some_and(|c| c.client_id != want.client_id)
        {
            connection = None;
        }
        if connection.is_none() {
            connection = Connection::open(&want.client_id).ok();
        }
        let Some(open) = connection.as_mut() else {
            shown = None;
            continue;
        };
        match open.set_activity(Some(&want.activity)) {
            Ok(()) => shown = Some((want, Instant::now())),
            Err(_) => {
                // Discord closed or restarted: reconnect on the next round.
                connection = None;
                shown = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[test]
    fn builds_the_activity() {
        let activity = activity_payload(&CallPresence {
            channel: "Sala de reunião".into(),
            server: "Amigos".into(),
            started_at: Some(1_700_000_000_000),
        });
        assert_eq!(activity["details"], "Em um canal de voz");
        assert_eq!(activity["state"], "Sala de reunião · Amigos");
        assert_eq!(activity["timestamps"]["start"], 1_700_000_000_000i64);
        assert_eq!(activity["assets"]["large_image"], "logo");

        let long = activity_payload(&CallPresence {
            channel: "x".repeat(300),
            server: String::new(),
            started_at: None,
        });
        assert_eq!(long["state"].as_str().unwrap().chars().count(), 128);
        assert!(long.get("timestamps").is_none());
        // Too short for Discord: left out.
        let short = activity_payload(&CallPresence {
            channel: "a".into(),
            server: " ".into(),
            started_at: None,
        });
        assert!(short.get("state").is_none());
        assert!(!snowflake("../x") && snowflake("123"));
    }

    /// A fake Discord: answers are queued, writes are recorded.
    struct Fake {
        input: VecDeque<u8>,
        output: Vec<u8>,
    }

    impl Read for Fake {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.input.read(buf)
        }
    }

    impl Write for Fake {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.output.write(buf)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn frames_and_pings() {
        let frame = encode(1, &json!({ "a": 1 }));
        assert_eq!(&frame[..4], &1u32.to_le_bytes());
        assert_eq!(&frame[4..8], &7u32.to_le_bytes());
        assert_eq!(
            read_frame(&mut frame.as_slice()).unwrap(),
            (1, json!({ "a": 1 }))
        );

        let mut input = encode(3, &json!({ "p": 1 }));
        input.extend(encode(1, &json!({ "evt": "READY" })));
        let mut pipe = Box::new(Fake {
            input: input.into(),
            output: Vec::new(),
        });
        assert_eq!(read_answer(&mut pipe).unwrap()["evt"], "READY");
        // The ping was answered with a pong carrying the same payload.
        assert_eq!(
            read_frame(&mut pipe.output.as_slice()).unwrap(),
            (4, json!({ "p": 1 }))
        );

        let mut closed = Box::new(Fake {
            input: encode(2, &json!({ "message": "Invalid Client ID" })).into(),
            output: Vec::new(),
        });
        assert!(read_answer(&mut closed).is_err());
    }
}
