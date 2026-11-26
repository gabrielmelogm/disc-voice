import type { Channel, RealtimeEvent, ScreenInfo, ScreenRequest, SignalPayload, VoiceParticipant } from "@disc-voice/shared";
import { api, message } from "./api";
import { nativeAudio } from "./audio";
import { cameraError, stopStream } from "./camera";
import { nativeCamera, type CameraClaim } from "./nativeCamera";
import { deviceInfos, nativeCall, type CallEvent, type VideoSource } from "./nativeCall";
import { nativeScreen, type ScreenClaim } from "./nativeScreen";
import { playLeaveSound, playMicSound, playScreenSound } from "./notifications";
import type { Realtime } from "./realtime";
import { opusStereo, screenAudio, type ScreenAudio } from "./screenAudio";
import { screenTrack, type ScreenTrack } from "./screenTrack";

export type ScreenQuality = "360p" | "720p" | "1080p";
export type ScreenFrameRate = 30 | 60;

/**
 * Screen sizes a call offers, with the upload for each frame rate. Every peer
 * gets its own copy (P2P mesh), so the upload is that times the others.
 */
export const SCREEN_QUALITIES: Record<ScreenQuality, { width: number; height: number; bitrate: Record<ScreenFrameRate, number>; label: string }> = {
  "360p": { width: 640, height: 360, bitrate: { 30: 800_000, 60: 1_200_000 }, label: "usa menos internet" },
  "720p": { width: 1280, height: 720, bitrate: { 30: 1_500_000, 60: 2_500_000 }, label: "equilibrada" },
  "1080p": { width: 1920, height: 1080, bitrate: { 30: 2_500_000, 60: 4_000_000 }, label: "mais nítida" },
};
export const SCREEN_FRAME_RATES: ScreenFrameRate[] = [30, 60];

/** What we choose when sharing the screen. */
export interface ScreenOptions {
  quality: ScreenQuality;
  frameRate: ScreenFrameRate;
  /** Send the computer's audio with it. */
  audio: boolean;
}

export function screenBitrate(quality: ScreenQuality, frameRate: ScreenFrameRate) {
  return SCREEN_QUALITIES[quality].bitrate[frameRate];
}

/** "1080p · 60 fps", for what we are sharing. */
export function screenLabel(share: { quality: ScreenQuality; frameRate: number }) {
  return `${share.quality} · ${share.frameRate} fps`;
}

/** The screen's audio: music and movies, in stereo. */
const SCREEN_AUDIO_BITRATE = 128_000;
const SCREEN_TAKEN = "O teste de compartilhamento de tela assumiu a captura.";
const CAMERA_TAKEN = "O teste de câmera nas configurações assumiu a webcam.";
const CAMERA_LOST = "A webcam foi desconectada ou o acesso à câmera foi interrompido.";
const CAMERA_FRAME_RATE = 30;
/** How often the webview reads each peer connection's round trip. */
const LATENCY_EVERY_MS = 2_000;

export type CameraQuality = "360p" | "720p";

/**
 * Camera sizes a call offers. Every peer gets its own copy (P2P mesh), so
 * the upload is the bitrate times the others in the call.
 */
export const CAMERA_QUALITIES: Record<CameraQuality, { width: number; height: number; bitrate: number; label: string }> = {
  "360p": { width: 640, height: 360, bitrate: 600_000, label: "360p · usa menos internet" },
  "720p": { width: 1280, height: 720, bitrate: 1_500_000, label: "720p · mais nítida" },
};

/**
 * A video to draw: a media stream (the webview's WebRTC) or JPEG frames
 * pulled from a native engine.
 */
export type VideoFeed = MediaStream | { pull: () => Promise<ArrayBuffer> };
/** A shared screen. */
export type ScreenFeed = VideoFeed;

export interface CameraOption {
  deviceId: string;
  label: string;
}

/** Our local volume for someone's shared screen audio. */
export interface ScreenVolume {
  /** From 0 to 1. */
  volume: number;
  muted: boolean;
}

export const DEFAULT_SCREEN_VOLUME: ScreenVolume = { volume: 1, muted: false };

export interface VoiceState {
  status: "idle" | "connecting" | "connected" | "reconnecting" | "error";
  channel: Channel | null;
  participants: VoiceParticipant[];
  muted: boolean;
  deafened: boolean;
  error: string;
  speaking: string[];
  devices: MediaDeviceInfo[];
  inputId: string;
  outputId: string;
  playbackBlocked: boolean;
  deviceBusy: boolean;
  /** Our own peer ID in the current call. */
  peerId: string;
  /** Whether this app can capture the screen natively. */
  screenSupported: boolean;
  /** Calls run in the native engine (Linux: WebKitGTK has no WebRTC). */
  native: boolean;
  /** `picking`: the system picker is open, waiting for the user. */
  screen: "idle" | "picking" | "live";
  screenInfo: ScreenInfo | null;
  /** What we send, for the local preview. */
  localScreen: ScreenFeed | null;
  /** Screens received, by peer ID, in the order they arrived. */
  remoteScreens: Record<string, ScreenFeed>;
  /** The peer whose screen is expanded in the call view, if any. */
  focusedScreen: string | null;
  /** Include the computer's audio when we share the screen (saved). */
  shareAudio: boolean;
  /** Quality and frame rate for the next share (saved). */
  screenQuality: ScreenQuality;
  screenFrameRate: ScreenFrameRate;
  /** What our screen is being sent at, while we share it. */
  screenShare: { quality: ScreenQuality; frameRate: ScreenFrameRate } | null;
  /** The screen we share carries the computer's audio right now. */
  screenAudio: boolean;
  /** Our volume for each person's screen audio, by user ID (saved). */
  screenVolumes: Record<string, ScreenVolume>;
  /** Whether this app can send a webcam in calls. */
  cameraSupported: boolean;
  camera: "idle" | "starting" | "live";
  /** Chosen webcam; empty for the default one. */
  cameraId: string;
  cameraQuality: CameraQuality;
  cameras: CameraOption[];
  /** Our webcam, for our own tile. */
  localCamera: VideoFeed | null;
  /** Webcams received, by peer ID. */
  remoteCameras: Record<string, VideoFeed>;
  /** Round trip to each peer in ms, once measured. */
  latency: Record<string, number>;
  /** Round trip to the server in ms; shown on our own tile. */
  serverLatency: number | null;
}

