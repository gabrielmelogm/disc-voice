import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectConversation, Server, User } from "@disc-voice/shared";
import { api } from "../lib/api";
import { ChannelSidebar } from "./ChannelSidebar";
import { DirectMessagesSidebar, NewMessageDialog } from "./DirectMessages";
import type { VoiceState } from "../lib/voice";

const elisa: User = { id: "elisa", email: "elisa@example.com", name: "Elisa Prado" };
const bruno: User = { id: "bruno", email: "bruno@example.com", name: "Bruno" };
const conversation = (user: User): DirectConversation => ({
  channel: { id: `dm-${user.id}`, serverId: null, name: "dm", type: "dm" }, user, lastMessageId: null,
});

describe("direct messages sidebar", () => {
  const props = {
    conversations: [conversation(elisa), conversation(bruno)],
    selectedId: "dm-bruno",
    unread: { "dm-elisa": 3, "dm-bruno": 2 },
    selfId: "me",
    loading: false, error: "", onSelect: vi.fn(), onFriends: vi.fn(), onNew: vi.fn(), onRetry: vi.fn(),
  };

  it("previews the newest message of each conversation", () => {
    const preview = (authorId: string, content: string) => ({ id: "9", authorId, content, createdAt: "2026-11-23T10:00:00Z" });
    render(<DirectMessagesSidebar {...props} conversations={[
      { ...conversation(elisa), lastMessage: preview("elisa", "Bora jogar\nhoje?") },
      { ...conversation(bruno), lastMessage: preview("me", "") },
    ]} />);
    expect(screen.getByText("Bora jogar hoje?")).toBeVisible();
    expect(screen.getByText("Você: Anexo")).toBeVisible();
  });

  it("opens the friends page, showing pending requests", async () => {
    const user = userEvent.setup();
    const onFriends = vi.fn();
    render(<DirectMessagesSidebar {...props} selectedId={null} friendsOpen requests={2} onFriends={onFriends} />);
    const entry = screen.getByRole("button", { name: "Amigos, 2 pedidos pendentes" });
    expect(entry).toHaveAttribute("aria-pressed", "true");
    await user.click(entry);
    expect(onFriends).toHaveBeenCalled();
  });

  it("shows unread conversations in bold with a badge, except the open one", () => {
    render(<DirectMessagesSidebar {...props} />);
    const unread = screen.getByRole("button", { name: /Elisa Prado/ });
    expect(unread).toHaveClass("unread");
    expect(screen.getByLabelText("3 mensagens não lidas")).toHaveTextContent("3");
    expect(screen.getByRole("button", { name: /Bruno/ })).not.toHaveClass("unread");
  });

  it("filters conversations by name", async () => {
    const user = userEvent.setup();
    render(<DirectMessagesSidebar {...props} />);
    await user.type(screen.getByLabelText("Encontrar conversa"), "eli");
    expect(screen.getByRole("button", { name: /Elisa Prado/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Bruno/ })).not.toBeInTheDocument();
  });
});

describe("new message dialog", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); },
    });
  });

  it("finds people of the user's servers and opens the conversation", async () => {
    const user = userEvent.setup();
    const search = vi.spyOn(api, "search").mockResolvedValue({ channels: [], messages: [], nextCursor: null, people: [elisa, { ...bruno, id: "me" }] });
    const onPick = vi.fn().mockResolvedValue(undefined);
    render(<NewMessageDialog selfId="me" onPick={onPick} onClose={() => {}} />);
    await user.type(screen.getByLabelText("Buscar pessoas"), "eli");
    await user.click(await screen.findByRole("button", { name: /Elisa Prado/ }));
    expect(search).toHaveBeenCalledWith("eli", undefined, expect.any(AbortSignal));
    expect(onPick).toHaveBeenCalledWith(elisa);
    // The user is never offered to themselves.
    expect(screen.queryByRole("button", { name: /Bruno/ })).not.toBeInTheDocument();
  });

  it("explains why a conversation could not start", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "search").mockResolvedValue({ channels: [], messages: [], nextCursor: null, people: [elisa] });
    const onPick = vi.fn().mockRejectedValue(new Error("Você só pode conversar com pessoas dos seus servidores."));
    render(<NewMessageDialog selfId="me" onPick={onPick} onClose={() => {}} />);
    await user.type(screen.getByLabelText("Buscar pessoas"), "eli");
    await user.click(await screen.findByRole("button", { name: /Elisa Prado/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Você só pode conversar"));
  });
});

describe("channel sidebar", () => {
  it("marks channels with unread messages, but not the open one", () => {
    const server: Server = { id: "s", name: "Servidor", ownerId: "me" };
    const channels = [
      { id: "geral", serverId: "s", name: "geral", type: "text" as const },
      { id: "jogos", serverId: "s", name: "jogos", type: "text" as const },
      { id: "memes", serverId: "s", name: "memes", type: "text" as const },
    ];
    const voiceState = { channel: null, status: "idle", participants: [], speaking: [] } as unknown as VoiceState;
    render(<ChannelSidebar server={server} channels={channels} channelId="geral" unread={{ geral: 4, jogos: 120 }} participants={{}}
      voiceState={voiceState} loading={false} error="" onSelect={() => {}} onJoin={() => {}} onCreate={() => {}} onInvite={() => {}} onReload={() => {}} />);
    expect(screen.getByRole("button", { name: /jogos/ })).toHaveClass("unread");
    expect(screen.getByLabelText("Mais de 99 mensagens não lidas")).toHaveTextContent("99+");
    expect(screen.getByRole("button", { name: /^geral/ })).not.toHaveClass("unread");
    expect(screen.getByRole("button", { name: /memes/ })).not.toHaveClass("unread");
  });
});
