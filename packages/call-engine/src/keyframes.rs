//! Lets a peer's keyframe requests (PLI, FIR) reach us.
//!
//! webrtc-rs stops inbound RTCP at the end of its interceptor chain unless
//! an interceptor marks a packet for the application. Without this we never
//! learn that a peer lost a picture, and had to send keyframes on a timer:
//! each 1080p keyframe is ~250 KB, and the rate control then skipped about
//! half a second of frames to pay for it.

use rtc::{
    interceptor::{Attribute, Interceptor, Packet, StreamInfo, TaggedPacket},
    rtcp::{
        self,
        payload_feedbacks::{
            full_intra_request::FullIntraRequest, picture_loss_indication::PictureLossIndication,
        },
    },
    sansio::Protocol,
    shared::error::Error,
};
use std::{collections::VecDeque, time::Instant};

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
}

impl Protocol<TaggedPacket, TaggedPacket, ()> for KeyframeRequests {
    type Rout = TaggedPacket;
    type Wout = TaggedPacket;
    type Eout = ();
    type Error = Error;
    type Time = Instant;

    fn handle_read(&mut self, mut msg: TaggedPacket) -> Result<(), Self::Error> {
        if let Packet::Rtcp(packets) = &msg.message.packet {
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
}
