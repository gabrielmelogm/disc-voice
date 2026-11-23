import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeCommand, RealtimeEvent } from "@disc-voice/shared";
import { api } from "./api";
import { nativeCall, type CallEvent } from "./nativeCall";
import { nativeCamera } from "./nativeCamera";
import { nativeScreen } from "./nativeScreen";
import { CAMERA_QUALITIES, Voice, roundTripMs, videoSource } from "./voice";
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

const sounds = vi.hoisted(() => ({ playMicSound: vi.fn(), playScreenSound: vi.fn(), playLeaveSound: vi.fn() }));
vi.mock("./notifications", () => sounds);

const channel = { id: "voice-1", serverId: "server-1", name: "conversa", type: "voice" as const };
const participant = { peerId: "self", user: { id: "user-1", email: "amigo@example.com", name: "Amigo" }, muted: false, deafened: false, screen: false };

function setup() {
  let listener: (event: RealtimeEvent) => void = () => {};
  let notify = () => {};
  let status = "connected";
  let latency: (ms: number | null) => void = () => {};
  const send = vi.fn<(command: RealtimeCommand) => void>();
  const realtime = {
    getSnapshot: () => ({ status }),
    latency: 30,
    onLatency: (fn: typeof latency) => { latency = fn; return () => { latency = () => {}; }; },
    send,
    onEvent: (fn: typeof listener) => { listener = fn; return () => { listener = () => {}; }; },
    subscribe: (fn: () => void) => { notify = fn; return () => {}; },
  } as unknown as Realtime;
  const voice = new Voice(realtime);
  voice.start();
  return {
    voice, send, event: (event: RealtimeEvent) => listener(event), status: (next: string) => { status = next; notify(); },
    serverLatency: (ms: number | null) => latency(ms),
  };
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
    expect(send).toHaveBeenLastCalledWith({ type: "voice.state", muted: true, deafened: true, screen: false, camera: false });
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

  it("plays the mic cue when muting or unmuting in a call, not before joining", async () => {
    const media = stream();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: vi.fn().mockResolvedValue(media.media),
      enumerateDevices: vi.fn().mockResolvedValue([]), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } });
    sounds.playMicSound.mockClear();
    const { voice, event } = setup();
    voice.toggleMute();
    voice.toggleMute();
    expect(sounds.playMicSound).not.toHaveBeenCalled();
    await voice.join(channel);
    event({ type: "voice.joined", channelId: channel.id, peerId: "self", participants: [participant] });
    voice.toggleMute();
    voice.toggleMute();
    expect(sounds.playMicSound).toHaveBeenCalledTimes(2);
    voice.toggleDeafen();
    expect(sounds.playMicSound).toHaveBeenCalledTimes(2);
    voice.dispose();
  });

  it("plays the leave cue only when the user hangs up a call", async () => {
    const media = stream();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: vi.fn().mockResolvedValue(media.media),
      enumerateDevices: vi.fn().mockResolvedValue([]), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } });
    sounds.playLeaveSound.mockClear();
    const { voice, event, send } = setup();
    voice.hangUp();
    expect(sounds.playLeaveSound).not.toHaveBeenCalled();
    await voice.join(channel);
    event({ type: "voice.joined", channelId: channel.id, peerId: "self", participants: [participant] });
    // Replaced by another device: the app leaves on its own, silently.
    event({ type: "voice.left", channelId: channel.id, reason: "replaced" });
    expect(sounds.playLeaveSound).not.toHaveBeenCalled();
    await voice.join(channel);
    event({ type: "voice.joined", channelId: channel.id, peerId: "self", participants: [participant] });
    voice.hangUp();
    expect(sounds.playLeaveSound).toHaveBeenCalledOnce();
    expect(send).toHaveBeenLastCalledWith({ type: "voice.leave" });
    expect(voice.getSnapshot()).toMatchObject({ status: "idle", channel: null });
    voice.dispose();
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
    expect(send).toHaveBeenLastCalledWith({ type: "voice.signal", peerId: "remote", data: { description: { type: "answer", sdp: "answer" }, streams: {} } });
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
    sounds.playScreenSound.mockClear();
    return { ...call, start, stop };
  }

  it("plays the share cue when sharing starts and stops, not for the picker or leaving", async () => {
    const { voice, start } = await inCall();
    await voice.startScreen();
    expect(sounds.playScreenSound).toHaveBeenCalledTimes(1);
    voice.stopScreen();
    expect(sounds.playScreenSound).toHaveBeenCalledTimes(2);

    start.mockResolvedValueOnce(null);
    await voice.startScreen();
    let answer!: (value: typeof info) => void;
    start.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));
    const starting = voice.startScreen();
    voice.stopScreen();
    answer(info);
    await starting;
    expect(sounds.playScreenSound).toHaveBeenCalledTimes(2);

    await voice.startScreen();
    expect(sounds.playScreenSound).toHaveBeenCalledTimes(3);
    voice.leave();
    expect(sounds.playScreenSound).toHaveBeenCalledTimes(3);
    voice.dispose();
  });

  it("sends the screen to every peer, including later ones, and stops it", async () => {
    const { voice, send, event, start, stop } = await inCall();
    await voice.startScreen();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ maxWidth: 1920, maxHeight: 1080, frameRate: 30 }));
    expect(voice.getSnapshot()).toMatchObject({ screen: "live", screenInfo: info, localScreen: share.stream });
    expect(screenSenders(ScreenPeer.all[0])).toHaveLength(1);
    expect(send).toHaveBeenLastCalledWith({ type: "voice.state", muted: false, deafened: false, screen: true, camera: false });

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
    expect(send).toHaveBeenLastCalledWith({ type: "voice.state", muted: false, deafened: false, screen: false, camera: false });
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

