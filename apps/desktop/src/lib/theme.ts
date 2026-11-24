import { useEffect, useSyncExternalStore } from "react";

/** A built-in theme, or `theme:<id>` for an imported one. */
export type Appearance = "light" | "dark" | "system" | `theme:${string}`;
export type ThemeBase = "light" | "dark";

/**
 * Color tokens of the design system that a theme may change. Keep the values
 * in sync with `:root` and `[data-theme="dark"]` in styles.css.
 */
const LIGHT = {
  "brand": "#6410c9", "brand-hover": "#5209a8", "brand-text": "#6410c9", "brand-soft": "#f0e7fc", "on-brand": "#ffffff",
  "surface": "#ffffff", "surface-sunken": "#f4f4f6", "surface-raised": "#ffffff",
  "fill": "#e9e9e9", "fill-hover": "#dcdce0", "line": "#e9e9e9",
  "ink": "#17141f", "ink-muted": "#4f4b5c", "ink-subtle": "#67637a",
  "focus": "#6410c9",
  "online": "#23a55a", "idle": "#b87a00", "offline": "#80788f", "speaking": "#23a55a",
  "danger": "#d12a37", "danger-hover": "#b21f2b", "on-danger": "#ffffff", "danger-soft": "#fbe4e6", "danger-text": "#c11f2d",
  "success-soft": "#dff5e8", "success-text": "#157a3f", "warning-soft": "#fcf0d6", "warning-text": "#8a5a00",
  "video-bg": "#15121c", "video-surface": "#221e2b", "on-video": "#ffffff", "on-video-muted": "#c9c4d4", "on-video-danger": "#ff7b82",
};

export type ThemeToken = keyof typeof LIGHT;
export type ThemeColors = Record<ThemeToken, string>;

export const THEME_TOKENS = Object.keys(LIGHT) as ThemeToken[];

export const BASE_THEMES: Record<ThemeBase, ThemeColors> = {
  light: LIGHT,
  dark: {
    ...LIGHT,
    "brand-hover": "#7424dc", "brand-text": "#b794f6", "brand-soft": "#2d1d4a",
    "surface": "#1c1a22", "surface-sunken": "#16141b", "surface-raised": "#26232e",
    "fill": "#2a2733", "fill-hover": "#353140", "line": "#2e2a38",
    "ink": "#f2f0f7", "ink-muted": "#b3aec0", "ink-subtle": "#9a95aa",
    "focus": "#b794f6",
    "online": "#2dc56c", "idle": "#f0b232", "offline": "#8a859a", "speaking": "#2dc56c",
    "danger-hover": "#e03a47", "danger-soft": "#3d1a20", "danger-text": "#ff8a8f",
    "success-soft": "#16301f", "success-text": "#5dd38e", "warning-soft": "#33270f", "warning-text": "#f0b232",
  },
};

export interface CustomTheme {
  id: string;
  name: string;
  author: string;
  base: ThemeBase;
  /** Only the colors the theme sets, after contrast adjustments. */
  colors: Partial<ThemeColors>;
  /** Tokens whose color was changed to keep text readable. */
  adjusted: ThemeToken[];
}

export const MAX_THEME_BYTES = 200 * 1024;
export const MIN_CONTRAST = 4.5;

export const THEME_EXAMPLE = {
  name: "Aurora",
  author: "Gabi Nunes",
  base: "dark",
  colors: {
    "brand": "#1fb5a3",
    "surface": "#0f1d24",
    "surface-sunken": "#0a151a",
    "fill": "#1b2e36",
    "ink": "#e6f4f2",
  },
};

/** A theme file with every color token, ready to be edited. */
export function themeTemplate(base: ThemeBase = "dark") {
  const colors = BASE_THEMES[base];
  return {
    name: "Meu tema",
    author: "Seu nome",
    base,
    colors: Object.fromEntries(THEME_TOKENS.map(token => [token, colors[token]])) as ThemeColors,
  };
}

// ---------- Contrast (WCAG 2.x) ----------

