import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeCommand, RealtimeEvent } from "@disc-voice/shared";
import { api } from "./api";
import { nativeCall, type CallEvent } from "./nativeCall";
import { nativeScreen } from "./nativeScreen";
import { Voice } from "./voice";
import type { Realtime } from "./realtime";

const share = vi.hoisted(() => ({
  stop: vi.fn(),
  track: { kind: "video" } as unknown as MediaStreamTrack,
  stream: { id: "screen" } as unknown as MediaStream,
  onError: (_message: string) => {},
}));
vi.mock("./screenTrack", () => ({
  screenTrack: vi.fn((_pull: unknown, _rate: number, onError: (message: string) => void) => {
    share.onError = onError;
    return { stream: share.stream, track: share.track, stop: share.stop };
  }),
}));

const channel = { id: "voice-1", serverId: "server-1", name: "conversa", type: "voice" as const };
const participant = { peerId: "self", user: { id: "user-1", email: "amigo@example.com", name: "Amigo" }, muted: false, deafened: false, screen: false };

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
    expect(send).toHaveBeenLastCalledWith({ type: "voice.state", muted: true, deafened: true, screen: false });
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

describe("screen sharing in a call", () => {
  const info = { source: "unknown" as const, width: 2560, height: 1440, maxWidth: 1920, maxHeight: 1080, frameRate: 30, cursor: true };

  class ScreenPeer {
    static all: ScreenPeer[] = [];
    remoteDescription = null;
    signalingState = "stable";
    connectionState = "new";
    ontrack: ((event: { track: { kind: string; onended?: () => void }; streams: MediaStream[] }) => void) | null = null;
    senders: { track: unknown; setParameters: ReturnType<typeof vi.fn> }[] = [];
    addTrack = vi.fn((track: unknown) => {
      const sender = { track, getParameters: () => ({ encodings: [{}] }), setParameters: vi.fn().mockResolvedValue(undefined) };
      this.senders.push(sender);
      return sender;
    });
    removeTrack = vi.fn();
    close = vi.fn();
    constructor() { ScreenPeer.all.push(this); }
  }

  const screenSenders = (peer: ScreenPeer) => peer.addTrack.mock.calls.filter(([track]) => track === share.track);

  async function inCall() {
    const media = stream();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: vi.fn().mockResolvedValue(media.media),
      enumerateDevices: vi.fn().mockResolvedValue([]), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    ScreenPeer.all = [];
    vi.stubGlobal("RTCPeerConnection", ScreenPeer);
    vi.stubGlobal("MediaStream", class { constructor(public tracks: unknown[]) {} });
    const stop = vi.spyOn(nativeScreen, "stop").mockResolvedValue(undefined);
    const start = vi.spyOn(nativeScreen, "start").mockResolvedValue(info);
    const call = setup();
    await call.voice.join(channel);
    call.event({ type: "voice.joined", channelId: channel.id, peerId: "self", participants: [
      participant, { ...participant, peerId: "remote" },
    ] });
    return { ...call, start, stop };
  }

  it("sends the screen to every peer, including later ones, and stops it", async () => {
    const { voice, send, event, start, stop } = await inCall();
    await voice.startScreen();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ maxWidth: 1920, maxHeight: 1080, frameRate: 30 }));
    expect(voice.getSnapshot()).toMatchObject({ screen: "live", screenInfo: info, localScreen: share.stream });
    expect(screenSenders(ScreenPeer.all[0])).toHaveLength(1);
    expect(send).toHaveBeenLastCalledWith({ type: "voice.state", muted: false, deafened: false, screen: true });

    event({ type: "voice.participants", serverId: "server-1", channelId: channel.id, participants: [
      participant, { ...participant, peerId: "remote" }, { ...participant, peerId: "late" },
    ] });
    expect(ScreenPeer.all).toHaveLength(2);
    expect(screenSenders(ScreenPeer.all[1])).toHaveLength(1);

    voice.stopScreen();
    for (const peer of ScreenPeer.all) expect(peer.removeTrack).toHaveBeenCalledOnce();
    expect(share.stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(voice.getSnapshot()).toMatchObject({ screen: "idle", localScreen: null });
    expect(send).toHaveBeenLastCalledWith({ type: "voice.state", muted: false, deafened: false, screen: false });
    voice.dispose();
  });

  it("returns to idle when the picker is dismissed", async () => {
    const { voice, start } = await inCall();
    start.mockResolvedValueOnce(null);
    await voice.startScreen();
    expect(voice.getSnapshot().screen).toBe("idle");
    expect(screenSenders(ScreenPeer.all[0])).toHaveLength(0);
    voice.dispose();
  });

  it("cancelling while picking closes the picker and ignores the late answer", async () => {
    const { voice, start, stop } = await inCall();
    let answer!: (value: typeof info) => void;
    start.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));
    const starting = voice.startScreen();
    expect(voice.getSnapshot().screen).toBe("picking");
    voice.stopScreen();
    expect(stop).toHaveBeenCalledOnce();
    answer(info);
    await starting;
    expect(voice.getSnapshot().screen).toBe("idle");
    expect(screenSenders(ScreenPeer.all[0])).toHaveLength(0);
    voice.dispose();
  });

  it("ends sharing when leaving the call or when the capture ends", async () => {
    const { voice, stop } = await inCall();
    await voice.startScreen();
    share.onError("O compartilhamento de tela foi encerrado.");
    expect(voice.getSnapshot()).toMatchObject({ screen: "idle", error: "O compartilhamento de tela foi encerrado." });
    expect(stop).toHaveBeenCalledOnce();

    await voice.startScreen();
    voice.leave();
    expect(share.stop).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(voice.getSnapshot().screen).toBe("idle");
    voice.dispose();
  });

  it("the settings test taking the engine ends the call's sharing without stopping the capture", async () => {
    const { voice, stop } = await inCall();
    await voice.startScreen();
    const test = nativeScreen.claim(() => {});
    expect(voice.getSnapshot()).toMatchObject({ screen: "idle", error: expect.stringMatching(/teste/) });
    expect(stop).not.toHaveBeenCalled();
    test.release();
    voice.dispose();
  });

  it("shows screens received from peers until they leave", async () => {
    const { voice, event } = await inCall();
    const track: { kind: string; onended?: () => void } = { kind: "video" };
    ScreenPeer.all[0].ontrack!({ track, streams: [] });
    expect(Object.keys(voice.getSnapshot().remoteScreens)).toEqual(["remote"]);
    track.onended!();
    expect(voice.getSnapshot().remoteScreens).toEqual({});
    ScreenPeer.all[0].ontrack!({ track, streams: [] });
    event({ type: "voice.participants", serverId: "server-1", channelId: channel.id, participants: [participant] });
    expect(voice.getSnapshot().remoteScreens).toEqual({});
    voice.dispose();
  });
});

