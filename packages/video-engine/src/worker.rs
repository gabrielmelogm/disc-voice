//! Plumbing shared by the capture engines: one thread that owns the native
//! backend for its whole life, and blocking request/reply calls into it.

use std::{
    sync::mpsc::{self, Receiver, Sender, SyncSender},
    thread,
};

pub(crate) type Reply<T> = SyncSender<Result<T, String>>;

/// Starts the `name` thread, builds the backend on it (backends may rely on
/// thread affinity, e.g. COM apartments) and hands it to `run` with the
/// request queue. Returns once the backend exists, or with its error.
pub(crate) fn spawn<B, R>(
    name: &str,
    make: impl FnOnce() -> Result<B, String> + Send + 'static,
    run: impl FnOnce(B, Receiver<R>) + Send + 'static,
) -> Result<Sender<R>, String>
where
    R: Send + 'static,
{
    let (sender, receiver) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name(name.into())
        .spawn(move || match make() {
            Ok(backend) => {
                let _ = ready_tx.send(Ok(()));
                run(backend, receiver);
            }
            Err(error) => {
                let _ = ready_tx.send(Err(error));
            }
        })
        .map_err(|error| error.to_string())?;
    ready_rx.recv().map_err(|error| error.to_string())??;
    Ok(sender)
}

/// Sends one request and waits for the worker's answer.
pub(crate) fn call<R, T>(
    sender: &Sender<R>,
    make: impl FnOnce(Reply<T>) -> R,
) -> Result<T, String> {
    let (reply, answer) = mpsc::sync_channel(1);
    sender
        .send(make(reply))
        .map_err(|_| "O motor de vídeo foi encerrado. Reinicie o aplicativo.".to_string())?;
    answer
        .recv()
        .map_err(|_| "O motor de vídeo parou de responder. Reinicie o aplicativo.".to_string())?
}
