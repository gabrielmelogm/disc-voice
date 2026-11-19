import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface WindowPrefs {
  /** The close button hides the app in the system tray instead of quitting. */
  closeToTray: boolean;
}

export interface TrayStatus {
  /** Voice channel the user is in, if any. */
  call: string | null;
  muted: boolean;
  /** Most recently used first. */
  recent: { id: string; name: string }[];
}

const KEY = "discvoice.window";
const RECENT_KEY = "discvoice.recentServers";
export const MAX_RECENT = 5;
const defaults: WindowPrefs = { closeToTray: true };
const listeners = new Set<() => void>();

function read(): WindowPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Record<keyof WindowPrefs, unknown>>;
    return { closeToTray: typeof saved.closeToTray === "boolean" ? saved.closeToTray : defaults.closeToTray };
  } catch { return { ...defaults }; }
}

let support: Promise<boolean> | null = null;

/** Whether the app can live in the system tray (Windows only for now). */
export function traySupported() {
  support ??= isTauri() ? invoke<boolean>("tray_supported").then(value => value === true, () => false) : Promise.resolve(false);
  return support;
}

export function useTraySupported() {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let live = true;
    void traySupported().then(value => { if (live) setSupported(value); });
    return () => { live = false; };
  }, []);
  return supported;
}

/** Calls the tray backend; where there is no tray, or if it fails, nothing happens. */
function call(command: string, args: Record<string, unknown>) {
  void traySupported().then(supported => supported ? invoke(command, args) : undefined).catch(() => {});
}

let current = read();
// The backend starts with the default; tell it what the user chose.
call("set_close_to_tray", { enabled: current.closeToTray });

export function windowPrefs() {
  return current;
}

export function setWindowPrefs(change: Partial<WindowPrefs>) {
  current = { ...current, ...change };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* Preference is per session only. */ }
  call("set_close_to_tray", { enabled: current.closeToTray });
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useWindowPrefs() {
  const value = useSyncExternalStore(subscribe, () => current);
  return [value, setWindowPrefs] as const;
}

function recentIds(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]") as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

/** Puts a server first in the recently used list. */
export function rememberServer(id: string) {
  const ids = [id, ...recentIds().filter(other => other !== id)].slice(0, MAX_RECENT);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(ids)); } catch { /* Kept for this session only. */ }
}

/** The recently used servers the user still has, most recent first. */
export function recentServers(servers: { id: string; name: string }[]) {
  return recentIds()
    .map(id => servers.find(server => server.id === id))
    .filter(server => server !== undefined)
    .map(server => ({ id: server.id, name: server.name }));
}

/** Updates the tray icon (in a call or not) and its right-click menu. */
export function syncTray(status: TrayStatus) {
  call("set_tray_status", { status });
}

/** Runs the actions picked in the tray menu; returns a function that stops listening. */
export function onTrayAction(actions: { openServer: (id: string) => void; toggleMute: () => void }) {
  // Without a tray these events never come; listening is harmless.
  if (!isTauri()) return () => {};
  const stops = [
    listen<string>("tray-open-server", event => actions.openServer(event.payload)),
    listen("tray-toggle-mute", () => actions.toggleMute()),
  ].map(listening => listening.catch(() => () => {}));
  return () => { stops.forEach(stop => void stop.then(unlisten => unlisten())); };
}
