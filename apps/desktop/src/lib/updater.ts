import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { Realtime } from "./realtime";

// Self-update. The app only learns that a version exists: the API announces
// it over the realtime connection when a release is published (`app.update`),
// and the app also asks the website at start-up and every few hours, for
// those who were offline. Nothing is downloaded until the user clicks the
// discreet button in the app bar: only then does tauri-plugin-updater ask
// the website's /api/update route, which signs a short-lived link to the
// installer. The download's signature is checked against the public key in
// tauri.conf.json before installing, and the app relaunches.

export const SITE_URL = "https://get-discvoice.devgabrielmelo.shop";

export type UpdateChannel = "alpha" | "beta" | "stable";

export const UPDATE_CHANNELS: { value: UpdateChannel; label: string; hint: string }[] = [
  { value: "stable", label: "Estável", hint: "Só versões testadas" },
  { value: "beta", label: "Beta", hint: "Novidades antes, quase prontas" },
  { value: "alpha", label: "Alpha", hint: "Tudo primeiro, pode ter falhas" },
];

export type UpdateStatus = "idle" | "available" | "downloading" | "installing" | "error";

export interface UpdateState {
  status: UpdateStatus;
  /** The newer version, once one is known. */
  version: string | null;
  notes: string;
  date: string | null;
  downloaded: number;
  total: number | null;
  error: string;
  /** When the last look for a version finished. */
  checkedAt: number | null;
}

const KEY = "discvoice.updates";
/** How often the app asks the website, for those who missed the announcement. */
export const CHECK_INTERVAL = 4 * 60 * 60 * 1000;
/** Lets the app settle (login, realtime) before the first look. */
export const FIRST_CHECK_DELAY = 10 * 1000;
/** Spreads the requests of every open app after an announcement. */
export const ANNOUNCEMENT_JITTER = 20 * 1000;

const initial: UpdateState = {
  status: "idle", version: null, notes: "", date: null, downloaded: 0, total: null, error: "", checkedAt: null,
};

let state = initial;
let looking: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(change: Partial<UpdateState>) {
  state = { ...state, ...change };
  listeners.forEach(listener => listener());
}

export function updateState() {
  return state;
}

export function useUpdateState() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state);
}

/** Compares two semver versions; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string) {
  const parse = (version: string) => {
    const [core = "", pre] = version.trim().replace(/^v/, "").split("+")[0]!.split(/-(.*)/s);
    return { core: core.split(".").map(part => Number(part) || 0), pre: pre ? pre.split(".") : [] };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  if (!left.pre.length || !right.pre.length) return Math.sign(right.pre.length - left.pre.length);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const diff = numeric ? Number(x) - Number(y) : /^\d+$/.test(x) ? -1 : /^\d+$/.test(y) ? 1 : x.localeCompare(y);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

/** The channel of a version: "0.1.0-alpha.3" is alpha, "1.0.0" stable. */
export function channelOf(version: string): UpdateChannel {
  const pre = version.split("+")[0]!.split("-").slice(1).join("-").toLowerCase();
  if (!pre) return "stable";
  return pre.startsWith("alpha") ? "alpha" : "beta";
}

function savedChannel(): UpdateChannel | null {
  try {
    const value = (JSON.parse(localStorage.getItem(KEY) || "{}") as { channel?: unknown }).channel;
    return UPDATE_CHANNELS.some(option => option.value === value) ? value as UpdateChannel : null;
  } catch { return null; }
}

let channelValue = savedChannel();
const channelListeners = new Set<() => void>();

/** The chosen channel; until the user picks one, the channel of the installed version. */
export function updateChannel(version: string) {
  return channelValue ?? channelOf(version);
}

export function setUpdateChannel(channel: UpdateChannel) {
  channelValue = channel;
  try { localStorage.setItem(KEY, JSON.stringify({ channel })); } catch { /* Kept for this session only. */ }
  channelListeners.forEach(listener => listener());
}

export function useUpdateChannel() {
  const version = useAppVersion();
  const chosen = useSyncExternalStore(
    listener => { channelListeners.add(listener); return () => { channelListeners.delete(listener); }; },
    () => channelValue,
  );
  return [chosen ?? (version ? channelOf(version) : "stable"), setUpdateChannel] as const;
}

export function useAppVersion() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (isTauri()) void getVersion().then(value => { if (live) setVersion(value); }, () => {});
    return () => { live = false; };
  }, []);
  return version;
}

/**
 * This install's update platform ("windows-x86_64"), or null when it does not
 * update itself (in a browser, a dev build or a .deb/.rpm).
 */