interface Peer {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  /** The audio of the peer's shared screen, played apart from its voice. */
  screenAudio?: HTMLAudioElement;
  screenSender?: RTCRtpSender;
  screenAudioSender?: RTCRtpSender;
  cameraSender?: RTCRtpSender;
  /** What the peer's video streams are, as its signaling named them. */
  streams: Record<string, VideoSource>;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingAnswer: boolean;
  candidates: RTCIceCandidateInit[];
  queue: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

function preference(key: string) {
  try { return localStorage.getItem(`discvoice.voice.${key}`) || ""; } catch { return ""; }
}

function savePreference(key: string, value: string) {
  try { localStorage.setItem(`discvoice.voice.${key}`, value); } catch { /* Optional preference. */ }
}

function savedQuality(): CameraQuality {
  const saved = preference("cameraQuality");
  return saved in CAMERA_QUALITIES ? saved as CameraQuality : "360p";
}

function savedScreenQuality(): ScreenQuality {
  const saved = preference("screenQuality");
  return saved in SCREEN_QUALITIES ? saved as ScreenQuality : "1080p";
}

function savedScreenFrameRate(): ScreenFrameRate {
  return preference("screenFrameRate") === "60" ? 60 : 30;
}

function savedScreenVolumes(): Record<string, ScreenVolume> {
  try {
    const saved = JSON.parse(preference("screenVolumes") || "{}") as Record<string, Partial<ScreenVolume>>;
    const volumes: Record<string, ScreenVolume> = {};
    for (const [userId, value] of Object.entries(saved)) {
      if (!value || typeof value !== "object") continue;
      const volume = typeof value.volume === "number" && Number.isFinite(value.volume) ? Math.min(1, Math.max(0, value.volume)) : 1;
      volumes[userId] = { volume, muted: value.muted === true };
    }
    return volumes;
  } catch { return {}; }
}

/** What actually plays: 0 while muted. */
export function effectiveVolume(setting: ScreenVolume = DEFAULT_SCREEN_VOLUME) {
  return setting.muted ? 0 : setting.volume;
}

/**
 * Whether a peer's audio track is its screen's audio rather than its voice:
 * it travels in the screen's stream, which webview peers name in signaling
 * and native peers call `disc-call-screen`. Voice streams are never named.
 */
export function isScreenAudio(streamId: string, named: Record<string, VideoSource>) {
  return named[streamId] === "screen" || streamId === "disc-call-screen";
}

/**
 * What a peer's video stream is. Webview peers name theirs in signaling;
 * native peers use fixed IDs; older clients only sent screens.
 */
/**
 * Round trip of a peer connection in milliseconds: the selected ICE pair's
 * (STUN consent checks), else the RTCP-based one; `null` before either.
 */
export function roundTripMs(report: RTCStatsReport): number | null {
  const all: Record<string, unknown>[] = [];
  report.forEach(stats => all.push(stats as Record<string, unknown>));
  const selected = all.find(stats => stats.type === "transport" && stats.selectedCandidatePairId)?.selectedCandidatePairId;
  const pair = all.find(stats => stats.type === "candidate-pair" && typeof stats.currentRoundTripTime === "number"
    && (selected ? stats.id === selected : stats.nominated && stats.state === "succeeded"));
  if (pair) return Math.round((pair.currentRoundTripTime as number) * 1000);
  const rtcp = all.filter(stats => stats.type === "remote-inbound-rtp" && typeof stats.roundTripTime === "number")
    .map(stats => stats.roundTripTime as number);
  return rtcp.length ? Math.round(Math.min(...rtcp) * 1000) : null;
}

export function videoSource(streamId: string, named: Record<string, VideoSource>): VideoSource {
  return named[streamId] ?? (streamId.includes("camera") ? "camera" : "screen");
}

export interface AudioProcessing {
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

const PROCESSING_DEFAULTS: AudioProcessing = { noiseSuppression: true, echoCancellation: true, autoGainControl: true };

/** Capture processing switches from the settings screen; applied on the next call join. */
export function audioProcessing(): AudioProcessing {
  try {
    const saved = JSON.parse(localStorage.getItem("discvoice.voice.processing") || "{}") as Partial<AudioProcessing>;
    return {
      noiseSuppression: saved.noiseSuppression ?? PROCESSING_DEFAULTS.noiseSuppression,
      echoCancellation: saved.echoCancellation ?? PROCESSING_DEFAULTS.echoCancellation,
      autoGainControl: saved.autoGainControl ?? PROCESSING_DEFAULTS.autoGainControl,
    };
  } catch { return { ...PROCESSING_DEFAULTS }; }
}

export function saveAudioProcessing(value: AudioProcessing) {
  try { localStorage.setItem("discvoice.voice.processing", JSON.stringify(value)); } catch { /* Not persisted. */ }
}

export function voiceError(error: unknown): string {
  // Native commands reject with the engine's message.
  if (typeof error === "string") return error;
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") return "Permita o acesso ao microfone para entrar no canal de voz.";
    if (error.name === "NotFoundError") return "Nenhum microfone foi encontrado. Conecte um dispositivo e tente novamente.";
    if (error.name === "NotReadableError") return "Não foi possível abrir o microfone. Verifique se outro aplicativo está usando o dispositivo.";
    if (error.name === "OverconstrainedError") return "O microfone selecionado está indisponível. Escolha outro dispositivo.";
  }
  return message(error);
}

export class Voice {
  private state: VoiceState = {
    status: "idle", channel: null, participants: [], muted: false, deafened: false, error: "",
    speaking: [], devices: [], inputId: preference("input"), outputId: preference("output"), playbackBlocked: false, deviceBusy: false,
    peerId: "", screenSupported: false, native: false, screen: "idle", screenInfo: null, localScreen: null, remoteScreens: {}, focusedScreen: null,
    shareAudio: preference("screenAudio") !== "off", screenAudio: false, screenVolumes: savedScreenVolumes(),
    screenQuality: savedScreenQuality(), screenFrameRate: savedScreenFrameRate(), screenShare: null,
    cameraSupported: typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia,
    camera: "idle", cameraId: preference("camera"), cameraQuality: savedQuality(), cameras: [], localCamera: null, remoteCameras: {},
    latency: {}, serverLatency: null,
  };
  private changes = new Set<() => void>();
  private stream?: MediaStream;
  private peers = new Map<string, Peer>();
  private generation = 0;
  private peerId = "";
  private joined = false;
  private iceServers: RTCIceServer[] = [];
  private deadline?: ReturnType<typeof setTimeout>;
  private meter?: ReturnType<typeof setInterval>;
  private context?: AudioContext;
  private analysers = new Map<string, { source: MediaStreamAudioSourceNode; analyser: AnalyserNode }>();
  private offEvent?: () => void;
  private offStatus?: () => void;
  private wasConnected = false;
  private share?: ScreenTrack;
  /** Upload cap of our screen for each peer, from the chosen quality. */
  private shareBitrate = screenBitrate("1080p", 30);
  /** The computer's audio, sent with `share` in the webview's connections. */
  private shareAudio?: ScreenAudio;
  private screenClaim?: ScreenClaim;
  /** Increments on every screen start/stop, so a late picker answer is ignored. */
  private screenAttempt = 0;
  private nativeSupport?: Promise<boolean>;
  /** The native engine's call, while one runs (it then owns all media). */
  private nativeId?: number;
  /** Connection state of each peer of the native call. */
  private nativeStates = new Map<string, RTCPeerConnectionState>();
  private nativeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The native engine is sending our screen. */
  private nativeShare = false;
  /** Our webcam in the webview's peer connections. */
  private cameraShare?: { stream: MediaStream; track: MediaStreamTrack };
  private cameraClaim?: CameraClaim;
  /** Increments on every camera start/stop, so a late answer is ignored. */
  private cameraAttempt = 0;
  /** The native engine is sending our webcam. */
  private nativeCamera = false;
  private latencyTimer?: ReturnType<typeof setInterval>;
  private offLatency?: () => void;

