import type { AuthSession } from "@disc-voice/shared";
import { api } from "./api";
import { native, random, signInThroughBrowser } from "./loopback";

// Sign in with Discord. The API holds the client secret and talks to Discord;
// when Discord sends the browser back, the API forwards it to the app with a
// one-time ticket the app exchanges for a session.
//  - Desktop: the app's temporary loopback server receives the ticket.
//  - Browser: the page comes back to CALLBACK_PATH.

export const CALLBACK_PATH = "/auth/discord/callback";
const FLOW_KEY = "discvoice.discord";

/** Checks the redirect from the API and exchanges its ticket. */
function finish(params: URLSearchParams, state: string) {
  if (params.get("state") !== state) throw new Error("Resposta de login inválida. Tente novamente.");
  const error = params.get("error");
  if (error) throw new Error(error);
  const ticket = params.get("ticket");
  if (!ticket) throw new Error("Resposta de login inválida. Tente novamente.");
  return api.discordLogin(ticket);
}

/**
 * Starts signing in with Discord. On desktop it resolves with the session;
 * in the browser the page navigates to Discord and the promise never settles.
 */
export async function signInWithDiscord(signal?: AbortSignal): Promise<AuthSession> {
  const state = random(24);
  if (!native()) {
    const { url } = await api.discordAuthStart({ platform: "web", state });
    sessionStorage.setItem(FLOW_KEY, state);
    window.location.assign(url);
    return new Promise<never>(() => {});
  }
  return signInThroughBrowser({
    authorize: async port => (await api.discordAuthStart({ platform: "desktop", port, state })).url,
    finish: url => finish(url.searchParams, state),
    expired: "O login com Discord expirou. Tente novamente.",
    signal,
  });
}

export function isDiscordCallback() {
  return !native() && window.location.pathname === CALLBACK_PATH;
}

let completing: Promise<AuthSession> | null = null;

/** Finishes the browser flow after the API redirects back to CALLBACK_PATH. */
export function completeDiscordRedirect(): Promise<AuthSession> {
  // Memoized: the ticket works once, and React may run effects twice.
  completing ??= (async () => {
    const params = new URL(window.location.href).searchParams;
    const state = sessionStorage.getItem(FLOW_KEY);
    sessionStorage.removeItem(FLOW_KEY);
    window.history.replaceState(null, "", "/");
    if (!state) throw new Error("O login expirou. Tente entrar novamente.");
    return finish(params, state);
  })().finally(() => { completing = null; });
  return completing;
}
