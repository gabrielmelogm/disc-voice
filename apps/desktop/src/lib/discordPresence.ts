import { useEffect, useRef, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { api } from "./api";

/**
 * Rich Presence: the desktop app tells the Discord client running on this
 * computer that the user is in a Disc Voice call ("Disc Voice · Em um canal de
 * voz"). Discord's web API can't set someone's presence, so it goes through
 * Discord's local socket (see `src-tauri/src/discord_rpc.rs`).
 */
export interface CallPresence {
  channel: string;
  server: string;
  /** When the user joined, in milliseconds since the epoch. */
  startedAt: number | null;
}

const KEY = "discvoice.discordPresence";
const listeners = new Set<() => void>();

function readPref(): boolean {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}") as { showCall?: unknown };
    return typeof saved.showCall === "boolean" ? saved.showCall : true;
  } catch { return true; }
}

let showCall = readPref();
let call: CallPresence | null = null;
let sent: string | null = null;
let clientId: Promise<string | null> | null = null;

/** The Discord application of the API, loaded once (and again after a failure). */
function loadClientId() {
  clientId ??= api.discord()
    .then(status => (status.enabled && status.clientId) || null)
    .catch(() => { clientId = null; return null; });
  return clientId;
}

function push() {
  if (!isTauri()) return;
  const presence = showCall ? call : null;
  const key = JSON.stringify(presence);
  if (key === sent) return;
  // Nothing was ever shown: no need to clear or to ask the API.
  if (sent === null && !presence) return;
  sent = key;
  void loadClientId()
    .then(id => invoke("discord_presence", { clientId: id, presence: id ? presence : null }))
    .catch(() => { /* Discord's presence is a nicety; never bother the user. */ });
}

/** Shows (or clears, with null) the call on Discord, if the user allows it. */
export function syncDiscordPresence(next: CallPresence | null) {
  call = next;
  push();
}

export function showCallOnDiscord() {
  return showCall;
}

export function setShowCallOnDiscord(value: boolean) {
  showCall = value;
  try { localStorage.setItem(KEY, JSON.stringify({ showCall: value })); } catch { /* Kept for this session only. */ }
  listeners.forEach(listener => listener());
  push();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useShowCallOnDiscord() {
  const value = useSyncExternalStore(subscribe, () => showCall);
  return [value, setShowCallOnDiscord] as const;
}

/** Keeps Discord in sync with the call the user is in; clears it on logout. */
export function useDiscordCallPresence(current: { channelId: string; channel: string; server: string } | null) {
  const joined = useRef<{ channelId: string; at: number } | null>(null);
  if (current && joined.current?.channelId !== current.channelId) joined.current = { channelId: current.channelId, at: Date.now() };
  if (!current) joined.current = null;
  const startedAt = joined.current?.at ?? null;
  const channel = current?.channel ?? null;
  const server = current?.server ?? "";
  useEffect(() => {
    syncDiscordPresence(channel === null ? null : { channel, server, startedAt });
  }, [channel, server, startedAt]);
  useEffect(() => () => syncDiscordPresence(null), []);
}

/** For tests: forget what was sent and the loaded application. */
export function resetDiscordPresence() {
  call = null;
  sent = null;
  clientId = null;
  showCall = readPref();
}
