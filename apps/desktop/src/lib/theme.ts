import { useEffect, useSyncExternalStore } from "react";

export type Appearance = "light" | "dark" | "system";

const KEY = "discvoice.appearance";
const listeners = new Set<() => void>();

function read(): Appearance {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" || value === "system" ? value : "system";
  } catch { return "system"; }
}

let current = read();

function systemDark() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Applies the resolved theme to <html data-theme> so the CSS tokens switch. */
export function applyAppearance(value: Appearance = current) {
  const dark = value === "dark" || (value === "system" && systemDark());
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function setAppearance(value: Appearance) {
  current = value;
  try { localStorage.setItem(KEY, value); } catch { /* Preference is per session only. */ }
  applyAppearance(value);
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useAppearance() {
  const value = useSyncExternalStore(subscribe, () => current);
  useEffect(() => {
    if (value !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const change = () => applyAppearance("system");
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, [value]);
  return [value, setAppearance] as const;
}
