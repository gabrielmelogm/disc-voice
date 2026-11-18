//! Opens the system screen picker and prints what was shared.
//!
//! `cargo run -p disc-video --example screen_probe [seconds]`: after the
//! given time (default 10 s) the probe stops, dismissing the picker if it
//! is still open, so cancellation can be checked too.

#[cfg(target_os = "linux")]
fn main() {
    use disc_video::{ScreenEngine, ScreenRequest};
    use std::time::{Duration, Instant};

    let seconds = std::env::args()
        .nth(1)
        .and_then(|arg| arg.parse().ok())
        .unwrap_or(10);
    let engine = ScreenEngine::new().expect("screen engine");
    let stopper = engine.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(seconds));
        println!("stop()");
        stopper.stop();
    });
    let started = Instant::now();
    let result = engine.start(ScreenRequest::default());
    println!("start -> {result:?} after {:?}", started.elapsed());
    if let Ok(Some(_)) = result {
        let mut frames = 0;
        while let Ok(frame) = engine.next_frame(Duration::from_millis(500)) {
            match frame {
                Some(frame) => {
                    frames += 1;
                    if frames == 1 {
                        println!("first frame: {} bytes", frame.len());
                    }
                }
                None if started.elapsed() > Duration::from_secs(seconds) => break,
                None => {}
            }
        }
        println!("{frames} frames");
    }
    engine.shutdown();
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("Screen capture is only implemented on Linux.");
}
