import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Ban, Search, Tags, X } from "lucide-react";
import type { Activity, Channel, ChosenStatus, PresenceStatus, Server, ServerMember, User } from "@disc-voice/shared";
import { activityLabel } from "../lib/activity";
import { api, message } from "../lib/api";
import { isOnline, STATUS_LABELS } from "../lib/presence";
import { can, outranksRole, type MemberBadge } from "../lib/roles";
import { ProfileButton, useActivity, useUserMenu } from "./ProfileCard";
import { BanDialog, TopRoleBadge, useCanBan, useServerRoles } from "./ServerRoles";
import { Avatar } from "./ui";

/** Where each person is in a voice room of the server, by user id. */
export type RoomPresence = Record<string, { channel: Channel; screen: boolean }>;

/** At most this many offline people show as avatars in the offline row. */
const OFFLINE_PREVIEW = 6;

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

/** Owner first, then by highest role, then by name. */
function byRank(badges: Record<string, MemberBadge>) {
  const rank = (m: ServerMember) => m.owner ? Number.MAX_SAFE_INTEGER : badges[m.user.id]?.roles[0]?.position ?? 0;
  return (a: ServerMember, b: ServerMember) => rank(b) - rank(a) || a.user.name.localeCompare(b.user.name, "pt-BR");
}

/** Members with the user's own status as they chose it, which is newer than the server's copy. */
function withSelf(members: ServerMember[], self: User, selfStatus: ChosenStatus): ServerMember[] {
  if (!members.some(m => m.user.id === self.id)) return members;
  return members.map(m => m.user.id === self.id ? { ...m, user: self, status: selfStatus } : m);
}

/** `children`: actions shown at the end of the row. Right-clicking the row opens the user menu. */
function MemberRow({ member, room, selfId, children }: { member: ServerMember; room?: RoomPresence[string]; selfId: string; children?: ReactNode }) {
  const menu = useUserMenu();
  return <li className={member.status === "offline" ? "is-offline" : undefined} onContextMenu={event => menu.open(event, member.user)}>
    <Avatar name={member.user.name} src={member.user.avatar} still={member.user.avatarStill} status={member.status} />
    <MemberDetails member={member} room={room} selfId={selfId} />
    {children}
    {menu.element}
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
  const { badges } = useServerRoles();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  // Until the list arrives, at least the user is shown.
  const everyone = members.length ? withSelf(members, self, selfStatus) : [{ user: self, owner: false, roles: [], status: selfStatus, joinedAt: "" }];
  const q = normalize(query);
  const shown = q ? everyone.filter(m => normalize(m.user.name).includes(q)) : everyone;
  const order = byRank(badges);
  const online = shown.filter(m => isOnline(m.status)).sort(order);
  const offline = shown.filter(m => !isOnline(m.status)).sort(order);
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
      : <button type="button" className="offline-group" aria-label={`Ver todas as pessoas (${offline.length} offline)`} onClick={onShowAll}>
        <span className="offline-label">Offline · {offline.length}</span>
        <div className="offline-stack" aria-hidden="true">
          {offline.slice(0, OFFLINE_PREVIEW).map(m => <Avatar key={m.user.id} name={m.user.name} src={m.user.avatar} still={m.user.avatarStill} size="sm" />)}
          {offline.length > OFFLINE_PREVIEW && <span className="avatar avatar-sm more-count">+{offline.length - OFFLINE_PREVIEW}</span>}
        </div>
      </button>)}
    {loading && !members.length && <p className="muted" role="status">Carregando pessoas…</p>}
  </section>;
}

/**
 * Every member of the server, grouped by highest role, then by status.
 * Who manages roles gives and takes away roles below theirs; who bans
 * removes people below them.
 */