describe("webcam in a call (webview)", () => {
  class CameraPeer {
    static all: CameraPeer[] = [];
    remoteDescription = null;
    localDescription = { toJSON: () => ({ type: "offer", sdp: "offer" }) };
    signalingState = "stable";
    connectionState = "new";
    onnegotiationneeded: (() => Promise<void>) | null = null;
    ontrack: ((event: { track: { kind: string; onended?: () => void }; streams: { id: string }[] }) => void) | null = null;
    senders: { track: unknown; setParameters: ReturnType<typeof vi.fn> }[] = [];
    addTrack = vi.fn((track: unknown) => {
      const sender = { track, getParameters: () => ({ encodings: [{}] }), setParameters: vi.fn().mockResolvedValue(undefined) };
      this.senders.push(sender);
      return sender;
    });
    removeTrack = vi.fn();
    close = vi.fn();
    setLocalDescription = vi.fn().mockResolvedValue(undefined);
    setRemoteDescription = vi.fn().mockResolvedValue(undefined);
    stats = new Map<string, unknown>();
    getStats = vi.fn(async () => this.stats);
    constructor() { CameraPeer.all.push(this); }
  }

  function camera(id = "cam-stream") {
    const track = { kind: "video", stop: vi.fn(), onended: null as null | (() => void), contentHint: "" };
    return { track, media: { id, getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] } as unknown as MediaStream };
  }

  async function inCall() {
    const mic = stream();
    const cams = [camera("cam-1"), camera("cam-2")];
    let next = 0;
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => constraints.video ? cams[next++].media : mic.media);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    CameraPeer.all = [];
    vi.stubGlobal("RTCPeerConnection", CameraPeer);
    vi.stubGlobal("MediaStream", class { id = "received"; constructor(public tracks: unknown[]) {} });
    const call = setup();
    await call.voice.join(channel);
    call.event({ type: "voice.joined", channelId: channel.id, peerId: "a-self", participants: [
      { ...participant, peerId: "a-self" }, { ...participant, peerId: "remote" },
    ] });
    return { ...call, getUserMedia, cams };
  }

  const cameraSenders = (peer: CameraPeer, track: unknown) => peer.addTrack.mock.calls.filter(([sent]) => sent === track);

  it("sends the camera to every peer at the chosen quality, names its stream, and stops it", async () => {
    const { voice, send, event, getUserMedia, cams } = await inCall();
    await voice.startCamera();
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: false, video: expect.objectContaining({ width: { ideal: 640 }, height: { ideal: 360 } }) });
    expect(voice.getSnapshot()).toMatchObject({ camera: "live", localCamera: cams[0].media });
    expect(cameraSenders(CameraPeer.all[0], cams[0].track)).toHaveLength(1);
    await vi.waitFor(() => expect(CameraPeer.all[0].senders.at(-1)!.setParameters).toHaveBeenCalledWith({ encodings: [{ maxBitrate: 600_000 }] }));
    expect(send).toHaveBeenLastCalledWith({ type: "voice.state", muted: false, deafened: false, screen: false, camera: true });

    // The offer that adds the camera tells the peer which stream it is.
    await CameraPeer.all[0].onnegotiationneeded!();
    expect(send).toHaveBeenLastCalledWith({ type: "voice.signal", peerId: "remote", data: { description: { type: "offer", sdp: "offer" }, streams: { "cam-1": "camera" } } });

    event({ type: "voice.participants", serverId: "server-1", channelId: channel.id, participants: [
      { ...participant, peerId: "a-self" }, { ...participant, peerId: "remote" }, { ...participant, peerId: "late" },
    ] });
    expect(cameraSenders(CameraPeer.all[1], cams[0].track)).toHaveLength(1);

    voice.stopCamera();
    for (const peer of CameraPeer.all) expect(peer.removeTrack).toHaveBeenCalledOnce();
    expect(cams[0].track.stop).toHaveBeenCalledOnce();
    expect(voice.getSnapshot()).toMatchObject({ camera: "idle", localCamera: null });
    expect(send).toHaveBeenLastCalledWith({ type: "voice.state", muted: false, deafened: false, screen: false, camera: false });
    voice.dispose();
  });

  it("switching quality reopens the camera at the new size", async () => {
    const { voice, getUserMedia, cams } = await inCall();
    await voice.startCamera();
    voice.setCameraQuality("720p");
    await vi.waitFor(() => expect(voice.getSnapshot().localCamera).toBe(cams[1].media));
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: false, video: expect.objectContaining({ width: { ideal: 1280 }, height: { ideal: 720 } }) });
    expect(cams[0].track.stop).toHaveBeenCalledOnce();
    expect(localStorage.getItem("discvoice.voice.cameraQuality")).toBe("720p");
    voice.dispose();
  });

  it("turns the camera off with an error when the webcam is unplugged", async () => {
    const { voice, cams } = await inCall();
    await voice.startCamera();
    cams[0].track.onended!();
    expect(voice.getSnapshot()).toMatchObject({ camera: "idle", error: expect.stringMatching(/desconectada/) });
    voice.dispose();
  });

  it("files received videos as camera or screen by the stream names the peer sent", async () => {
    const { voice, event } = await inCall();
    event({ type: "voice.signal", channelId: channel.id, peerId: "remote", data: { description: { type: "answer", sdp: "x" }, streams: { "{cam}": "camera" } } });
    await vi.waitFor(() => expect(CameraPeer.all[0].setRemoteDescription).toHaveBeenCalled());
    CameraPeer.all[0].ontrack!({ track: { kind: "video" }, streams: [{ id: "{cam}" }] });
    expect(Object.keys(voice.getSnapshot().remoteCameras)).toEqual(["remote"]);
    expect(voice.getSnapshot().remoteScreens).toEqual({});
    CameraPeer.all[0].ontrack!({ track: { kind: "video" }, streams: [{ id: "{other}" }] });
    expect(Object.keys(voice.getSnapshot().remoteScreens)).toEqual(["remote"]);
    voice.dispose();
  });

  it("reads each peer's round trip every few seconds and forgets it when they leave", async () => {
    const { voice, event, serverLatency } = await inCall();
    expect(voice.getSnapshot().serverLatency).toBe(30);
    serverLatency(55);
    expect(voice.getSnapshot().serverLatency).toBe(55);
    CameraPeer.all[0].stats = new Map([
      ["T1", { id: "T1", type: "transport", selectedCandidatePairId: "P2" }],
      ["P1", { id: "P1", type: "candidate-pair", currentRoundTripTime: 0.3 }],
      ["P2", { id: "P2", type: "candidate-pair", currentRoundTripTime: 0.0424 }],
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(voice.getSnapshot().latency).toEqual({ remote: 42 });
    event({ type: "voice.participants", serverId: "server-1", channelId: channel.id, participants: [{ ...participant, peerId: "a-self" }] });
    expect(voice.getSnapshot().latency).toEqual({});
    voice.dispose();
  });

  it("recognizes native peers' fixed stream IDs", () => {
    expect(videoSource("disc-call-camera", {})).toBe("camera");
    expect(videoSource("disc-call-screen", {})).toBe("screen");
    expect(videoSource("{abc}", { "{abc}": "camera" })).toBe("camera");
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
      startCamera: vi.spyOn(nativeCall, "startCamera").mockResolvedValue(undefined),
      stopCamera: vi.spyOn(nativeCall, "stopCamera").mockResolvedValue(undefined),
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
    expect(send).toHaveBeenLastCalledWith({ type: "voice.state", muted: false, deafened: false, screen: true, camera: false });

    engine.emit({ type: "videoEnded", source: "screen", message: "O compartilhamento de tela foi encerrado." });
    expect(voice.getSnapshot()).toMatchObject({ screen: "idle", localScreen: null, error: "O compartilhamento de tela foi encerrado." });
    expect(engine.stopScreen).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();

    engine.emit({ type: "video", peerId: "remote", source: "screen", active: true });
    const remote = voice.getSnapshot().remoteScreens.remote as { pull: () => Promise<ArrayBuffer> };
    await remote.pull();
    expect(engine.frame).toHaveBeenLastCalledWith("remote", "screen");
    event({ type: "voice.participants", serverId: "server-1", channelId: channel.id, participants: [participant] });
    expect(voice.getSnapshot().remoteScreens).toEqual({});
    expect(engine.peers).toHaveBeenLastCalledWith("self", []);
    voice.dispose();
  });
  it("sends the camera through the engine and shows received cameras as frames", async () => {
    const startForCall = vi.spyOn(nativeCamera, "startForCall").mockResolvedValue({ deviceId: "camera-2", width: 1280, height: 720, frameRate: 30, passthrough: true });
    const stopCamera = vi.spyOn(nativeCamera, "stop").mockResolvedValue(undefined);
    const { voice, send, event, engine } = await inNativeCall();
    voice.setCamera("camera-2");
    await voice.startCamera();
    expect(startForCall).toHaveBeenCalledWith("camera-2", 360);
    expect(engine.startCamera).toHaveBeenCalledWith(30, CAMERA_QUALITIES["360p"].bitrate);
    expect((voice.getSnapshot().localCamera as { pull: unknown }).pull).toBe(nativeCamera.frame);
    expect(send).toHaveBeenLastCalledWith({ type: "voice.state", muted: false, deafened: false, screen: false, camera: true });

    // A new quality restarts the camera; the others keep seeing it on.
    send.mockClear();
    voice.setCameraQuality("720p");
    await vi.waitFor(() => expect(startForCall).toHaveBeenLastCalledWith("camera-2", 720));
    await vi.waitFor(() => expect(voice.getSnapshot().camera).toBe("live"));
    expect(engine.startCamera).toHaveBeenLastCalledWith(30, CAMERA_QUALITIES["720p"].bitrate);
    expect(send.mock.calls.every(([command]) => command.type !== "voice.state" || command.camera)).toBe(true);

    engine.emit({ type: "videoEnded", source: "camera", message: "A webcam parou de enviar vídeo." });
    expect(voice.getSnapshot()).toMatchObject({ camera: "idle", localCamera: null, error: "A webcam parou de enviar vídeo." });
    expect(stopCamera).toHaveBeenCalled();

    engine.emit({ type: "video", peerId: "remote", source: "camera", active: true });
    expect(voice.getSnapshot().remoteScreens).toEqual({});
    const remote = voice.getSnapshot().remoteCameras.remote as { pull: () => Promise<ArrayBuffer> };
    await remote.pull();
    expect(engine.frame).toHaveBeenLastCalledWith("remote", "camera");
    engine.emit({ type: "video", peerId: "remote", source: "camera", active: false });
    expect(voice.getSnapshot().remoteCameras).toEqual({});
    event({ type: "voice.participants", serverId: "server-1", channelId: channel.id, participants: [participant] });
    voice.dispose();
  });

  it("shows the round trip the engine measures to each peer", async () => {
    const { voice, event, engine } = await inNativeCall();
    engine.emit({ type: "latency", peerId: "remote", ms: 87 });
    expect(voice.getSnapshot().latency).toEqual({ remote: 87 });
    engine.emit({ type: "latency", peerId: "stranger", ms: 5 });
    expect(voice.getSnapshot().latency).toEqual({ remote: 87 });
    engine.emit({ type: "latency", peerId: "remote", ms: null });
    expect(voice.getSnapshot().latency).toEqual({});
    engine.emit({ type: "latency", peerId: "remote", ms: 90 });
    event({ type: "voice.participants", serverId: "server-1", channelId: channel.id, participants: [participant] });
    expect(voice.getSnapshot().latency).toEqual({});
    voice.dispose();
  });

  it("the settings test taking the camera turns the call's camera off without stopping the test", async () => {
    vi.spyOn(nativeCamera, "startForCall").mockResolvedValue({ deviceId: "camera-1", width: 640, height: 360, frameRate: 30, passthrough: true });
    const stopCamera = vi.spyOn(nativeCamera, "stop").mockResolvedValue(undefined);
    const { voice, send, engine } = await inNativeCall();
    await voice.startCamera();
    const test = nativeCamera.claim(() => {});
    expect(voice.getSnapshot()).toMatchObject({ camera: "idle", error: expect.stringMatching(/teste de câmera/) });
    expect(engine.stopCamera).toHaveBeenCalledOnce();
    expect(stopCamera).not.toHaveBeenCalled();
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "voice.state", camera: false }));
    test.release();
    voice.dispose();
  });
});

