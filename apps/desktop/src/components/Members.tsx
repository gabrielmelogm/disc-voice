import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Shield, X } from "lucide-react";
import type { Activity, Channel, ChosenStatus, MemberRole, PresenceStatus, Server, ServerMember, User } from "@disc-voice/shared";
import { activityLabel } from "../lib/activity";
import { api, message } from "../lib/api";
import { isOnline, ROLE_RANK, roleLabel, STATUS_LABELS } from "../lib/presence";
import { ProfileButton, useActivity } from "./ProfileCard";
import { Avatar } from "./ui";

/** Where each person is in a voice room of the server, by user id. */
export type RoomPresence = Record<string, { channel: Channel; screen: boolean }>;

/** At most this many offline people show as avatars before "Ver todos". */
const OFFLINE_PREVIEW = 6;

export function RoleBadge({ role }: { role: MemberRole | undefined }) {
  const label = roleLabel(role);
  if (!label) return null;
  return <span className={`role-badge role-${role}`} title={label}>{role === "moderator" && <Shield size={11} aria-hidden="true" />}{label}</span>;
}

/** Search ignores case and accents: "joao" finds "João". */
export function normalize(text: string) {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

/** What a member is doing, most specific first. */
export function activityText(status: PresenceStatus, room: RoomPresence[string] | undefined, activity: Activity | undefined, fallback?: string) {
  if (room?.screen) return "Compartilhando a tela";
  if (room) return `Na ${room.channel.name}`;
  if (activity && isOnline(status)) return activityLabel(activity);
  if (status === "idle" || status === "dnd") return STATUS_LABELS[status];
  return fallback ?? (status === "offline" ? STATUS_LABELS.offline : "");
}

function byRoleThenName(a: ServerMember, b: ServerMember) {
  return ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.user.name.localeCompare(b.user.name, "pt-BR");
}

/** Members with the user's own status as they chose it, which is newer than the server's copy. */
function withSelf(members: ServerMember[], self: User, selfStatus: ChosenStatus): ServerMember[] {
  if (!members.some(m => m.user.id === self.id)) return members;
  return members.map(m => m.user.id === self.id ? { ...m, user: self, status: selfStatus } : m);
}

function MemberRow({ member, room, selfId }: { member: ServerMember; room?: RoomPresence[string]; selfId: string }) {
  return <li className={member.status === "offline" ? "is-offline" : undefined}>
    <Avatar name={member.user.name} src={member.user.avatar} still={member.user.avatarStill} status={member.status} />
    <MemberDetails member={member} room={room} selfId={selfId} />
  </li>;
}

/** "Pessoas" section of a text channel's side panel. */
export function PeoplePanel({ self, selfStatus, members, loading, error, rooms, onRetry, onShowAll }: {
  self: User;
  selfStatus: ChosenStatus;
  members: ServerMember[];
  loading: boolean;
  error: string;
  rooms: RoomPresence;
  onRetry: () => void;
  onShowAll: () => void;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  // Until the list arrives, at least the user is shown.
  const everyone = members.length ? withSelf(members, self, selfStatus) : [{ user: self, role: "member" as const, status: selfStatus, joinedAt: "" }];
  const q = normalize(query);
  const shown = q ? everyone.filter(m => normalize(m.user.name).includes(q)) : everyone;
  const online = shown.filter(m => isOnline(m.status)).sort(byRoleThenName);
  const offline = shown.filter(m => !isOnline(m.status)).sort(byRoleThenName);
  const onlineCount = everyone.filter(m => isOnline(m.status)).length;

  function toggleSearch() {
    if (searching) setQuery("");
    setSearching(!searching);
  }

  return <section className="detail-card people-card" aria-label="Pessoas">
    <div className="detail-heading">
      <h2 className="eyebrow">Pessoas · {onlineCount} online</h2>
      <button className="icon-button small" aria-label={searching ? "Fechar busca de pessoas" : "Buscar pessoas"} aria-expanded={searching} onClick={toggleSearch}>{searching ? <X size={16} /> : <Search size={16} />}</button>
    </div>
    {searching && <div className="search-field compact"><Search size={14} /><label className="sr-only" htmlFor="people-search">Buscar pessoas pelo nome</label>
      <input id="people-search" className="search-input" autoFocus placeholder="Buscar pelo nome" value={query}
        onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") toggleSearch(); }} /></div>}
    {error && <p className="inline-error" role="alert">{error} <button className="link-button" onClick={onRetry}>Tentar novamente</button></p>}
    {q && !shown.length && <p className="muted">Ninguém encontrado com esse nome.</p>}
    {!!online.length && <ul className="people-list" aria-label="Pessoas online">
      {online.map(m => <MemberRow key={m.user.id} member={m} room={rooms[m.user.id]} selfId={self.id} />)}
    </ul>}
    {!!offline.length && (q
      // While searching, offline matches are listed like everyone else.
      ? <ul className="people-list" aria-label="Pessoas offline">{offline.map(m => <MemberRow key={m.user.id} member={m} selfId={self.id} />)}</ul>
      : <div className="offline-group">
        <span className="offline-label">Offline · {offline.length}</span>
        <div className="offline-stack" aria-hidden="true">
          {offline.slice(0, OFFLINE_PREVIEW).map(m => <Avatar key={m.user.id} name={m.user.name} src={m.user.avatar} still={m.user.avatarStill} size="sm" />)}
          {offline.length > OFFLINE_PREVIEW && <span className="avatar avatar-sm more-count">+{offline.length - OFFLINE_PREVIEW}</span>}
        </div>
        <button className="link-button" onClick={onShowAll}>Ver todos</button>
      </div>)}
    {loading && !members.length && <p className="muted" role="status">Carregando pessoas…</p>}
  </section>;
}

/** Every member of the server, grouped by role and status. The owner can name moderators. */
export function MembersDialog({ server, self, selfStatus, members, rooms, onClose }: {
  server: Server;
  self: User;
  selfStatus: ChosenStatus;
  members: ServerMember[];
  rooms: RoomPresence;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const isOwner = server.ownerId === self.id;

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  const groups = useMemo(() => {
    const q = normalize(query);
    const shown = withSelf(members, self, selfStatus).filter(m => !q || normalize(m.user.name).includes(q)).sort(byRoleThenName);
    return [
      { id: "owner", title: "Dono", list: shown.filter(m => m.role === "owner") },
      { id: "moderator", title: "Moderadores", list: shown.filter(m => m.role === "moderator") },
      { id: "online", title: "Online", list: shown.filter(m => m.role === "member" && isOnline(m.status)) },
      { id: "offline", title: "Offline", list: shown.filter(m => m.role === "member" && !isOnline(m.status)) },
    ].filter(group => group.list.length);
  }, [members, self, selfStatus, query]);

  async function changeRole(member: ServerMember) {
    setBusy(member.user.id);
    setError("");
    // The list follows the realtime update; the answer only confirms it.
    try { await api.setRole(server.id, member.user.id, member.role === "moderator" ? "member" : "moderator"); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(null); }
  }

  return <dialog ref={ref} className="action-dialog members-dialog" aria-labelledby="members-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="dialog-heading"><h2 id="members-title">Pessoas em {server.name}</h2><button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}><X size={20} /></button></div>
    <div className="search-field"><Search size={16} /><label className="sr-only" htmlFor="members-search">Buscar pessoas</label>
      <input id="members-search" className="search-input" autoFocus placeholder="Buscar pelo nome" value={query} onChange={event => setQuery(event.target.value)} /></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!groups.length && <p className="dialog-empty">Ninguém encontrado com esse nome.</p>}
    {groups.map(group => <div key={group.id} role="group" aria-label={group.title} className="member-group">
      <h3 className="eyebrow">{group.title} · {group.list.length}</h3>
      <ul className="people-list">
        {group.list.map(m => <li key={m.user.id} className={m.status === "offline" ? "is-offline" : undefined}>
          <Avatar name={m.user.name} src={m.user.avatar} still={m.user.avatarStill} status={m.status} />
          <MemberDetails member={m} room={rooms[m.user.id]} selfId={self.id} />
          {isOwner && m.role !== "owner" && <button className="button secondary small" disabled={busy === m.user.id} onClick={() => void changeRole(m)}>
            {m.role === "moderator" ? "Remover moderador" : "Tornar moderador"}
          </button>}
        </li>)}
      </ul>
    </div>)}
  </dialog>;
}

function MemberDetails({ member, room, selfId }: { member: ServerMember; room?: RoomPresence[string]; selfId: string }) {
  const activity = useActivity(member.user.id);
  const text = activityText(member.status, room, activity, member.user.id === selfId ? "Você" : undefined);
  return <div>
    <span className="member-name"><strong><ProfileButton user={member.user} /></strong><RoleBadge role={member.role} /></span>
    {text && <small title={text}>{text}</small>}
  </div>;
}
