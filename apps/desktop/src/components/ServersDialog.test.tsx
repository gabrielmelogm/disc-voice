import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server, User } from "@disc-voice/shared";
import { api } from "../lib/api";
import type { Voice, VoiceState } from "../lib/voice";
import { AppBar } from "./AppBar";
import { ServerDialog } from "./ServerDialog";
import { memberCount, serverCount, ServersDialog } from "./ServersDialog";

const servers: Server[] = [
  { id: "s1", name: "Estúdio Norte", ownerId: "u1" },
  { id: "s2", name: "Clube do Livro", ownerId: "u2" },
  { id: "s3", name: "Jogos de sexta", ownerId: "u2" },
];

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); },
  });
  vi.spyOn(api, "servers").mockResolvedValue([
    { ...servers[0], memberCount: 24, onlineCount: 9 },
    { ...servers[1], memberCount: 1204, onlineCount: 312 },
    { ...servers[2], memberCount: 1, onlineCount: 0 },
  ]);
  vi.spyOn(api, "discord").mockResolvedValue({ enabled: true, presence: true, account: null, clientId: null });
});
afterEach(() => vi.restoreAllMocks());

function open(props: Partial<Parameters<typeof ServersDialog>[0]> = {}) {
  const handlers = { onClose: vi.fn(), onOpen: vi.fn(), onCreate: vi.fn(), onJoin: vi.fn(), onImport: vi.fn() };
  render(<ServersDialog servers={servers} currentId="s1" unread={{ s3: 5 }} {...handlers} {...props} />);
  return { ...handlers, dialog: screen.getByRole("dialog", { name: "Seus servidores" }) };
}

describe("managing servers", () => {
  it("shows every server with its members, who is online and unread messages", async () => {
    const { dialog } = open();
    expect(within(dialog).getByText("3 servidores")).toBeVisible();
    const grid = within(dialog).getByRole("list", { name: "Seus servidores" });
    const here = within(grid).getByRole("button", { name: "Abrir Estúdio Norte, você está aqui" });
    expect(here).toHaveAttribute("aria-current", "true");
    expect(within(here).getByText("Você está aqui")).toBeVisible();
    expect(await within(here).findByText("24 membros")).toBeVisible();
    expect(within(here).getByText("9 online")).toBeVisible();
    expect(within(grid).getByText("1.204 membros")).toBeVisible();
    expect(within(grid).getByText("1 membro")).toBeVisible();
    const unread = within(grid).getByRole("button", { name: "Abrir Jogos de sexta, 5 mensagens não lidas" });
    expect(within(unread).getByText("5")).toBeVisible();
    expect(within(grid).getByRole("button", { name: "Criar ou entrar em um servidor" })).toBeVisible();
  });

  it("opens a server and closes", async () => {
    const user = userEvent.setup();
    const { dialog, onOpen, onClose } = open();
    await user.click(within(dialog).getByRole("button", { name: /^Abrir Clube do Livro/ }));
    expect(onOpen).toHaveBeenCalledWith(servers[1]);
    expect(onClose).toHaveBeenCalled();
  });

  it("searches by name, ignoring accents, and shows what to do when nothing matches", async () => {
    const user = userEvent.setup();
    const { dialog, onJoin } = open();
    const search = within(dialog).getByRole("textbox", { name: "Buscar servidores pelo nome" });
    expect(search).toHaveFocus();
    await user.type(search, "estudio");
    const grid = within(dialog).getByRole("list", { name: "Seus servidores" });
    expect(within(grid).getAllByRole("button").map(b => b.getAttribute("aria-label"))).toEqual(["Abrir Estúdio Norte, você está aqui"]);
    expect(within(dialog).getByText("1 de 3 servidores")).toBeVisible();

    await user.clear(search);
    await user.type(search, "xadrez");
    expect(within(dialog).getByText("Nenhum resultado")).toBeVisible();
    const heading = within(dialog).getByRole("heading", { name: "Nenhum servidor com “xadrez”" });
    expect(heading).toBeVisible();
    await user.click(within(heading.parentElement!).getByRole("button", { name: "Limpar busca" }));
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(within(dialog).getByText("3 servidores")).toBeVisible();

    await user.type(search, "xadrez");
    const empty = within(dialog).getByRole("heading", { name: /Nenhum servidor/ }).parentElement!;
    await user.click(within(empty).getByRole("button", { name: "Entrar com convite" }));
    expect(onJoin).toHaveBeenCalled();
  });

  it("clears the search with Esc, then closes the drawer, and only then the dialog", async () => {
    const user = userEvent.setup();
    const { dialog, onClose } = open();
    const search = within(dialog).getByRole("textbox", { name: "Buscar servidores pelo nome" });
    await user.type(search, "clube");
    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    await user.keyboard("{Escape}");
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    const toggle = within(dialog).getByRole("button", { name: "Buscar servidores" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(toggle);
    await waitFor(() => expect(within(dialog).getByRole("textbox")).toHaveFocus());
  });

  it("creates, joins or imports a server from the drawer", async () => {
    const user = userEvent.setup();
    const { dialog, onCreate, onJoin, onImport } = open();
    const drawer = within(dialog).getByRole("complementary", { name: "Buscar servidores" });
    await user.click(within(drawer).getByRole("button", { name: "Criar servidor" }));
    await user.click(within(drawer).getByRole("button", { name: "Entrar com convite" }));
    await user.click(await within(drawer).findByRole("button", { name: "Importar do Discord" }));
    expect(onCreate).toHaveBeenCalled();
    expect(onJoin).toHaveBeenCalled();
    expect(onImport).toHaveBeenCalled();
  });

  it("hides importing when the Discord integration is off", async () => {
    vi.mocked(api.discord).mockResolvedValue({ enabled: false, presence: false, account: null, clientId: null });
    const { dialog } = open();
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Importar do Discord" })).not.toBeInTheDocument());
  });

  it("writes counts in Portuguese", () => {
    expect(serverCount(1)).toBe("1 servidor");
    expect(serverCount(8)).toBe("8 servidores");
    expect(memberCount(1204)).toBe("1.204 membros");
  });
});

describe("opening the grid and its actions", () => {
  it("is in the server switcher of the app bar", async () => {
    const user = userEvent.setup();
    const onManageServers = vi.fn();
    const me: User = { id: "u1", email: "levi@example.com", name: "Levi" };
    const idle = { status: "idle", channel: null, participants: [], muted: false, deafened: false, devices: [], cameras: [], screen: "idle", camera: "idle" } as unknown as VoiceState;
    render(<AppBar user={me} servers={servers} server={servers[0]} view="server" voice={{} as Voice} voiceState={idle} canJoinVoice
      onSelectServer={() => {}} onCreateServer={() => {}} onJoinServer={() => {}} onManageServers={onManageServers} onDms={() => {}} onVoice={() => {}}
      onSettings={() => {}} onVoiceSettings={() => {}} onSearch={() => {}} />);
    await user.click(screen.getByRole("button", { name: /^Trocar de servidor/ }));
    await user.click(within(screen.getByRole("menu", { name: "Servidores" })).getByRole("menuitem", { name: "Gerenciar servidores" }));
    expect(onManageServers).toHaveBeenCalled();
    expect(screen.queryByRole("menu", { name: "Servidores" })).not.toBeInTheDocument();
  });

  it("goes straight to importing from Discord", async () => {
    render(<ServerDialog mode={{ kind: "create", step: "discord" }} onClose={() => {}} onServer={() => {}} onChannel={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "Importar do Discord" });
    expect(await within(dialog).findByRole("button", { name: "Conectar conta do Discord" })).toBeVisible();
  });
});
