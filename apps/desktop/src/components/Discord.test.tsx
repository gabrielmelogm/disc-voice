import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity, ChatMessage, DiscordImport, DiscordServer, DiscordStatus, RealtimeEvent } from "@disc-voice/shared";
import { api } from "../lib/api";
import { activityLabel, withActivity } from "../lib/activity";
import type { Realtime } from "../lib/realtime";
import { DiscordImportDialog, importStatus } from "./DiscordImportDialog";
import { ProfileCardProvider, ProfileSummary } from "./ProfileCard";
import { presenceHelp, Settings } from "./Settings";
import { TextChannel } from "./TextChannel";

function realtime() {
  const listeners = new Set<(event: RealtimeEvent) => void>();
  return {
    client: { onEvent: (fn: (event: RealtimeEvent) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; } } as unknown as Realtime,
    emit: (event: RealtimeEvent) => act(() => listeners.forEach(listener => listener(event))),
  };
}

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); },
  });
});

const minecraft: Activity = { kind: "playing", name: "Minecraft", details: "Sobrevivência", state: null, startedAt: null, source: "discord" };

const imported = (overrides: Partial<DiscordImport> = {}): DiscordImport => ({
  channelId: "mirror-1", serverId: "server-1", guildId: "700", discordChannelId: "500", discordChannelName: "Geral",
  phase: "history", status: "running", imported: 200, error: null, syncedAt: null, ...overrides,
});

