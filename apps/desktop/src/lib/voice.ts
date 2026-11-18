import type { Channel, RealtimeEvent, ScreenInfo, ScreenRequest, VoiceParticipant } from "@disc-voice/shared";
import { api, message } from "./api";
import { nativeAudio } from "./audio";
import { nativeScreen, type ScreenClaim } from "./nativeScreen";
import type { Realtime } from "./realtime";
import { screenTrack, type ScreenTrack } from "./screenTrack";

/** What a call shares: sharp enough for text, light enough for a P2P mesh. */
export const CALL_SCREEN: ScreenRequest = { maxWidth: 1920, maxHeight: 1080, frameRate: 30, cursor: true };
/** Upload per participant; every peer gets its own copy of the screen. */
const SCREEN_BITRATE = 2_500_000;
const SCREEN_TAKEN = "O teste de compartilhamento de tela assumiu a captura.";

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
  /** `picking`: the system picker is open, waiting for the user. */
  screen: "idle" | "picking" | "live";
  screenInfo: ScreenInfo | null;
  /** What we send, for the local preview. */
  localScreen: MediaStream | null;
  /** Screens received, by peer ID. */
  remoteScreens: Record<string, MediaStream>;
}

interface Peer {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  screenSender?: RTCRtpSender;
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

export function voiceError(error: unknown): string {
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
    peerId: "", screenSupported: false, screen: "idle", screenInfo: null, localScreen: null, remoteScreens: {},
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
  private screenClaim?: ScreenClaim;
  /** Increments on every screen start/stop, so a late picker answer is ignored. */
  private screenAttempt = 0;

  constructor(private realtime: Realtime) {}

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
    navigator.mediaDevices?.addEventListener("devicechange", this.refreshDevices);
    window.addEventListener("pagehide", this.leave);
    void this.refreshDevices();
    void nativeScreen.supported().then(screenSupported => this.update({ screenSupported }), () => {});
  }

  dispose() {
    this.offEvent?.();
    this.offStatus?.();
    navigator.mediaDevices?.removeEventListener("devicechange", this.refreshDevices);
    window.removeEventListener("pagehide", this.leave);
    this.leave();
  }

