import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, RealtimeEvent, User } from "@disc-voice/shared";
import { api } from "../lib/api";
import * as files from "../lib/files";
import { mediaFileName } from "../lib/files";
import type { Realtime } from "../lib/realtime";
import { serverRoles, everyone } from "../test/serverRoles";
import { menuEntries, menuPosition, SEPARATOR, useContextMenu } from "./ContextMenu";
import { ImageThumb } from "./MessageContent";
import { ProfileButton, ProfileCardProvider } from "./ProfileCard";
import { ServerRolesProvider } from "./ServerRoles";
import { TextChannel } from "./TextChannel";

const me: User = { id: "me", email: "me@example.com", name: "Eu" };
const ana: User = { id: "ana", email: "ana@example.com", name: "Ana Souza" };
const channel = { id: "channel-1", serverId: "server", name: "geral", type: "text" as const };
const chat = (id: string, content: string, author: User = ana, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, channelId: channel.id, clientId: `client-${id}`, author, content, createdAt: "2026-11-17T10:00:00Z", ...extra });

function realtime() {
  const listeners = new Set<(event: RealtimeEvent) => void>();
  return {
    client: { onEvent: (fn: (event: RealtimeEvent) => void) => { listeners.add(fn); return () => listeners.delete(fn); }, send: vi.fn() } as unknown as Realtime,
    emit: (event: RealtimeEvent) => act(() => listeners.forEach(fn => fn(event))),
  };
}

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });
});
afterEach(() => vi.restoreAllMocks());

describe("menu entries", () => {
  it("drops hidden items and stray separators", () => {
    const item = (label: string) => ({ label, onSelect: () => {} });
    expect(menuEntries([SEPARATOR, item("A"), false, SEPARATOR, SEPARATOR, null, item("B"), SEPARATOR, undefined]).map(e => e === SEPARATOR ? "-" : e.label))
      .toEqual(["A", "-", "B"]);
    expect(menuEntries([item("A"), SEPARATOR, false])).toHaveLength(1);
  });

  it("opens at the cursor and flips away from the edges", () => {
    const viewport = { width: 1000, height: 800 };
    expect(menuPosition(100, 100, 200, 150, viewport)).toEqual({ left: 100, top: 100 });
    // Near the right and bottom edges it opens to the left of and above the cursor.
    expect(menuPosition(950, 780, 200, 150, viewport)).toEqual({ left: 750, top: 630 });
    // Never off screen, even when it can't flip.
    expect(menuPosition(50, 50, 200, 150, { width: 220, height: 160 })).toEqual({ left: 8, top: 8 });
  });
});

function Demo({ onPick }: { onPick: (label: string) => void }) {
  const menu = useContextMenu();
  return <>
    <button type="button" onContextMenu={event => menu.open(event, "Demo", [
      { label: "Primeiro", onSelect: () => onPick("Primeiro") },
      { label: "Segundo", onSelect: () => onPick("Segundo") },
      SEPARATOR,
      { label: "Terceiro", danger: true, onSelect: () => onPick("Terceiro") },
    ])}>Alvo</button>
    <p>Fora</p>
    {menu.element}
  </>;
}

