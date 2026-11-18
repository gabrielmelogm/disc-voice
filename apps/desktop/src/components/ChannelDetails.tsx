import { Headphones, MoreHorizontal, MessageSquareText, Search, Users } from "lucide-react";
import type { Channel, User, VoiceParticipant } from "@disc-voice/shared";
import type { VoiceState } from "../lib/voice";
import { Avatar, LiveTag, SoonTag } from "./ui";

export function ChannelHeader({ channel }: { channel: Channel }) {
  return <header className="channel-header">
    <span className="channel-icon"><MessageSquareText size={20} /></span>
    <div><h1>{channel.name}</h1><p>Canal de texto</p></div>
    {/* Channel options are designed but not implemented yet. */}
    <button className="icon-button" disabled aria-label="Opções do canal (em breve)" title="Opções do canal em breve"><MoreHorizontal size={20} /></button>
    <nav className="channel-tabs" aria-label="Seções da conversa">
      <button className="tab selected" aria-current="page">Conversa</button>
      {/* Pinned messages and shared files: see the channel details issue. */}
      <button className="tab" disabled title="Mensagens fixadas em breve">Fixadas</button>
      <button className="tab" disabled title="Arquivos em breve">Arquivos</button>
    </nav>
  </header>;
}

/** Right-hand panel of a text channel. */
export function ChannelDetails({ user, voiceChannels, participants, voiceState, onJoin }: {
  user: User;
  voiceChannels: Channel[];
  participants: Record<string, VoiceParticipant[]>;
  voiceState: VoiceState;
  onJoin: (channel: Channel) => void;
}) {
  const connectedId = voiceState.channel && voiceState.status !== "error" ? voiceState.channel.id : null;
  const occupants = (channel: Channel) => connectedId === channel.id ? voiceState.participants : participants[channel.id] || [];
  const live = voiceChannels.find(channel => occupants(channel).length > 0);
  const people = live ? occupants(live) : [];
  const sharer = people.find(p => p.screen);

  return <aside className="details-panel" aria-label="Detalhes da conversa">
    {live && <section className="live-room">
      <div className="live-room-heading"><h2>{live.name} agora</h2>{sharer && <LiveTag />}</div>
      <div className="live-room-people">{people.slice(0, 5).map(p => <Avatar key={p.peerId} name={p.user.name} speaking={voiceState.speaking.includes(p.peerId)} />)}</div>
      <p>{sharer ? `${sharer.user.name} está compartilhando a tela` : people.length === 1 ? `${people[0].user.name} está na sala` : `${people.length} pessoas conversando`}</p>
      {connectedId === live.id
        ? <button className="button on-dark full" onClick={() => onJoin(live)}><Headphones size={17} />Voltar para a chamada</button>
        : <button className="button on-dark full" onClick={() => onJoin(live)}><Headphones size={17} />Entrar na chamada</button>}
    </section>}

    <section className="detail-card">
      <h2 className="eyebrow">Sobre a conversa <SoonTag /></h2>
      <p className="muted">Em breve você poderá descrever o assunto do canal e fixar a pauta aqui.</p>
    </section>

    <section className="detail-card">
      <div className="detail-heading"><h2 className="eyebrow">Pessoas</h2><button className="icon-button small" disabled aria-label="Buscar pessoas (em breve)"><Search size={16} /></button></div>
      <ul className="people-list">
        <li><Avatar name={user.name} status="online" /><div><strong>{user.name}</strong><small>{connectedId && voiceState.channel ? `Em ${voiceState.channel.name}` : "Você"}</small></div></li>
        {people.filter(p => p.user.id !== user.id).map(p => <li key={p.peerId}><Avatar name={p.user.name} status="online" /><div><strong>{p.user.name}</strong><small>{p.screen ? "Compartilhando a tela" : `Em ${live!.name}`}</small></div></li>)}
      </ul>
      <p className="detail-footnote"><Users size={14} />Lista de membros e presença em breve</p>
    </section>
  </aside>;
}
