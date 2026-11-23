import { useEffect, useRef, useState } from "react";
import { MessageCircle, Plus, RefreshCw, Search, Users, X } from "lucide-react";
import type { DirectConversation, User } from "@disc-voice/shared";
import { api, message } from "../lib/api";
import type { Realtime } from "../lib/realtime";
import { TextChannel } from "./TextChannel";
import { Avatar, Badge, SoonTag, unreadLabel } from "./ui";

/** The list of conversations, next to the open one. */
export function DirectMessagesSidebar({ conversations, selectedId, unread, loading, error, onSelect, onNew, onRetry }: {
  conversations: DirectConversation[];
  selectedId: string | null;
  /** Unread messages per conversation channel. */
  unread: Record<string, number>;
  loading: boolean;
  error: string;
  onSelect: (conversation: DirectConversation) => void;
  onNew: () => void;
  onRetry: () => void;
}) {
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLocaleLowerCase("pt-BR");
  const shown = query ? conversations.filter(c => c.user.name.toLocaleLowerCase("pt-BR").includes(query)) : conversations;
  return <aside className="sidebar" aria-label="Mensagens diretas">
    <div className="search-field"><Search size={16} /><label className="sr-only" htmlFor="dm-search">Encontrar conversa</label>
      <input id="dm-search" className="search-input" placeholder="Encontrar conversa" value={filter} onChange={event => setFilter(event.target.value)} /></div>
    {/* Friends are designed but not implemented yet. */}
    <button className="channel-item" disabled><Users size={18} /><span>Amigos</span><SoonTag /></button>
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
          <Avatar name={conversation.user.name} src={conversation.user.avatar} size="sm" />
          <span>{conversation.user.name}</span>
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
      <Avatar name={user.name} src={user.avatar} size="sm" />
      <div><h1>{user.name}</h1><p>Mensagem direta</p></div>
    </header>
    <TextChannel key={channel.id} channel={channel} peer={user} realtime={realtime} revision={revision} self={self}
      onRead={messageId => onRead(channel.id, messageId)} />
  </main>;
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
        <Avatar name={person.name} src={person.avatar} size="sm" /><span>{person.name}</span>
      </button></li>)}
    </ul>
  </dialog>;
}
