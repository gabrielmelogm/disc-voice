import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Headphones, Maximize2, Mic, MicOff, PhoneOff } from "lucide-react";
import type { VoiceParticipant } from "@disc-voice/shared";
import type { Voice, VoiceState } from "../lib/voice";
import { CameraVideo } from "./VoiceChannel";
import { Avatar, LiveTag } from "./ui";

/** "4:05", or "1:02:09" past an hour. */
export function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** Time since `since`, updated every second; empty without a call. */
export function useElapsed(since: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? "" : formatElapsed(now - since);
}

/**
 * The call bar shrunk into a green chip while the user browses elsewhere: a
 * way back to the call and, behind the arrow, mute and leave.
 */
export function CallChip({ voice, state, serverName, onOpen }: {
  voice: Voice; state: VoiceState; serverName?: string; onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const elapsed = useElapsed(state.since);
  if (!state.channel) return null;
  const room = state.channel.name;
  const silent = state.muted || state.deafened;
  const caption = silent ? "Microfone desligado" : [serverName, elapsed].filter(Boolean).join(" · ");
  const micLabel = state.muted ? "Ativar microfone" : "Silenciar microfone";
  const toggleLabel = open ? "Recolher controles da chamada" : "Mostrar controles da chamada";
  return <div role="group" aria-label="Você está em uma chamada" className="call-chip">
    <button className="call-chip-main" aria-label={`Voltar para a chamada em ${room}${serverName ? `, ${serverName}` : ""}`} title="Voltar para a chamada" onClick={onOpen}>
      <span className="call-chip-icon" aria-hidden="true"><Headphones size={16} /></span>
      <span className="call-chip-text">
        <strong>{room}</strong>
        <span className={silent ? "is-muted" : undefined}>{caption}</span>
      </span>
    </button>
    {open && <div id="call-quick-controls" className="call-chip-controls">
      <button className={`chip-button ${silent ? "off" : ""}`} aria-pressed={state.muted} aria-label={micLabel} title={micLabel} onClick={voice.toggleMute}>
        {silent ? <MicOff size={16} /> : <Mic size={16} />}
      </button>
      <button className="chip-button danger" aria-label="Sair da chamada" title="Sair da chamada" onClick={voice.hangUp}><PhoneOff size={16} /></button>
    </div>}
    <button className="chip-button toggle" aria-expanded={open} aria-controls="call-quick-controls" aria-label={toggleLabel} title={toggleLabel} onClick={() => setOpen(!open)}>
      {open ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
    </button>
  </div>;
}

/** Top of another server's channel list: the call goes on somewhere else. */
export function CallBanner({ room, serverName, onOpen }: { room: string; serverName?: string; onOpen: () => void }) {
  const where = [serverName, room].filter(Boolean).join(" · ");
  return <button className="call-banner" aria-label={`Você está em uma chamada em ${where}. Voltar para a chamada`} onClick={onOpen}>
    <span className="call-chip-icon" aria-hidden="true"><Headphones size={16} /></span>
    <span className="call-banner-text"><strong>Você está em uma chamada</strong><span>{where}</span></span>
    <span className="call-banner-cta">Voltar</span>
  </button>;
}

/**
 * Who to feature in the mini window: whoever is speaking (others first), else
 * the last one who spoke, else the first other person in the call.
 */
function useActiveSpeaker(state: VoiceState) {
  const last = useRef<string | null>(null);
  const others = state.participants.filter(p => p.peerId !== state.peerId);
  const speaking = state.participants.filter(p => state.speaking.includes(p.peerId));
  const current = speaking.find(p => p.peerId !== state.peerId) ?? speaking[0];
  if (current) last.current = current.peerId;
  const featured = current ?? state.participants.find(p => p.peerId === last.current) ?? others[0] ?? state.participants[0];
  return { featured, speaking: !!current };
}

/** Floating card over the direct messages while the call goes on. */
export function MiniCall({ state, serverName, onOpen }: { state: VoiceState; serverName?: string; onOpen: () => void }) {
  const elapsed = useElapsed(state.since);
  const { featured, speaking } = useActiveSpeaker(state);
  if (!state.channel) return null;
  const room = state.channel.name;
  const rest = state.participants.filter(p => p.peerId !== featured?.peerId);
  return <section className="mini-call" aria-label={`Mini janela da chamada em ${room}`}>
    <div className="mini-call-head">
      <span className="mini-call-dot" aria-hidden="true" />
      <span className="mini-call-title"><strong>{room}</strong><span>{[serverName, elapsed].filter(Boolean).join(" · ")}</span></span>
      <LiveTag />
    </div>
    {featured && <MiniTile participant={featured} state={state} speaking={speaking} />}
    <div className="mini-call-people">
      {rest.length > 0 && <span className="avatar-stack" aria-label={rest.map(p => p.user.name).join(", ")}>
        {rest.slice(0, 4).map(p => <Avatar key={p.peerId} name={p.user.name} src={p.user.avatar} still={p.user.avatarStill} size="xs" />)}
      </span>}
      <span>{speaking && featured ? `${firstName(featured.user.name)} está falando` : state.participants.length === 1 ? "Só você na sala" : "Ninguém falando agora"}</span>
    </div>
    <button className="button mini-call-back" onClick={onOpen}><Maximize2 size={16} />Voltar para a chamada</button>
  </section>;
}

function firstName(name: string) {
  return name.split(/\s+/)[0] || name;
}

function MiniTile({ participant, state, speaking }: { participant: VoiceParticipant; state: VoiceState; speaking: boolean }) {
  const self = !!state.peerId && participant.peerId === state.peerId;
  const feed = self ? state.localCamera : state.remoteCameras[participant.peerId];
  const camera = (self ? state.camera === "live" : !!participant.camera) && feed;
  const name = participant.user.name;
  return <div className={`mini-tile ${speaking ? "is-speaking" : ""}`}>
    {camera
      ? <CameraVideo feed={camera} label={self ? "Sua câmera" : `Câmera de ${name}`} mirrored={self} />
      : <Avatar name={name} src={participant.user.avatar} still={participant.user.avatarStill} size="lg" />}
    <span className="tile-name">{self ? `${name} (você)` : name}</span>
  </div>;
}
