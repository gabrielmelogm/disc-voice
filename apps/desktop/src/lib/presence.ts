import type { ChosenStatus, MemberRole, PresenceStatus } from "@disc-voice/shared";

export const STATUS_LABELS: Record<PresenceStatus, string> = {
  online: "Online",
  idle: "Ausente",
  dnd: "Não perturbe",
  offline: "Offline",
};

/** Statuses the user can pick, in menu order. */
export const CHOSEN_STATUSES: { value: ChosenStatus; label: string; hint: string }[] = [
  { value: "online", label: "Online", hint: "Fica ausente sozinho depois de um tempo sem uso" },
  { value: "idle", label: "Ausente", hint: "Mostra que você não está por perto" },
  { value: "dnd", label: "Não perturbe", hint: "Mostra que você não quer ser interrompido" },
];

/** Badge text for a role; plain members have none. */
export function roleLabel(role: MemberRole | undefined) {
  return role === "owner" ? "Dono" : role === "moderator" ? "Moderador" : null;
}

/** Order in the people list: owner, moderators, then everyone else. */
export const ROLE_RANK: Record<MemberRole, number> = { owner: 0, moderator: 1, member: 2 };

export const isOnline = (status: PresenceStatus | undefined) => !!status && status !== "offline";

/** "1 pessoa", "9 pessoas". */
export function peopleCount(count: number) {
  return count === 1 ? "1 pessoa" : `${count} pessoas`;
}