  constructor(private realtime: Realtime) {}

  private isNative() {
    this.nativeSupport ??= nativeCall.supported().catch(() => false);
    return this.nativeSupport;
  }

  /** The microphone is open: ours (browser) or the engine's. */
  private get mediaReady() {
    return !!this.stream || this.nativeId !== undefined;
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.changes.add(listener);
    return () => { this.changes.delete(listener); };
  };
  private update(next: Partial<VoiceState>) {
    this.state = { ...this.state, ...next };
    this.changes.forEach(listener => listener());
  }

  start() {
    this.offEvent = this.realtime.onEvent(event => this.event(event));
    this.offStatus = this.realtime.subscribe(() => {
      const connected = this.realtime.getSnapshot().status === "connected";
      if (!connected && this.wasConnected && this.state.channel && this.state.status !== "error") {
        this.cleanup();
        this.update({ status: "reconnecting", participants: [], speaking: [] });
      }
      this.wasConnected = connected;
    });
    this.wasConnected = this.realtime.getSnapshot().status === "connected";
    this.update({ serverLatency: this.realtime.latency });
    this.offLatency = this.realtime.onLatency(serverLatency => this.update({ serverLatency }));
    navigator.mediaDevices?.addEventListener("devicechange", this.refreshDevices);
    window.addEventListener("pagehide", this.leave);
    void this.refreshDevices();
    void nativeScreen.supported().then(screenSupported => this.update({ screenSupported }), () => {});
    void this.isNative().then(native => {
      if (!native) return;
      this.update({ native });
      void this.refreshDevices();
    });
    // Linux sends the native camera; the webview's getUserMedia corrupts it.
    void nativeCamera.supported().then(cameraSupported => { if (cameraSupported) this.update({ cameraSupported }); }, () => {});
  }

  dispose() {
    this.offEvent?.();
    this.offStatus?.();
    this.offLatency?.();
    navigator.mediaDevices?.removeEventListener("devicechange", this.refreshDevices);
    window.removeEventListener("pagehide", this.leave);
    this.leave();
  }

  refreshDevices = async () => {
    try {
      if (this.state.native) {
        this.update({ devices: deviceInfos(await nativeCall.devices()) });
        return;
      }
      const devices = await navigator.mediaDevices?.enumerateDevices();
      this.update({ devices: devices || [] });
    } catch { /* Permission/device errors are reported when capture starts. */ }
  };

  private send(command: Parameters<Realtime["send"]>[0]) {
    this.realtime.send(command);
  }

  private capture(inputId: string) {
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      throw new Error("Áudio WebRTC indisponível. Use um navegador compatível em HTTPS ou localhost.");
    }
    return navigator.mediaDevices.getUserMedia({
      audio: { deviceId: inputId ? { exact: inputId } : undefined, ...audioProcessing() },
      video: false,
    });
  }

  join = async (channel: Channel) => {
    if (channel.type !== "voice") return;
    this.leave();
    const generation = this.generation;
    this.update({ channel, status: "connecting", error: "" });
    try {
      if (this.realtime.getSnapshot().status !== "connected") throw new Error("Aguarde a conexão em tempo real antes de entrar.");
      const native = await this.isNative();
      if (generation !== this.generation) return;
      if (!native) {
        this.context = new AudioContext();
        void this.context.resume().catch(() => {});
      }
      this.deadline = setTimeout(() => this.fail("A conexão de voz demorou demais. Verifique a rede e tente novamente."), 30_000);
      if (nativeAudio.available()) await nativeAudio.action({ type: "stopAll" });
      if (generation !== this.generation) return;
      const config = await api.voiceConfig();
      if (generation !== this.generation) return;
      if (native) {
        const id = await nativeCall.join({
          iceServers: config.iceServers, inputId: this.state.inputId, outputId: this.state.outputId,
          muted: this.state.muted || this.state.deafened, deafened: this.state.deafened,
        }, event => { if (generation === this.generation) this.nativeEvent(event); });
        if (generation !== this.generation) { void nativeCall.leave(id).catch(() => {}); return; }
        this.nativeId = id;
      } else {
        const stream = await this.capture(this.state.inputId);
        if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
        this.stream = stream;
        this.prepareTracks(stream);
      }
      this.iceServers = config.iceServers;
      void this.refreshDevices();
      this.send({ type: "voice.join", channelId: channel.id, muted: this.state.muted || this.state.deafened, deafened: this.state.deafened });
    } catch (error) {
      if (generation === this.generation) this.fail(voiceError(error));
    }
  };

  leave = () => {
    if (this.state.channel && this.realtime.getSnapshot().status === "connected") {
      try { this.send({ type: "voice.leave" }); } catch { /* Socket closed concurrently. */ }
    }
    this.cleanup();
    this.update({ status: "idle", channel: null, participants: [], speaking: [], error: "", playbackBlocked: false, deviceBusy: false, peerId: "" });
  };

  /** The user hangs up: the cue plays here, not on the leaves the app does on its own. */
  hangUp = () => {
    if (this.state.channel && this.state.status !== "error") playLeaveSound();
    this.leave();
  };

  private fail(error: string) {
    const channel = this.state.channel;
    this.leave();
    this.update({ status: "error", channel, error });
  }

  private prepareTracks(stream: MediaStream) {
    stream.getAudioTracks().forEach(track => {
      track.enabled = !this.state.muted && !this.state.deafened;
      track.onended = () => {
        if (this.stream === stream) this.fail("O microfone foi desconectado. Selecione outro dispositivo e entre novamente.");
      };
    });
  }

