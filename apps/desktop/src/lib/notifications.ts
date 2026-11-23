import { useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { initials } from "./display";

export interface NotificationPrefs {
  /** Native OS notifications while the window is in the background. */
  desktop: boolean;
  /** Sound when a message arrives. */
  messageSounds: boolean;
  /**
   * Alert when someone enters a voice channel of your servers while you are not in a call;
   * in a call, only a sound when someone connects to yours.
   */
  voiceJoin: boolean;
}

const KEY = "discvoice.notifications";
const SOUND_URL = "/songs/notification.mp3";
const VOICE_CONNECT_URL = "/songs/user-voicecall-connect.mp3";
const MIC_URL = "/songs/mic-control-notification.mp3";
const SCREEN_URL = "/songs/share-media-voicecall-notification.mp3";
const LEAVE_URL = "/songs/notification-beep.mp3";
/** Bursts (several messages at once) play the sound only once. */
const SOUND_GAP_MS = 750;
const defaults: NotificationPrefs = { desktop: true, messageSounds: true, voiceJoin: true };
const listeners = new Set<() => void>();

function read(): NotificationPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Record<keyof NotificationPrefs, unknown>>;
    const pick = (key: keyof NotificationPrefs) => typeof saved[key] === "boolean" ? saved[key] as boolean : defaults[key];
    return { desktop: pick("desktop"), messageSounds: pick("messageSounds"), voiceJoin: pick("voiceJoin") };
  } catch { return { ...defaults }; }
}

let current = read();

export function notificationPrefs() {
  return current;
}

export function setNotificationPrefs(change: Partial<NotificationPrefs>) {
  current = { ...current, ...change };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* Preference is per session only. */ }
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useNotificationPrefs() {
  const value = useSyncExternalStore(subscribe, () => current);
  return [value, setNotificationPrefs] as const;
}

const sounds = new Map<string, { audio: HTMLAudioElement | null; last: number }>();

function playSound(url: string, gap = SOUND_GAP_MS) {
  const sound = sounds.get(url) ?? { audio: null, last: -Infinity };
  sounds.set(url, sound);
  const now = Date.now();
  if (now - sound.last < gap) return;
  sound.last = now;
  try {
    const audio = sound.audio ??= new Audio(url);
    let output = "";
    try { output = localStorage.getItem("discvoice.voice.output") || ""; } catch { /* Default output. */ }
    // Follow the output chosen for calls; if that device is gone, the default one plays it.
    if (output && "setSinkId" in audio) void audio.setSinkId(output).catch(() => {});
    audio.currentTime = 0;
    void audio.play()?.catch(() => {});
  } catch { /* Sounds are best effort. */ }
}

export function playNotificationSound() {
  playSound(SOUND_URL);
}

/** Someone connected to the call we are in. */
export function playVoiceConnectSound() {
  playSound(VOICE_CONNECT_URL);
}

/** We muted or unmuted ourselves: every click answers, so no throttle (it restarts instead). */
export function playMicSound() {
  playSound(MIC_URL, 0);
}

/** We started or stopped sharing the screen in a call. */
export function playScreenSound() {
  playSound(SCREEN_URL, 0);
}

/** We left the call. */
export function playLeaveSound() {
  playSound(LEAVE_URL, 0);
}

async function allowed() {
  if (await isPermissionGranted()) return true;
  return await requestPermission() === "granted";
}

/** Asks the OS for permission; called when the user turns desktop notifications on. */
export async function requestDesktopPermission() {
  if (!isTauri()) return false;
  try { return await allowed(); } catch { return false; }
}

const AVATAR_SIZE = 128;
const AVATAR_BACKGROUND = "#6410c9";
const AVATAR_INK = "#ffffff";

/** A round avatar with the person's initials, the same look as in the app, as PNG bytes. */
export async function avatarPng(name: string) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = AVATAR_SIZE;
  let context: CanvasRenderingContext2D | null = null;
  try { context = canvas.getContext("2d"); } catch { /* No canvas support. */ }
  if (!context) return null;
  const text = initials(name);
  context.fillStyle = AVATAR_BACKGROUND;
  context.beginPath();
  context.arc(AVATAR_SIZE / 2, AVATAR_SIZE / 2, AVATAR_SIZE / 2, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = AVATAR_INK;
  context.font = `800 ${AVATAR_SIZE * 0.4}px "Segoe UI", system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, AVATAR_SIZE / 2, AVATAR_SIZE / 2 + AVATAR_SIZE * 0.02);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
  if (!blob) return null;
  const png = Array.from(new Uint8Array(await blob.arrayBuffer()));
  // The key names what the picture shows, so the app can reuse the saved file.
  const key = Array.from(text, char => char.codePointAt(0)!.toString(16)).join("-");
  return { key: `${key}-${AVATAR_BACKGROUND.slice(1)}`, png };
}

/** Shows an OS notification; `from` is whose avatar goes beside the text. */
export async function showDesktopNotification(title: string, body: string, from?: string) {
  if (!isTauri()) return;
  try {
    if (!await allowed()) return;
    const avatar = from ? await avatarPng(from).catch(() => null) : null;
    try {
      await invoke("show_notification", { title, body, avatar });
    } catch {
      sendNotification({ title, body });
    }
  } catch { /* Notifications are best effort. */ }
}

/** Test hook: forgets the throttles and the cached audio elements. */
export function resetNotificationSound() {
  sounds.clear();
}
