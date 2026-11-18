import { MessageSquareText, Plus, RefreshCw, UserPlus, Volume2 } from "lucide-react";
import type { Channel, Server, VoiceParticipant } from "@disc-voice/shared";
import type { VoiceState } from "../lib/voice";
import { Avatar, LiveTag } from "./ui";

export function ChannelSidebar({ server, channels, channelId, participants, voiceState, loading, error, onSelect, onJoin, onCreate, onInvite, onReload }: {
  server: Server;
  channels: Channel[];
  channelId: string | null;
  participants: Record<string, VoiceParticipant[]>;
  voiceState: VoiceState;
  loading: boolean;
  error: string;
  onSelect: (channel: Channel) => void;
  onJoin: (channel: Channel) => void;
  onCreate: (type: Channel["type"]) => void;
  onInvite: () => void;
  onReload: () => void;
}) {
  const text = channels.filter(item => item.type === "text");
  const voice = channels.filter(item => item.type === "voice");
  const connectedId = voiceState.channel && voiceState.status !== "error" ? voiceState.channel.id : null;

  return <aside className="sidebar" aria-label={`Canais de ${server.name}`}>
    <div className="sidebar-title"><h2 title={server.name}>{server.name}</h2></div>
    <button className="button soft full" onClick={onInvite}><UserPlus size={16} />Convidar pessoas</button>
    {loading && <p className="sidebar-status" role="status">Carregando canais…</p>}
    {error && <div className="sidebar-status"><p role="alert">{error}</p><button className="link-button" onClick={onReload}><RefreshCw size={13} />Tentar novamente</button></div>}
    {!loading && !error && channels.length === 0 && <p className="sidebar-status">Crie o primeiro canal.</p>}

    <div className="section-heading"><span>Conversas</span><button className="icon-button small" aria-label="Criar canal de texto" title="Criar canal de texto" disabled={loading} onClick={() => onCreate("text")}><Plus size={17} /></button></div>
    <nav className="channel-list" aria-label="Canais de texto">
      {text.map(item => <button key={item.id} className={`channel-item ${channelId === item.id ? "selected" : ""}`} aria-pressed={channelId === item.id} onClick={() => onSelect(item)}>
        <MessageSquareText size={18} /><span>{item.name}</span>
      </button>)}
    </nav>

    <div className="section-heading"><span>Salas de voz</span><button className="icon-button small" aria-label="Criar canal de voz" title="Criar canal de voz" disabled={loading} onClick={() => onCreate("voice")}><Plus size={17} /></button></div>
    <nav className="room-list" aria-label="Canais de voz">
      {voice.map(item => {
        const people = connectedId === item.id ? voiceState.participants : participants[item.id] || [];
        const here = connectedId === item.id;
        return <div key={item.id} className={`room-card ${here ? "is-here" : ""} ${channelId === item.id ? "selected" : ""}`}>
          <button className="room-title" aria-pressed={channelId === item.id} onClick={() => onSelect(item)}><Volume2 size={17} /><span>{item.name}</span>{people.some(p => p.screen) && <LiveTag />}</button>
          <div className="room-meta">
            {people.length > 0 ? <span className="avatar-stack" aria-label={people.map(p => p.user.name).join(", ")}>
              {people.slice(0, 4).map(p => <Avatar key={p.peerId} name={p.user.name} size="xs" speaking={voiceState.speaking.includes(p.peerId)} />)}
            </span> : null}
            <span className="room-count">{people.length ? `${people.length} na sala` : "Ninguém por aqui"}</span>
            {here ? <span className="room-here">Você está aqui</span> : <button className="link-button" aria-label={`Entrar em ${item.name}`} onClick={() => onJoin(item)}>Entrar</button>}
          </div>
        </div>;
      })}
    </nav>
  </aside>;
}