  toggleMute = () => {
    this.update({ muted: !this.state.muted });
    this.syncControls();
    // Feedback only in a call; before joining, the button just sets how we will enter.
    if (this.state.channel) playMicSound();
  };
  toggleDeafen = () => {
    this.update({ deafened: !this.state.deafened });
    this.syncControls();
  };
  private syncControls() {
    this.stream?.getAudioTracks().forEach(track => { track.enabled = !this.state.muted && !this.state.deafened; });
    this.peers.forEach((peer, id) => {
      peer.audio.muted = this.state.deafened;
      this.applyScreenVolume(id);
    });
    if (this.nativeId !== undefined) {
      void nativeCall.mute(this.state.muted || this.state.deafened).catch(() => {});
      void nativeCall.deafen(this.state.deafened).catch(() => {});
    }
    if (this.joined) {
      try {
        this.send({
          type: "voice.state", muted: this.state.muted || this.state.deafened, deafened: this.state.deafened,
          screen: this.state.screen === "live", camera: this.state.camera === "live",
          screenAudio: this.state.screen === "live" && this.state.screenAudio,
        });
      } catch { /* Reconnect restores controls. */ }
    }
  }

  /**
   * Opens the system picker and sends what the user chose to everyone in
   * the call, as a video track on the existing peer connections (adding it
   * renegotiates them). Peers that join later get it too. The choices are
   * saved for the next time; without them, the saved ones are used.
   */
  startScreen = async (options?: Partial<ScreenOptions>) => {
    if (!this.joined || this.state.screen !== "idle") return;
    const quality = options?.quality && options.quality in SCREEN_QUALITIES ? options.quality : this.state.screenQuality;
    const frameRate: ScreenFrameRate = options?.frameRate === 60 || options?.frameRate === 30 ? options.frameRate : this.state.screenFrameRate;
    const audio = options?.audio ?? this.state.shareAudio;
    savePreference("screenQuality", quality);
    savePreference("screenFrameRate", String(frameRate));
    savePreference("screenAudio", audio ? "on" : "off");
    this.update({ screenQuality: quality, screenFrameRate: frameRate, shareAudio: audio });
    const size = SCREEN_QUALITIES[quality];
    const request: ScreenRequest = { maxWidth: size.width, maxHeight: size.height, frameRate, cursor: true };
    const bitrate = screenBitrate(quality, frameRate);
    const generation = this.generation;
    const attempt = ++this.screenAttempt;
    const claim: ScreenClaim = nativeScreen.claim(() => {
      if (this.screenClaim !== claim) return;
      this.screenClaim = undefined;
      if (this.state.screen === "live") playScreenSound();
      this.endScreen();
      this.update({ error: SCREEN_TAKEN });
      this.syncControls();
    });
    this.screenClaim = claim;
    this.update({ screen: "picking", error: "" });
    const current = () => generation === this.generation && attempt === this.screenAttempt && this.screenClaim === claim;
    try {
      const info = await nativeScreen.start(request);
      if (!current()) return;
      if (!info) {
        this.screenClaim = undefined;
        this.update({ screen: "idle" });
        return;
      }
      if (this.nativeId !== undefined) {
        // The engine encodes the capture's raw frames; our preview is
        // drawn from its JPEG ones, like the settings test.
        this.nativeShare = true;
        await nativeCall.startScreen(info.frameRate, bitrate);
        if (!current()) { void nativeCall.stopScreen().catch(() => {}); return; }
        this.update({ screen: "live", screenInfo: info, localScreen: { pull: nativeScreen.frame }, screenShare: { quality, frameRate } });
        this.syncControls();
        playScreenSound();
        if (audio) void this.startNativeScreenAudio(current);
        return;
      }
      const share: ScreenTrack = screenTrack(nativeScreen.frame, info.frameRate, error => {
        if (this.share !== share) return;
        this.stopScreen();
        this.update({ error });
      });
      this.share = share;
      this.shareBitrate = bitrate;
      this.peers.forEach(peer => this.sendScreen(peer));
      this.update({ screen: "live", screenInfo: info, localScreen: share.stream, screenShare: { quality, frameRate } });
      this.syncControls();
      playScreenSound();
      if (audio) void this.startScreenAudio(share);
    } catch (error) {
      if (!current()) return;
      this.nativeShare = false;
      this.screenClaim = undefined;
      claim.release();
      this.update({ screen: "idle", error: voiceError(error) });
    }
  };

  /** Stops sharing, or closes the picker while it is open. */
  stopScreen = () => {
    if (this.state.screen === "idle" && !this.share) return;
    // Closing the picker shared nothing; leaving the call ends sharing through cleanup, silently.
    if (this.state.screen === "live") playScreenSound();
    const claim = this.screenClaim;
    this.screenClaim = undefined;
    this.endScreen();
    claim?.release();
    this.syncControls();
  };

  /**
   * Adds the computer's audio to the screen we send from the webview. The
   * screen goes on without it when the system cannot capture it.
   */
  private async startScreenAudio(share: ScreenTrack) {
    try {
      const audio = await screenAudio(nativeScreen.audio);
      if (this.share !== share) { audio.stop(); return; }
      this.shareAudio = audio;
      this.peers.forEach(peer => this.sendScreenAudio(peer));
      this.update({ screenAudio: true });
      this.syncControls();
    } catch (error) {
      if (this.share === share) this.update({ error: voiceError(error) });
    }
  }

  /** The same, when the native engine sends our screen (Linux). */
  private async startNativeScreenAudio(current: () => boolean) {
    try {
      await nativeCall.startScreenAudio();
      if (!current() || !this.nativeShare) { void nativeCall.stopScreenAudio().catch(() => {}); return; }
      this.update({ screenAudio: true });
      this.syncControls();
    } catch (error) {
      if (current() && this.nativeShare) this.update({ error: voiceError(error) });
    }
  }

  /** Removes our screen from the call; the capture itself is the claim's. */
  private endScreen() {
    this.screenAttempt++;
    if (this.nativeShare) {
      this.nativeShare = false;
      // Stops the screen's audio too.
      void nativeCall.stopScreen().catch(() => {});
    }
    const share = this.share;
    this.share = undefined;
    const audio = this.shareAudio;
    this.shareAudio = undefined;
    this.peers.forEach(peer => {
      for (const sender of [peer.screenSender, peer.screenAudioSender]) {
        if (!sender) continue;
        try { if (peer.pc.signalingState !== "closed") peer.pc.removeTrack(sender); }
        catch { /* The connection is closing. */ }
      }
      peer.screenSender = undefined;
      peer.screenAudioSender = undefined;
    });
    audio?.stop();
    share?.stop();
    if (this.state.screen !== "idle" || this.state.localScreen || this.state.screenAudio || this.state.screenShare) {
      this.update({ screen: "idle", screenInfo: null, localScreen: null, screenAudio: false, screenShare: null });
    }
  }

