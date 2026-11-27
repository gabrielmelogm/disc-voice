import { PERMISSIONS, type Permission, type Role, type ServerMember } from "@disc-voice/shared";

/** The toggles of a role, in the order shown, with what each one allows. */
export const PERMISSION_OPTIONS: { id: Permission; label: string; description: string }[] = [
  { id: "manageServer", label: "Gerenciar servidor", description: "Permite que os membros mudem o nome e a descrição do servidor." },
  { id: "manageChannels", label: "Gerenciar canais", description: "Permite que os membros criem canais de texto e salas de voz." },
  { id: "manageRoles", label: "Gerenciar cargos", description: "Permite que os membros criem, editem e excluam cargos abaixo do cargo mais alto deles, e os deem a outros membros." },
  { id: "createInvite", label: "Criar convite", description: "Permite que os membros vejam e compartilhem o link de convite do servidor." },
  { id: "manageMessages", label: "Gerenciar mensagens", description: "Permite que os membros excluam mensagens de outras pessoas nos canais do servidor." },
  { id: "mentionEveryone", label: "Mencionar @everyone", description: "Permite que os membros usem @everyone para avisar todo mundo do servidor." },
  { id: "banMembers", label: "Banir membros", description: "Permite que os membros banam e desbanam pessoas com cargos abaixo do deles." },
];

/** What someone may do in a server. */
export interface Access {
  owner: boolean;
  permissions: number;
  /** Position of their highest role (0: only @everyone). */
  top: number;
}

export const NO_ACCESS: Access = { owner: false, permissions: 0, top: 0 };

/** A member's place in the server: the owner flag and their roles, highest first. */
export interface MemberBadge {
  owner: boolean;
  roles: Role[];
}

/** The member's roles (without @everyone), highest first. */
export function rolesOf(member: Pick<ServerMember, "roles"> | undefined, roles: Role[]): Role[] {
  if (!member) return [];
  return roles.filter(role => !role.everyone && member.roles.includes(role.id)).sort((a, b) => b.position - a.position);
}

/** What a member may do, from @everyone and their roles; the owner may do everything. */
export function accessOf(member: Pick<ServerMember, "owner" | "roles"> | undefined, roles: Role[]): Access {
  if (!member) return NO_ACCESS;
  if (member.owner) return { owner: true, permissions: Object.values(PERMISSIONS).reduce((all, bit) => all | bit, 0), top: Number.MAX_SAFE_INTEGER };
  const held = roles.filter(role => role.everyone || member.roles.includes(role.id));
  return {
    owner: false,
    permissions: held.reduce((all, role) => all | role.permissions, 0),
    top: Math.max(0, ...held.map(role => role.position)),
  };
}

export function can(access: Access, permission: Permission) {
  return access.owner || (access.permissions & PERMISSIONS[permission]) !== 0;
}

/** Whether a role at this position is below the member's highest one. */
export function outranksRole(access: Access, position: number) {
  return access.owner || position < access.top;
}

/** Whether the member outranks someone else (nobody outranks the owner). */
export function outranks(access: Access, other: Access) {
  return !other.owner && outranksRole(access, other.top);
}

/** Only the owner hands out or takes away permissions they lack. */
export function canChange(access: Access, before: number, after: number) {
  return access.owner || ((before ^ after) & ~access.permissions) === 0;
}

export function hasBit(permissions: number, permission: Permission) {
  return (permissions & PERMISSIONS[permission]) !== 0;
}

export function toggleBit(permissions: number, permission: Permission, on: boolean) {
  return on ? permissions | PERMISSIONS[permission] : permissions & ~PERMISSIONS[permission];
}

/** `#rrggbb` of a role color. */
export function colorHex(color: number) {
  return `#${color.toString(16).padStart(6, "0")}`;
}

export function parseColor(hex: string): number | null {
  return /^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : null;
}

/** The name color of a member: their highest role that has one. */
export function nameColor(badge: MemberBadge | undefined) {
  const color = badge?.roles.find(role => role.color !== null)?.color;
  return color === undefined || color === null ? undefined : colorHex(color);
}

/** Colors offered for a role, as in the design system palette. */
export const ROLE_COLORS = [0x5865f2, 0x2ecc71, 0x1abc9c, 0x3498db, 0x9b59b6, 0xe91e63, 0xf1c40f, 0xe67e22, 0xe74c3c, 0x95a5a6];
