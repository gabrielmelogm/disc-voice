import type { AuthSession, GoogleLogin } from "@disc-voice/shared";
import { api } from "./api";
import { challenge, native, random, signInThroughBrowser } from "./loopback";

// Google Sign-In with an authorization code and PKCE. The app only gets the
// code; the API exchanges it with Google using the client secret.
//  - Desktop: the system browser redirects to a temporary loopback server
//    (http://127.0.0.1:<port>) opened by tauri-plugin-oauth.
//  - Browser: the page redirects to Google and comes back to CALLBACK_PATH.

export const CALLBACK_PATH = "/auth/google/callback";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const FLOW_KEY = "discvoice.google";

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

  const clientId = config.desktopClientId;
  if (!clientId) notConfigured();
  return signInThroughBrowser({
    authorize: port => authUrl(clientId, `http://127.0.0.1:${port}`, state, verifier),
    finish: (url, port) => finish(url, state, verifier, `http://127.0.0.1:${port}`, "desktop"),
    expired: "O login com Google expirou. Tente novamente.",
    signal,
  });
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