export function updaterPlatform() {
  return isTauri()
    ? invoke<string | null>("updater_platform").then(value => (typeof value === "string" && value ? value : null), () => null)
    : Promise.resolve(null);
}

export function useUpdaterSupported() {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let live = true;
    void updaterPlatform().then(value => { if (live) setSupported(!!value); });
    return () => { live = false; };
  }, []);
  return supported;
}

interface Latest { version?: unknown; notes?: unknown; pub_date?: unknown; platforms?: unknown }

async function look() {
  const platform = await updaterPlatform();
  if (!platform) return;
  // The user is already updating: keep what they see.
  if (state.status === "downloading" || state.status === "installing") return;
  const current = await getVersion();
  const channel = updateChannel(current);
  let latest: Latest | null = null;
  try {
    const response = await fetch(`${SITE_URL}/api/update/latest?channel=${channel}`, { cache: "no-store" });
    if (response.status === 200) latest = await response.json() as Latest;
    else if (response.status !== 204) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    // Offline or the site is down: keep whatever was shown.
    console.warn("Could not look for updates.", error);
    return;
  }
  const version = typeof latest?.version === "string" ? latest.version : null;
  const forHere = Array.isArray(latest?.platforms) && latest.platforms.includes(platform);
  if (!version || !forHere || compareVersions(version, current) <= 0) {
    set({ ...initial, checkedAt: Date.now() });
    return;
  }
  set({
    status: "available", version, error: "", checkedAt: Date.now(),
    notes: typeof latest?.notes === "string" ? latest.notes.trim() : "",
    date: typeof latest?.pub_date === "string" ? latest.pub_date : null,
  });
}

/** Looks for a newer version, without downloading. Calls while one runs share it. */
export function lookForUpdates() {
  looking ??= look().catch(error => { console.warn("Update look-up failed.", error); }).finally(() => { looking = null; });
  return looking;
}

function errorText(error: unknown) {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /signature/i.test(text)
    ? "A assinatura da atualização não confere. Ela foi descartada."
    : "Não foi possível baixar a atualização. Tente de novo em instantes.";
}

/**
 * Runs when the user clicks to update: only now the website signs a link to
 * the installer. Downloads it with progress (a call keeps going meanwhile),
 * runs `beforeInstall` (leaving the call), installs and relaunches. On
 * Windows the installer itself closes the app.
 */
export async function installUpdate(beforeInstall: () => void | Promise<void> = () => {}) {
  if (state.status !== "available" && state.status !== "error") return false;
  set({ status: "downloading", downloaded: 0, total: null, error: "" });
  try {
    const current = await getVersion();
    const update = await check({ headers: { "X-Update-Channel": updateChannel(current) }, timeout: 30_000 });
    if (!update) {
      // Withdrawn after the notice.
      set({ ...initial, checkedAt: Date.now() });
      return false;
    }
    set({ version: update.version, notes: update.body?.trim() || state.notes });
    await update.download(event => {
      if (event.event === "Started") set({ total: event.data.contentLength ?? null, downloaded: 0 });
      else if (event.event === "Progress") set({ downloaded: state.downloaded + event.data.chunkLength });
    });
    set({ status: "installing" });
    await beforeInstall();
    await update.install();
    await relaunch();
    return true;
  } catch (error) {
    console.warn("Could not update.", error);
    set({ status: "error", error: errorText(error) });
    return false;
  }
}

/** Reacts to the API's announcement: a version on the user's channel. */
async function announced(version: string, channels: string[]) {
  const current = await getVersion().catch(() => null);
  if (!current || !channels.includes(updateChannel(current)) || compareVersions(version, current) <= 0) return;
  if (state.version && compareVersions(version, state.version) <= 0) return;
  // Every open app hears it at once; spread the requests to the website.
  setTimeout(() => void lookForUpdates(), Math.random() * ANNOUNCEMENT_JITTER);
}

/**
 * Looks after start-up and every few hours, when the channel changes and
 * when the API announces a release.
 */
export function useUpdateChecks(realtime?: Realtime) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      timer = setTimeout(() => { void lookForUpdates().finally(() => schedule(CHECK_INTERVAL)); }, delay);
    };
    schedule(FIRST_CHECK_DELAY);
    const onChannel = () => { void lookForUpdates(); };
    channelListeners.add(onChannel);
    const stop = realtime?.onEvent(event => {
      if (event.type === "app.update") void announced(event.version, event.channels);
    });
    return () => { clearTimeout(timer); channelListeners.delete(onChannel); stop?.(); };
  }, [realtime]);
}
