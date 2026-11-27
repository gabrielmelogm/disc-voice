import { useEffect, useRef, useState } from "react";
import { Clock, MessageCircle, Plus, RefreshCw, Search, UserCheck, UserPlus, Users, X } from "lucide-react";
import type { DirectConversation, Friendship, PresenceStatus, User, UserProfile } from "@disc-voice/shared";
import { api, message } from "../lib/api";
import { mentionText } from "../lib/mentions";
import type { Realtime } from "../lib/realtime";
import { bannerColor } from "./ProfileCard";
import { RoleBadges } from "./ServerRoles";
import { TextChannel } from "./TextChannel";
import { Avatar, Badge, unreadLabel } from "./ui";

/** One line about the newest message: "Você: Oi!", or "Anexo" for files only. */
export function previewText(conversation: DirectConversation, selfId: string) {
  const last = conversation.lastMessage;
  if (!last) return "Nenhuma mensagem ainda";
  // Only the two people of the conversation can be mentioned in it.
  const text = mentionText(last.content, [conversation.user, { id: selfId, name: "você" }]).replace(/\s+/g, " ").trim() || "Anexo";
  return last.authorId === selfId ? `Você: ${text}` : text;
}

/** The list of conversations, next to the open one. */
export function DirectMessagesSidebar({ conversations, selectedId, selfId, unread, presence = {}, friendsOpen = false, requests = 0, loading, error, onSelect, onFriends, onNew, onRetry }: {
  conversations: DirectConversation[];
  selectedId: string | null;
  selfId: string;
  /** Unread messages per conversation channel. */
  unread: Record<string, number>;
  /** Presence of friends, by user id. */
  presence?: Record<string, PresenceStatus>;
  /** The friends page is open. */
  friendsOpen?: boolean;
  /** Friend requests waiting for an answer. */
  requests?: number;
  loading: boolean;
  error: string;
  onSelect: (conversation: DirectConversation) => void;
  onFriends: () => void;
  onNew: () => void;
  onRetry: () => void;
}) {
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLocaleLowerCase("pt-BR");
  const shown = query ? conversations.filter(c => c.user.name.toLocaleLowerCase("pt-BR").includes(query)) : conversations;
  return <aside className="sidebar" aria-label="Mensagens diretas">
    <div className="search-field"><Search size={16} /><label className="sr-only" htmlFor="dm-search">Encontrar conversa</label>
      <input id="dm-search" className="search-input" placeholder="Encontrar conversa" value={filter} onChange={event => setFilter(event.target.value)} /></div>
    <button className={`channel-item ${friendsOpen ? "selected" : ""} ${requests ? "unread" : ""}`} aria-pressed={friendsOpen} onClick={onFriends}
      aria-label={requests ? `Amigos, ${requests} ${requests === 1 ? "pedido pendente" : "pedidos pendentes"}` : "Amigos"}>
      <Users size={18} /><span>Amigos</span><Badge count={requests} />
    </button>
    <div className="section-heading"><span>Mensagens diretas</span><button className="icon-button small" aria-label="Nova mensagem direta" title="Nova mensagem direta" onClick={onNew}><Plus size={17} /></button></div>
    {loading && !conversations.length && <p className="sidebar-status" role="status">Carregando conversas…</p>}
    {error && <div className="sidebar-status"><p role="alert">{error}</p><button className="link-button" onClick={onRetry}><RefreshCw size={13} />Tentar novamente</button></div>}
    {!loading && !error && !conversations.length && <p className="sidebar-status">Suas conversas privadas aparecem aqui.</p>}
    {query && conversations.length > 0 && !shown.length && <p className="sidebar-status">Nenhuma conversa com “{filter.trim()}”.</p>}
    <nav className="channel-list" aria-label="Conversas">
      {shown.map(conversation => {
        const selected = conversation.channel.id === selectedId;
        const count = selected ? 0 : unread[conversation.channel.id] || 0;
        return <button key={conversation.channel.id} className={`channel-item dm-item ${selected ? "selected" : ""} ${count ? "unread" : ""}`}
          aria-pressed={selected} onClick={() => onSelect(conversation)}>
          <Avatar name={conversation.user.name} src={conversation.user.avatar} still={conversation.user.avatarStill} size="sm" status={presence[conversation.user.id]} />
          <span className="dm-text"><span className="dm-name">{conversation.user.name}</span><small className="dm-preview">{previewText(conversation, selfId)}</small></span>
          <Badge count={count} label={unreadLabel(count)} />
        </button>;
      })}
    </nav>
  </aside>;
}

/** The open conversation, or an invitation to start one. */
export function DirectMessages({ conversation, realtime, revision, self, onRead, onNew }: {
  conversation: DirectConversation | undefined;
  realtime: Realtime;
  revision: number;
  self: User;
  onRead: (channelId: string, messageId: string) => void;
  onNew: () => void;
}) {
  if (!conversation) {
    return <main className="dm-main">
      <div className="empty-state">
        <span className="empty-icon"><MessageCircle size={34} /></span>
        <h1>Mensagens diretas</h1>
        <p>Converse em particular com as pessoas dos seus servidores.</p>
        <button className="button primary" onClick={onNew}><Plus size={16} />Nova mensagem</button>
      </div>
    </main>;
  }
  const { channel, user } = conversation;
  return <main className="channel-main">
    <header className="channel-header">
      <Avatar name={user.name} src={user.avatar} still={user.avatarStill} size="sm" />
      <div><h1>{user.name}</h1><p>Mensagem direta</p></div>
    </header>
    <TextChannel key={channel.id} channel={channel} peer={user} realtime={realtime} revision={revision} self={self}
      onRead={messageId => onRead(channel.id, messageId)} />
  </main>;
}