describe("native calls (Linux: WebKitGTK has no WebRTC)", () => {
  function nativeEngine() {
    let emit: (event: CallEvent) => void = () => {};
    const spies = {
      supported: vi.spyOn(nativeCall, "supported").mockResolvedValue(true),
      join: vi.spyOn(nativeCall, "join").mockImplementation(async (_config, onEvent) => { emit = onEvent; return 7; }),
      leave: vi.spyOn(nativeCall, "leave").mockResolvedValue(undefined),
      peers: vi.spyOn(nativeCall, "peers").mockResolvedValue(undefined),
      signal: vi.spyOn(nativeCall, "signal").mockResolvedValue(undefined),
      mute: vi.spyOn(nativeCall, "mute").mockResolvedValue(undefined),
      deafen: vi.spyOn(nativeCall, "deafen").mockResolvedValue(undefined),
      devices: vi.spyOn(nativeCall, "devices").mockResolvedValue({
        inputs: [{ id: "alsa_input.usb", name: "Microfone USB", isDefault: true }],
        outputs: [{ id: "alsa_output.hdmi", name: "HDMI", isDefault: true }],
      }),
      startScreen: vi.spyOn(nativeCall, "startScreen").mockResolvedValue(undefined),
      stopScreen: vi.spyOn(nativeCall, "stopScreen").mockResolvedValue(undefined),
      frame: vi.spyOn(nativeCall, "frame").mockResolvedValue(new ArrayBuffer(0)),
    };
    return { ...spies, emit: (event: CallEvent) => emit(event) };
  }

  beforeEach(() => {
    // The webview has no peer connection (and must not be asked for a mic).
    vi.stubGlobal("RTCPeerConnection", undefined);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: vi.fn().mockRejectedValue(new Error("not used")),
      enumerateDevices: vi.fn().mockResolvedValue([]), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  async function inNativeCall() {
    const engine = nativeEngine();
    const call = setup();
    await call.voice.join(channel);
    call.event({ type: "voice.joined", channelId: channel.id, peerId: "self", participants: [
      participant, { ...participant, peerId: "remote" },
    ] });
    return { ...call, engine };
  }

  it("joins through the engine and relays its signaling both ways", async () => {
    const { voice, send, event, engine } = await inNativeCall();
    expect(engine.join).toHaveBeenCalledWith(expect.objectContaining({ iceServers: [], inputId: "", muted: false, deafened: false }), expect.any(Function));
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ type: "voice.join", channelId: channel.id, muted: false, deafened: false });
    expect(engine.peers).toHaveBeenLastCalledWith("self", ["remote"]);
    expect(voice.getSnapshot().status).toBe("connecting");

    const offer = { description: { type: "offer" as const, sdp: "v=0\r\n" } };
    engine.emit({ type: "signal", peerId: "remote", data: offer });
    expect(send).toHaveBeenLastCalledWith({ type: "voice.signal", peerId: "remote", data: offer });
    const answer = { description: { type: "answer" as const, sdp: "v=0\r\n" } };
    event({ type: "voice.signal", channelId: channel.id, peerId: "remote", data: answer });
    expect(engine.signal).toHaveBeenCalledWith("remote", answer);

    engine.emit({ type: "peerState", peerId: "remote", state: "connected" });
    expect(voice.getSnapshot().status).toBe("connected");
    engine.emit({ type: "speaking", peerIds: ["remote", "self"] });
    expect(voice.getSnapshot().speaking).toEqual(["remote", "self"]);

    voice.toggleMute();
    expect(engine.mute).toHaveBeenLastCalledWith(true);
    voice.leave();
    expect(engine.leave).toHaveBeenCalledWith(7);
    engine.emit({ type: "speaking", peerIds: ["remote"] });
    expect(voice.getSnapshot().speaking).toEqual([]);
    voice.dispose();
  });

  it("lists the engine's devices and ends an abandoned join's call", async () => {
    const engine = nativeEngine();
    let finish!: (id: number) => void;
    engine.join.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { voice, send } = setup();
    await vi.waitFor(() => expect(voice.getSnapshot().devices.map(d => d.deviceId)).toEqual(["alsa_input.usb", "alsa_output.hdmi"]));
    expect(voice.getSnapshot().native).toBe(true);
    const joining = voice.join(channel);
    await vi.waitFor(() => expect(engine.join).toHaveBeenCalled());
    voice.leave();
    finish(9);
    await joining;
    expect(engine.leave).toHaveBeenCalledWith(9);
    expect(send.mock.calls.some(([command]) => command.type === "voice.join")).toBe(false);
    voice.dispose();
  });

  it("fails the call on engine errors", async () => {
    const { voice, engine } = await inNativeCall();
    engine.emit({ type: "error", message: "O microfone foi desconectado." });
    expect(voice.getSnapshot()).toMatchObject({ status: "error", error: "O microfone foi desconectado." });
    expect(engine.leave).toHaveBeenCalledWith(7);
    voice.dispose();
  });

  it("shares the screen through the engine and shows received screens as frames", async () => {
    const info = { source: "monitor" as const, width: 1920, height: 1080, maxWidth: 1920, maxHeight: 1080, frameRate: 30, cursor: true };
    vi.spyOn(nativeScreen, "start").mockResolvedValue(info);
    const stop = vi.spyOn(nativeScreen, "stop").mockResolvedValue(undefined);
    const { voice, send, event, engine } = await inNativeCall();
    await voice.startScreen();
    expect(engine.startScreen).toHaveBeenCalledWith(30);
    const local = voice.getSnapshot().localScreen as { pull: () => Promise<ArrayBuffer> };
    expect(local.pull).toBe(nativeScreen.frame);
    expect(send).toHaveBeenLastCalledWith({ type: "voice.state", muted: false, deafened: false, screen: true });

    engine.emit({ type: "screenEnded", message: "O compartilhamento de tela foi encerrado." });
    expect(voice.getSnapshot()).toMatchObject({ screen: "idle", localScreen: null, error: "O compartilhamento de tela foi encerrado." });
    expect(engine.stopScreen).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();

    engine.emit({ type: "screen", peerId: "remote", active: true });
    const remote = voice.getSnapshot().remoteScreens.remote as { pull: () => Promise<ArrayBuffer> };
    await remote.pull();
    expect(engine.frame).toHaveBeenLastCalledWith("remote");
    event({ type: "voice.participants", serverId: "server-1", channelId: channel.id, participants: [participant] });
    expect(voice.getSnapshot().remoteScreens).toEqual({});
    expect(engine.peers).toHaveBeenLastCalledWith("self", []);
    voice.dispose();
  });
});
