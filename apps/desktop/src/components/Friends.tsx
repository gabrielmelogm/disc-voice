import { useEffect, useState } from "react";
import { Check, MessageCircle, Search, UserMinus, UserPlus, Users, X } from "lucide-react";
import type { Friendship, User } from "@disc-voice/shared";
import type { FriendsState } from "../hooks/useFriends";
import { api, message } from "../lib/api";
import { isOnline, STATUS_LABELS } from "../lib/presence";
import { Avatar, Badge } from "./ui";

type Tab = "online" | "all" | "pending" | "add";

/** Where the user stands with someone, from the friends list. */
export function friendshipWith(friends: Pick<FriendsState, "friends" | "incoming" | "outgoing">, userId: string): Friendship {
  if (friends.friends.some(f => f.user.id === userId)) return "friends";
  if (friends.incoming.some(r => r.user.id === userId)) return "incoming";
  if (friends.outgoing.some(r => r.user.id === userId)) return "outgoing";
  return "none";
}

/** Friends, requests and finding new friends: the page behind "Amigos". */
export function FriendsPage({ friends, selfId, onMessage }: {
  friends: FriendsState;
  selfId: string;
  onMessage: (user: User) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>(friends.incoming.length ? "pending" : "online");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);

  async function run(key: string, change: () => Promise<unknown>) {
    if (busy) return;
    setBusy(key);
    setError("");
    try { await change(); setConfirming(null); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(null); }
  }

  const online = friends.friends.filter(f => isOnline(f.status));
  const shown = tab === "online" ? online : friends.friends;
  const pending = friends.incoming.length + friends.outgoing.length;
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "online", label: "Online" },
    { id: "all", label: "Todos" },
    { id: "pending", label: "Pendentes", count: friends.incoming.length },
    { id: "add", label: "Adicionar amigo" },
  ];

  return <main className="channel-main friends-page">
    <header className="channel-header">
      <span className="channel-icon"><Users size={20} /></span>
      <div><h1>Amigos</h1><p>{friends.friends.length === 1 ? "1 amigo" : `${friends.friends.length} amigos`} · {online.length} online</p></div>
      <span />
      <nav className="channel-tabs" aria-label="Seções de amigos">
        {tabs.map(item => <button key={item.id} className={`tab ${tab === item.id ? "selected" : ""}`} aria-current={tab === item.id ? "page" : undefined}
          aria-label={item.count ? `${item.label}, ${item.count} ${item.count === 1 ? "pedido" : "pedidos"}` : undefined}
          onClick={() => { setTab(item.id); setError(""); }}>
          {item.label}{!!item.count && <Badge count={item.count} />}
        </button>)}
      </nav>
    </header>

    <div className="friends-body">
      {error && <p className="inline-error" role="alert">{error}</p>}
      {friends.error && <p className="inline-error" role="alert">{friends.error} <button className="link-button" onClick={friends.retry}>Tentar novamente</button></p>}
      {friends.loading && <p className="muted" role="status">Carregando amigos…</p>}

      {(tab === "online" || tab === "all") && !friends.loading && <>
        <h2 className="eyebrow">{tab === "online" ? `Online — ${online.length}` : `Todos os amigos — ${friends.friends.length}`}</h2>
        {!shown.length && <p className="dialog-empty">{friends.friends.length
          ? "Nenhum amigo online agora."
          : "Você ainda não tem amigos por aqui. Adicione pessoas dos seus servidores."}</p>}
        <ul className="friend-list" aria-label="Amigos">
          {shown.map(({ user, status }) => <li key={user.id} className="friend-row">
            <Avatar name={user.name} src={user.avatar} status={status} />
            <div><strong>{user.name}</strong><small>{STATUS_LABELS[status]}</small></div>
            {confirming === user.id ? <span className="friend-actions">
              <span className="muted">Remover {user.name}?</span>
              <button className="button danger small" disabled={!!busy} onClick={() => void run(user.id, () => friends.remove(user.id))}>Remover</button>
              <button className="button secondary small" disabled={!!busy} onClick={() => setConfirming(null)}>Cancelar</button>
            </span> : <span className="friend-actions">
              <button className="icon-button" aria-label={`Enviar mensagem para ${user.name}`} title="Enviar mensagem" disabled={!!busy}
                onClick={() => void run(user.id, () => onMessage(user))}><MessageCircle size={18} /></button>
              <button className="icon-button" aria-label={`Remover ${user.name} dos amigos`} title="Remover amigo" disabled={!!busy}
                onClick={() => setConfirming(user.id)}><UserMinus size={18} /></button>
            </span>}
          </li>)}
        </ul>
      </>}

      {tab === "pending" && !friends.loading && <>
        {!pending && <p className="dialog-empty">Nenhum pedido de amizade pendente.</p>}
        {!!friends.incoming.length && <h2 className="eyebrow">Recebidos — {friends.incoming.length}</h2>}
        <ul className="friend-list" aria-label="Pedidos recebidos">
          {friends.incoming.map(({ user }) => <li key={user.id} className="friend-row">
            <Avatar name={user.name} src={user.avatar} />
            <div><strong>{user.name}</strong><small>Quer ser seu amigo</small></div>
            <span className="friend-actions">
              <button className="icon-button" aria-label={`Aceitar pedido de ${user.name}`} title="Aceitar" disabled={!!busy}
                onClick={() => void run(user.id, () => friends.accept(user.id))}><Check size={18} /></button>
              <button className="icon-button" aria-label={`Recusar pedido de ${user.name}`} title="Recusar" disabled={!!busy}
                onClick={() => void run(user.id, () => friends.remove(user.id))}><X size={18} /></button>
            </span>
          </li>)}
        </ul>
        {!!friends.outgoing.length && <h2 className="eyebrow">Enviados — {friends.outgoing.length}</h2>}
        <ul className="friend-list" aria-label="Pedidos enviados">
          {friends.outgoing.map(({ user }) => <li key={user.id} className="friend-row">
            <Avatar name={user.name} src={user.avatar} />
            <div><strong>{user.name}</strong><small>Pedido enviado</small></div>
            <span className="friend-actions">
              <button className="icon-button" aria-label={`Cancelar pedido para ${user.name}`} title="Cancelar pedido" disabled={!!busy}
                onClick={() => void run(user.id, () => friends.remove(user.id))}><X size={18} /></button>
            </span>
          </li>)}
        </ul>
      </>}

      {tab === "add" && <AddFriend friends={friends} selfId={selfId} busy={busy} run={run} />}
    </div>
  </main>;
}

