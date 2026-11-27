import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, RealtimeEvent, User } from "@disc-voice/shared";
import { api } from "../lib/api";
import type { Realtime } from "../lib/realtime";
import { typingLabel } from "./useTyping";
import { useUnread } from "./useUnread";

const me: User = { id: "me", email: "eu@example.com", name: "Eu" };
const friend: User = { id: "friend", email: "amiga@example.com", name: "Elisa Prado" };
const chat = (id: string, channelId: string, author = friend): ChatMessage => ({
  id, channelId, clientId: `c-${id}`, author, content: "Oi", createdAt: "2026-11-23T10:00:00Z",
});

function realtime() {
  const listeners = new Set<(event: RealtimeEvent) => void>();
  return {
    client: { onEvent: (fn: (event: RealtimeEvent) => void) => { listeners.add(fn); return () => listeners.delete(fn); } } as unknown as Realtime,
    emit: (event: RealtimeEvent) => act(() => listeners.forEach(fn => fn(event))),
  };
}

async function setup() {
  vi.spyOn(api, "reads").mockResolvedValue([
    { channelId: "geral", serverId: "server-1", lastReadId: "10", unread: 2 },
    { channelId: "dm-1", serverId: null, lastReadId: "5", unread: 1 },
    { channelId: "dm-2", serverId: null, lastReadId: "0", unread: 3 },
  ]);
  const mark = vi.spyOn(api, "markRead").mockResolvedValue({ channelId: "", lastReadId: "" });
  const live = realtime();
  const hook = renderHook(() => useUnread(live.client, 1, { userId: me.id, serverId: "server-1" }));
  await waitFor(() => expect(hook.result.current.counts.geral).toBe(2));
  return { ...live, hook, mark };
}

describe("unread state", () => {
  it("counts direct conversations for the DMs button", async () => {
    const { hook } = await setup();
    expect(hook.result.current.dmUnread).toBe(4);
  });

  it("adds up each server's channels for the server list", async () => {
    const { hook, emit } = await setup();
    expect(hook.result.current.serverUnread).toEqual({ "server-1": 2 });
    emit({ type: "message.created", message: chat("11", "geral") });
    expect(hook.result.current.serverUnread).toEqual({ "server-1": 3 });
    act(() => hook.result.current.markRead("geral", "11"));
    expect(hook.result.current.serverUnread).toEqual({});
  });

  it("counts new messages from other people, not the user's own", async () => {
    const { hook, emit } = await setup();
    emit({ type: "message.created", message: chat("11", "geral") });
    emit({ type: "message.created", message: chat("12", "geral", me) });
    // Already covered by the read marker.
    emit({ type: "message.created", message: chat("9", "geral") });
    expect(hook.result.current.counts.geral).toBe(3);
  });

  it("clears a channel when it is read and saves the marker only when it moves forward", async () => {
    const { hook, mark } = await setup();
    act(() => hook.result.current.markRead("geral", "15"));
    expect(hook.result.current.counts.geral).toBe(0);
    expect(mark).toHaveBeenCalledWith("geral", "15");
    act(() => hook.result.current.markRead("geral", "12"));
    act(() => hook.result.current.markRead("geral", "15"));
    expect(mark).toHaveBeenCalledTimes(1);
  });

  it("follows reads made on another device", async () => {
    const { hook, emit } = await setup();
    emit({ type: "message.created", message: chat("6", "dm-1") });
    emit({ type: "read.updated", channelId: "dm-1", lastReadId: "6" });
    expect(hook.result.current.counts["dm-1"]).toBe(0);
    // A read that does not reach the newest message keeps the badge.
    emit({ type: "message.created", message: chat("20", "geral") });
    emit({ type: "read.updated", channelId: "geral", lastReadId: "11" });
    expect(hook.result.current.counts.geral).toBe(3);
  });

  it("reloads when a message arrives in a conversation it does not know", async () => {
    const { emit } = await setup();
    emit({ type: "message.created", message: chat("30", "dm-new") });
    await waitFor(() => expect(api.reads).toHaveBeenCalledTimes(2));
  });
});

describe("typing label", () => {
  it("names up to two people", () => {
    expect(typingLabel([])).toBe("");
    expect(typingLabel([friend])).toBe("Elisa Prado está digitando…");
    expect(typingLabel([friend, { name: "Bruno" }])).toBe("Elisa Prado e Bruno estão digitando…");
    expect(typingLabel([friend, { name: "Bruno" }, { name: "Caio" }])).toBe("Várias pessoas estão digitando…");
  });
});
