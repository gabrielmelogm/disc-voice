import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { sessionToken } from "./lib/api";
import { removeTheme, setAppearance, THEME_EXAMPLE, themeById } from "./lib/theme";

const account = { id: "user-1", email: "amigo@example.com", name: "Amigo", pronouns: "", bio: "", banner: "brand" };
const friend = { id: "user-2", email: "bia@example.com", name: "Bia", pronouns: "ela/dela", bio: "Toco violão.", banner: "green" };
const servers = [{ id: "server-1", name: "Amigos", ownerId: account.id }, { id: "server-2", name: "Clube", ownerId: friend.id }];
const channels = {
  "server-1": [{ id: "channel-1", serverId: "server-1", name: "geral", type: "text" }],
  "server-2": [{ id: "channel-2", serverId: "server-2", name: "livros", type: "text" }, { id: "voice-2", serverId: "server-2", name: "leitura", type: "voice" }],
};
type Handler = (path: string, init?: RequestInit) => { status?: number; body?: unknown } | undefined;

function mockApi(handler: Handler) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input);
    const result = handler(path, init) ?? (
      path.endsWith("/me") ? { body: account }
      : path.endsWith("/servers") ? { body: servers }
      : path.match(/servers\/(server-\d)\/channels$/) ? { body: channels[path.match(/servers\/(server-\d)/)![1] as keyof typeof channels] }
      : path.includes("/messages?") ? { body: { messages: [], hasMore: false } }
      : undefined);
    if (!result) throw new Error(`Unexpected request: ${init?.method || "GET"} ${path}`);
    return new Response(result.status === 204 ? null : JSON.stringify(result.body), {
      status: result.status || 200, headers: { "Content-Type": "application/json" },
    });
  });
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", class { static OPEN = 1; readyState = 0; close() {} send() {} });
  sessionStorage.clear();
  // Theme state lives in the module: reset it, then the stored copy.
  for (const stored of JSON.parse(localStorage.getItem("discvoice.themes") || "[]") as { id: string }[]) {
    if (themeById(`theme:${stored.id}`)) removeTheme(stored.id);
  }
  setAppearance("system");
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  sessionToken.set("session-token");
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); },
  });
});

const settings = () => screen.getByRole("dialog", { name: "Configurações" });

async function openSettings(page: string) {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Sua conta e configurações" }));
  await user.click(screen.getByRole("button", { name: page }));
  return user;
}

