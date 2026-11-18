//! The latest picture of each peer's screen, pulled by the UI as JPEG.
//!
//! Each screen has one reader (its canvas), so a picture is handed out once
//! and a slow reader skips pictures instead of queueing them.

use std::{
    collections::HashMap,
    sync::{Condvar, Mutex},
    time::{Duration, Instant},
};

struct Slot {
    /// Which receiver owns the slot: a peer can replace its screen track
    /// (stop and share again) while the previous receiver is still ending.
    owner: u64,
    jpeg: Option<Vec<u8>>,
}

#[derive(Default)]
pub(crate) struct Frames {
    slots: Mutex<HashMap<String, Slot>>,
    ready: Condvar,
}

impl Frames {
    fn slots(&self) -> std::sync::MutexGuard<'_, HashMap<String, Slot>> {
        self.slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Replaces the slot's picture; true when `owner` just took the slot.
    pub fn publish(&self, key: &str, owner: u64, jpeg: Vec<u8>) -> bool {
        let mut slots = self.slots();
        let taken = slots.get(key).is_none_or(|slot| slot.owner != owner);
        slots.insert(
            key.to_owned(),
            Slot {
                owner,
                jpeg: Some(jpeg),
            },
        );
        drop(slots);
        self.ready.notify_all();
        taken
    }

    /// Removes the slot if `owner` still holds it; true when it did.
    pub fn release(&self, key: &str, owner: u64) -> bool {
        let mut slots = self.slots();
        if slots.get(key).is_some_and(|slot| slot.owner == owner) {
            slots.remove(key);
            return true;
        }
        false
    }

    /// Removes the slot whoever owns it; true when there was one.
    pub fn release_any(&self, key: &str) -> bool {
        self.slots().remove(key).is_some()
    }

    pub fn clear(&self) {
        self.slots().clear();
        self.ready.notify_all();
    }

    /// Waits for a picture the reader has not seen yet.
    pub fn next(&self, key: &str, timeout: Duration) -> Option<Vec<u8>> {
        let deadline = Instant::now() + timeout;
        let mut slots = self.slots();
        loop {
            if let Some(jpeg) = slots.get_mut(key).and_then(|slot| slot.jpeg.take()) {
                return Some(jpeg);
            }
            let left = deadline.checked_duration_since(Instant::now())?;
            slots = self
                .ready
                .wait_timeout(slots, left)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const JPEG: [u8; 4] = [0xFF, 0xD8, 0xFF, 0xD9];

    #[test]
    fn hands_each_picture_out_once() {
        let frames = Frames::default();
        assert!(frames.publish("peer", 1, JPEG.to_vec()));
        assert!(!frames.publish("peer", 1, JPEG.to_vec()));
        assert_eq!(frames.next("peer", Duration::ZERO).unwrap(), JPEG);
        assert!(frames.next("peer", Duration::from_millis(10)).is_none());
    }

    #[test]
    fn an_old_owner_cannot_remove_the_new_screen() {
        let frames = Frames::default();
        frames.publish("peer", 1, JPEG.to_vec());
        assert!(
            frames.publish("peer", 2, JPEG.to_vec()),
            "new owner takes the slot"
        );
        assert!(!frames.release("peer", 1));
        assert!(frames.next("peer", Duration::ZERO).is_some());
        assert!(frames.release("peer", 2));
    }

    #[test]
    fn waits_for_the_next_picture() {
        let frames = Arc::new(Frames::default());
        let producer = frames.clone();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            producer.publish("peer", 7, JPEG.to_vec());
        });
        assert_eq!(frames.next("peer", Duration::from_secs(2)).unwrap(), JPEG);
        thread.join().unwrap();
    }
}
