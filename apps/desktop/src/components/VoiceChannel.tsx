import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Headphones, LoaderCircle, Maximize2, MessageSquareText, MicOff, MonitorUp, Signal, SignalHigh, SignalLow, SignalMedium,
  SignalZero, Video, Volume2, VolumeX, X, type LucideIcon,
} from "lucide-react";
import type { Channel, MemberRole, User, VoiceParticipant } from "@disc-voice/shared";
import type { Realtime } from "../lib/realtime";
import { DEFAULT_SCREEN_VOLUME, effectiveVolume, screenLabel, type ScreenFeed, type ScreenVolume, type VideoFeed, type Voice, type VoiceState } from "../lib/voice";
import { NativeFramePreview } from "./NativeFramePreview";
import { ProfileButton } from "./ProfileCard";
import { TextChannel } from "./TextChannel";
import { Avatar, LiveTag } from "./ui";

export const voiceLabels: Record<VoiceState["status"], string> = {
  idle: "Desconectado", connecting: "Conectando áudio…", connected: "Voz conectada",
  reconnecting: "Reconectando…", error: "Falha na conexão",
};

/**
 * Status pill above the app bar. A healthy call is already shown by the bar's call
 * controls, so this only appears while connecting, on errors or when autoplay is blocked.
 */
export function CallStatus({ voice, state, serverName, onOpen }: {
  voice: Voice; state: VoiceState; serverName?: string; onOpen: () => void;
}) {
  if (!state.channel) return state.error ? <p className="call-status error" role="status">{state.error}</p> : null;
  if (state.status === "connected" && !state.playbackBlocked && !state.error) return null;
  return <section className={`call-status ${state.status === "error" ? "error" : ""}`} aria-label="Chamada atual">
    <span className={`status-dot ${state.status === "connected" ? "ok" : ""}`} />
    <button className="call-status-main" onClick={onOpen}><strong role="status">{voiceLabels[state.status]}</strong><span>{state.channel.name}{serverName ? ` · ${serverName}` : ""}</span></button>
    {state.error && <span role="alert">{state.error}</span>}
    {state.status === "error" && <button className="link-button" onClick={() => void voice.join(state.channel!)}>Tentar novamente</button>}
    {state.playbackBlocked && <button className="button secondary small" onClick={() => void voice.resumePlayback()}>Ativar reprodução de áudio</button>}
  </section>;
}

/** A video ends with its sharing; draw errors only mean a frame was skipped. */
const ignoreFrameError = () => {};

function StreamVideo({ stream, label, mirrored = false }: { stream: MediaStream; label: string; mirrored?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    void video.play?.()?.catch(() => {});
    return () => { video.srcObject = null; };
  }, [stream]);
  return <video ref={ref} className={mirrored ? "mirrored" : undefined} autoPlay muted playsInline aria-label={label} onDoubleClick={() => void ref.current?.requestFullscreen?.().catch(() => {})} />;
}

/** A webcam: a media stream (webview) or JPEG frames from a native engine. */
function CameraVideo({ feed, label, mirrored }: { feed: VideoFeed; label: string; mirrored: boolean }) {
  return <div className="tile-video">
    {"pull" in feed
      ? <NativeFramePreview active pull={feed.pull} label={label} mirrored={mirrored} onError={ignoreFrameError} />
      : <StreamVideo stream={feed} label={label} mirrored={mirrored} />}
  </div>;
}

/**
 * Our own volume for the audio of someone's screen: it changes nothing for
 * the others, nor that person's voice.
 */
function ScreenVolumeControl({ name, setting, onVolume, onMute }: {
  name: string; setting: ScreenVolume; onVolume: (volume: number) => void; onMute: () => void;
}) {
  const silent = effectiveVolume(setting) === 0;
  const percent = Math.round(setting.volume * 100);
  return <span className="screen-volume">
    <button className="icon-button on-dark small" aria-pressed={setting.muted}
      aria-label={setting.muted ? `Ativar o áudio da tela de ${name}` : `Silenciar o áudio da tela de ${name}`}
      title={setting.muted ? "Ativar o áudio da tela" : "Silenciar o áudio da tela"} onClick={onMute}>
      {silent ? <VolumeX size={15} /> : <Volume2 size={15} />}
    </button>
    <input type="range" min={0} max={100} step={1} value={setting.muted ? 0 : percent}
      aria-label={`Volume da tela de ${name}`} aria-valuetext={setting.muted ? "Silenciado" : `${percent}%`}
      title={setting.muted ? "Silenciado" : `${percent}%`}
      onChange={event => onVolume(Number(event.currentTarget.value) / 100)} />
  </span>;
}

