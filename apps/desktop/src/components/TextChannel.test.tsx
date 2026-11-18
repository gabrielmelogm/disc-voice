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
  let listener: (event: RealtimeEvent) => void = () => {};
  return {
    client: { onEvent: (fn: typeof listener) => { listener = fn; return () => {}; } } as unknown as Realtime,
    emit: (event: RealtimeEvent) => act(() => listener(event)),
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
    expect([...screen.getByRole("log").querySelectorAll("article p")].map(p => p.textContent)).toEqual(["Primeira", "Perdida", "Ao vivo"]);
  });
});
