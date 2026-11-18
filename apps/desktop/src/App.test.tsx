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

beforeEach(() => {
  vi.stubGlobal("WebSocket", class {
    static OPEN = 1;
    readyState = 0;
    close() {}
    send() {}
  });
  sessionStorage.clear();
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

  it("registers, creates a server, copies its invite and creates a text channel", async () => {
    const user = userEvent.setup();
    const fetch = mockApi((path, init) => {
      if (path.endsWith("/auth/register")) {
        expect(JSON.parse(String(init?.body))).toEqual({ name: account.name, email: account.email, password: "senha-segura" });
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
    await user.click(screen.getByRole("button", { name: "Cadastre-se" }));
    await user.type(screen.getByLabelText("Nome"), account.name);
    await user.type(screen.getByLabelText("E-mail"), account.email);
    await user.type(screen.getByLabelText("Senha"), "senha-segura");
    await user.click(screen.getByRole("button", { name: "Criar conta" }));
    await user.click(await screen.findByRole("button", { name: "Criar meu servidor" }));
    let dialog = screen.getByRole("dialog");
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
      if (path.endsWith("/auth/login")) return { body: { user: account, token: "session-token" } };
      if (path.endsWith(`/invites/${code}`)) return { body: invite };
      if (path.endsWith("/join")) return { body: server };
      if (path.endsWith("/servers") || path.endsWith("/channels")) return { body: [] };
      throw new Error(`Unexpected ${init?.method}: ${path}`);
    });
    render(<App />);
    expect(screen.getByText(/Você tem um convite/)).toBeVisible();
    await user.type(screen.getByLabelText("E-mail"), account.email);
    await user.type(screen.getByLabelText("Senha"), "senha-segura");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    const accept = await screen.findByRole("button", { name: "Aceitar convite" });
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/join"))).toBe(false);
    await user.click(accept);
    expect(await screen.findByRole("heading", { name: "Bem-vindo a Amigos" })).toBeVisible();
    expect(window.location.search).toBe("");
    expect(sessionStorage.getItem("discvoice.invite")).toBeNull();
  });

  it("shows login failures and allows correcting credentials", async () => {
    const user = userEvent.setup();
    mockApi(() => ({ status: 401, body: { error: "E-mail ou senha incorretos." } }));
    render(<App />);
    await user.type(screen.getByLabelText("E-mail"), account.email);
    await user.type(screen.getByLabelText("Senha"), "senha-errada");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("E-mail ou senha incorretos.");
    expect(screen.getByRole("button", { name: "Entrar" })).toBeEnabled();
    expect(sessionToken.get()).toBeNull();
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
    await user.click(await screen.findByRole("button", { name: "Sair da conta" }));
    expect(await screen.findByRole("button", { name: "Entrar" })).toBeVisible();
    expect(sessionToken.get()).toBeNull();
    expect(fetch).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST" }));
  });

  it("clears an expired session while keeping the pending invitation", async () => {
    sessionToken.set("expired-token");
    window.history.replaceState(null, "", `/?invite=${code}`);
    mockApi(() => ({ status: 401, body: { error: "Sessão expirada." } }));
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Entrar" })).toBeVisible());
    expect(screen.getByText(/Sua sessão expirou/)).toBeVisible();
    expect(screen.getByText(/Você tem um convite/)).toBeVisible();
    expect(sessionToken.get()).toBeNull();
  });
});
