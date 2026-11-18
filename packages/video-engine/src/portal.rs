//! Minimal xdg-desktop-portal client shared by the camera and screen-cast
//! backends: request/response calls, session handles and PipeWire remotes.
//!
//! Portal methods that need the user return a `Request` object right away
//! and answer later through its `Response` signal. [`request`] subscribes
//! before calling (a fast answer is not missed) and pumps a private main
//! context until the answer arrives, the timeout passes or the caller
//! cancels, in which case the request is closed (dismissing its dialog).

use gio::{glib, prelude::*};
use std::{
    cell::RefCell,
    os::fd::{FromRawFd, OwnedFd},
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};

pub(crate) const BUS_NAME: &str = "org.freedesktop.portal.Desktop";
pub(crate) const PATH: &str = "/org/freedesktop/portal/desktop";
const REQUEST_INTERFACE: &str = "org.freedesktop.portal.Request";
const SESSION_INTERFACE: &str = "org.freedesktop.portal.Session";
const CALL_TIMEOUT_MS: i32 = 5_000;

/// How the user (or the policy) answered a request.
pub(crate) enum Outcome {
    /// Allowed; carries the method's results.
    Granted(glib::VariantDict),
    /// The user dismissed the dialog, or the caller cancelled the request.
    Cancelled,
    /// Refused or failed on the portal's side.
    Denied,
    /// No answer before the timeout; the request was closed.
    TimedOut,
}

pub(crate) fn session_bus() -> Result<gio::DBusConnection, String> {
    gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE)
        .map_err(|error| error.to_string())
}

/// An `a{sv}` dictionary.
pub(crate) fn dict(entries: &[(&str, glib::Variant)]) -> glib::Variant {
    let dict = glib::VariantDict::new(None);
    for (key, value) in entries {
        dict.insert_value(key, value);
    }
    dict.end()
}

pub(crate) fn object_path(path: &str) -> Result<glib::Variant, String> {
    glib::variant::ObjectPath::try_from(path.to_owned())
        .map(|path| path.to_variant())
        .map_err(|_| format!("Caminho D-Bus inválido: {path}"))
}

/// A token unique to this process, for request and session handles.
pub(crate) fn token() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "discvoice{}_{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

/// The object path the portal uses for `token` (the documented scheme, so
/// the signal can be subscribed before the call returns it).
fn handle_path(
    connection: &gio::DBusConnection,
    kind: &str,
    token: &str,
) -> Result<String, String> {
    let sender = connection
        .unique_name()
        .ok_or("Conexão D-Bus sem nome.")?
        .trim_start_matches(':')
        .replace('.', "_");
    Ok(format!("{PATH}/{kind}/{sender}/{token}"))
}

/// Session handles follow the same scheme as requests.
pub(crate) fn session_path(
    connection: &gio::DBusConnection,
    token: &str,
) -> Result<String, String> {
    handle_path(connection, "session", token)
}

