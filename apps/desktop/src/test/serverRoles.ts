import type { Role, ServerMember } from "@disc-voice/shared";
import { accessOf, rolesOf, type Access, type MemberBadge } from "../lib/roles";
import type { ServerRoles } from "../components/ServerRoles";

/** @everyone of a test server, with what members can do by default. */
export const everyone = (permissions = 2 | 8): Role => ({ id: "server", name: "@everyone", color: null, position: 0, permissions, everyone: true });

export const role = (id: string, name: string, position: number, permissions = 0, color: number | null = null): Role =>
  ({ id, name, color, position, permissions, everyone: false });

/** The roles context of a test server, as the workspace builds it. */
export function serverRoles(selfId: string, members: Pick<ServerMember, "user" | "owner" | "roles">[], roles: Role[] = [everyone()]): ServerRoles {
  const badges: Record<string, MemberBadge> = {};
  const access: Record<string, Access> = {};
  for (const member of members) {
    badges[member.user.id] = { owner: member.owner, roles: rolesOf(member, roles) };
    access[member.user.id] = accessOf(member, roles);
  }
  return { serverId: "server", serverName: "Estúdio", roles, badges, access, self: access[selfId] ?? accessOf(undefined, roles) };
}
