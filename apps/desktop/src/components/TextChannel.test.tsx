import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, RealtimeEvent } from "@disc-voice/shared";
import { TextChannel } from "./TextChannel";
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
      .mockResolvedValueOnce({ messages: [chat("2", "Perdida"), chat("3", "Ao vivo")], hasMore: false });
    const live = realtime();
    const { rerender } = render(<TextChannel channel={channel} realtime={live.client} revision={1} />);
    await screen.findByText("Primeira");
    live.emit({ type: "message.created", message: chat("3", "Ao vivo") });
    rerender(<TextChannel channel={channel} realtime={live.client} revision={2} />);
    await screen.findByText("Perdida");
    expect(history.mock.calls[1][1]).toEqual({ after: "1" });
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
});
