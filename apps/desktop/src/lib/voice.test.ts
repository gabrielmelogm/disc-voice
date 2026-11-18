import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeCommand, RealtimeEvent } from "@disc-voice/shared";
import { api } from "./api";
import { Voice } from "./voice";
import type { Realtime } from "./realtime";

const channel = { id: "voice-1", serverId: "server-1", name: "conversa", type: "voice" as const };
const participant = { peerId: "self", user: { id: "user-1", email: "amigo@example.com", name: "Amigo" }, muted: false, deafened: false };

function setup() {
  let listener: (event: RealtimeEvent) => void = () => {};
  let notify = () => {};
  let status = "connected";
  const send = vi.fn<(command: RealtimeCommand) => void>();
  const realtime = {
    getSnapshot: () => ({ status }),
    send,
    onEvent: (fn: typeof listener) => { listener = fn; return () => { listener = () => {}; }; },
    subscribe: (fn: () => void) => { notify = fn; return () => {}; },
  } as unknown as Realtime;
  const voice = new Voice(realtime);
  voice.start();
  return { voice, send, event: (event: RealtimeEvent) => listener(event), status: (next: string) => { status = next; notify(); } };
}

function stream() {
  const track = { enabled: true, kind: "audio", stop: vi.fn(), onended: null };
  return { track, media: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.spyOn(api, "voiceConfig").mockResolvedValue({ iceServers: [] });
  vi.stubGlobal("RTCPeerConnection", class {});
  vi.stubGlobal("AudioContext", class {
    resume = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    createAnalyser = () => ({ fftSize: 512, getFloatTimeDomainData: vi.fn(), disconnect: vi.fn() });
  });
});
afterEach(() => { vi.useRealTimers(); });

describe("voice lifecycle", () => {
  it("discards late microphone permissions after leaving", async () => {
    const media = stream();
    let resolve!: (stream: MediaStream) => void;
    const capture = vi.fn(() => new Promise<MediaStream>(done => { resolve = done; }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: capture, enumerateDevices: vi.fn().mockResolvedValue([]),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } });
    const { voice, send } = setup();
    const joining = voice.join(channel);
    await vi.waitFor(() => expect(capture).toHaveBeenCalled());
    voice.leave();
    resolve(media.media);
    await joining;
    expect(media.track.stop).toHaveBeenCalledOnce();
    expect(send.mock.calls.some(([event]) => event.type === "voice.join")).toBe(false);
    expect(voice.getSnapshot().status).toBe("idle");
    voice.dispose();
  });

  it("releases tracks on disconnect and restores controls when reconnecting", async () => {
    const first = stream();
    const second = stream();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: vi.fn().mockResolvedValueOnce(first.media).mockResolvedValueOnce(second.media),
      enumerateDevices: vi.fn().mockResolvedValue([]), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } });
    const { voice, event, status, send } = setup();
    await voice.join(channel);
    event({ type: "voice.joined", channelId: channel.id, peerId: "self", participants: [participant] });
    expect(voice.getSnapshot().status).toBe("connected");
    voice.toggleDeafen();
    expect(first.track.enabled).toBe(false);
    expect(send).toHaveBeenLastCalledWith({ type: "voice.state", muted: true, deafened: true });
    status("reconnecting");
    expect(first.track.stop).toHaveBeenCalledOnce();
    expect(voice.getSnapshot().status).toBe("reconnecting");
    status("connected");
    event({ type: "ready", peerId: "new-self" });
    await vi.waitFor(() => expect(send).toHaveBeenLastCalledWith({
      type: "voice.join", channelId: channel.id, muted: true, deafened: true,
    }));
    expect(second.track.enabled).toBe(false);
    voice.dispose();
    expect(second.track.stop).toHaveBeenCalledOnce();
  });

  it("reports microphone permission errors without joining the server room", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError")),
      enumerateDevices: vi.fn().mockResolvedValue([]), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } });
    const { voice, send } = setup();
    await voice.join(channel);
    expect(voice.getSnapshot().error).toMatch(/Permita o acesso/);
    expect(voice.getSnapshot().status).toBe("error");
    expect(send.mock.calls.some(([event]) => event.type === "voice.join")).toBe(false);
    voice.dispose();
  });

  it("elects one initial offerer and retains ICE candidates received before the offer", async () => {
    const media = stream();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: vi.fn().mockResolvedValue(media.media),
      enumerateDevices: vi.fn().mockResolvedValue([]), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    let peer!: FakePeer;
    class FakePeer {
      remoteDescription: RTCSessionDescriptionInit | null = null;
      localDescription = { toJSON: () => ({ type: "answer", sdp: "answer" }) };
      signalingState = "stable";
      connectionState = "new";
      onnegotiationneeded: (() => Promise<void>) | null = null;
      addTrack = vi.fn();
      close = vi.fn();
      addIceCandidate = vi.fn().mockResolvedValue(undefined);
      setLocalDescription = vi.fn().mockResolvedValue(undefined);
      setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => { this.remoteDescription = description; });
      constructor() { peer = this; }
    }
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    const { voice, event, send } = setup();
    await voice.join(channel);
    event({ type: "voice.joined", channelId: channel.id, peerId: "self", participants: [
      participant, { ...participant, peerId: "remote" },
    ] });
    await peer.onnegotiationneeded!();
    expect(peer.setLocalDescription).not.toHaveBeenCalled();
    event({ type: "voice.signal", channelId: channel.id, peerId: "remote", data: { candidate: { candidate: "candidate", usernameFragment: "ice" } } });
    event({ type: "voice.signal", channelId: channel.id, peerId: "remote", data: { description: { type: "offer", sdp: "a=ice-ufrag:ice\r\n" } } });
    await vi.waitFor(() => expect(peer.addIceCandidate).toHaveBeenCalledOnce());
    expect(send).toHaveBeenLastCalledWith({ type: "voice.signal", peerId: "remote", data: { description: { type: "answer", sdp: "answer" } } });
    voice.dispose();
    expect(peer.close).toHaveBeenCalledOnce();
  });
});