  private sendScreen(peer: Peer) {
    if (!this.share || peer.screenSender) return;
    peer.screenSender = this.sendVideo(peer, this.share, this.shareBitrate);
    this.sendScreenAudio(peer);
  }

  /** The screen's audio goes in the screen's stream: peers know what it is and keep it in sync. */
  private sendScreenAudio(peer: Peer) {
    if (!this.share || !this.shareAudio || peer.screenAudioSender) return;
    peer.screenAudioSender = this.sendVideo(peer, { stream: this.share.stream, track: this.shareAudio.track }, SCREEN_AUDIO_BITRATE);
  }

  /** The screen expanded in the call view (picture-in-picture shows it first). */
  focusScreen = (peerId: string | null) => {
    if (peerId !== this.state.focusedScreen) this.update({ focusedScreen: peerId });
  };

  /** Whether the computer's audio goes with our next screen share (saved). */
  setShareAudio = (shareAudio: boolean) => {
    savePreference("screenAudio", shareAudio ? "on" : "off");
    this.update({ shareAudio });
  };

  /** Our volume (0 to 1) for someone's screen audio; their voice keeps its own. */
  setScreenVolume = (userId: string, volume: number) => {
    const clamped = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
    const previous = this.state.screenVolumes[userId] ?? DEFAULT_SCREEN_VOLUME;
    // Moving the slider off zero also unmutes, as on any volume control.
    this.saveScreenVolume(userId, { volume: clamped, muted: clamped === 0 ? previous.muted : false });
  };

  toggleScreenMute = (userId: string) => {
    const previous = this.state.screenVolumes[userId] ?? DEFAULT_SCREEN_VOLUME;
    this.saveScreenVolume(userId, { ...previous, muted: !previous.muted });
  };

  private saveScreenVolume(userId: string, setting: ScreenVolume) {
    const screenVolumes = { ...this.state.screenVolumes, [userId]: setting };
    savePreference("screenVolumes", JSON.stringify(screenVolumes));
    this.update({ screenVolumes });
    for (const participant of this.state.participants) {
      if (participant.user.id === userId && participant.peerId !== this.peerId) this.applyScreenVolume(participant.peerId);
    }
  }

  /** Applies our volume for a peer's screen audio to what plays it now. */
  private applyScreenVolume(peerId: string) {
    const userId = this.state.participants.find(p => p.peerId === peerId)?.user.id;
    const volume = effectiveVolume(userId ? this.state.screenVolumes[userId] : undefined);
    if (this.nativeId !== undefined) {
      if (this.nativeStates.has(peerId)) void nativeCall.setScreenVolume(peerId, volume).catch(() => {});
      return;
    }
    const element = this.peers.get(peerId)?.screenAudio;
    if (!element) return;
    element.volume = volume;
    element.muted = this.state.deafened || volume === 0;
  }

  private sendCamera(peer: Peer) {
    if (!this.cameraShare || peer.cameraSender) return;
    peer.cameraSender = this.sendVideo(peer, this.cameraShare, CAMERA_QUALITIES[this.state.cameraQuality].bitrate);
  }

