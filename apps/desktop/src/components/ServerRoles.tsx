import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Ban, Crown } from "lucide-react";
import type { Permission, Role, User } from "@disc-voice/shared";
import { api, message } from "../lib/api";
import { can, colorHex, NO_ACCESS, outranks, type Access, type MemberBadge } from "../lib/roles";
import { Avatar } from "./ui";

/** The open server's roles and what the user may do there; empty outside a server. */
export interface ServerRoles {
  serverId: string | null;
  serverName: string;
  roles: Role[];
  /** Each member's owner flag and roles, by user id. */
  badges: Record<string, MemberBadge>;
  /** Each member's access, by user id. */
  access: Record<string, Access>;
  /** The signed-in user's access. */
  self: Access;
}

const EMPTY: ServerRoles = { serverId: null, serverName: "", roles: [], badges: {}, access: {}, self: NO_ACCESS };
const Context = createContext<ServerRoles>(EMPTY);

export function ServerRolesProvider({ value, children }: { value: ServerRoles | null; children: ReactNode }) {
  return <Context.Provider value={value ?? EMPTY}>{children}</Context.Provider>;
}

export const useServerRoles = () => useContext(Context);

/** Whether the user may do this in the open server. */
export function useCan(permission: Permission) {
  const { serverId, self } = useServerRoles();
  return !!serverId && can(self, permission);
}

/** Whether the user may ban this person from the open server. */
export function useCanBan(userId: string) {
  const { serverId, self, access } = useServerRoles();
  const other = access[userId];
  return !!serverId && !!other && can(self, "banMembers") && outranks(self, other);
}

export function OwnerBadge() {
  return <span className="role-badge role-owner" title="Dono do servidor"><Crown size={11} aria-hidden="true" />Dono</span>;
}

export function RoleChip({ role }: { role: Pick<Role, "name" | "color"> }) {
  return <span className="role-badge role-chip" title={role.name}>
    <span className="role-dot" style={role.color !== null ? { background: colorHex(role.color) } : undefined} aria-hidden="true" />{role.name}
  </span>;
}

/** The owner badge and the highest role, next to a name. */
export function TopRoleBadge({ badge }: { badge: MemberBadge | undefined }) {
  if (!badge) return null;
  if (badge.owner) return <OwnerBadge />;
  return badge.roles[0] ? <RoleChip role={badge.roles[0]} /> : null;
}

/** Every role of a member, as on the profile card. */
export function RoleBadges({ badge, label = "Cargos" }: { badge: MemberBadge | undefined; label?: string }) {
  if (!badge || (!badge.owner && !badge.roles.length)) return null;
  return <ul className="role-badges" aria-label={label}>
    {badge.owner && <li><OwnerBadge /></li>}
    {badge.roles.map(role => <li key={role.id}><RoleChip role={role} /></li>)}
  </ul>;
}

/** Asks for an optional reason before banning someone from the server. */
export function BanDialog({ serverId, serverName, user, onClose, onBanned }: {
  serverId: string; serverName: string; user: User; onClose: () => void; onBanned?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  async function confirm() {
    setBusy(true);
    setError("");
    try { await api.ban(serverId, user.id, reason.trim()); onBanned?.(); onClose(); }
    catch (cause) { setError(message(cause)); setBusy(false); }
  }

  return <dialog ref={ref} className="action-dialog" aria-labelledby="ban-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <form method="dialog" onSubmit={event => { event.preventDefault(); void confirm(); }}>
      <div className="dialog-heading"><h2 id="ban-title">Banir {user.name}</h2></div>
      <p className="lede">{user.name} sai de {serverName} na hora e não consegue voltar pelo convite até ser desbanido.</p>
      <blockquote className="delete-preview"><Avatar name={user.name} src={user.avatar} still={user.avatarStill} size="sm" /><span>{user.name}</span></blockquote>
      <div className="field"><label htmlFor="ban-reason">Motivo (opcional)</label>
        <input id="ban-reason" autoFocus maxLength={512} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} placeholder="Ex.: spam no chat" /></div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="button secondary" onClick={onClose}>Cancelar</button>
        <button type="submit" className="button danger" disabled={busy}><Ban size={16} />{busy ? "Banindo…" : "Banir"}</button>
      </div>
    </form>
  </dialog>;
}
