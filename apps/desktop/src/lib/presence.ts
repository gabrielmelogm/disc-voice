import type { ChosenStatus, PresenceStatus } from "@disc-voice/shared";

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

export const isOnline = (status: PresenceStatus | undefined) => !!status && status !== "offline";

/** "1 pessoa", "9 pessoas". */
export function peopleCount(count: number) {
  return count === 1 ? "1 pessoa" : `${count} pessoas`;
}