  /** Adds a video track to a peer (renegotiating it), capped to `bitrate`. */
  private sendVideo(peer: Peer, video: { stream: MediaStream; track: MediaStreamTrack }, bitrate: number) {
    const sender = peer.pc.addTrack(video.track, video.stream);
    void (async () => {
      try {
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length) return;
        parameters.encodings[0].maxBitrate = bitrate;
        await sender.setParameters(parameters);
      } catch { /* The default bitrate also works. */ }
    })();
    return sender;
  }

  /** Our streams, named for the peer (browsers cannot choose stream IDs). */
  private streamNames(): Record<string, VideoSource> {
    const names: Record<string, VideoSource> = {};
    if (this.share) names[this.share.stream.id] = "screen";
    if (this.cameraShare) names[this.cameraShare.stream.id] = "camera";
    return names;
  }

  private describe(pc: RTCPeerConnection): SignalPayload {
    return { description: pc.localDescription!.toJSON(), streams: this.streamNames() };
  }

  setCamera = (cameraId: string) => {
    savePreference("camera", cameraId);
    this.update({ cameraId });
    if (this.state.camera !== "idle") this.restartCamera();
  };

  setCameraQuality = (cameraQuality: CameraQuality) => {
    if (!(cameraQuality in CAMERA_QUALITIES)) return;
    savePreference("cameraQuality", cameraQuality);
    this.update({ cameraQuality });
    if (this.state.camera !== "idle") this.restartCamera();
  };

  /** Webcams to choose from (asking for camera access on Linux). */
  refreshCameras = async () => {
    try {
      const cameras = this.state.native || await nativeCamera.supported().catch(() => false)
        ? (await nativeCamera.devices()).map(device => ({ deviceId: device.id, label: device.name }))
        : (await navigator.mediaDevices?.enumerateDevices() ?? [])
          .filter(device => device.kind === "videoinput" && device.deviceId)
          .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Webcam ${index + 1}` }));
      this.update({ cameras });
    } catch (error) { this.update({ error: cameraError(error) }); }
  };

  /** Applies a new camera or quality: the others keep seeing the camera on. */
  private restartCamera() {
    this.endCamera();
    void this.startCamera();
  }

  /**
   * Turns our webcam on for everyone in the call: a video track on the
   * webview's peer connections, or the native engine's camera track.
   */
  startCamera = async () => {
    if (!this.joined || this.state.camera !== "idle") return;
    const generation = this.generation;
    const attempt = ++this.cameraAttempt;
    const quality = CAMERA_QUALITIES[this.state.cameraQuality];
    const current = () => generation === this.generation && attempt === this.cameraAttempt;
    this.update({ camera: "starting", error: "" });
    try {
      if (this.nativeId !== undefined) {
        const claim: CameraClaim = nativeCamera.claim(() => {
          if (this.cameraClaim !== claim) return;
          this.cameraClaim = undefined;
          this.endCamera();
          this.update({ error: CAMERA_TAKEN });
          this.syncControls();
        });
        this.cameraClaim = claim;
        const info = await nativeCamera.startForCall(this.state.cameraId, quality.height);
        if (!current()) { nativeCamera.releaseLate(); return; }
        this.nativeCamera = true;
        await nativeCall.startCamera(Math.min(CAMERA_FRAME_RATE, Math.round(info.frameRate) || CAMERA_FRAME_RATE), quality.bitrate);
        if (!current()) { void nativeCall.stopCamera().catch(() => {}); return; }
        this.update({ camera: "live", localCamera: { pull: nativeCamera.frame } });
      } else {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("A câmera não está disponível neste ambiente.");
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            ...(this.state.cameraId ? { deviceId: { exact: this.state.cameraId } } : {}),
            width: { ideal: quality.width }, height: { ideal: quality.height },
            frameRate: { ideal: CAMERA_FRAME_RATE, max: CAMERA_FRAME_RATE },
          },
        });
        if (!current()) { stopStream(stream); return; }
        const track = stream.getVideoTracks()[0];
        if (!track) { stopStream(stream); throw new Error("A webcam não forneceu uma faixa de vídeo."); }
        // Favors smooth motion over detail when the bandwidth is short.
        track.contentHint = "motion";
        track.onended = () => {
          if (this.cameraShare?.track !== track) return;
          this.stopCamera();
          this.update({ error: CAMERA_LOST });
        };
        this.cameraShare = { stream, track };
        this.peers.forEach(peer => this.sendCamera(peer));
        this.update({ camera: "live", localCamera: stream });
      }
      this.syncControls();
    } catch (error) {
      if (!current()) return;
      this.endCamera();
      this.update({ error: cameraError(error) });
      this.syncControls();
    }
  };

  stopCamera = () => {
    if (this.state.camera === "idle" && !this.cameraShare && !this.cameraClaim) return;
    this.endCamera();
    this.syncControls();
  };

  /** Removes our webcam from the call and releases it. */
  private endCamera() {
    this.cameraAttempt++;
    if (this.nativeCamera) {
      this.nativeCamera = false;
      void nativeCall.stopCamera().catch(() => {});
    }
    const claim = this.cameraClaim;
    this.cameraClaim = undefined;
    claim?.release();
    const share = this.cameraShare;
    this.cameraShare = undefined;
    this.peers.forEach(peer => {
      if (!peer.cameraSender) return;
      try { if (peer.pc.signalingState !== "closed") peer.pc.removeTrack(peer.cameraSender); }
      catch { /* The connection is closing. */ }
      peer.cameraSender = undefined;
    });
    if (share) {
      share.track.onended = null;
      stopStream(share.stream);
    }
    if (this.state.camera !== "idle" || this.state.localCamera) this.update({ camera: "idle", localCamera: null });
  }

  /** Sets (or, without a value, removes) the round trip to a peer. */
  private peerLatency(id: string, ms?: number | null) {
    const { [id]: previous, ...rest } = this.state.latency;
    if (typeof ms === "number") { if (ms !== previous) this.update({ latency: { ...rest, [id]: ms } }); }
    else if (previous !== undefined) this.update({ latency: rest });
  }

  /** Reads every webview peer connection's round trip. */
  private async measureLatency() {
    await Promise.all([...this.peers].map(async ([id, peer]) => {
      try {
        const ms = roundTripMs(await peer.pc.getStats());
        if (this.peers.get(id) === peer && ms !== null) this.peerLatency(id, ms);
      } catch { /* The connection is closing. */ }
    }));
  }

  /** Sets (or, without a feed, removes) a peer's received video. */
  private remoteVideo(source: VideoSource, id: string, feed?: VideoFeed) {
    const key = source === "camera" ? "remoteCameras" : "remoteScreens";
    const { [id]: previous, ...rest } = this.state[key];
    if (feed) this.update({ [key]: { ...rest, [id]: feed } });
    else if (previous) this.update({ [key]: rest });
  }

  /** What the native engine reports about the call. */
  private nativeEvent(event: CallEvent) {
    switch (event.type) {
      case "signal":
        if (!this.nativeStates.has(event.peerId)) return;
        try { this.send({ type: "voice.signal", peerId: event.peerId, data: event.data }); }
        catch { /* Connection recovery rebuilds peers. */ }
        return;
      case "peerState": {
        const id = event.peerId;
        if (!this.nativeStates.has(id)) return;
        this.nativeStates.set(id, event.state);
        const timer = this.nativeTimers.get(id);
        if (event.state === "connected") {
          clearTimeout(timer);
          this.nativeTimers.delete(id);
        } else if ((event.state === "failed" || event.state === "disconnected") && !timer) {
          // The engine restarts ICE itself; give it the browser's grace period.
          this.nativeTimers.set(id, setTimeout(() => {
            if (this.nativeStates.has(id)) this.fail("Não foi possível restabelecer o áudio. Verifique a conexão e a configuração TURN do servidor.");
          }, 20_000));
        }
        this.connectionState();
        return;
      }
      case "latency":
        if (this.nativeStates.has(event.peerId)) this.peerLatency(event.peerId, event.ms);
        return;
      case "speaking":
        if (event.peerIds.join() !== this.state.speaking.join()) this.update({ speaking: event.peerIds });
        return;
      case "video": {
        const { peerId: id, source } = event;
        const live = event.active && this.nativeStates.has(id);
        this.remoteVideo(source, id, live ? { pull: () => nativeCall.frame(id, source) } : undefined);
        return;
      }
      case "videoEnded":
        if (event.source === "screen") {
          if (!this.nativeShare) return;
          this.stopScreen();
        } else {
          if (!this.nativeCamera) return;
          this.stopCamera();
        }
        this.update({ error: event.message });
        return;
      case "error":
        this.fail(event.message);
    }
  }

  private nativePeers(ids: Set<string>) {
    for (const id of [...this.nativeStates.keys()]) {
      if (ids.has(id)) continue;
      this.nativeStates.delete(id);
      clearTimeout(this.nativeTimers.get(id));
      this.nativeTimers.delete(id);
      this.peerLatency(id);
      this.remoteVideo("screen", id);
      this.remoteVideo("camera", id);
    }
    for (const id of ids) if (!this.nativeStates.has(id)) this.nativeStates.set(id, "new");
    void nativeCall.peers(this.peerId, [...ids]).catch(error => this.fail(voiceError(error)));
  }

  private remoteTrack(id: string, peer: Peer, track: MediaStreamTrack, source: VideoSource) {
    const stream = new MediaStream([track]);
    const key = source === "camera" ? "remoteCameras" : "remoteScreens";
    track.onended = () => {
      if (this.state[key][id] === stream) this.remoteVideo(source, id);
    };
    if (this.peers.get(id) === peer) this.remoteVideo(source, id, stream);
  }

  setInput = async (inputId: string) => {
    if (this.state.deviceBusy) return;
    const generation = this.generation;
    this.update({ deviceBusy: true });
    try {
      if (this.nativeId !== undefined) {
        await nativeCall.setInput(inputId);
        if (generation !== this.generation) return;
      } else if (this.stream) {
        const next = await this.capture(inputId);
        if (generation !== this.generation) { next.getTracks().forEach(t => t.stop()); return; }
        const previous = this.stream;
        this.stream = next;
        this.prepareTracks(next);
        try {
          await Promise.all([...this.peers.values()].map(peer =>
            peer.pc.getSenders().find(sender => sender.track?.kind === "audio")?.replaceTrack(next.getAudioTracks()[0])));
        } finally { previous.getTracks().forEach(track => track.stop()); }
        if (generation !== this.generation) return;
        this.analyse(this.peerId, next);
      }
      try { localStorage.setItem("discvoice.voice.input", inputId); } catch { /* Optional preference. */ }
      this.update({ inputId, error: "" });
    } catch (error) {
      if (generation === this.generation) this.update({ error: voiceError(error) });
    } finally { if (generation === this.generation) this.update({ deviceBusy: false }); }
  };

  setOutput = async (outputId: string) => {
    if (this.state.deviceBusy) return;
    this.update({ deviceBusy: true });
    try {
      if (this.nativeId !== undefined) await nativeCall.setOutput(outputId);
      else {
        await Promise.all([...this.peers.values()].flatMap(peer =>
          [peer.audio, peer.screenAudio].filter(audio => !!audio).map(audio => this.sink(audio, outputId))));
      }
      try { localStorage.setItem("discvoice.voice.output", outputId); } catch { /* Optional preference. */ }
      this.update({ outputId, error: "" });
    } catch (error) { this.update({ error: voiceError(error) }); }
    finally { this.update({ deviceBusy: false }); }
  };

  private async sink(audio: HTMLAudioElement, id: string) {
    if ("setSinkId" in audio) await audio.setSinkId(id);
    else if (id) throw new Error("Este ambiente usa a saída padrão do sistema. Selecione “Padrão do sistema”.");
  }

  resumePlayback = async () => {
    try {
      await this.context?.resume();
      await Promise.all([...this.peers.values()].flatMap(peer => [peer.audio.play(), ...(peer.screenAudio ? [peer.screenAudio.play()] : [])]));
      this.update({ playbackBlocked: false });
    } catch { this.update({ error: "Não foi possível reproduzir o áudio. Verifique a saída selecionada." }); }
  };

  private event(event: RealtimeEvent) {
    const channel = this.state.channel;
    if (event.type === "ready" && this.state.status === "reconnecting" && channel) void this.join(channel);
    if (!channel) return;
    if (event.type === "error" && event.operation === "voice.join") this.fail(event.message);
    if (event.type === "voice.left" && event.channelId === channel.id && this.joined) {
      this.leave();
      if (event.reason === "replaced") this.update({ error: "Sua chamada foi aberta em outra aba ou dispositivo." });
    }
    if (event.type === "voice.joined" && event.channelId === channel.id && this.mediaReady) {
      this.peerId = event.peerId;
      this.joined = true;
      this.update({ peerId: event.peerId });
      if (this.stream) this.analyse(this.peerId, this.stream);
      this.participants(event.participants);
      if (this.nativeId === undefined && !this.latencyTimer) {
        this.latencyTimer = setInterval(() => void this.measureLatency(), LATENCY_EVERY_MS);
      }
    }
    if (event.type === "voice.participants" && event.channelId === channel.id && this.joined) this.participants(event.participants);
    if (event.type === "voice.signal" && event.channelId === channel.id && this.joined && this.nativeId !== undefined) {
      if (!this.nativeStates.has(event.peerId)) return;
      void nativeCall.signal(event.peerId, event.data).catch(error => this.fail(`Falha ao negociar o áudio: ${voiceError(error)}`));
      return;
    }
    if (event.type === "voice.signal" && event.channelId === channel.id && this.joined) {
      const peer = this.peers.get(event.peerId);
      if (!peer) return;
      peer.queue = peer.queue.then(() => this.signal(event.peerId, peer, event.data)).catch(error => {
        if (this.peers.get(event.peerId) === peer) this.fail(`Falha ao negociar o áudio: ${voiceError(error)}`);
      });
    }
  }

  private participants(participants: VoiceParticipant[]) {
    this.update({ participants });
    const ids = new Set(participants.filter(p => p.peerId !== this.peerId).map(p => p.peerId));
    if (this.nativeId !== undefined) {
      this.nativePeers(ids);
      ids.forEach(id => this.applyScreenVolume(id));
      this.connectionState();
      return;
    }
    for (const id of this.peers.keys()) if (!ids.has(id)) this.removePeer(id);
    for (const id of ids) if (!this.peers.has(id)) this.addPeer(id);
    this.connectionState();
  }

  private addPeer(id: string) {
    if (!this.stream) return;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const audio = new Audio();
    audio.autoplay = true;
    audio.muted = this.state.deafened;
    const peer: Peer = { pc, audio, streams: {}, makingOffer: false, ignoreOffer: false, settingAnswer: false, candidates: [], queue: Promise.resolve() };
    this.peers.set(id, peer);
    pc.onicecandidate = event => {
      if (event.candidate && this.peers.get(id) === peer) {
        try { this.send({ type: "voice.signal", peerId: id, data: { candidate: event.candidate.toJSON() } }); }
        catch { /* Connection recovery rebuilds peers. */ }
      }
    };
    pc.onnegotiationneeded = async () => {
      // Elect one initial offerer per pair. This avoids simultaneous initial
      // ICE gathering/rollback (particularly problematic for relay candidates).
      // Later renegotiation still uses the polite/impolite collision handling.
      if (!pc.remoteDescription && this.peerId > id) return;
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (this.peers.get(id) !== peer) return;
        this.send({ type: "voice.signal", peerId: id, data: this.describe(pc) });
      } catch (error) {
        if (this.peers.get(id) === peer && pc.signalingState !== "closed") this.fail(voiceError(error));
      } finally { peer.makingOffer = false; }
    };
    pc.ontrack = event => {
      if (this.peers.get(id) !== peer) return;
      // Screens and cameras come in their own streams; audio stays as before.
      if (event.track.kind === "video") {
        this.remoteTrack(id, peer, event.track, videoSource(event.streams[0]?.id ?? "", peer.streams));
        return;
      }
      if (isScreenAudio(event.streams[0]?.id ?? "", peer.streams)) {
        this.remoteScreenAudio(id, peer, event.track);
        return;
      }
      const stream = event.streams[0] || new MediaStream([event.track]);
      audio.srcObject = stream;
      this.analyse(id, stream);
      void this.sink(audio, this.state.outputId).catch(() => {
        this.update({ error: "Saída selecionada indisponível; usando a saída padrão.", outputId: "" });
        return this.sink(audio, "").catch(() => {});
      });
      void audio.play().catch(() => {
        if (this.peers.get(id) === peer) this.update({ playbackBlocked: true });
      });
    };
    pc.onconnectionstatechange = () => {
      if (this.peers.get(id) !== peer) return;
      if (pc.connectionState === "connected") { clearTimeout(peer.timer); peer.timer = undefined; }
      if ((pc.connectionState === "failed" || pc.connectionState === "disconnected") && !peer.timer) {
        pc.restartIce();
        peer.timer = setTimeout(() => {
          if (this.peers.get(id) === peer) this.fail("Não foi possível restabelecer o áudio. Verifique a conexão e a configuração TURN do servidor.");
        }, 20_000);
      }
      this.connectionState();
    };
    this.stream.getTracks().forEach(track => pc.addTrack(track, this.stream!));
    this.sendScreen(peer);
    this.sendCamera(peer);
  }

  /** Plays a peer's screen audio on its own element, at our volume for that person. */
  private remoteScreenAudio(id: string, peer: Peer, track: MediaStreamTrack) {
    const element = peer.screenAudio ?? new Audio();
    element.autoplay = true;
    element.srcObject = new MediaStream([track]);
    peer.screenAudio = element;
    this.applyScreenVolume(id);
    void this.sink(element, this.state.outputId).catch(() => this.sink(element, "").catch(() => {}));
    void element.play().catch(() => {
      if (this.peers.get(id) === peer) this.update({ playbackBlocked: true });
    });
  }

  private async signal(id: string, peer: Peer, data: SignalPayload) {
    if (this.peers.get(id) !== peer) return;
    const pc = peer.pc;
    // Before the description: its tracks arrive while it is applied.
    if (data.streams) peer.streams = { ...peer.streams, ...data.streams };
    if (data.description) {
      const readyForOffer = !peer.makingOffer && (pc.signalingState === "stable" || peer.settingAnswer);
      const collision = data.description.type === "offer" && !readyForOffer;
      const polite = this.peerId > id;
      peer.ignoreOffer = !polite && collision;
      if (peer.ignoreOffer) return;
      // Modern WebRTC automatically rolls back a colliding local offer for the polite peer.
      peer.settingAnswer = data.description.type === "answer";
      const description = data.description.sdp
        ? { ...data.description, sdp: opusStereo(data.description.sdp) }
        : data.description;
      try { await pc.setRemoteDescription(description); }
      finally { peer.settingAnswer = false; }
      for (const candidate of peer.candidates.splice(0)) {
        // Candidates from a rolled-back offer may belong to an obsolete ICE
        // generation; retain candidates that match the accepted description.
        if (candidate.usernameFragment && !pc.remoteDescription?.sdp.includes(`a=ice-ufrag:${candidate.usernameFragment}\r\n`)) continue;
        await pc.addIceCandidate(candidate);
      }
      if (data.description.type === "offer") {
        await pc.setLocalDescription();
        if (this.peers.get(id) === peer) this.send({ type: "voice.signal", peerId: id, data: this.describe(pc) });
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(data.candidate); }
        catch (error) { if (!peer.ignoreOffer) throw error; }
      } else peer.candidates.push(data.candidate);
    }
  }

  private connectionState() {
    if (!this.joined) return;
    const connected = this.nativeId !== undefined
      ? [...this.nativeStates.values()].every(state => state === "connected")
      : [...this.peers.values()].every(peer => peer.pc.connectionState === "connected");
    if (connected) {
      clearTimeout(this.deadline);
      this.deadline = undefined;
      this.update({ status: "connected" });
    } else {
      this.update({ status: "connecting" });
      if (!this.deadline) this.deadline = setTimeout(() => this.fail("Não foi possível conectar o áudio entre os participantes. Verifique a rede e o TURN."), 30_000);
    }
  }

  private analyse(id: string, stream: MediaStream) {
    this.removeAnalyser(id);
    if (!this.context) return;
    const source = this.context.createMediaStreamSource(stream);
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    this.analysers.set(id, { source, analyser });
    if (!this.meter) this.meter = setInterval(() => {
      const speaking: string[] = [];
      this.analysers.forEach(({ analyser }, peerId) => {
        if (peerId === this.peerId && (this.state.muted || this.state.deafened)) return;
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
        if (rms > 0.015) speaking.push(peerId);
      });
      if (speaking.join() !== this.state.speaking.join()) this.update({ speaking });
    }, 150);
  }

  private removeAnalyser(id: string) {
    const entry = this.analysers.get(id);
    entry?.source.disconnect();
    entry?.analyser.disconnect();
    this.analysers.delete(id);
  }
  private removePeer(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    clearTimeout(peer.timer);
    peer.pc.ontrack = null;
    peer.pc.onicecandidate = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    peer.audio.pause();
    peer.audio.srcObject = null;
    peer.screenAudio?.pause();
    if (peer.screenAudio) peer.screenAudio.srcObject = null;
    this.removeAnalyser(id);
    this.peerLatency(id);
    this.remoteVideo("screen", id);
    this.remoteVideo("camera", id);
  }
  private cleanup() {
    // Sharing ends with the call; the voice.leave (or the lost socket)
    // already tells the others.
    const claim = this.screenClaim;
    this.screenClaim = undefined;
    this.endScreen();
    claim?.release();
    this.endCamera();
    this.generation++;
    this.joined = false;
    clearTimeout(this.deadline);
    this.deadline = undefined;
    clearInterval(this.meter);
    this.meter = undefined;
    clearInterval(this.latencyTimer);
    this.latencyTimer = undefined;
    for (const id of this.peers.keys()) this.removePeer(id);
    for (const id of this.analysers.keys()) this.removeAnalyser(id);
    if (this.nativeId !== undefined) void nativeCall.leave(this.nativeId).catch(() => {});
    this.nativeId = undefined;
    this.nativeTimers.forEach(timer => clearTimeout(timer));
    this.nativeTimers.clear();
    this.nativeStates.clear();
    if (Object.keys(this.state.remoteScreens).length) this.update({ remoteScreens: {} });
    if (Object.keys(this.state.remoteCameras).length) this.update({ remoteCameras: {} });
    if (Object.keys(this.state.latency).length) this.update({ latency: {} });
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.stream = undefined;
    void this.context?.close().catch(() => {});
    this.context = undefined;
  }
}