function ScreenVideo({ feed, label, detail, expanded, onToggle, audio, volume }: {
  feed: ScreenFeed; label: string; expanded: boolean; onToggle: () => void;
  /** What it is sent at ("1080p · 60 fps"), for our own screen. */
  detail?: string;
  /** The screen carries the computer's audio. */
  audio?: boolean;
  /** Our volume for it (screens received only). */
  volume?: ReactNode;
}) {
  return <figure className={`call-screen ${expanded ? "expanded" : ""}`}>
    {"pull" in feed
      ? <div className="call-screen-frames" onDoubleClick={event => void event.currentTarget.requestFullscreen?.().catch(() => {})}>
        <NativeFramePreview active pull={feed.pull} label={label} onError={ignoreFrameError} />
      </div>
      : <StreamVideo stream={feed} label={label} />}
    <figcaption><LiveTag /><span>{label}</span>
      {detail && <small className="screen-quality" aria-label={`Qualidade: ${detail}`}>{detail}</small>}
      {audio && (volume ?? <span className="screen-audio-badge" role="img" aria-label="Com áudio do computador" title="Com áudio do computador"><Volume2 size={15} /></span>)}
      <button className="icon-button on-dark small" aria-label={expanded ? `Reduzir ${label}` : `Ampliar ${label}`} aria-pressed={expanded} title={expanded ? "Reduzir" : "Ampliar"} onClick={onToggle}><Maximize2 size={15} /></button>
    </figcaption>
  </figure>;
}

/** Screens shared in the call: ours (what we send) and the ones received. */
function CallScreens({ voice, state, participants }: { voice: Voice; state: VoiceState; participants: VoiceParticipant[] }) {
  const [expanded, setExpanded] = useState("");
  const remote = participants.filter(p => p.screen && p.peerId !== state.peerId);
  const local = state.localScreen;
  if (!local && !remote.length && state.screen !== "picking") return null;
  const toggle = (id: string) => setExpanded(current => (current === id ? "" : id));
  return <div className="call-screens" aria-label="Telas compartilhadas">
    {state.screen === "picking" && <div className="call-screen pending" role="status">Escolha uma tela ou janela na janela do sistema.</div>}
    {local && <ScreenVideo feed={local} label="Sua tela" detail={state.screenShare ? screenLabel(state.screenShare) : undefined} audio={state.screenAudio} expanded={expanded === state.peerId} onToggle={() => toggle(state.peerId)} />}
    {remote.map(p => {
      const feed = state.remoteScreens[p.peerId];
      const volume = <ScreenVolumeControl name={p.user.name} setting={state.screenVolumes[p.user.id] ?? DEFAULT_SCREEN_VOLUME}
        onVolume={value => voice.setScreenVolume(p.user.id, value)} onMute={() => voice.toggleScreenMute(p.user.id)} />;
      return feed
        ? <ScreenVideo key={p.peerId} feed={feed} label={`Tela de ${p.user.name}`} audio={!!p.screenAudio} volume={volume} expanded={expanded === p.peerId} onToggle={() => toggle(p.peerId)} />
        : <div key={p.peerId} className="call-screen pending" role="status">Recebendo a tela de {p.user.name}…</div>;
    })}
  </div>;
}

/** Bars and color for a round trip, like a phone's signal indicator. */
export function signalLevel(ms: number | null | undefined): { Icon: LucideIcon; tone: string } {
  if (ms === null || ms === undefined) return { Icon: SignalZero, tone: "unknown" };
  if (ms < 80) return { Icon: Signal, tone: "good" };
  if (ms < 150) return { Icon: SignalHigh, tone: "good" };
  if (ms < 300) return { Icon: SignalMedium, tone: "fair" };
  return { Icon: SignalLow, tone: "poor" };
}

/** Connection quality to a participant (to the server, for us); hover for the ping. */
function SignalBadge({ ms, self }: { ms: number | null | undefined; self: boolean }) {
  const { Icon, tone } = signalLevel(ms);
  const value = typeof ms === "number" ? `${ms} ms` : "medindo…";
  const text = self ? `Ping com o servidor: ${value}` : `Ping: ${value}`;
  return <span className={`tile-signal ${tone}`} tabIndex={0} aria-label={text}>
    <Icon size={14} aria-hidden />
    <span className="tile-tooltip" role="tooltip">{text}</span>
  </span>;
}

/** Tile orders chosen by dragging, per channel; in memory only, by user ID. */
const tileOrders = new Map<string, string[]>();