function rgb(hex: string): [number, number, number] {
  const value = hex.length === 4 ? hex.slice(1).split("").map(c => c + c).join("") : hex.slice(1);
  return [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex([r, g, b]: [number, number, number]) {
  return `#${[r, g, b].map(c => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex: string) {
  const [r, g, b] = rgb(hex).map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** Text colors and the backgrounds they are drawn on. */
const TEXT_PAIRS: [ThemeToken, ThemeToken[]][] = [
  ["ink", ["surface", "surface-sunken", "surface-raised", "fill", "fill-hover"]],
  ["ink-muted", ["surface", "surface-sunken", "surface-raised", "fill"]],
  ["ink-subtle", ["surface", "surface-raised"]],
  ["brand-text", ["surface", "surface-raised", "brand-soft"]],
  ["on-brand", ["brand", "brand-hover"]],
  ["on-danger", ["danger", "danger-hover"]],
  ["danger-text", ["surface", "danger-soft"]],
  ["success-text", ["success-soft"]],
  ["warning-text", ["warning-soft"]],
  ["on-video", ["video-bg", "video-surface"]],
  ["on-video-muted", ["video-bg", "video-surface"]],
];

function mix(from: string, to: string, amount: number) {
  const a = rgb(from), b = rgb(to);
  return toHex([0, 1, 2].map(i => a[i] + (b[i] - a[i]) * amount) as [number, number, number]);
}

/** Moves `color` toward black or white until it reads on every background. */
function readable(color: string, backgrounds: string[]) {
  const worst = (c: string) => Math.min(...backgrounds.map(bg => contrast(c, bg)));
  if (worst(color) >= MIN_CONTRAST) return color;
  const target = worst("#000000") >= worst("#ffffff") ? "#000000" : "#ffffff";
  for (let step = 1; step <= 20; step++) {
    const candidate = mix(color, target, step / 20);
    if (worst(candidate) >= MIN_CONTRAST) return candidate;
  }
  return target;
}

/** Fills in the base theme and fixes text colors below 4.5:1. */
export function resolveTheme(base: ThemeBase, colors: Partial<ThemeColors>) {
  const resolved: ThemeColors = { ...BASE_THEMES[base], ...colors };
  const adjusted: ThemeToken[] = [];
  for (const [text, backgrounds] of TEXT_PAIRS) {
    const fixed = readable(resolved[text], backgrounds.map(bg => resolved[bg]));
    if (fixed !== resolved[text]) { resolved[text] = fixed; adjusted.push(text); }
  }
  return { colors: resolved, adjusted };
}

// ---------- Parsing ----------

export class ThemeError extends Error {}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const FIELDS = new Set(["name", "author", "base", "colors"]);

function text(value: unknown, field: string, max: number, required: boolean) {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || (required && !value.trim()) || [...value.trim()].length > max) {
    throw new ThemeError(`O campo "${field}" deve ser um texto de ${required ? 1 : 0} a ${max} caracteres.`);
  }
  return value.trim();
}

/** Validates a theme file. Throws ThemeError with a message for the user. */
export function parseTheme(source: string): CustomTheme {
  if (new TextEncoder().encode(source).length > MAX_THEME_BYTES) throw new ThemeError("O tema deve ter até 200 KB.");
  let data: unknown;
  try { data = JSON.parse(source); }
  catch { throw new ThemeError("O arquivo não é um JSON válido."); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ThemeError("O tema deve ser um objeto JSON.");
  const input = data as Record<string, unknown>;
  const unknown = Object.keys(input).filter(key => !FIELDS.has(key));
  if (unknown.length) throw new ThemeError(`Campo desconhecido no tema: ${unknown.join(", ")}.`);
  const name = text(input.name, "name", 40, true);
  const author = text(input.author, "author", 40, false);
  if (input.base !== "light" && input.base !== "dark") throw new ThemeError('O campo "base" deve ser "light" ou "dark".');
  const raw = input.colors;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ThemeError('O campo "colors" deve ser um objeto com as cores do tema.');
  const colors: Partial<ThemeColors> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(THEME_TOKENS as string[]).includes(key)) throw new ThemeError(`Cor desconhecida: "${key}". Use os nomes de cor do Disc Voice.`);
    if (typeof value !== "string" || !HEX.test(value)) throw new ThemeError(`A cor "${key}" deve estar no formato #rrggbb ou #rgb.`);
    colors[key as ThemeToken] = value.toLowerCase();
  }
  const resolved = resolveTheme(input.base, colors);
  for (const token of resolved.adjusted) colors[token] = resolved.colors[token];
  return { id: crypto.randomUUID(), name, author, base: input.base, colors, adjusted: resolved.adjusted };
}

// ---------- Storage and application ----------

const KEY = "discvoice.appearance";
const THEMES_KEY = "discvoice.themes";
const MAX_THEMES = 30;
const listeners = new Set<() => void>();

function readThemes(): CustomTheme[] {
  try {
    const value = JSON.parse(localStorage.getItem(THEMES_KEY) || "[]") as unknown;
    if (!Array.isArray(value)) return [];
    // Stored themes are validated again: the storage may have been edited.
    return value.flatMap(item => {
      try {
        const { id, adjusted, ...file } = item as CustomTheme;
        if (typeof id !== "string") return [];
        const theme = parseTheme(JSON.stringify(file));
        // Colors were already adjusted on import; keep the list shown to the user.
        return [{ ...theme, id, adjusted: Array.isArray(adjusted) ? adjusted.filter(token => THEME_TOKENS.includes(token)) : theme.adjusted }];
      } catch { return []; }
    });
  } catch { return []; }
}

function readAppearance(): Appearance {
  try {
    const value = localStorage.getItem(KEY);
    if (value === "light" || value === "dark" || value === "system") return value;
    if (value?.startsWith("theme:") && themes.some(theme => `theme:${theme.id}` === value)) return value as Appearance;
  } catch { /* Storage unavailable: use the default. */ }
  return "system";
}

let themes = readThemes();
let current = readAppearance();
let snapshot = { appearance: current, themes };

function save() {
  try {
    localStorage.setItem(KEY, current);
    localStorage.setItem(THEMES_KEY, JSON.stringify(themes));
  } catch { /* Preferences last for this session only. */ }
  snapshot = { appearance: current, themes };
  applyAppearance(current);
  listeners.forEach(listener => listener());
}

function systemDark() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function themeById(appearance: Appearance) {
  return themes.find(theme => `theme:${theme.id}` === appearance);
}

/** Applies the resolved theme to <html data-theme> and the color tokens. */
export function applyAppearance(value: Appearance = current) {
  const root = document.documentElement;
  const custom = themeById(value);
  const dark = custom ? custom.base === "dark" : value === "dark" || (value === "system" && systemDark());
  root.dataset.theme = dark ? "dark" : "light";
  for (const token of THEME_TOKENS) root.style.removeProperty(`--${token}`);
  if (custom) {
    for (const [token, color] of Object.entries(resolveTheme(custom.base, custom.colors).colors)) root.style.setProperty(`--${token}`, color);
  }
}

export function setAppearance(value: Appearance) {
  current = value.startsWith("theme:") && !themeById(value) ? "system" : value;
  save();
}

/** Adds the theme, replacing an earlier import with the same name and author. */
export function addTheme(theme: CustomTheme) {
  const same = themes.find(item => item.name === theme.name && item.author === theme.author);
  const stored = same ? { ...theme, id: same.id } : theme;
  if (!same && themes.length >= MAX_THEMES) throw new ThemeError(`Você pode guardar até ${MAX_THEMES} temas. Remova algum para importar outro.`);
  themes = same ? themes.map(item => item.id === same.id ? stored : item) : [...themes, stored];
  save();
  return stored;
}

export function removeTheme(id: string) {
  const removed = themes.find(theme => theme.id === id);
  themes = themes.filter(theme => theme.id !== id);
  if (removed && current === `theme:${id}`) current = removed.base;
  save();
}

/** Downloads a theme from a public link. */
export async function fetchTheme(link: string, signal?: AbortSignal) {
  let url: URL;
  try { url = new URL(link.trim()); } catch { throw new ThemeError("Cole um link válido, começando com https://."); }
  if (url.protocol !== "https:") throw new ThemeError("Use um link https://.");
  let response: Response;
  try {
    response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000), credentials: "omit" });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ThemeError("Não foi possível baixar o tema. Verifique se o link é público.");
  }
  if (!response.ok) throw new ThemeError(`O link respondeu com erro ${response.status}.`);
  if (Number(response.headers.get("content-length") || 0) > MAX_THEME_BYTES) throw new ThemeError("O tema deve ter até 200 KB.");
  return parseTheme(await response.text());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Imported themes and the theme in use. */
export function useThemes() {
  return useSyncExternalStore(subscribe, () => snapshot);
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