describe("settings dialog", () => {
  it("floats over the workspace, filters pages and closes with Esc", async () => {
    mockApi(() => undefined);
    const user = await openSettings("Visão geral");
    expect(settings()).toBeVisible();
    // The workspace stays open behind the dialog.
    expect(screen.getByRole("navigation", { name: "Barra do app", hidden: true })).toBeInTheDocument();
    await user.type(within(settings()).getByRole("searchbox", { name: "Buscar nas configurações" }), "camera");
    expect(within(settings()).getByRole("button", { name: "Voz e vídeo" })).toBeVisible();
    expect(within(settings()).queryByRole("button", { name: "Perfil" })).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(within(settings()).getByRole("heading", { name: "Voz e vídeo" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Configurações" })).not.toBeInTheDocument());
  });
});

describe("profile editing", () => {
  it("validates inline, saves the profile and discards unsaved changes", async () => {
    const fetch = mockApi((path, init) => {
      if (path.endsWith("/me") && init?.method === "PATCH") return { body: { ...account, ...JSON.parse(String(init.body)) } };
    });
    const user = await openSettings("Perfil");
    const name = screen.getByLabelText("Nome de exibição");
    await user.clear(name);
    await user.tab();
    expect(screen.getByText("O nome deve ter entre 1 e 32 caracteres.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeDisabled();

    await user.type(name, "  Amigo   Novo ");
    await user.type(screen.getByLabelText("Pronomes"), "ele/dele");
    await user.click(screen.getByRole("radio", { name: "Verde" }));
    await user.type(screen.getByLabelText("Sobre mim"), "Olá!");
    const preview = screen.getByRole("complementary", { name: "Prévia do perfil" });
    expect(within(preview).getByText("Amigo Novo")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Salvar alterações" }));
    expect(await within(settings()).findByRole("status")).toHaveTextContent("Perfil salvo.");
    expect(fetch).toHaveBeenCalledWith("/api/me", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ name: "Amigo Novo", pronouns: "ele/dele", bio: "Olá!", banner: "green" }),
    }));

    await user.type(screen.getByLabelText("Pronomes"), " e mais");
    await user.click(screen.getByRole("button", { name: "Descartar" }));
    expect(screen.getByLabelText("Pronomes")).toHaveValue("ele/dele");
    expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Visão geral" }));
    expect(screen.getAllByText("Amigo Novo").length).toBeGreaterThan(0);
  });

  it("shows API validation errors without losing the form", async () => {
    mockApi((_path, init) => {
      if (init?.method === "PATCH") return { status: 400, body: { error: "Escolha uma das cores de banner disponíveis." } };
    });
    const user = await openSettings("Perfil");
    await user.type(screen.getByLabelText("Pronomes"), "ela/dela");
    await user.click(screen.getByRole("button", { name: "Salvar alterações" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Escolha uma das cores de banner disponíveis.");
    expect(screen.getByLabelText("Pronomes")).toHaveValue("ela/dela");
  });
});

describe("custom themes", () => {
  const file = (content: string, name = "tema.json") => new File([content], name, { type: "application/json" });

  it("imports, applies, persists and removes a theme file", async () => {
    mockApi(() => undefined);
    const user = await openSettings("Temas");
    await user.upload(screen.getByLabelText("Arquivo do tema"), file(JSON.stringify({ ...THEME_EXAMPLE, colors: { ...THEME_EXAMPLE.colors, ink: "#203038" } })));
    expect(await screen.findByText("Tema “Aurora” importado.")).toBeVisible();
    // Dark ink on a dark surface is adjusted, and the user is told.
    expect(within(settings()).getByRole("status")).toHaveTextContent("ink");
    await user.click(screen.getByRole("button", { name: "Usar tema Aurora" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--brand")).toBe("#1fb5a3");
    expect(localStorage.getItem("discvoice.appearance")).toMatch(/^theme:/);
    await user.click(screen.getByRole("button", { name: "Remover tema Aurora" }));
    expect(screen.queryByRole("button", { name: "Usar tema Aurora" })).not.toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue("--brand")).toBe("");
  });

  it("rejects invalid files and keeps the current theme", async () => {
    mockApi(() => undefined);
    const user = await openSettings("Temas");
    await user.click(screen.getByRole("button", { name: "Usar tema Escuro" }));
    await user.upload(screen.getByLabelText("Arquivo do tema"), file(JSON.stringify({ name: "Ruim", base: "dark", colors: { primary: "#fff" } })));
    expect(await screen.findByRole("alert")).toHaveTextContent('Cor desconhecida: "primary"');
    expect(JSON.parse(localStorage.getItem("discvoice.themes") || "[]")).toEqual([]);
    expect(localStorage.getItem("discvoice.appearance")).toBe("dark");
  });

  it("imports a theme from a public link", async () => {
    const fetch = mockApi(path => path.startsWith("https://temas.example") ? { body: THEME_EXAMPLE } : undefined);
    const user = await openSettings("Temas");
    await user.type(screen.getByLabelText("Link do tema"), "https://temas.example/aurora.json");
    await user.click(screen.getByRole("button", { name: "Importar" }));
    expect(await screen.findByText("Tema “Aurora” importado.")).toBeVisible();
    expect(fetch).toHaveBeenCalledWith(new URL("https://temas.example/aurora.json"), expect.objectContaining({ credentials: "omit" }));
  });
});

describe("global search", () => {
  const results = {
    channels: [{ id: "voice-2", serverId: "server-2", serverName: "Clube", name: "leitura", type: "voice" }],
    people: [friend],
    messages: [{ id: "42", channelId: "channel-2", channelName: "livros", serverId: "server-2", serverName: "Clube", author: friend, content: "Vamos ler juntos", createdAt: "2026-11-17T10:00:00Z" }],
    nextCursor: null,
  };

  it("opens with Ctrl+K, closes with Esc and opens a message in its channel", async () => {
    const fetch = mockApi(path => {
      if (path.startsWith("/api/search?")) return { body: results };
      if (path.includes("/channels/channel-2/messages?")) return { body: { messages: [{ ...results.messages[0], clientId: "c" }], hasMore: false } };
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: "Buscar mensagens, pessoas e canais" });
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog", { name: "Buscar" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Buscar" })).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Buscar mensagens, pessoas e canais" }));
    await user.type(screen.getByRole("combobox"), "ler");
    expect(await screen.findByRole("option", { name: /Mensagem de Bia em livros/ })).toBeVisible();
    expect(fetch).toHaveBeenCalledWith("/api/search?q=ler", expect.anything());
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    const message = await screen.findByText("Vamos ler juntos");
    expect(message.closest("article")).toHaveClass("is-focused");
    expect(screen.getByRole("heading", { name: "livros" })).toBeVisible();
    expect(fetch).toHaveBeenCalledWith("/api/channels/channel-2/messages?before=43", expect.anything());
  });

  it("opens a channel or a person's profile card", async () => {
    mockApi(path => path.startsWith("/api/search?") ? { body: results } : undefined);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Buscar mensagens, pessoas e canais" }));
    await user.type(screen.getByRole("combobox"), "bia");
    await user.click(await screen.findByRole("option", { name: "Perfil de Bia" }));
    const card = await screen.findByRole("dialog", { name: "Perfil de Bia" });
    expect(within(card).getByText("Toco violão.")).toBeVisible();
    expect(within(card).getByText("ela/dela")).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Perfil de Bia" })).not.toBeInTheDocument());

    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true })); });
    await user.type(screen.getByRole("combobox"), "leit");
    await user.click(await screen.findByRole("option", { name: "Sala leitura em Clube" }));
    expect(await screen.findByRole("button", { name: "Entrar no canal de voz" })).toBeVisible();
  });
});