const ACTIONS: Record<Friendship, string> = {
  none: "Adicionar amigo",
  outgoing: "Pedido enviado",
  incoming: "Aceitar pedido de amizade",
  friends: "Amigos",
};

/** The other person's profile, beside a direct conversation. */
export function DirectProfilePanel({ user, friendship, status, onAddFriend }: {
  user: User;
  /** From the live friends list, so the panel follows changes at once. */
  friendship: Friendship;
  status?: PresenceStatus;
  onAddFriend: () => Promise<void>;
}) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void api.profile(user.id, controller.signal)
      .then(result => { if (!controller.signal.aborted) setProfile(result); })
      .catch(cause => { if (!controller.signal.aborted) setError(message(cause)); });
    return () => controller.abort();
  }, [user.id, friendship]);

  async function add() {
    setBusy(true);
    setError("");
    try { await onAddFriend(); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  const person = profile?.user.id === user.id ? { ...profile.user, ...user } : user;
  return <aside className="details-panel dm-profile" aria-label={`Perfil de ${user.name}`}>
    <div className="profile-preview">
      <div className="profile-banner" style={{ background: bannerColor(person.banner) }} />
      <Avatar name={person.name} src={person.avatar} still={person.avatarStill} size="xl" status={status} className="profile-avatar" />
      <strong>{person.name}</strong>
      {person.pronouns && <span>{person.pronouns}</span>}
      <div className="detail-card"><h3 className="eyebrow">Sobre mim</h3><p className="profile-bio">{person.bio || "Ainda não escreveu nada por aqui."}</p></div>
      {profile && <div className="detail-card"><h3 className="eyebrow">Membro desde</h3>
        <p>{new Date(profile.memberSince).toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric" })}</p></div>}
      {profile && <div className="detail-card"><h3 className="eyebrow">Servidores em comum — {profile.mutualServers.length}</h3>
        {profile.mutualServers.length
          ? <ul className="mutual-servers">{profile.mutualServers.map(server => <li key={server.id}>
            <span className="mutual-server-name"><Avatar name={server.name} src={server.icon} size="xs" square />{server.name}</span>
            {/* The person's roles in each shared server. */}
            <RoleBadges badge={{ owner: !!server.owner, roles: server.roles ?? [] }} label={`Cargos de ${person.name} em ${server.name}`} />
          </li>)}</ul>
          : <p className="muted">Nenhum servidor em comum.</p>}
      </div>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {friendship === "friends" || friendship === "outgoing"
        ? <p className="friend-state">{friendship === "friends" ? <><UserCheck size={16} />Vocês são amigos</> : <><Clock size={16} />Pedido de amizade enviado</>}</p>
        : <button className="button primary small full" disabled={busy} onClick={() => void add()}><UserPlus size={16} />{ACTIONS[friendship]}</button>}
    </div>
  </aside>;
}

/** Picks someone from the user's servers to talk to. */
export function NewMessageDialog({ selfId, onPick, onClose }: {
  selfId: string;
  onPick: (user: User) => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setPeople([]); setSearching(false); return; }
    const controller = new AbortController();
    setSearching(true);
    // Wait for a pause in typing before asking the API.
    const timer = setTimeout(() => {
      void api.search(q, undefined, controller.signal)
        .then(result => { setPeople(result.people.filter(person => person.id !== selfId)); setError(""); })
        .catch(cause => { if (!controller.signal.aborted) setError(message(cause)); })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, selfId]);

  async function pick(person: User) {
    if (busy) return;
    setBusy(true);
    setError("");
    try { await onPick(person); }
    catch (cause) { setError(message(cause)); setBusy(false); }
  }

  return <dialog ref={ref} className="action-dialog" aria-labelledby="new-dm-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog-heading"><h2 id="new-dm-title">Nova mensagem</h2><button type="button" className="icon-button" aria-label="Fechar" disabled={busy} onClick={onClose}><X size={20} /></button></div>
    <p className="lede">Converse em particular com alguém dos seus servidores.</p>
    <div className="search-field"><Search size={16} /><label className="sr-only" htmlFor="new-dm-search">Buscar pessoas</label>
      <input id="new-dm-search" className="search-input" autoFocus placeholder="Buscar pelo nome" value={query} onChange={event => setQuery(event.target.value)} /></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {searching && <p className="muted" role="status">Buscando…</p>}
    {!searching && query.trim() && !people.length && !error && <p className="dialog-empty">Ninguém encontrado nos seus servidores.</p>}
    <ul className="person-list" aria-label="Pessoas">
      {people.map(person => <li key={person.id}><button className="channel-item dm-item" disabled={busy} onClick={() => void pick(person)}>
        <Avatar name={person.name} src={person.avatar} still={person.avatarStill} size="sm" /><span>{person.name}</span>
      </button></li>)}
    </ul>
  </dialog>;
}
