import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { sessionToken } from "./lib/api";

const account = { id: "user-1", email: "amigo@example.com", name: "Amigo" };
const server = { id: "server-1", name: "Amigos", ownerId: account.id };
const code = "6c247e76-7b39-4b12-a278-49838c3fa6d6";
const invite = { code, url: `http://localhost:3001/?invite=${code}`, server };
const channel = { id: "channel-1", serverId: server.id, name: "geral", type: "text" };
type Handler = (path: string, init?: RequestInit) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;

function mockApi(handler: Handler) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const result = await handler(String(input), init);
    return new Response(result.status === 204 ? null : JSON.stringify(result.body), {
      status: result.status || 200, headers: { "Content-Type": "application/json" },
    });
  });
}

/** The browser build coming back from Google to the callback route. */
function returnFromGoogle(query = "code=google-code&state=flow-state") {
  sessionStorage.setItem("discvoice.google", JSON.stringify({ state: "flow-state", verifier: "flow-verifier" }));
  window.history.replaceState(null, "", `/auth/google/callback?${query}`);
}

const googleLogin = () => ({
  code: "google-code",
  codeVerifier: "flow-verifier",
  redirectUri: `${window.location.origin}/auth/google/callback`,
  platform: "web",
});

/** Requests that try to sign in (the login screen also asks which options exist). */
const signInCalls = (fetch: ReturnType<typeof mockApi>) =>
  fetch.mock.calls.map(([url]) => String(url)).filter(url => !url.endsWith("/auth/discord/config"));

beforeEach(() => {
  vi.stubGlobal("WebSocket", class {
    static OPEN = 1;
    readyState = 0;
    close() {}
    send() {}
  });
  sessionStorage.clear(); localStorage.clear();
  window.history.replaceState(null, "", "/");
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); },
  });
});

