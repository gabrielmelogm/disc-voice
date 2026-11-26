import { Headphones, MoreHorizontal, MessageSquareText } from "lucide-react";
import type { Channel, ChosenStatus, ServerMember, User, VoiceParticipant } from "@disc-voice/shared";
import type { VoiceState } from "../lib/voice";
import { peopleCount } from "../lib/presence";
import { PeoplePanel, type RoomPresence } from "./Members";
import { Avatar, LiveTag, SoonTag } from "./ui";

export function ChannelHeader({ channel, memberCount }: { channel: Channel; memberCount?: number }) {
  const kind = channel.readOnly ? "Importando do Discord…" : channel.source === "discord" ? "Canal de texto · importado do Discord" : "Canal de texto";
  return <header className="channel-header">
    <span className="channel-icon"><MessageSquareText size={20} /></span>
    <div><h1>{channel.name}</h1><p>{kind}{!!memberCount && ` · ${peopleCount(memberCount)}`}</p></div>
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

/** The people in each voice room, with ours from the call itself (it is newer). */
export function voiceOccupants(participants: Record<string, VoiceParticipant[]>, voiceState: VoiceState) {
  const connectedId = voiceState.channel && voiceState.status !== "error" ? voiceState.channel.id : null;
  return (channel: Channel) => connectedId === channel.id ? voiceState.participants : participants[channel.id] || [];
}

/** Which voice room each person is in, and whether they share their screen. */
export function roomPresence(voiceChannels: Channel[], occupants: (channel: Channel) => VoiceParticipant[]): RoomPresence {
  const rooms: RoomPresence = {};
  for (const channel of voiceChannels) {
    for (const p of occupants(channel)) {
      rooms[p.user.id] = { channel, screen: p.screen || !!rooms[p.user.id]?.screen };
    }
  }
  return rooms;
}

/** Right-hand panel of a text channel. */
export function ChannelDetails({ user, selfStatus, members, voiceChannels, participants, voiceState, onJoin, onShowMembers }: {
  user: User;
  selfStatus: ChosenStatus;
  members: { members: ServerMember[]; loading: boolean; error: string; retry: () => void };
  voiceChannels: Channel[];
  participants: Record<string, VoiceParticipant[]>;
  voiceState: VoiceState;
  onJoin: (channel: Channel) => void;
  onShowMembers: () => void;
}) {
  const connectedId = voiceState.channel && voiceState.status !== "error" ? voiceState.channel.id : null;
  const occupants = voiceOccupants(participants, voiceState);
  const live = voiceChannels.find(channel => occupants(channel).length > 0);
  const people = live ? occupants(live) : [];
  const sharer = people.find(p => p.screen);

  return <aside className="details-panel" aria-label="Detalhes da conversa">
    {live && <section className="live-room">
      <div className="live-room-heading"><h2>{live.name} agora</h2>{sharer && <LiveTag />}</div>
      <div className="live-room-people">{people.slice(0, 5).map(p => <Avatar key={p.peerId} name={p.user.name} src={p.user.avatar} still={p.user.avatarStill} speaking={voiceState.speaking.includes(p.peerId)} />)}</div>
      <p>{sharer ? `${sharer.user.name} está compartilhando a tela` : people.length === 1 ? `${people[0].user.name} está na sala` : `${people.length} pessoas conversando`}</p>
      {connectedId === live.id
        ? <button className="button on-dark full" onClick={() => onJoin(live)}><Headphones size={17} />Voltar para a chamada</button>
        : <button className="button on-dark full" onClick={() => onJoin(live)}><Headphones size={17} />Entrar na chamada</button>}
    </section>}

    <section className="detail-card">
      <h2 className="eyebrow">Sobre a conversa <SoonTag /></h2>
      <p className="muted">Em breve você poderá descrever o assunto do canal e fixar a pauta aqui.</p>
    </section>

    <PeoplePanel self={user} selfStatus={selfStatus} members={members.members} loading={members.loading} error={members.error}
      rooms={roomPresence(voiceChannels, occupants)} onRetry={members.retry} onShowAll={onShowMembers} />
  </aside>;
}
