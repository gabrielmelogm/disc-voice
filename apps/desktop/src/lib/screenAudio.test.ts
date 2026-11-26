import { describe, expect, it } from "vitest";
import { opusStereo } from "./screenAudio";

describe("opusStereo", () => {
  const sdp = [
    "v=0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
    "a=rtpmap:111 opus/48000/2",
    "a=fmtp:111 minptime=10;useinbandfec=1",
    "a=rtpmap:63 red/48000/2",
    "a=fmtp:63 111/111",
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "a=rtpmap:96 VP8/90000",
    "",
  ].join("\r\n");

  it("lets Opus carry stereo and leaves the other codecs alone", () => {
    const stereo = opusStereo(sdp);
    expect(stereo).toContain("a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1\r\n");
    expect(stereo).toContain("a=fmtp:63 111/111\r\n");
    expect(stereo.split("\r\n")).toHaveLength(sdp.split("\r\n").length);
  });

  it("does not repeat what the description already says", () => {
    expect(opusStereo(opusStereo(sdp))).toBe(opusStereo(sdp));
    const native = sdp.replace("useinbandfec=1", "useinbandfec=1;stereo=1;sprop-stereo=1");
    expect(opusStereo(native)).toBe(native);
  });

  it("keeps descriptions without Opus as they are", () => {
    expect(opusStereo("v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n")).toBe("v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n");
  });
});