describe("accounts and communities", () => {
  it("creates a voice channel using the channel type selector", async () => {
    const user = userEvent.setup();
    sessionToken.set("session-token");
    const fetch = mockApi((path, init) => {
      if (path.endsWith("/me")) return { body: account };
      if (path.endsWith("/servers")) return { body: [server] };
      if (path.endsWith("/channels") && init?.method === "POST") return { status: 201, body: { ...channel, name: "conversa", type: "voice" } };
      if (path.endsWith("/channels")) return { body: [] };
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Criar primeiro canal" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: "Voz" }));
    await user.type(within(dialog).getByLabelText("Nome do canal"), "conversa");
    await user.click(within(dialog).getByRole("button", { name: "Criar canal" }));
    expect(await screen.findByRole("button", { name: "Entrar no canal de voz" })).toBeVisible();
    expect(fetch).toHaveBeenCalledWith("/api/servers/server-1/channels", expect.objectContaining({
      method: "POST", body: JSON.stringify({ name: "conversa", type: "voice" }),
    }));
  });

  it("signs in with Google, creates a server, copies its invite and creates a text channel", async () => {
    const user = userEvent.setup();
    returnFromGoogle();
    const fetch = mockApi((path, init) => {
      if (path.endsWith("/auth/google")) {
        expect(JSON.parse(String(init?.body))).toEqual(googleLogin());
        return { body: { user: account, token: "session-token" } };
      }
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer session-token");
      if (path.endsWith("/servers") && init?.method === "POST") return { status: 201, body: invite };
      if (path.endsWith("/channels") && init?.method === "POST") return { status: 201, body: channel };
      if (path.endsWith("/channels") || path.endsWith("/servers")) return { body: [] };
      if (path.includes("/messages?")) return { body: { messages: [], hasMore: false } };
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<App />);
    expect(screen.getByRole("status")).toHaveTextContent("Entrando com Google…");
    await user.click(await screen.findByRole("button", { name: "Criar meu servidor" }));
    // The code is used once and removed from the address bar.
    expect(window.location.pathname).toBe("/");
    expect(sessionStorage.getItem("discvoice.google")).toBeNull();
    expect(sessionToken.get()).toBe("session-token");
    let dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Criar do zero/ }));
    await user.type(within(dialog).getByLabelText("Nome do servidor"), "Amigos");
    await user.click(within(dialog).getByRole("button", { name: "Criar servidor" }));
    expect(await within(dialog).findByLabelText("Link de convite")).toHaveValue(invite.url);
    await user.click(within(dialog).getByRole("button", { name: "Copiar link" }));
    expect(await navigator.clipboard.readText()).toBe(invite.url);
    await user.click(within(dialog).getByRole("button", { name: "Concluir" }));
    await user.click(screen.getByRole("button", { name: "Criar primeiro canal" }));
    dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Nome do canal"), "geral");
    await user.click(within(dialog).getByRole("button", { name: "Criar canal" }));
    expect(await screen.findByRole("heading", { name: "Bem-vindo a #geral" })).toBeVisible();
    expect(fetch).toHaveBeenCalledWith("/api/servers/server-1/channels", expect.objectContaining({
      method: "POST", body: JSON.stringify({ name: "geral", type: "text" }),
    }));
  });

  it("keeps an invitation through login and joins only after confirmation", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", `/?invite=${code}`);
    const fetch = mockApi((path, init) => {
      if (path.endsWith("/auth/google")) return { body: { user: account, token: "session-token" } };
      if (path.endsWith(`/invites/${code}`)) return { body: invite };
      if (path.endsWith("/join")) return { body: server };
      if (path.endsWith("/servers") || path.endsWith("/channels")) return { body: [] };
      throw new Error(`Unexpected ${init?.method}: ${path}`);
    });
    const first = render(<App />);
    expect(screen.getByText(/Você tem um convite/)).toBeVisible();
    first.unmount();
    // The page goes to Google and comes back; the invite survives the round trip.
    returnFromGoogle();
    render(<App />);
    const accept = await screen.findByRole("button", { name: "Aceitar convite" });
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/join"))).toBe(false);
    await user.click(accept);
    expect(await screen.findByRole("heading", { name: "Bem-vindo a Amigos" })).toBeVisible();
    expect(window.location.search).toBe("");
    expect(sessionStorage.getItem("discvoice.invite")).toBeNull();
  });

  it("explains when Google Sign-In is not configured and lets the user retry", async () => {
    const user = userEvent.setup();
    mockApi(path => {
      if (path.endsWith("/auth/google/config")) return { body: { desktopClientId: null, webClientId: null } };
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Continuar com Google" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("não está configurado");
    expect(screen.getByRole("button", { name: "Continuar com Google" })).toBeEnabled();
    expect(sessionToken.get()).toBeNull();
  });

  it("shows Google failures after the redirect without calling the API", async () => {
    const fetch = mockApi(path => { throw new Error(`Unexpected request: ${path}`); });
    returnFromGoogle("error=access_denied&state=flow-state");
    render(<App />);
    expect(await screen.findByText("O login com Google foi cancelado.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Continuar com Google" })).toBeEnabled();
    expect(window.location.pathname).toBe("/");
    expect(signInCalls(fetch)).toEqual([]);
  });

  it("rejects a redirect whose state does not match", async () => {
    const fetch = mockApi(path => { throw new Error(`Unexpected request: ${path}`); });
    returnFromGoogle("code=google-code&state=forged");
    render(<App />);
    expect(await screen.findByText(/Resposta de login inválida/)).toBeVisible();
    expect(signInCalls(fetch)).toEqual([]);
    expect(sessionToken.get()).toBeNull();
  });

  it("offers Discord first and Google second, or Google alone without the integration", async () => {
    mockApi(path => {
      if (path.endsWith("/auth/discord/config")) return { body: { enabled: true } };
      throw new Error(`Unexpected request: ${path}`);
    });
    const first = render(<App />);
    const buttons = screen.getAllByRole("button", { name: /Continuar com/ }).map(b => b.textContent);
    expect(buttons).toEqual(["Continuar com Discord", "Continuar com Google"]);
    first.unmount();
    vi.restoreAllMocks();
    mockApi(path => {
      if (path.endsWith("/auth/discord/config")) return { body: { enabled: false } };
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<App />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Continuar com Discord" })).toBeNull());
    expect(screen.getByRole("button", { name: "Continuar com Google" })).toBeVisible();
  });

  it("signs in with Discord, asks about the profile and imports a Discord server", async () => {
    const user = userEvent.setup();
    sessionStorage.setItem("discvoice.discord", "discord-flow-state");
    window.history.replaceState(null, "", "/auth/discord/callback?state=discord-flow-state&ticket=the-ticket");
    const imported = { id: "server-9", name: "Comunidade", ownerId: account.id, icon: "https://cdn.discordapp.com/icons/700/abc.png" };
    const consent = vi.fn();
    const discordAccount = { id: "31", username: "bia", displayName: "Bia", avatar: null, shareActivity: false, presenceSeen: false, consentPending: true, canListGuilds: true };
    let servers: unknown[] = [];
    mockApi((path, init) => {
      if (path.endsWith("/auth/discord/config")) return { body: { enabled: true } };
      if (path.endsWith("/auth/discord")) {
        expect(JSON.parse(String(init?.body))).toEqual({ ticket: "the-ticket" });
        return { body: { user: account, token: "session-token", discordConsent: true } };
      }
      if (path.endsWith("/discord")) return { body: { enabled: true, presence: true, account: discordAccount, clientId: null } };
      if (path.endsWith("/discord/consent")) { consent(JSON.parse(String(init?.body))); return { status: 204 }; }
      if (path.endsWith("/me") && init?.method === "PATCH") {
        const changes = JSON.parse(String(init.body));
        consent(changes);
        return { body: { ...account, ...changes } };
      }
      if (path.endsWith("/discord/guilds")) return { body: [{ id: "700", name: "Comunidade", icon: imported.icon, botInstalled: true, importedServerId: null }] };
      if (path.endsWith("/discord/guilds/700/import")) {
        servers = [imported];
        return { status: 201, body: { server: { code, url: invite.url, server: imported }, installUrl: null, channels: 3, warning: null } };
      }
      if (path.endsWith("/servers")) return { body: servers };
      if (path.endsWith("/channels")) return { body: [] };
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<App />);
    expect(screen.getByRole("status")).toHaveTextContent("Entrando com Discord…");
    const dialog = await screen.findByRole("dialog", { name: "Integrar seu perfil do Discord" });
    expect(window.location.pathname).toBe("/");
    expect(sessionToken.get()).toBe("session-token");
    await user.click(within(dialog).getByRole("switch", { name: /Mostrar minha atividade/ }));
    // Discord doesn't share the "About me": the user pastes it.
    await user.type(within(dialog).getByLabelText("Sobre mim"), "Jogo à noite");
    await user.click(within(dialog).getByRole("button", { name: "Continuar" }));
    expect(consent.mock.calls).toEqual([[{ bio: "Jogo à noite" }], [{ useAvatar: true, shareActivity: false }]]);
    expect(await within(dialog).findByRole("heading", { name: "Importar servidores do Discord?" })).toBeVisible();
    await user.click(await within(dialog).findByRole("button", { name: "Importar Comunidade" }));
    expect(await within(dialog).findByText("Importado com 3 canais.")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Abrir" }));
    expect(await screen.findByRole("heading", { name: "Bem-vindo a Comunidade" })).toBeVisible();
  });

  it("keeps the session after the app is closed, carrying over the old sessionStorage one", async () => {
    sessionStorage.setItem("discvoice.session", "session-token");
    mockApi(path => {
      if (path.endsWith("/me")) return { body: account };
      if (path.endsWith("/servers")) return { body: [] };
      throw new Error(`Unexpected request: ${path}`);
    });
    const { unmount } = render(<App />);
    expect(await screen.findByRole("button", { name: "Sua conta e configurações" })).toBeVisible();
    expect(localStorage.getItem("discvoice.session")).toBe("session-token");
    expect(sessionStorage.getItem("discvoice.session")).toBeNull();
    // Reopening the app (a fresh session storage) still finds the session.
    unmount();
    sessionStorage.clear();
    render(<App />);
    expect(await screen.findByRole("button", { name: "Sua conta e configurações" })).toBeVisible();
  });

  it("restores sessions, revokes them on logout and returns to login", async () => {
    const user = userEvent.setup();
    sessionToken.set("session-token");
    const fetch = mockApi(path => {
      if (path.endsWith("/me")) return { body: account };
      if (path.endsWith("/servers")) return { body: [] };
      if (path.endsWith("/auth/logout")) return { status: 204 };
      throw new Error(`Unexpected request: ${path}`);
    });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Sua conta e configurações" }));
    await user.click(screen.getByRole("menuitem", { name: "Configurações" }));
    await user.click(screen.getByRole("button", { name: "Sair da conta" }));
    expect(await screen.findByRole("button", { name: "Continuar com Google" })).toBeVisible();
    expect(sessionToken.get()).toBeNull();
    expect(fetch).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST" }));
  });

  it("clears an expired session while keeping the pending invitation", async () => {
    sessionToken.set("expired-token");
    window.history.replaceState(null, "", `/?invite=${code}`);
    mockApi(() => ({ status: 401, body: { error: "Sessão expirada." } }));
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Continuar com Google" })).toBeVisible());
    expect(screen.getByText(/Sua sessão expirou/)).toBeVisible();
    expect(screen.getByText(/Você tem um convite/)).toBeVisible();
    expect(sessionToken.get()).toBeNull();
  });
});
