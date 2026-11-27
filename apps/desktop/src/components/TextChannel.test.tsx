import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, RealtimeEvent } from "@disc-voice/shared";
import { refreshMessages, TextChannel } from "./TextChannel";
import type { Realtime } from "../lib/realtime";
import { api } from "../lib/api";

const channel = { id: "channel-1", serverId: "server-1", name: "geral", type: "text" as const };
const author = { id: "user-1", email: "amigo@example.com", name: "Amigo" };
const chat = (id: string, content: string): ChatMessage => ({
  id, channelId: channel.id, clientId: `client-${id}`, author, content, createdAt: "2026-11-17T10:00:00Z",
});
function realtime() {
  const listeners = new Set<(event: RealtimeEvent) => void>();
  const send = vi.fn();
  return {
    client: {
      onEvent: (fn: (event: RealtimeEvent) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
      send,
    } as unknown as Realtime,
    send,
    emit: (event: RealtimeEvent) => act(() => listeners.forEach(fn => fn(event))),
  };
}

describe("text chat", () => {
  it("retries with the same client id and deduplicates the live acknowledgement", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [], hasMore: false });
    const send = vi.spyOn(api, "sendMessage").mockRejectedValueOnce(new Error("Sem conexão"));
    const live = realtime();
    render(<TextChannel channel={channel} realtime={live.client} revision={1} />);
    await user.type(screen.getByRole("textbox"), "Olá comunidade");
    await user.click(screen.getByRole("button", { name: "Enviar mensagem" }));
    expect(await screen.findByText(/Sem conexão/)).toBeVisible();
    const [, clientId] = send.mock.calls[0];
    const saved = { ...chat("1", "Olá comunidade"), clientId };
    send.mockResolvedValue(saved);
    await user.click(screen.getByRole("button", { name: "Reenviar" }));
    await waitFor(() => expect(screen.queryByText("Não enviada")).not.toBeInTheDocument());
    live.emit({ type: "message.created", message: saved });
    expect(screen.getAllByText("Olá comunidade")).toHaveLength(1);
    expect(send.mock.calls[1]).toEqual([channel.id, clientId, "Olá comunidade"]);
  });

  it("recovers gaps from the REST watermark rather than the last live event", async () => {
    const history = vi.spyOn(api, "messages").mockResolvedValueOnce({ messages: [chat("1", "Primeira")], hasMore: false })
      .mockResolvedValueOnce({ messages: [chat("2", "Perdida"), chat("3", "Ao vivo")], hasMore: false })
      .mockResolvedValueOnce({ messages: [chat("1", "Primeira"), chat("2", "Perdida"), chat("3", "Ao vivo")], hasMore: false });
    const live = realtime();
    const { rerender } = render(<TextChannel channel={channel} realtime={live.client} revision={1} />);
    await screen.findByText("Primeira");
    live.emit({ type: "message.created", message: chat("3", "Ao vivo") });
    rerender(<TextChannel channel={channel} realtime={live.client} revision={2} />);
    await screen.findByText("Perdida");
    expect(history.mock.calls[1][1]).toEqual({ after: "1" });
    // Then the newest page again, for edits and deletions missed meanwhile.
    await waitFor(() => expect(history.mock.calls[2]?.[1]).toEqual({ before: "4" }));
    expect(screen.getAllByText("Ao vivo")).toHaveLength(1);
    expect([...screen.getByRole("log").querySelectorAll("article .message-text")].map(p => p.textContent)).toEqual(["Primeira", "Perdida", "Ao vivo"]);
  });

  it("shows the current author name after a profile update", async () => {
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [chat("1", "Oi")], hasMore: false });
    const live = realtime();
    render(<TextChannel channel={channel} realtime={live.client} revision={1} />);
    await screen.findByText("Oi");
    live.emit({ type: "user.updated", user: { ...author, name: "Amiga Nova" } });
    expect(screen.getByRole("button", { name: "Amiga Nova" })).toBeVisible();
    expect(screen.queryByText("Amigo")).not.toBeInTheDocument();
  });

  it("opens at a focused message and catches up to the latest ones", async () => {
    const history = vi.spyOn(api, "messages")
      .mockResolvedValueOnce({ messages: [chat("4", "Antes"), chat("5", "Procurada")], hasMore: true })
      .mockResolvedValueOnce({ messages: [chat("6", "Depois")], hasMore: false });
    render(<TextChannel channel={channel} realtime={realtime().client} revision={1} focusId="5" />);
    await screen.findByText("Depois");
    expect(history.mock.calls[0][1]).toEqual({ before: "6" });
    expect(history.mock.calls[1][1]).toEqual({ after: "5" });
    expect(screen.getByText("Procurada").closest("article")).toHaveClass("is-focused");
    expect(screen.getByRole("button", { name: "Carregar mensagens anteriores" })).toBeVisible();
  });

  it("tells others the user is typing, at most once every few seconds", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const user = userEvent.setup();
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [], hasMore: false });
    const live = realtime();
    render(<TextChannel channel={channel} realtime={live.client} revision={1} />);
    await user.type(screen.getByRole("textbox"), "Oi");
    expect(live.send).toHaveBeenCalledTimes(1);
    expect(live.send).toHaveBeenCalledWith({ type: "typing.start", channelId: channel.id });
    vi.mocked(Date.now).mockReturnValue(13_500);
    await user.type(screen.getByRole("textbox"), "!");
    expect(live.send).toHaveBeenCalledTimes(2);
  });

  it("keeps working when the realtime connection is down", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [], hasMore: false });
    const live = realtime();
    live.send.mockImplementation(() => { throw new Error("offline"); });
    render(<TextChannel channel={channel} realtime={live.client} revision={1} />);
    await user.type(screen.getByRole("textbox"), "Oi");
    expect(screen.getByRole("textbox")).toHaveValue("Oi");
  });

  it("shows who is typing until they stop or send the message", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(api, "messages").mockResolvedValue({ messages: [], hasMore: false });
      const live = realtime();
      const elisa = { id: "user-2", email: "elisa@example.com", name: "Elisa Prado" };
      render(<TextChannel channel={channel} realtime={live.client} revision={1} self={{ id: "me", email: "eu@example.com", name: "Eu" }} />);
      live.emit({ type: "typing", channelId: channel.id, user: elisa });
      // Typing elsewhere, or our own echo, shows nothing.
      live.emit({ type: "typing", channelId: "other", user: author });
      live.emit({ type: "typing", channelId: channel.id, user: { id: "me", email: "eu@example.com", name: "Eu" } });
      expect(screen.getByText("Elisa Prado está digitando…")).toBeVisible();
      live.emit({ type: "typing", channelId: channel.id, user: author });
      expect(screen.getByText("Elisa Prado e Amigo estão digitando…")).toBeVisible();
      // Her message arrived: only Amigo is still typing.
      live.emit({ type: "message.created", message: { ...chat("9", "Pronto"), author: elisa } });
      expect(screen.getByText("Amigo está digitando…")).toBeVisible();
      // Without a new announcement, the indicator goes away.
      act(() => { vi.advanceTimersByTime(6_100); });
      expect(screen.queryByText(/digitando/)).not.toBeInTheDocument();
      expect(screen.getByText(/Enter para enviar/)).toBeVisible();
    } finally { vi.useRealTimers(); }
  });

  it("reports the newest message as read while the user sees the bottom of the chat", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [chat("1", "Oi"), chat("2", "Tudo bem?")], hasMore: false });
    const live = realtime();
    const onRead = vi.fn();
    render(<TextChannel channel={channel} realtime={live.client} revision={1} onRead={onRead} />);
    await waitFor(() => expect(onRead).toHaveBeenLastCalledWith("2"));
    live.emit({ type: "message.created", message: chat("3", "Nova") });
    expect(onRead).toHaveBeenLastCalledWith("3");
  });

  it("waits for the window to have focus before marking messages as read", async () => {
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [chat("1", "Oi")], hasMore: false });
    const onRead = vi.fn();
    render(<TextChannel channel={channel} realtime={realtime().client} revision={1} onRead={onRead} />);
    await screen.findByText("Oi");
    expect(onRead).not.toHaveBeenCalled();
    focus.mockReturnValue(true);
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(onRead).toHaveBeenCalledWith("1");
  });

  it("names the other person in a direct conversation", async () => {
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [], hasMore: false });
    const dm = { id: "dm-1", serverId: null, name: "dm", type: "dm" as const };
    render(<TextChannel channel={dm} peer={author} realtime={realtime().client} revision={1} />);
    expect(await screen.findByText("Esse é o começo da sua conversa com Amigo.")).toBeVisible();
    expect(screen.getByPlaceholderText("Conversar com Amigo")).toBeVisible();
  });

  describe("reactions, mentions, edits and deletes", () => {
    const me = { id: "00000000-0000-4000-8000-0000000000aa", email: "eu@example.com", name: "Levi" };
    const ana = { id: "00000000-0000-4000-8000-0000000000bb", email: "ana@example.com", name: "Ana Souza" };
    beforeEach(() => {
      Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
        configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); },
      });
      Object.defineProperty(HTMLDialogElement.prototype, "close", {
        configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); },
      });
    });

    it("shows reaction counts, highlights the user's own, and toggles them", async () => {
      const user = userEvent.setup();
      const reacted = { ...chat("1", "Bom dia"), author: ana, reactions: [
        { emoji: "🔥", count: 2, users: [ana.id, me.id] },
        { emoji: "👀", count: 1, users: [ana.id] },
      ] };
      vi.spyOn(api, "messages").mockResolvedValue({ messages: [reacted], hasMore: false });
      const react = vi.spyOn(api, "react").mockResolvedValue([{ emoji: "👀", count: 1, users: [ana.id] }]);
      const live = realtime();
      render(<TextChannel channel={channel} realtime={live.client} revision={1} self={me} members={[me, ana]} />);
      const fire = await screen.findByRole("button", { name: /Ana Souza e Você reagiram com 🔥/ });
      expect(fire).toHaveAttribute("aria-pressed", "true");
      expect(fire).toHaveTextContent("2");
      expect(screen.getByRole("button", { name: /Ana Souza reagiu com 👀/ })).toHaveAttribute("aria-pressed", "false");
      await user.click(fire);
      expect(react).toHaveBeenCalledWith(channel.id, "1", "🔥", false);
      await waitFor(() => expect(screen.queryByRole("button", { name: /com 🔥/ })).not.toBeInTheDocument());
      // Someone else reacts: the count updates live.
      live.emit({ type: "message.reactions", channelId: channel.id, messageId: "1", reactions: [{ emoji: "👀", count: 2, users: [ana.id, "x"] }] });
      expect(screen.getByRole("button", { name: /Ana Souza, Alguém reagiram com 👀|Ana Souza e Alguém reagiram com 👀/ })).toHaveTextContent("2");
      // Quick reactions from the message's toolbar.
      await user.click(screen.getByRole("button", { name: "Reagir com 👍" }));
      expect(react).toHaveBeenLastCalledWith(channel.id, "1", "👍", true);
    });

    it("suggests members after @ and sends the mention by id", async () => {
      const user = userEvent.setup();
      vi.spyOn(api, "messages").mockResolvedValue({ messages: [], hasMore: false });
      const send = vi.spyOn(api, "sendMessage").mockImplementation(async (_, clientId, content) => ({ ...chat("5", content), clientId, author: me }));
      render(<TextChannel channel={channel} realtime={realtime().client} revision={1} self={me} members={[me, ana]} />);
      const field = screen.getByRole("textbox");
      await user.type(field, "oi @so");
      const option = screen.getByRole("option", { name: "Ana Souza" });
      expect(option).toHaveAttribute("aria-selected", "true");
      // The user's own name is not offered.
      await user.keyboard("{Enter}");
      expect(field).toHaveValue("oi @Ana Souza ");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      await user.type(field, "revisa?{Enter}");
      expect(send).toHaveBeenCalledWith(channel.id, expect.any(String), `oi <@${ana.id}> revisa?`);
    });

    it("highlights messages that mention the user", async () => {
      const mentioned = { ...chat("1", `<@${me.id}> consegue revisar?`), author: ana, mentions: [me] };
      vi.spyOn(api, "messages").mockResolvedValue({ messages: [mentioned, { ...chat("2", "outra"), author: ana }], hasMore: false });
      render(<TextChannel channel={channel} realtime={realtime().client} revision={1} self={me} />);
      const mention = await screen.findByText("@Levi");
      expect(mention).toHaveClass("mention", "self");
      expect(mention.closest("article")).toHaveClass("mentions-me");
      expect(screen.getByText("outra").closest("article")).not.toHaveClass("mentions-me");
    });

    it("edits the user's own messages and shows the marker", async () => {
      const user = userEvent.setup();
      const mine = { ...chat("1", `Oi <@${ana.id}>`), author: me, mentions: [ana] };
      vi.spyOn(api, "messages").mockResolvedValue({ messages: [{ ...chat("0", "Dela"), author: ana }, mine], hasMore: false });
      const edit = vi.spyOn(api, "editMessage").mockImplementation(async (_, id, content) =>
        ({ ...mine, id, content, editedAt: "2026-11-17T10:05:00Z" }));
      const live = realtime();
      render(<TextChannel channel={channel} realtime={live.client} revision={1} self={me} members={[me, ana]} />);
      await screen.findByText("Dela");
      // Only one's own messages can be edited.
      expect(within(screen.getByText("Dela").closest("article")!).queryByRole("button", { name: "Editar mensagem" })).not.toBeInTheDocument();
      // ↑ in the empty composer edits the last one, with names instead of ids.
      await user.click(screen.getByRole("textbox"));
      await user.keyboard("{ArrowUp}");
      const box = screen.getByRole("textbox", { name: "Editar mensagem" });
      expect(box).toHaveValue("Oi @Ana Souza");
      await user.type(box, ", tudo bem?{Enter}");
      expect(edit).toHaveBeenCalledWith(channel.id, "1", `Oi <@${ana.id}>, tudo bem?`);
      expect(await screen.findByText("(editado)")).toBeVisible();
      // An edit from elsewhere arrives live.
      live.emit({ type: "message.updated", message: { ...chat("0", "Dela, editada"), author: ana, editedAt: "2026-11-17T10:06:00Z" } });
      expect(screen.getByText("Dela, editada")).toBeVisible();
      // Escape cancels.
      await user.click(within(screen.getByText(/tudo bem/).closest("article")!).getByRole("button", { name: "Editar mensagem" }));
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("textbox", { name: "Editar mensagem" })).not.toBeInTheDocument();
    });

    it("deletes after confirming, and removes messages deleted by others", async () => {
      const user = userEvent.setup();
      vi.spyOn(api, "messages").mockResolvedValue({ messages: [{ ...chat("1", "Dela"), author: ana }, { ...chat("2", "Minha"), author: me }], hasMore: false });
      const remove = vi.spyOn(api, "deleteMessage").mockResolvedValue(undefined);
      const live = realtime();
      render(<TextChannel channel={channel} realtime={live.client} revision={1} self={me} />);
      await user.click(within((await screen.findByText("Minha")).closest("article")!).getByRole("button", { name: "Excluir mensagem" }));
      const dialog = screen.getByRole("dialog", { name: "Excluir mensagem" });
      await user.click(within(dialog).getByRole("button", { name: "Excluir" }));
      expect(remove).toHaveBeenCalledWith(channel.id, "2");
      await waitFor(() => expect(screen.queryByText("Minha")).not.toBeInTheDocument());
      live.emit({ type: "message.deleted", channelId: channel.id, messageId: "1" });
      expect(screen.queryByText("Dela")).not.toBeInTheDocument();
    });

    it("inserts emoji from the composer's picker", async () => {
      const user = userEvent.setup();
      vi.spyOn(api, "messages").mockResolvedValue({ messages: [], hasMore: false });
      render(<TextChannel channel={channel} realtime={realtime().client} revision={1} self={me} />);
      await user.type(screen.getByRole("textbox"), "Bom dia ");
      await user.click(screen.getByRole("button", { name: "Inserir emoji" }));
      await user.type(screen.getByRole("searchbox", { name: "Buscar emoji" }), "sol");
      await user.click(screen.getByRole("button", { name: "☀️" }));
      expect(screen.getAllByRole("textbox")[0]).toHaveValue("Bom dia ☀️");
    });
  });
});

describe("refreshMessages", () => {
  it("applies the newest page and drops what was deleted in its range", () => {
    const current = [chat("1", "Antiga"), chat("5", "Apagada"), chat("6", "Velha"), chat("9", "Nova ao vivo")];
    const page = { messages: [chat("4", "Quatro"), chat("6", "Editada")], hasMore: true };
    expect(refreshMessages(current, page, "8").map(m => `${m.id}:${m.content}`))
      .toEqual(["1:Antiga", "4:Quatro", "6:Editada", "9:Nova ao vivo"]);
    // The whole history fits in the page: anything missing was deleted.
    expect(refreshMessages(current, { messages: [chat("6", "Editada")], hasMore: false }, "9").map(m => m.id)).toEqual(["6"]);
  });
});