describe("round trip from WebRTC stats", () => {
  const report = (...entries: Record<string, unknown>[]) => new Map(entries.map(entry => [String(entry.id), entry])) as unknown as RTCStatsReport;

  it("prefers the selected ICE pair, then a nominated one, then RTCP", () => {
    expect(roundTripMs(report(
      { id: "T", type: "transport", selectedCandidatePairId: "B" },
      { id: "A", type: "candidate-pair", currentRoundTripTime: 0.5, nominated: true, state: "succeeded" },
      { id: "B", type: "candidate-pair", currentRoundTripTime: 0.012 },
    ))).toBe(12);
    expect(roundTripMs(report(
      { id: "A", type: "candidate-pair", currentRoundTripTime: 0.5, nominated: false, state: "succeeded" },
      { id: "B", type: "candidate-pair", currentRoundTripTime: 0.08, nominated: true, state: "succeeded" },
    ))).toBe(80);
    expect(roundTripMs(report(
      { id: "R1", type: "remote-inbound-rtp", roundTripTime: 0.2 },
      { id: "R2", type: "remote-inbound-rtp", roundTripTime: 0.15 },
    ))).toBe(150);
    expect(roundTripMs(report({ id: "A", type: "candidate-pair", nominated: true, state: "succeeded" }))).toBeNull();
  });
});