describe("context menu", () => {
  it("replaces the webview's menu and works from the keyboard", async () => {
    const user = userEvent.setup();
    const pick = vi.fn();
    render(<Demo onPick={pick} />);
    const target = screen.getByRole("button", { name: "Alvo" });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
    act(() => { target.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    const menu = screen.getByRole("menu", { name: "Demo" });
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["Primeiro", "Segundo", "Terceiro"]);
    expect(screen.getByRole("separator")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Primeiro" })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Segundo" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Primeiro" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Terceiro" })).toHaveFocus();
    await user.keyboard("s");
    expect(screen.getByRole("menuitem", { name: "Segundo" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(pick).toHaveBeenCalledWith("Segundo");
    expect(menu).not.toBeInTheDocument();
    expect(target).toHaveFocus();
  });

  it("closes with Escape and with a click outside", async () => {
    const user = userEvent.setup();
    render(<Demo onPick={() => {}} />);
    const target = screen.getByRole("button", { name: "Alvo" });
    fireEvent.contextMenu(target);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(target).toHaveFocus();
    fireEvent.contextMenu(target);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(screen.getByText("Fora"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("user menu", () => {
  const friends = (relation: "none" | "outgoing" | "incoming" | "friends") => ({
    friends: relation === "friends" ? [{ user: ana, status: "online" as const, since: "" }] : [],
    incoming: relation === "incoming" ? [{ user: ana, createdAt: "" }] : [],
    outgoing: relation === "outgoing" ? [{ user: ana, createdAt: "" }] : [],
    add: vi.fn(async () => {}), accept: vi.fn(async () => {}), remove: vi.fn(async () => {}),
  });

  it("offers the profile, a friend request, a direct message and, for who may, a ban", async () => {
    const user = userEvent.setup();
    const state = friends("none");
    const onMessage = vi.fn();
    const roles = serverRoles(me.id, [{ user: me, owner: true, roles: [] }, { user: ana, owner: false, roles: [] }]);
    const { rerender } = render(<ServerRolesProvider value={roles}><ProfileCardProvider profiles={{}} selfId={me.id} friends={state} onMessage={onMessage}>
      <ProfileButton user={ana} />
    </ProfileCardProvider></ServerRolesProvider>);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Ana Souza" }));
    expect(screen.getByRole("menu", { name: "Ações de Ana Souza" })).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem").map(item => item.textContent))
      .toEqual(["Exibir perfil", "Enviar pedido de amizade", "Enviar mensagem direta", "Banir usuário"]);
    await user.click(screen.getByRole("menuitem", { name: "Enviar pedido de amizade" }));
    expect(state.add).toHaveBeenCalledWith(ana.id);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Ana Souza" }));
    await user.click(screen.getByRole("menuitem", { name: "Enviar mensagem direta" }));
    expect(onMessage).toHaveBeenCalledWith(ana);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Ana Souza" }));
    await user.click(screen.getByRole("menuitem", { name: "Exibir perfil" }));
    expect(screen.getByRole("dialog", { name: "Perfil de Ana Souza" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    fireEvent.contextMenu(screen.getByRole("button", { name: "Ana Souza" }));
    await user.click(screen.getByRole("menuitem", { name: "Banir usuário" }));
    expect(screen.getByRole("dialog", { name: /Banir Ana Souza/ })).toBeInTheDocument();

    // A pending request can be undone; without the permission there is no ban.
    const pending = friends("outgoing");
    const plain = serverRoles(me.id, [{ user: me, owner: false, roles: [] }, { user: ana, owner: true, roles: [] }], [everyone()]);
    rerender(<ServerRolesProvider value={plain}><ProfileCardProvider profiles={{}} selfId={me.id} friends={pending} onMessage={onMessage}>
      <ProfileButton user={ana} />
    </ProfileCardProvider></ServerRolesProvider>);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Ana Souza" }));
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["Exibir perfil", "Desfazer pedido", "Enviar mensagem direta"]);
    await user.click(screen.getByRole("menuitem", { name: "Desfazer pedido" }));
    expect(pending.remove).toHaveBeenCalledWith(ana.id);
  });

  it("shows only the profile for oneself", () => {
    render(<ProfileCardProvider profiles={{}} selfId={me.id} friends={friends("none")} onMessage={() => {}}><ProfileButton user={me} /></ProfileCardProvider>);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Eu" }));
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["Exibir perfil"]);
  });
});

describe("media menu", () => {
  it("downloads the image", async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(files, "saveMedia").mockResolvedValue(null);
    render(<ImageThumb url="https://cdn.example/gato.png" name="gato.png" onView={() => {}} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Ver imagem gato.png" }));
    await user.click(screen.getByRole("menuitem", { name: "Fazer download" }));
    expect(save).toHaveBeenCalledWith("https://cdn.example/gato.png", "gato.png");
  });

  it("names the file by its type", () => {
    expect(mediaFileName("Gato dançando.gif", "image/webp")).toBe("Gato dançando.webp");
    expect(mediaFileName("foto", "image/jpeg")).toBe("foto.jpg");
    expect(mediaFileName("doc.pdf", "application/pdf")).toBe("doc.pdf");
  });
});

describe("message menu and replies", () => {
  it("replies to a message and shows what it answers", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [chat("1", "Bora jogar?")], hasMore: false });
    const send = vi.spyOn(api, "sendMessage").mockImplementation(async (_, clientId, content, _gif, _files, replyTo) =>
      chat("2", content, me, { clientId, replyTo: replyTo ? { id: replyTo, author: ana, content: "Bora jogar?" } : undefined }));
    const live = realtime();
    render(<TextChannel channel={channel} realtime={live.client} revision={1} self={me} members={[me, ana]} />);
    const original = (await screen.findByText("Bora jogar?")).closest("article")!;
    fireEvent.contextMenu(original);
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["Responder", "Reagir com emoji", "Responder com GIF"]);
    await user.click(screen.getByRole("menuitem", { name: "Responder" }));
    expect(screen.getByText(/Respondendo a/)).toHaveTextContent("Respondendo a Ana Souza");
    const field = screen.getByRole("textbox");
    expect(field).toHaveFocus();
    await user.type(field, "Bora!{Enter}");
    expect(send).toHaveBeenCalledWith(channel.id, expect.any(String), "Bora!", undefined, undefined, "1");
    expect(screen.queryByText(/Respondendo a/)).not.toBeInTheDocument();
    const quote = await screen.findByRole("button", { name: "Resposta a Ana Souza: Bora jogar?. Ir para a mensagem" });
    expect(quote).toBeVisible();

    // Esc cancels a reply; deleting the original leaves the reply pointing to nothing.
    fireEvent.contextMenu(original);
    await user.click(screen.getByRole("menuitem", { name: "Responder" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByText(/Respondendo a/)).not.toBeInTheDocument();
    live.emit({ type: "message.deleted", channelId: channel.id, messageId: "1" });
    expect(screen.getByText("Mensagem original excluída")).toBeVisible();
  });

  it("offers editing and deleting one's own message, and reacting with an emoji", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [chat("1", "Minha mensagem", me)], hasMore: false });
    render(<TextChannel channel={channel} realtime={realtime().client} revision={1} self={me} members={[me, ana]} />);
    const row = (await screen.findByText("Minha mensagem")).closest("article")!;
    fireEvent.contextMenu(row);
    expect(screen.getAllByRole("menuitem").map(item => item.textContent))
      .toEqual(["Responder", "Reagir com emoji", "Responder com GIF", "Editar mensagem", "Excluir mensagem"]);
    await user.click(screen.getByRole("menuitem", { name: "Reagir com emoji" }));
    expect(screen.getByRole("dialog", { name: "Reagir à mensagem" })).toBeInTheDocument();
    fireEvent.contextMenu(row);
    await user.click(screen.getByRole("menuitem", { name: "Editar mensagem" }));
    expect(screen.getByRole("textbox", { name: "Editar mensagem" })).toHaveValue("Minha mensagem");
  });
});
