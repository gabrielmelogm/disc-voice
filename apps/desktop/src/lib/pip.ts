import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ScreenFeed, VoiceState } from "./voice";

/**
 * Picture-in-picture: minimizing the app (or closing it to the tray) while
 * watching someone's screen in a call shrinks the window into a floating one
 * that keeps showing it (see `src-tauri/src/pip.rs`).
 */

const KEY = "discvoice.voice.pip";
const listeners = new Set<() => void>();

function read() {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
}

let enabled = read();

/** Whether picture-in-picture starts by itself (saved; on by default). */
export function pipEnabled() {
  return enabled;
}

export function setPipEnabled(value: boolean) {
  enabled = value;
  try { localStorage.setItem(KEY, value ? "on" : "off"); } catch { /* Kept for this session only. */ }
  listeners.forEach(listener => listener());
}

export function usePipEnabled() {
  const value = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => enabled);
  return [value, setPipEnabled] as const;
}

/**
 * The screen to float: the one expanded in the call view, else the one
 * shared last. Only screens received, never ours.
 */
export function pipScreen(state: Pick<VoiceState, "remoteScreens" | "focusedScreen" | "participants" | "peerId">): { peerId: string; feed: ScreenFeed } | null {
  const sharing = (peerId: string) => peerId !== state.peerId && state.participants.some(p => p.peerId === peerId && p.screen);
  const focused = state.focusedScreen;
  if (focused && state.remoteScreens[focused] && sharing(focused)) return { peerId: focused, feed: state.remoteScreens[focused] };
  const latest = Object.keys(state.remoteScreens).filter(sharing).at(-1);
  return latest ? { peerId: latest, feed: state.remoteScreens[latest] } : null;
}

/** Tells the app whether minimizing should float a screen now. */
export function syncPipReady(ready: boolean) {
  if (isTauri()) void invoke("set_pip_ready", { ready }).catch(() => {});
}

/** Back to the whole app. */
export function exitPip() {
  if (isTauri()) void invoke("pip_exit").catch(() => {});
}

/** Follows the window going in and out of picture-in-picture. */
export function onPipChanged(listener: (active: boolean) => void) {
  if (!isTauri()) return () => {};
  const stop = listen<boolean>("pip-changed", event => listener(event.payload === true)).catch(() => () => {});
  return () => { void stop.then(unlisten => unlisten()); };
}

/**
 * Keeps the app told whether minimizing should float a screen (the option is
 * on, we are in a call and someone's screen is shown), and whether the window
 * is floating one now. Losing the screen or the call ends picture-in-picture.
 */
export function usePictureInPicture(state: VoiceState) {
  const [enabled] = usePipEnabled();
  const [active, setActive] = useState(false);
  const screen = pipScreen(state);
  const ready = enabled && !!state.channel && state.status !== "error" && !!screen;
  useEffect(() => { syncPipReady(ready); }, [ready]);
  useEffect(() => onPipChanged(setActive), []);
  useEffect(() => () => syncPipReady(false), []);
  return { active: active && !!screen, screen };
}
