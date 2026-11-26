import { History, Import, MessageSquareText, Plus, RefreshCw, UserPlus, Volume2 } from "lucide-react";
import type { Channel, Server, VoiceParticipant } from "@disc-voice/shared";
import type { VoiceState } from "../lib/voice";
import { Avatar, Badge, LiveTag, unreadLabel } from "./ui";

export function ChannelSidebar({ server, channels, channelId, unread = {}, participants, voiceState, loading, error, onSelect, onJoin, onCreate, onInvite, onReload, onDiscord }: {
  server: Server;
  channels: Channel[];
  channelId: string | null;
  /** Unread messages per text channel. */
  unread?: Record<string, number>;
  participants: Record<string, VoiceParticipant[]>;
  voiceState: VoiceState;
  loading: boolean;
  error: string;
  onSelect: (channel: Channel) => void;
  onJoin: (channel: Channel) => void;
  onCreate: (type: Channel["type"]) => void;
  onInvite: () => void;
  onReload: () => void;
  /** Opens the Discord import; only for the server owner. */
  onDiscord?: () => void;
}) {
  const text = channels.filter(item => item.type === "text");
  const voice = channels.filter(item => item.type === "voice");
  const connectedId = voiceState.channel && voiceState.status !== "error" ? voiceState.channel.id : null;

  return <aside className="sidebar" aria-label={`Canais de ${server.name}`}>
    <div className="sidebar-title"><h2 title={server.name}>{server.name}</h2></div>
    <button className="button soft full" onClick={onInvite}><UserPlus size={16} />Convidar pessoas</button>
    {onDiscord && <button className="button secondary small full" onClick={onDiscord}><Import size={16} />Importar do Discord</button>}
    {loading && <p className="sidebar-status" role="status">Carregando canais…</p>}
    {error && <div className="sidebar-status"><p role="alert">{error}</p><button className="link-button" onClick={onReload}><RefreshCw size={13} />Tentar novamente</button></div>}
    {!loading && !error && channels.length === 0 && <p className="sidebar-status">Crie o primeiro canal.</p>}

    <div className="section-heading"><span>Conversas</span><button className="icon-button small" aria-label="Criar canal de texto" title="Criar canal de texto" disabled={loading} onClick={() => onCreate("text")}><Plus size={17} /></button></div>
    <nav className="channel-list" aria-label="Canais de texto">
      {text.map(item => {
        const selected = channelId === item.id;
        // The open channel is being read: no badge there.
        const count = selected ? 0 : unread[item.id] || 0;
        return <button key={item.id} className={`channel-item ${selected ? "selected" : ""} ${count ? "unread" : ""}`} aria-pressed={selected} onClick={() => onSelect(item)}
          title={item.readOnly ? "Importando do Discord…" : undefined}>
          {item.readOnly ? <History size={18} aria-label="Importando do Discord" /> : <MessageSquareText size={18} />}<span>{item.name}</span>
          <Badge count={count} label={unreadLabel(count)} />
        </button>;
      })}
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
              {people.slice(0, 4).map(p => <Avatar key={p.peerId} name={p.user.name} src={p.user.avatar} still={p.user.avatarStill} size="xs" speaking={voiceState.speaking.includes(p.peerId)} />)}
            </span> : null}
            <span className="room-count">{people.length ? `${people.length} na sala` : "Ninguém por aqui"}</span>
            {here ? <span className="room-here">Você está aqui</span> : <button className="link-button" aria-label={`Entrar em ${item.name}`} onClick={() => onJoin(item)}>Entrar</button>}
          </div>
        </div>;
      })}
    </nav>
  </aside>;
}
