import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordStatus, RealtimeEvent } from "@disc-voice/shared";
import { api } from "../lib/api";
import type { Realtime } from "../lib/realtime";
import { ServerDialog } from "./ServerDialog";

function realtime() {
  const listeners = new Set<(event: RealtimeEvent) => void>();
  return {
    client: { onEvent: (fn: (event: RealtimeEvent) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; } } as unknown as Realtime,
    emit: (event: RealtimeEvent) => act(() => listeners.forEach(listener => listener(event))),
  };
}

const account = { id: "31", username: "bia", displayName: "Bia", avatar: null, shareActivity: true, presenceSeen: false, canListGuilds: true };
const status = (linked: boolean): DiscordStatus => ({ enabled: true, presence: true, account: linked ? account : null, clientId: null });
const server = { id: "server-8", name: "Outro Servidor", ownerId: "user-1", icon: null };

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); },
  });
});
afterEach(() => vi.restoreAllMocks());

function open(live = realtime()) {
  const onServer = vi.fn();
  render(<ServerDialog mode={{ kind: "create" }} realtime={live.client} onClose={() => {}} onServer={onServer} onChannel={() => {}} />);
  return { onServer, live };
}

describe("creating a server", () => {
  it("imports a Discord server whose bot is added in the browser", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "discord").mockResolvedValue(status(true));
    vi.spyOn(api, "discordGuilds").mockResolvedValue([
      { id: "700", name: "Comunidade", icon: null, botInstalled: true, importedServerId: "server-7" },
      { id: "800", name: "Outro Servidor", icon: null, botInstalled: false, importedServerId: null },
    ]);
    const start = vi.spyOn(api, "importDiscordGuild").mockResolvedValue({
      server: { code: "c", url: "u", server }, installUrl: "https://discord.com/oauth2/authorize?guild_id=800", channels: 0, warning: null,
    });
    const popup = vi.spyOn(window, "open").mockReturnValue(null);
    const { onServer, live } = open();
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Importar do Discord/ }));
    const list = await within(dialog).findByRole("list", { name: "Seus servidores do Discord" });
    // Already imported servers are not offered again.
    expect(within(list).getByText("Já importado")).toBeVisible();
    await user.click(within(list).getByRole("button", { name: "Importar Outro Servidor" }));
    expect(start).toHaveBeenCalledWith("800");
    expect(onServer).toHaveBeenCalledWith(server);
    expect(popup).toHaveBeenCalledWith("https://discord.com/oauth2/authorize?guild_id=800", "_blank", "noopener,noreferrer");
    expect(within(list).getByText(/Adicione o bot no navegador/)).toBeVisible();
    // The API announces the channels once the bot is in.
    live.emit({ type: "discord.updated", serverId: server.id });
    expect(await within(list).findByText("Importado com os canais do Discord.")).toBeVisible();
  });

  it("asks to connect Discord before listing its servers", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "discord").mockResolvedValue(status(false));
    vi.spyOn(api, "linkDiscord").mockResolvedValue({ url: "https://discord.com/oauth2/authorize?scope=identify+guilds" });
    vi.spyOn(window, "open").mockReturnValue(null);
    open();
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Importar do Discord/ }));
    await user.click(await within(dialog).findByRole("button", { name: "Conectar conta do Discord" }));
    expect(await within(dialog).findByText(/Conclua a autorização no navegador/)).toBeVisible();
    // Or go back and just give it a name.
    await user.click(within(dialog).getByRole("button", { name: "Voltar" }));
    await user.click(within(dialog).getByRole("button", { name: /Criar do zero/ }));
    expect(within(dialog).getByLabelText("Nome do servidor")).toBeVisible();
  });
});