function AddFriend({ friends, selfId, busy, run }: {
  friends: FriendsState;
  selfId: string;
  busy: string | null;
  run: (key: string, change: () => Promise<unknown>) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");

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

  return <section className="add-friend" aria-labelledby="add-friend-title">
    <h2 id="add-friend-title">Adicionar amigo</h2>
    <p className="muted">Encontre pessoas dos seus servidores pelo nome e envie um pedido de amizade.</p>
    <div className="search-field"><Search size={16} /><label className="sr-only" htmlFor="friend-search">Buscar pessoas</label>
      <input id="friend-search" className="search-input" placeholder="Buscar pelo nome" value={query} onChange={event => setQuery(event.target.value)} /></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {searching && <p className="muted" role="status">Buscando…</p>}
    {!searching && query.trim() && !people.length && !error && <p className="dialog-empty">Ninguém encontrado nos seus servidores.</p>}
    <ul className="friend-list" aria-label="Pessoas encontradas">
      {people.map(person => {
        const relation = friendshipWith(friends, person.id);
        return <li key={person.id} className="friend-row">
          <Avatar name={person.name} src={person.avatar} />
          <div><strong>{person.name}</strong>{person.pronouns && <small>{person.pronouns}</small>}</div>
          <span className="friend-actions">
            {relation === "friends" ? <span className="muted">Já são amigos</span>
              : relation === "outgoing" ? <span className="muted">Pedido enviado</span>
              : <button className="button primary small" disabled={!!busy} onClick={() => void run(person.id, () => friends.add(person.id))}>
                <UserPlus size={16} />{relation === "incoming" ? "Aceitar pedido" : "Adicionar"}
              </button>}
          </span>
        </li>;
      })}
    </ul>
  </section>;
}
