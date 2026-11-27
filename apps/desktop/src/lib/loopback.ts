// Desktop sign-in through the system browser: a temporary loopback server
// (http://127.0.0.1:<port>, opened by tauri-plugin-oauth) receives the
// browser's last redirect, so the app learns how the sign-in went.

import { openExternal } from "./external";

const TIMEOUT_MS = 5 * 60_000;

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Disc Voice</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0">
<p>Login concluído. Você já pode fechar esta aba e voltar ao Disc Voice.</p></body>`;

export const native = () => "__TAURI_INTERNALS__" in window;

/**
 * Opens the URL `authorize` returns for the loopback port, waits for the
 * redirect to that port and hands it to `finish`. Always stops the server.
 */
export async function signInThroughBrowser<T>({ authorize, finish, expired, signal }: {
  authorize: (port: number) => Promise<string>;
  finish: (redirect: URL, port: number) => Promise<T>;
  /** Message when the user takes too long. */
  expired: string;
  signal?: AbortSignal;
}): Promise<T> {
  const { start, cancel, onUrl } = await import("@fabianlars/tauri-plugin-oauth");
  const port = await start({ response: DONE_PAGE });
  let received!: (url: string) => void;
  const redirect = new Promise<string>(resolve => { received = resolve; });
  const unlisten = await onUrl(url => received(url));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await openExternal(await authorize(port));
    const url = await Promise.race([
      redirect,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(expired)), TIMEOUT_MS);
        onAbort = () => reject(new DOMException("Login cancelado.", "AbortError"));
        if (signal?.aborted) onAbort();
        signal?.addEventListener("abort", onAbort);
      }),
    ]);
    return await finish(new URL(url), port);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    unlisten();
    await cancel(port).catch(() => {});
  }
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** URL-safe random text from `size` random bytes. */
export function random(size: number) {
  return base64url(crypto.getRandomValues(new Uint8Array(size)));
}

export async function challenge(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}