export function MembersDialog({ server, self, selfStatus, members, rooms, onClose }: {
  server: Server;
  self: User;
  selfStatus: ChosenStatus;
  members: ServerMember[];
  rooms: RoomPresence;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { roles, badges, self: access } = useServerRoles();
  const [query, setQuery] = useState("");
  const [banning, setBanning] = useState<User | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  const groups = useMemo(() => {
    const q = normalize(query);
    const shown = withSelf(members, self, selfStatus).filter(m => !q || normalize(m.user.name).includes(q)).sort(byRank(badges));
    const top = (m: ServerMember) => badges[m.user.id]?.roles[0]?.id;
    const plain = shown.filter(m => !m.owner && !top(m));
    return [
      { id: "owner", title: "Dono", list: shown.filter(m => m.owner) },
      ...roles.filter(role => !role.everyone).map(role => ({ id: role.id, title: role.name, list: shown.filter(m => !m.owner && top(m) === role.id) })),
      { id: "online", title: "Online", list: plain.filter(m => isOnline(m.status)) },
      { id: "offline", title: "Offline", list: plain.filter(m => !isOnline(m.status)) },
    ].filter(group => group.list.length);
  }, [members, self, selfStatus, query, roles, badges]);

  const assignable = can(access, "manageRoles") ? roles.filter(role => !role.everyone && outranksRole(access, role.position)) : [];

  return <dialog ref={ref} className="action-dialog members-dialog" aria-labelledby="members-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="dialog-heading"><h2 id="members-title">Pessoas em {server.name}</h2><button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}><X size={20} /></button></div>
    <div className="search-field"><Search size={16} /><label className="sr-only" htmlFor="members-search">Buscar pessoas</label>
      <input id="members-search" className="search-input" autoFocus placeholder="Buscar pelo nome" value={query} onChange={event => setQuery(event.target.value)} /></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!groups.length && <p className="dialog-empty">Ninguém encontrado com esse nome.</p>}
    {groups.map(group => <div key={group.id} role="group" aria-label={group.title} className="member-group">
      <h3 className="eyebrow">{group.title} · {group.list.length}</h3>
      <ul className="people-list">
        {group.list.map(m => <MemberRow key={m.user.id} member={m} room={rooms[m.user.id]} selfId={self.id}>
          <MemberActions server={server} member={m} assignable={assignable} onBan={setBanning} onError={setError} />
        </MemberRow>)}
      </ul>
    </div>)}
    {banning && <BanDialog serverId={server.id} serverName={server.name} user={banning} onClose={() => setBanning(null)} />}
  </dialog>;
}

/** Roles to give or take away, and banning, for one member. */
function MemberActions({ server, member, assignable, onBan, onError }: {
  server: Server;
  member: ServerMember;
  assignable: { id: string; name: string }[];
  onBan: (user: User) => void;
  onError: (error: string) => void;
}) {
  const canBan = useCanBan(member.user.id);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  async function toggle(roleId: string, give: boolean) {
    setBusy(roleId);
    onError("");
    // The list follows the realtime update; the answer only confirms it.
    try { await api.assignRole(server.id, member.user.id, roleId, give); }
    catch (cause) { onError(message(cause)); }
    finally { setBusy(null); }
  }

  if (member.owner || (!assignable.length && !canBan)) return null;
  return <div className="member-actions" ref={menu}>
    {!!assignable.length && <button type="button" className="icon-button small" aria-label={`Cargos de ${member.user.name}`} title="Cargos"
      aria-expanded={open} onClick={() => setOpen(!open)}><Tags size={16} /></button>}
    {canBan && <button type="button" className="icon-button small danger" aria-label={`Banir ${member.user.name}`} title="Banir"
      onClick={() => onBan(member.user)}><Ban size={16} /></button>}
    {open && <div className="role-menu" role="group" aria-label={`Cargos de ${member.user.name}`}>
      {assignable.map(role => <label key={role.id}>
        <input type="checkbox" checked={member.roles.includes(role.id)} disabled={busy === role.id}
          onChange={event => void toggle(role.id, event.target.checked)} />{role.name}
      </label>)}
    </div>}
  </div>;
}

function MemberDetails({ member, room, selfId }: { member: ServerMember; room?: RoomPresence[string]; selfId: string }) {
  const activity = useActivity(member.user.id);
  const { badges } = useServerRoles();
  const text = activityText(member.status, room, activity, member.user.id === selfId ? "Você" : undefined);
  return <div>
    <span className="member-name"><strong><ProfileButton user={member.user} /></strong><TopRoleBadge badge={badges[member.user.id]} /></span>
    {text && <small title={text}>{text}</small>}
  </div>;
}
