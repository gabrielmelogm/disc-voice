//! Lets a peer's keyframe requests (PLI, FIR) reach us, and measures the
//! round trip to the peer from its RTCP reports.
//!
//! webrtc-rs stops inbound RTCP at the end of its interceptor chain unless
//! an interceptor marks a packet for the application. Without this we never
//! learn that a peer lost a picture, and had to send keyframes on a timer:
//! each 1080p keyframe is ~250 KB, and the rate control then skipped about
//! half a second of frames to pay for it.
//!
//! webrtc-rs leaves every round-trip time in its stats at zero, so we
//! compute it as RFC 3550 §6.4.1 does: a report block echoes the middle bits
//! of our last sender report's NTP time (LSR) and how long the peer held it
//! (DLSR), so `arrival - LSR - DLSR` is the network round trip.

use rtc::{
    interceptor::{Attribute, Interceptor, Packet, StreamInfo, TaggedPacket},
    rtcp::{
        self,
        payload_feedbacks::{
            full_intra_request::FullIntraRequest, picture_loss_indication::PictureLossIndication,
        },
        receiver_report::ReceiverReport,
        reception_report::ReceptionReport,
        sender_report::SenderReport,
    },
    sansio::Protocol,
    shared::error::Error,
};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

/// No round trip measured yet.
pub(crate) const UNKNOWN_RTT: u32 = u32::MAX;

/// The middle 32 bits of the NTP time now, as report blocks echo it.
fn ntp_middle_now() -> u32 {
    let unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = unix.as_secs() + 0x83AA_7E80; // NTP epoch: 1900.
    let fraction = (u64::from(unix.subsec_nanos()) << 32) / 1_000_000_000;
    (((seconds << 32) | fraction) >> 16) as u32
}

/// Round trip in milliseconds from a report block that arrived at `arrival`
/// (middle NTP bits); `None` before the peer received any of our reports.
pub(crate) fn round_trip_ms(arrival: u32, report: &ReceptionReport) -> Option<u32> {
    if report.last_sender_report == 0 {
        return None;
    }
    let units = arrival
        .wrapping_sub(report.last_sender_report)
        .wrapping_sub(report.delay);
    // A "negative" result is clock noise on a very short path.
    if units >= 0x8000_0000 {
        return Some(0);
    }
    Some(((u64::from(units) * 1000) >> 16) as u32)
}

/// Whether an RTCP compound packet asks for a keyframe.
pub(crate) fn asks_keyframe(packets: &[Box<dyn rtcp::Packet>]) -> bool {
    packets.iter().any(|packet| {
        let packet = packet.as_any();
        packet.is::<PictureLossIndication>() || packet.is::<FullIntraRequest>()
    })
}

#[derive(Default)]
pub(crate) struct KeyframeRequests {
    read: VecDeque<TaggedPacket>,
    write: VecDeque<TaggedPacket>,
    /// Latest round trip to the peer in ms ([`UNKNOWN_RTT`] until measured).
    rtt: Arc<AtomicU32>,
}

impl KeyframeRequests {
    pub(crate) fn new(rtt: Arc<AtomicU32>) -> Self {
        Self {
            rtt,
            ..Self::default()
        }
    }

    fn measure(&self, packets: &[Box<dyn rtcp::Packet>]) {
        let arrival = ntp_middle_now();
        let reports = packets.iter().flat_map(|packet| {
            let packet = packet.as_any();
            let reports: &[ReceptionReport] =
                if let Some(rr) = packet.downcast_ref::<ReceiverReport>() {
                    &rr.reports
                } else if let Some(sr) = packet.downcast_ref::<SenderReport>() {
                    &sr.reports
                } else {
                    &[]
                };
            reports.iter()
        });
        // Every stream reports the same path; the smallest is the least
        // delayed by the peer's own scheduling.
        if let Some(rtt) = reports.filter_map(|r| round_trip_ms(arrival, r)).min() {
            self.rtt.store(rtt, Ordering::Relaxed);
        }
    }
}

impl Protocol<TaggedPacket, TaggedPacket, ()> for KeyframeRequests {
    type Rout = TaggedPacket;
    type Wout = TaggedPacket;
    type Eout = ();
    type Error = Error;
    type Time = Instant;

    fn handle_read(&mut self, mut msg: TaggedPacket) -> Result<(), Self::Error> {
        if let Packet::Rtcp(packets) = &msg.message.packet {
            self.measure(packets);
            if asks_keyframe(packets) && !msg.message.has(&Attribute::DeliverToApplication) {
                msg.message.add(Attribute::DeliverToApplication);
            }
        }
        self.read.push_back(msg);
        Ok(())
    }

    fn poll_read(&mut self) -> Option<Self::Rout> {
        self.read.pop_front()
    }

    fn handle_write(&mut self, msg: TaggedPacket) -> Result<(), Self::Error> {
        self.write.push_back(msg);
        Ok(())
    }

    fn poll_write(&mut self) -> Option<Self::Wout> {
        self.write.pop_front()
    }
}

impl Interceptor for KeyframeRequests {
    fn bind_local_stream(&mut self, _info: &StreamInfo) {}
    fn unbind_local_stream(&mut self, _info: &StreamInfo) {}
    fn bind_remote_stream(&mut self, _info: &StreamInfo) {}
    fn unbind_remote_stream(&mut self, _info: &StreamInfo) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use rtc::rtcp::receiver_report::ReceiverReport;

    #[test]
    fn recognizes_keyframe_requests() {
        let pli: Vec<Box<dyn rtcp::Packet>> = vec![Box::new(PictureLossIndication {
            sender_ssrc: 1,
            media_ssrc: 2,
        })];
        let report: Vec<Box<dyn rtcp::Packet>> = vec![Box::new(ReceiverReport::default())];
        assert!(asks_keyframe(&pli));
        assert!(!asks_keyframe(&report));
    }

    fn block(last_sender_report: u32, delay: u32) -> ReceptionReport {
        ReceptionReport {
            last_sender_report,
            delay,
            ..Default::default()
        }
    }

    #[test]
    fn round_trip_is_arrival_minus_our_report_minus_the_peers_delay() {
        // Units of 1/65536 s: sent at 10 s, held 0.5 s, back at 10.6 s.
        let rtt = round_trip_ms(10 * 65536 + 39322, &block(10 * 65536, 32768));
        assert_eq!(rtt, Some(100));
        assert_eq!(
            round_trip_ms(5, &block(0, 0)),
            None,
            "no report of ours yet"
        );
        assert_eq!(round_trip_ms(100, &block(101, 0)), Some(0), "clock noise");
        // Survives the NTP middle bits wrapping around.
        assert_eq!(round_trip_ms(3276, &block(u32::MAX - 3276, 0)), Some(99));
    }

    #[test]
    fn measures_the_smallest_round_trip_of_a_report() {
        let rtt = Arc::new(AtomicU32::new(UNKNOWN_RTT));
        let requests = KeyframeRequests::new(rtt.clone());
        let now = ntp_middle_now();
        let report: Vec<Box<dyn rtcp::Packet>> = vec![Box::new(ReceiverReport {
            reports: vec![
                block(now.wrapping_sub(6554), 0),
                block(now.wrapping_sub(3277), 0),
            ],
            ..Default::default()
        })];
        requests.measure(&report);
        let measured = rtt.load(Ordering::Relaxed);
        assert!((49..=60).contains(&measured), "{measured} ms");
    }
}
