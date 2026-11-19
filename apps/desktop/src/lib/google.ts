import type { AuthSession, GoogleLogin } from "@disc-voice/shared";
import { api } from "./api";

// Google Sign-In with an authorization code and PKCE. The app only gets the
// code; the API exchanges it with Google using the client secret.
//  - Desktop: the system browser redirects to a temporary loopback server
//    (http://127.0.0.1:<port>) opened by tauri-plugin-oauth.
//  - Browser: the page redirects to Google and comes back to CALLBACK_PATH.

export const CALLBACK_PATH = "/auth/google/callback";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const FLOW_KEY = "discvoice.google";
const TIMEOUT_MS = 5 * 60_000;
const native = () => "__TAURI_INTERNALS__" in window;

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Disc Voice</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0">
<p>Login concluído. Você já pode fechar esta aba e voltar ao Disc Voice.</p></body>`;

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function random(size: number) {
  return base64url(crypto.getRandomValues(new Uint8Array(size)));
}

async function challenge(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

async function authUrl(clientId: string, redirectUri: string, state: string, verifier: string) {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: await challenge(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.href;
}

function notConfigured(): never {
  throw new Error("O login com Google não está configurado neste servidor.");
}

/** Checks Google's redirect and exchanges the code through the API. */
function finish(url: URL, state: string, codeVerifier: string, redirectUri: string, platform: GoogleLogin["platform"]) {
  const params = url.searchParams;
  const error = params.get("error");
  if (error) {
    throw new Error(error === "access_denied" ? "O login com Google foi cancelado." : "O Google não autorizou o login. Tente novamente.");
  }
  const code = params.get("code");
  if (!code || params.get("state") !== state) throw new Error("Resposta de login inválida. Tente novamente.");
  return api.googleLogin({ code, codeVerifier, redirectUri, platform });
}

/**
 * Starts Google Sign-In. On desktop it resolves with the session; in the
 * browser the page navigates to Google and the promise never settles.
 */
export async function signInWithGoogle(signal?: AbortSignal): Promise<AuthSession> {
  const config = await api.googleConfig();
  const state = random(16);
  const verifier = random(48);

  if (!native()) {
    if (!config.webClientId) notConfigured();
    sessionStorage.setItem(FLOW_KEY, JSON.stringify({ state, verifier }));
    window.location.assign(await authUrl(config.webClientId, `${window.location.origin}${CALLBACK_PATH}`, state, verifier));
    return new Promise<never>(() => {});
  }

  if (!config.desktopClientId) notConfigured();
  const [{ start, cancel, onUrl }, { openUrl }] = await Promise.all([
    import("@fabianlars/tauri-plugin-oauth"),
    import("@tauri-apps/plugin-opener"),
  ]);
  const port = await start({ response: DONE_PAGE });
  const redirectUri = `http://127.0.0.1:${port}`;
  let received!: (url: string) => void;
  const redirect = new Promise<string>(resolve => { received = resolve; });
  const unlisten = await onUrl(url => received(url));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await openUrl(await authUrl(config.desktopClientId, redirectUri, state, verifier));
    const url = await Promise.race([
      redirect,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("O login com Google expirou. Tente novamente.")), TIMEOUT_MS);
        onAbort = () => reject(new DOMException("Login cancelado.", "AbortError"));
        if (signal?.aborted) onAbort();
        signal?.addEventListener("abort", onAbort);
      }),
    ]);
    return await finish(new URL(url), state, verifier, redirectUri, "desktop");
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    unlisten();
    await cancel(port).catch(() => {});
  }
}

export function isGoogleCallback() {
  return !native() && window.location.pathname === CALLBACK_PATH;
}

let completing: Promise<AuthSession> | null = null;

/** Finishes the browser flow after Google redirects back to CALLBACK_PATH. */
export function completeGoogleRedirect(): Promise<AuthSession> {
  // Memoized: the code can be used only once, and React may run effects twice.
  completing ??= (async () => {
    const url = new URL(window.location.href);
    const saved = sessionStorage.getItem(FLOW_KEY);
    sessionStorage.removeItem(FLOW_KEY);
    window.history.replaceState(null, "", "/");
    let flow: { state?: string; verifier?: string } | null = null;
    try { flow = saved ? JSON.parse(saved) : null; } catch { flow = null; }
    if (!flow?.state || !flow.verifier) throw new Error("O login expirou. Tente entrar novamente.");
    return finish(url, flow.state, flow.verifier, `${window.location.origin}${CALLBACK_PATH}`, "web");
  })().finally(() => { completing = null; });
  return completing;
}