/// Calls `method` with `leading` arguments followed by an options
/// dictionary (a `handle_token` is added) and waits for the `Response`.
/// `Err` is a D-Bus failure: the portal or the method is missing.
pub(crate) fn request(
    connection: &gio::DBusConnection,
    interface: &str,
    method: &str,
    leading: &[glib::Variant],
    options: &[(&str, glib::Variant)],
    timeout: Duration,
    cancelled: &dyn Fn() -> bool,
) -> Result<Outcome, String> {
    let token = token();
    let request_path = handle_path(connection, "request", &token)?;
    let mut entries = options.to_vec();
    entries.push(("handle_token", token.to_variant()));
    let parameters =
        glib::Variant::tuple_from_iter(leading.iter().cloned().chain([dict(&entries)]));

    let context = glib::MainContext::new();
    context
        .with_thread_default(|| {
            let answer: Rc<RefCell<Option<(u32, glib::Variant)>>> = Rc::default();
            let slot = answer.clone();
            let subscription = connection.signal_subscribe(
                Some(BUS_NAME),
                Some(REQUEST_INTERFACE),
                Some("Response"),
                Some(&request_path),
                None,
                gio::DBusSignalFlags::NONE,
                move |_, _, _, _, _, parameters| {
                    let code = parameters.child_value(0).get::<u32>().unwrap_or(2);
                    *slot.borrow_mut() = Some((code, parameters.child_value(1)));
                },
            );
            let call = connection.call_sync(
                Some(BUS_NAME),
                PATH,
                interface,
                method,
                Some(&parameters),
                None,
                gio::DBusCallFlags::NONE,
                CALL_TIMEOUT_MS,
                gio::Cancellable::NONE,
            );
            let deadline = Instant::now() + timeout;
            let mut stopped = None;
            while call.is_ok() && answer.borrow().is_none() {
                if cancelled() {
                    stopped = Some(Outcome::Cancelled);
                    break;
                }
                if Instant::now() >= deadline {
                    stopped = Some(Outcome::TimedOut);
                    break;
                }
                if !context.iteration(false) {
                    thread::sleep(Duration::from_millis(5));
                }
            }
            connection.signal_unsubscribe(subscription);
            call.map_err(|error| error.to_string())?;
            if let Some(outcome) = stopped {
                // Closes the dialog, if the portal still shows one.
                close(connection, &request_path, REQUEST_INTERFACE);
                return Ok(outcome);
            }
            let (code, results) = answer.take().expect("loop ends with an answer");
            Ok(match code {
                0 => Outcome::Granted(glib::VariantDict::new(Some(&results))),
                1 => Outcome::Cancelled,
                _ => Outcome::Denied,
            })
        })
        .map_err(|error| error.to_string())?
}

/// Ends a portal session (stops its sharing indicator). Sessions also end
/// with the D-Bus connection, but the session bus connection is shared and
/// lives as long as the app.
pub(crate) fn close_session(connection: &gio::DBusConnection, session: &str) {
    close(connection, session, SESSION_INTERFACE);
}

fn close(connection: &gio::DBusConnection, path: &str, interface: &str) {
    let _ = connection.call_sync(
        Some(BUS_NAME),
        path,
        interface,
        "Close",
        None,
        None,
        gio::DBusCallFlags::NONE,
        CALL_TIMEOUT_MS,
        gio::Cancellable::NONE,
    );
}

/// A portal interface property, e.g. `AvailableSourceTypes`.
pub(crate) fn property(
    connection: &gio::DBusConnection,
    interface: &str,
    name: &str,
) -> Option<glib::Variant> {
    connection
        .call_sync(
            Some(BUS_NAME),
            PATH,
            "org.freedesktop.DBus.Properties",
            "Get",
            Some(&(interface, name).to_variant()),
            Some(glib::VariantTy::new("(v)").expect("valid type")),
            gio::DBusCallFlags::NONE,
            CALL_TIMEOUT_MS,
            gio::Cancellable::NONE,
        )
        .ok()?
        .child_value(0)
        .as_variant()
}

/// `OpenPipeWireRemote` of `interface`, with `leading` arguments (e.g. the
/// session handle) before an empty options dictionary.
pub(crate) fn open_pipewire_remote(
    connection: &gio::DBusConnection,
    interface: &str,
    leading: &[glib::Variant],
) -> Result<OwnedFd, String> {
    let parameters = glib::Variant::tuple_from_iter(leading.iter().cloned().chain([dict(&[])]));
    let (reply, fds) = connection
        .call_with_unix_fd_list_sync(
            Some(BUS_NAME),
            PATH,
            interface,
            "OpenPipeWireRemote",
            Some(&parameters),
            Some(glib::VariantTy::new("(h)").expect("valid type")),
            gio::DBusCallFlags::NONE,
            CALL_TIMEOUT_MS,
            gio::UnixFDList::NONE,
            gio::Cancellable::NONE,
        )
        .map_err(|error| error.to_string())?;
    let (glib::variant::Handle(index),) = reply.get().ok_or("Resposta inválida do portal.")?;
    // g_unix_fd_list_get returns a duplicate owned by the caller.
    let fd = fds.get(index).map_err(|error| error.to_string())?;
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}