  refreshDevices = async () => {
    try {
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
      audio: { deviceId: inputId ? { exact: inputId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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
      this.context = new AudioContext();
      void this.context.resume().catch(() => {});
      this.deadline = setTimeout(() => this.fail("A conexão de voz demorou demais. Verifique a rede e tente novamente."), 30_000);
      if (nativeAudio.available()) await nativeAudio.action({ type: "stopAll" });
      if (generation !== this.generation) return;
      const config = await api.voiceConfig();
      if (generation !== this.generation) return;
      const stream = await this.capture(this.state.inputId);
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      this.iceServers = config.iceServers;
      this.prepareTracks(stream);
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
  };
  toggleDeafen = () => {
    this.update({ deafened: !this.state.deafened });
    this.syncControls();
  };
  private syncControls() {
    this.stream?.getAudioTracks().forEach(track => { track.enabled = !this.state.muted && !this.state.deafened; });
    this.peers.forEach(peer => { peer.audio.muted = this.state.deafened; });
    if (this.joined) {
      try {
        this.send({
          type: "voice.state", muted: this.state.muted || this.state.deafened, deafened: this.state.deafened,
          screen: this.state.screen === "live",
        });
      } catch { /* Reconnect restores controls. */ }
    }
  }

  /**
   * Opens the system picker and sends what the user chose to everyone in
   * the call, as a video track on the existing peer connections (adding it
   * renegotiates them). Peers that join later get it too.
   */
  startScreen = async (request: ScreenRequest = CALL_SCREEN) => {
    if (!this.joined || this.state.screen !== "idle") return;
    const generation = this.generation;
    const attempt = ++this.screenAttempt;
    const claim: ScreenClaim = nativeScreen.claim(() => {
      if (this.screenClaim !== claim) return;
      this.screenClaim = undefined;
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
      const share: ScreenTrack = screenTrack(nativeScreen.frame, info.frameRate, error => {
        if (this.share !== share) return;
        this.stopScreen();
        this.update({ error });
      });
      this.share = share;
      this.peers.forEach(peer => this.sendScreen(peer));
      this.update({ screen: "live", screenInfo: info, localScreen: share.stream });
      this.syncControls();
    } catch (error) {
      if (!current()) return;
      this.screenClaim = undefined;
      claim.release();
      this.update({ screen: "idle", error: voiceError(error) });
    }
  };

  /** Stops sharing, or closes the picker while it is open. */
  stopScreen = () => {
    if (this.state.screen === "idle" && !this.share) return;
    const claim = this.screenClaim;
    this.screenClaim = undefined;
    this.endScreen();
    claim?.release();
    this.syncControls();
  };

  /** Removes our screen from the call; the capture itself is the claim's. */
  private endScreen() {
    this.screenAttempt++;
    const share = this.share;
    this.share = undefined;
    this.peers.forEach(peer => {
      if (!peer.screenSender) return;
      try { if (peer.pc.signalingState !== "closed") peer.pc.removeTrack(peer.screenSender); }
      catch { /* The connection is closing. */ }
      peer.screenSender = undefined;
    });
    share?.stop();
    if (this.state.screen !== "idle" || this.state.localScreen) this.update({ screen: "idle", screenInfo: null, localScreen: null });
  }

  private sendScreen(peer: Peer) {
    if (!this.share || peer.screenSender) return;
    const sender = peer.pc.addTrack(this.share.track, this.share.stream);
    peer.screenSender = sender;
    void (async () => {
      try {
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length) return;
        parameters.encodings[0].maxBitrate = SCREEN_BITRATE;
        await sender.setParameters(parameters);
      } catch { /* The default bitrate also works. */ }
    })();
  }

  private remoteScreen(id: string, peer: Peer, track: MediaStreamTrack) {
    const stream = new MediaStream([track]);
    track.onended = () => {
      if (this.state.remoteScreens[id] !== stream) return;
      const { [id]: _ended, ...rest } = this.state.remoteScreens;
      this.update({ remoteScreens: rest });
    };
    if (this.peers.get(id) === peer) this.update({ remoteScreens: { ...this.state.remoteScreens, [id]: stream } });
  }

  setInput = async (inputId: string) => {
    if (this.state.deviceBusy) return;
    const generation = this.generation;
    this.update({ deviceBusy: true });
    try {
      if (this.stream) {
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
      await Promise.all([...this.peers.values()].map(peer => this.sink(peer.audio, outputId)));
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
      await Promise.all([...this.peers.values()].map(peer => peer.audio.play()));
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
    if (event.type === "voice.joined" && event.channelId === channel.id && this.stream) {
      this.peerId = event.peerId;
      this.joined = true;
      this.update({ peerId: event.peerId });
      this.analyse(this.peerId, this.stream);
      this.participants(event.participants);
    }
    if (event.type === "voice.participants" && event.channelId === channel.id && this.joined) this.participants(event.participants);
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
    const peer: Peer = { pc, audio, makingOffer: false, ignoreOffer: false, settingAnswer: false, candidates: [], queue: Promise.resolve() };
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
        this.send({ type: "voice.signal", peerId: id, data: { description: pc.localDescription!.toJSON() } });
      } catch (error) {
        if (this.peers.get(id) === peer && pc.signalingState !== "closed") this.fail(voiceError(error));
      } finally { peer.makingOffer = false; }
    };
    pc.ontrack = event => {
      if (this.peers.get(id) !== peer) return;
      // Screens come in their own stream; audio stays as before.
      if (event.track.kind === "video") { this.remoteScreen(id, peer, event.track); return; }
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
  }

  private async signal(id: string, peer: Peer, data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) {
    if (this.peers.get(id) !== peer) return;
    const pc = peer.pc;
    if (data.description) {
      const readyForOffer = !peer.makingOffer && (pc.signalingState === "stable" || peer.settingAnswer);
      const collision = data.description.type === "offer" && !readyForOffer;
      const polite = this.peerId > id;
      peer.ignoreOffer = !polite && collision;
      if (peer.ignoreOffer) return;
      // Modern WebRTC automatically rolls back a colliding local offer for the polite peer.
      peer.settingAnswer = data.description.type === "answer";
      try { await pc.setRemoteDescription(data.description); }
      finally { peer.settingAnswer = false; }
      for (const candidate of peer.candidates.splice(0)) {
        // Candidates from a rolled-back offer may belong to an obsolete ICE
        // generation; retain candidates that match the accepted description.
        if (candidate.usernameFragment && !pc.remoteDescription?.sdp.includes(`a=ice-ufrag:${candidate.usernameFragment}\r\n`)) continue;
        await pc.addIceCandidate(candidate);
      }
      if (data.description.type === "offer") {
        await pc.setLocalDescription();
        if (this.peers.get(id) === peer) this.send({ type: "voice.signal", peerId: id, data: { description: pc.localDescription!.toJSON() } });
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
    const connected = [...this.peers.values()].every(peer => peer.pc.connectionState === "connected");
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
    this.removeAnalyser(id);
    if (this.state.remoteScreens[id]) {
      const { [id]: _removed, ...rest } = this.state.remoteScreens;
      this.update({ remoteScreens: rest });
    }
  }
  private cleanup() {
    // Sharing ends with the call; the voice.leave (or the lost socket)
    // already tells the others.
    const claim = this.screenClaim;
    this.screenClaim = undefined;
    this.endScreen();
    claim?.release();
    this.generation++;
    this.joined = false;
    clearTimeout(this.deadline);
    this.deadline = undefined;
    clearInterval(this.meter);
    this.meter = undefined;
    for (const id of this.peers.keys()) this.removePeer(id);
    for (const id of this.analysers.keys()) this.removeAnalyser(id);
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.stream = undefined;
    void this.context?.close().catch(() => {});
    this.context = undefined;
  }
}