describe("imported Discord channels", () => {
  const channel = { id: "mirror-1", serverId: "server-1", name: "geral", type: "text" as const, source: "discord" as const };
  const importing = { ...channel, readOnly: true };
  const discordAuthor = { id: "d15c0000-0000-0000-0000-00000000002a", email: "", name: "Pessoa", discord: "pessoa" };
  const message = (id: string, extra: Partial<ChatMessage>): ChatMessage => ({
    id, channelId: channel.id, clientId: `c-${id}`, author: discordAuthor, content: "", createdAt: "2024-05-01T12:00:00Z", discordId: `9${id}`, ...extra,
  });

  it("is read-only only while importing", async () => {
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [message("1", { content: "Oi do Discord" })], hasMore: false });
    const { rerender } = render(<TextChannel channel={importing} realtime={realtime().client} revision={1} />);
    expect(await screen.findByText("Oi do Discord")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("quando a importação terminar");
    expect(screen.getAllByText("Discord")[0]).toHaveClass("source-tag");
    rerender(<TextChannel channel={channel} realtime={realtime().client} revision={1} />);
    expect(screen.getByRole("textbox")).toBeVisible();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("previews media in the app", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "messages").mockResolvedValue({
      messages: [
        message("2", { attachments: [
          { id: "a", filename: "mapa.png", url: "/api/files/f1/mapa.png", size: 2048, contentType: "image/png", width: 800, height: 600 },
          { id: "b", filename: "clipe.mp4", url: "/api/files/f2/clipe.mp4", size: 4096, contentType: "video/mp4", width: null, height: null },
          { id: "c", filename: "notas.pdf", url: "/api/files/f3/notas.pdf", size: 3 * 1024 * 1024, contentType: "application/pdf", width: null, height: null },
          { id: "d", filename: "velho.png", url: "https://cdn.discordapp.com/x/velho.png", size: 10, contentType: "image/png", width: null, height: null, unavailable: true },
        ] }),
        message("3", { author: { ...discordAuthor, id: "other", name: "Outra" } }),
      ],
      hasMore: false,
    });
    render(<TextChannel channel={channel} realtime={realtime().client} revision={1} />);
    const thumb = await screen.findByRole("button", { name: "Ver imagem mapa.png" });
    // Files kept by the API resolve against the API's address.
    expect(within(thumb).getByRole("img")).toHaveAttribute("src", `${window.location.origin}/api/files/f1/mapa.png`);
    expect(thumb).toHaveStyle({ width: "400px" });
    expect(screen.getByLabelText("clipe.mp4").tagName).toBe("VIDEO");
    expect(screen.getByRole("link", { name: /notas\.pdf/ }).closest(".file-card")).toHaveTextContent("3 MB");
    // Files kept by the API can be saved to the computer.
    expect(screen.getByRole("button", { name: "Baixar notas.pdf" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Baixar mapa.png" })).toBeInTheDocument();
    // Media that couldn't be copied falls back to a file card.
    expect(screen.getByRole("link", { name: /velho\.png/ }).closest(".file-card")).toHaveTextContent("pode ter expirado");
    expect(screen.queryByRole("button", { name: "Baixar velho.png" })).not.toBeInTheDocument();
    expect(screen.getByText("Mensagem sem texto")).toBeVisible();

    await user.click(thumb);
    const viewer = screen.getByRole("dialog", { name: "mapa.png" });
    expect(within(viewer).getByRole("img")).toHaveAttribute("src", `${window.location.origin}/api/files/f1/mapa.png`);
    await user.click(within(viewer).getByRole("button", { name: "Fechar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("loads new batches as the import advances", async () => {
    const history = vi.spyOn(api, "messages")
      .mockResolvedValueOnce({ messages: [], hasMore: false })
      .mockResolvedValueOnce({ messages: [message("5", { content: "Mais recente" })], hasMore: true });
    const live = realtime();
    render(<TextChannel channel={importing} realtime={live.client} revision={1} />);
    expect(await screen.findByText("#geral vem do Discord")).toBeVisible();
    live.emit({ type: "discord.import", serverId: "server-1", import: imported({ imported: 100 }) });
    expect(await screen.findByText("Mais recente")).toBeVisible();
    // An empty channel loads the latest page rather than replaying from the start.
    expect(history.mock.calls[1][1]).toEqual({});
    expect(screen.getByRole("button", { name: "Carregar mensagens anteriores" })).toBeVisible();
  });
});

describe("Discord import dialog", () => {
  const server = { id: "server-1", name: "Amigos", ownerId: "user-1" };
  const view: DiscordServer = {
    messageContent: false,
    guilds: [{
      id: "700", name: "Comunidade", icon: null, available: true, error: null,
      channels: [
        { id: "500", name: "geral", category: "Texto", readable: true, import: null },
        { id: "501", name: "secreto", category: "Texto", readable: false, import: null },
      ],
    }],
    imports: [],
  };

  it("imports readable channels and follows their progress", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "serverDiscord").mockResolvedValue(view);
    const create = vi.spyOn(api, "importDiscord").mockResolvedValue(imported({ status: "queued", imported: 0 }));
    const live = realtime();
    const open = vi.fn();
    render(<DiscordImportDialog server={server} realtime={live.client} onClose={() => {}} onOpenChannel={open} />);
    expect(await screen.findByText(/sem acesso ao conteúdo das mensagens/)).toBeVisible();
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[1]).getByText("Sem permissão para ler")).toBeVisible();
    expect(within(rows[1]).queryByRole("button", { name: /Importar/ })).not.toBeInTheDocument();

    await user.click(within(rows[0]).getByRole("button", { name: "Importar" }));
    expect(create).toHaveBeenCalledWith("server-1", "700", "500");
    expect(await within(rows[0]).findByText("Na fila para importar")).toBeVisible();
    live.emit({ type: "discord.import", serverId: "server-1", import: imported({ imported: 1234 }) });
    expect(within(rows[0]).getByText("Importando histórico… 1.234 mensagens")).toBeVisible();
    live.emit({ type: "discord.import", serverId: "server-1", import: imported({ phase: "done", status: "idle", imported: 1250 }) });
    expect(within(rows[0]).getByText("Importado · 1.250 mensagens")).toBeVisible();
    // Finished imports are not followed: no sync action.
    expect(within(rows[0]).queryByRole("button", { name: /Tentar de novo|Sincronizar/ })).not.toBeInTheDocument();
    await user.click(within(rows[0]).getByRole("button", { name: "Abrir" }));
    expect(open).toHaveBeenCalledWith("mirror-1");
  });

  it("retries or finishes failed imports and connects new Discord servers in the browser", async () => {
    const user = userEvent.setup();
    const failed = imported({ status: "error", error: "O bot não tem acesso a este canal." });
    vi.spyOn(api, "serverDiscord").mockResolvedValue({
      ...view, messageContent: true,
      guilds: [{ ...view.guilds[0], channels: [{ ...view.guilds[0].channels[0], import: failed }] }],
      imports: [failed],
    });
    const sync = vi.spyOn(api, "retryDiscord").mockResolvedValue(imported({ status: "queued" }));
    const finish = vi.spyOn(api, "finishDiscord").mockResolvedValue(imported({ phase: "done", status: "idle" }));
    vi.spyOn(api, "installDiscord").mockResolvedValue({ url: "https://discord.com/oauth2/authorize?x=1" });
    const popup = vi.spyOn(window, "open").mockReturnValue(null);
    render(<DiscordImportDialog server={server} realtime={realtime().client} onClose={() => {}} onOpenChannel={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("O bot não tem acesso a este canal.");
    expect(screen.queryByText(/sem acesso ao conteúdo/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(sync).toHaveBeenCalledWith("mirror-1");
    await user.click(screen.getByRole("button", { name: "Concluir com o que já foi importado" }));
    expect(finish).toHaveBeenCalledWith("mirror-1");
    await user.click(screen.getByRole("button", { name: "Conectar outro servidor do Discord" }));
    await waitFor(() => expect(popup).toHaveBeenCalledWith("https://discord.com/oauth2/authorize?x=1", "_blank", "noopener,noreferrer"));
    expect(screen.getByText(/Conclua a instalação no navegador/)).toBeVisible();
  });

  it("describes each import state", () => {
    expect(importStatus(imported({ status: "queued", imported: 0 })).text).toBe("Na fila para importar");
    expect(importStatus(imported({ status: "running", imported: 1 })).text).toBe("Importando histórico… 1 mensagem");
    expect(importStatus(imported({ phase: "done", status: "idle", imported: 1 })).text).toBe("Importado · 1 mensagem");
    expect(importStatus(imported({ status: "error", error: null })).tone).toBe("error");
  });
});

describe("activities", () => {
  it("labels and updates activities", () => {
    expect(activityLabel(minecraft)).toBe("Jogando Minecraft");
    expect(activityLabel({ ...minecraft, kind: "listening", name: "Spotify" })).toBe("Ouvindo Spotify");
    const current = withActivity({}, "u1", minecraft);
    expect(current).toEqual({ u1: minecraft });
    expect(withActivity(current, "u1", null)).toEqual({});
    expect(withActivity(current, "u2", null)).toBe(current);
  });

  it("shows what the person is doing on their profile card", () => {
    const person = { id: "u1", email: "a@example.com", name: "Ana", bio: "Oi" };
    render(<ProfileCardProvider profiles={{}} activities={{ u1: minecraft }}><ProfileSummary user={person} /></ProfileCardProvider>);
    expect(screen.getByText("Jogando Minecraft")).toBeVisible();
    expect(screen.getByText("Sobrevivência")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("shows the activity thumbnail, falling back to the icon when it fails", () => {
    const person = { id: "u1", email: "a@example.com", name: "Ana" };
    const spotify: Activity = { ...minecraft, kind: "listening", name: "Spotify", image: "https://i.scdn.co/image/abc", imageText: "Álbum" };
    render(<ProfileCardProvider profiles={{}} activities={{ u1: spotify }}><ProfileSummary user={person} /></ProfileCardProvider>);
    const art = screen.getByRole("img", { name: "Álbum" });
    expect(art).toHaveAttribute("src", "https://i.scdn.co/image/abc");
    act(() => { art.dispatchEvent(new Event("error")); });
    expect(screen.queryByRole("img", { name: "Álbum" })).not.toBeInTheDocument();
    expect(screen.getByText("Ouvindo Spotify")).toBeVisible();
  });

  it("explains authors known only from Discord", () => {
    render(<ProfileSummary user={{ id: "x", email: "", name: "Pessoa", discord: "pessoa" }} />);
    expect(screen.getByText("@pessoa · Discord")).toBeVisible();
    expect(screen.queryByText("Sobre mim")).not.toBeInTheDocument();
  });
});

describe("Discord connection settings", () => {
  const status = (account: Partial<DiscordStatus["account"]> | null, presence = true): DiscordStatus => ({
    enabled: true, presence,
    account: account && { id: "10", username: "ana", displayName: "Ana", avatar: null, shareActivity: true, presenceSeen: true, ...account },
  });
  const settings = (live = realtime()) => render(<Settings user={{ id: "u1", email: "a@example.com", name: "Ana" }} page="connections" onPage={() => {}} onClose={() => {}}
    onLogout={() => {}} leaving={false} error="" inCall={false} callDevices={null} onUserChange={() => {}} realtime={live.client} />);

  it("explains when the activity can sync", () => {
    expect(presenceHelp(status({ shareActivity: false }))).toMatch(/não aparece para ninguém/);
    expect(presenceHelp(status({}, false))).toMatch(/não está recebendo presenças/);
    expect(presenceHelp(status({ presenceSeen: false }))).toMatch(/servidores em comum/);
    expect(presenceHelp(status({}))).toMatch(/^Sincronizando/);
  });

  it("links an account and controls sharing", async () => {
    const user = userEvent.setup();
    const load = vi.spyOn(api, "discord").mockResolvedValueOnce(status(null)).mockResolvedValue(status({ presenceSeen: false }));
    vi.spyOn(api, "linkDiscord").mockResolvedValue({ url: "https://discord.com/oauth2/authorize?scope=identify" });
    const update = vi.spyOn(api, "updateDiscord").mockResolvedValue(undefined);
    const popup = vi.spyOn(window, "open").mockReturnValue(null);
    const live = realtime();
    settings(live);
    await user.click(await screen.findByRole("button", { name: "Conectar conta do Discord" }));
    expect(popup).toHaveBeenCalledWith("https://discord.com/oauth2/authorize?scope=identify", "_blank", "noopener,noreferrer");
    // The API announces the link when Discord redirects back.
    live.emit({ type: "discord.updated", serverId: null });
    expect(await screen.findByText("@ana")).toBeVisible();
    expect(screen.getByText(/servidores em comum/)).toBeVisible();
    await user.click(screen.getByRole("switch", { name: /Mostrar minha atividade do Discord/ }));
    expect(update).toHaveBeenCalledWith({ shareActivity: false });
    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThanOrEqual(3));
  });

  it("says when the integration is not configured", async () => {
    vi.spyOn(api, "discord").mockResolvedValue({ enabled: false, presence: false, account: null });
    settings();
    expect(await screen.findByText(/não está configurada/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Conectar conta do Discord" })).not.toBeInTheDocument();
  });
});