/** Participants in the chosen order; anyone not ordered yet goes last. */
export function arrangeTiles<T extends { user: { id: string } }>(participants: T[], order: string[]): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return participants
    .map((participant, index) => ({ participant, key: rank.get(participant.user.id) ?? order.length + index }))
    .sort((a, b) => a.key - b.key)
    .map(entry => entry.participant);
}

/** `ids` with the item at `from` moved to `to`. */
export function moveTile(ids: string[], from: number, to: number): string[] {
  if (from < 0 || to < 0 || from === to) return ids;
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

interface Reorder {
  dragging: boolean;
  target: boolean;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  /** Moves the tile by `step` places (keyboard). */
  onMove: (step: number) => void;
}

function Tile({ participant, speaking, self, camera, feed, ping, reorder }: {
  participant: VoiceParticipant; speaking: boolean; self: boolean;
  /** The camera is on (for us: sending). */
  camera: boolean;
  feed: VideoFeed | null | undefined;
  /** Shown while in the call: round trip in ms, `null` until measured. */
  ping?: number | null;
  reorder: Reorder;
}) {
  const name = participant.user.name;
  const video = camera && feed;
  const classes = ["call-tile", speaking && "is-speaking", video && "has-video", reorder.dragging && "is-dragging", reorder.target && "drop-target"];
  return <li className={classes.filter(Boolean).join(" ")} draggable tabIndex={0}
    aria-label={`${name}${self ? " (você)" : ""}. Arraste ou use Alt e as setas para mudar a posição.`}
    onDragStart={event => { event.dataTransfer?.setData("text/plain", participant.user.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"; reorder.onDragStart(); }}
    onDragEnter={reorder.onDragEnter}
    onDragOver={event => event.preventDefault()}
    onDrop={event => { event.preventDefault(); reorder.onDrop(); }}
    onDragEnd={reorder.onDragEnd}
    onKeyDown={event => {
      if (!event.altKey || event.target !== event.currentTarget) return;
      const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : 0;
      if (!step) return;
      event.preventDefault();
      reorder.onMove(step);
    }}>
    {video
      // Our own camera is mirrored, as in any video call; others see it as is.
      ? <CameraVideo feed={feed} label={self ? "Sua câmera" : `Câmera de ${name}`} mirrored={self} />
      : <Avatar name={name} src={participant.user.avatar} still={participant.user.avatarStill} size="xl" />}
    {ping !== undefined && <SignalBadge ms={ping} self={self} />}
    {camera && !feed && <span className="tile-loading" role="status"><Video size={14} />Carregando câmera…</span>}
    {participant.screen && <span className="tile-badge"><MonitorUp size={14} aria-label="Compartilhando a tela" /></span>}
    <span className="tile-name">
      {participant.muted && <MicOff size={14} aria-label="Microfone desligado" />}
      {participant.deafened && <VolumeX size={14} aria-label="Áudio desativado" />}
      <span><ProfileButton user={participant.user} />{self ? " (você)" : ""}</span>
    </span>
    {speaking && <span className="sr-only">Falando</span>}
  </li>;
}

/** `realtime`, `revision`, `self` and `roles` feed the room chat, as in a text channel. */
export function VoiceChannel({ channel, voice, state, participants, online, realtime, revision, self, roles }: {
  channel: Channel; voice: Voice; state: VoiceState; participants: VoiceParticipant[]; online: boolean;
  realtime: Realtime; revision: number; self?: User; roles?: Record<string, MemberRole>;
}) {
  const active = state.channel?.id === channel.id && state.status !== "error";
  const [chatOpen, setChatOpen] = useState(true);
  const [since, setSince] = useState<Date | null>(null);
  useEffect(() => { setSince(active ? new Date() : null); }, [active]);
  const [order, setOrder] = useState(() => tileOrders.get(channel.id) ?? []);
  useEffect(() => { setOrder(tileOrders.get(channel.id) ?? []); }, [channel.id]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const tiles = arrangeTiles(participants, order);
  const ids = tiles.map(p => p.user.id);
  const reorderTo = (id: string, to: number) => {
    const next = moveTile(ids, ids.indexOf(id), Math.max(0, Math.min(ids.length - 1, to)));
    tileOrders.set(channel.id, next);
    setOrder(next);
  };
  const endDrag = () => { setDragging(null); setTarget(null); };
  const sharing = active && (!!state.localScreen || state.screen === "picking" || participants.some(p => p.screen && p.peerId !== state.peerId));

  return <div className="call-layout">
    <section className="call-stage" aria-label={`Chamada em ${channel.name}`}>
      <header className="call-header">
        <Volume2 size={20} />
        <h1>{channel.name}</h1>
        <span>{participants.length === 1 ? "1 pessoa" : `${participants.length} pessoas`}</span>
        <span className="call-header-end">
          {active && since && <span>Desde {since.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>}
          {!chatOpen && <button className="icon-button on-dark" aria-label="Abrir chat da sala" onClick={() => setChatOpen(true)}><MessageSquareText size={18} /></button>}
        </span>
      </header>

      {active && <CallScreens voice={voice} state={state} participants={participants} />}
      {participants.length > 0 && <ul className={`call-grid ${sharing ? "compact" : `count-${Math.min(participants.length, 9)}`}`} aria-label="Participantes do canal de voz">
        {tiles.map((p, index) => {
          const self = !!state.peerId && p.peerId === state.peerId;
          const camera = active && (self ? state.camera === "live" : !!p.camera);
          const feed = self ? state.localCamera : state.remoteCameras[p.peerId];
          const ping = !active ? undefined : self ? state.serverLatency : state.latency[p.peerId] ?? null;
          const id = p.user.id;
          return <Tile key={p.peerId} participant={p} speaking={state.speaking.includes(p.peerId)} self={self} camera={camera} feed={feed} ping={ping}
            reorder={{
              dragging: dragging === id,
              target: !!dragging && dragging !== id && target === id,
              onDragStart: () => setDragging(id),
              onDragEnter: () => setTarget(id),
              onDrop: () => { if (dragging && dragging !== id) reorderTo(dragging, index); endDrag(); },
              onDragEnd: endDrag,
              onMove: step => reorderTo(id, index + step),
            }} />;
        })}
      </ul>}

      {!active && <div className="call-lobby">
        {!participants.length && <><span className="lobby-icon"><Headphones size={30} /></span><h2>Ninguém na sala ainda</h2></>}
        <p>{state.channel?.id === channel.id && state.status === "error" ? state.error : "Entre para conversar por voz com quem está no servidor."}</p>
        <button className="button primary large" disabled={!online} onClick={() => void voice.join(channel)}><Headphones size={18} />Entrar no canal de voz</button>
        {!online && <small>Aguardando conexão com o servidor…</small>}
      </div>}
      {active && state.status !== "connected" && <p className="call-progress" role="status"><LoaderCircle size={16} className="spin" />{voiceLabels[state.status]}</p>}
    </section>

    {/* Only the panel closes: the call goes on. */}
    {chatOpen && <aside className="room-chat" aria-label="Chat da chamada">
      <header><h2>Chat da sala</h2><button className="icon-button" aria-label="Fechar chat da sala" onClick={() => setChatOpen(false)}><X size={18} /></button></header>
      <TextChannel key={channel.id} channel={channel} realtime={realtime} revision={revision} self={self} roles={roles} room />
    </aside>}
  </div>;
}

export function VoiceDevices({ voice, state }: { voice: Voice; state: VoiceState }) {
  // The native call engine opens any output itself.
  const sinkSupported = state.native || (typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype);
  return <section aria-labelledby="call-devices-title">
    <h2 id="call-devices-title" className="settings-section-title">Voz</h2>
    <div className="field-grid">
      <div className="field"><label htmlFor="call-input">Microfone</label>
        <select id="call-input" value={state.inputId} disabled={state.deviceBusy || state.status === "connecting"} onChange={event => void voice.setInput(event.target.value)}>
          <option value="">Padrão do sistema</option>
          {state.inputId && !state.devices.some(d => d.deviceId === state.inputId) && <option value={state.inputId}>Dispositivo selecionado indisponível</option>}
          {state.devices.filter(d => d.kind === "audioinput" && d.deviceId).map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microfone ${i + 1}`}</option>)}
        </select>
      </div>
      <div className="field"><label htmlFor="call-output">Saída de áudio</label>
        <select id="call-output" value={state.outputId} disabled={!sinkSupported || state.deviceBusy} onChange={event => void voice.setOutput(event.target.value)}>
          <option value="">Padrão do sistema</option>
          {state.devices.filter(d => d.kind === "audiooutput" && d.deviceId).map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Saída ${i + 1}`}</option>)}
        </select>
        {!sinkSupported && <small>Este ambiente utiliza a saída padrão do sistema.</small>}
      </div>
    </div>
    <p className="field-help">{state.native ? "Usados nas chamadas." : "Usados nas chamadas. Autorize o microfone ao entrar em uma sala para ver os nomes dos dispositivos."} <button className="link-button" onClick={() => void voice.refreshDevices()}>Atualizar lista</button></p>
    {state.error && !state.channel && <p className="inline-error" role="alert">{state.error}</p>}
  </section>;
}
