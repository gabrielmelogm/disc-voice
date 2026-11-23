import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Friends, RealtimeEvent } from "@disc-voice/shared";
import { api } from "../lib/api";
import type { Realtime } from "../lib/realtime";
import { useFriends } from "./useFriends";

const elisa = { id: "elisa", email: "elisa@example.com", name: "Elisa Prado" };
const data: Friends = { friends: [{ user: elisa, status: "offline", since: "2026-11-01T00:00:00Z" }], incoming: [], outgoing: [] };

function realtime() {
  const listeners = new Set<(event: RealtimeEvent) => void>();
  return {
    client: { onEvent: (fn: (event: RealtimeEvent) => void) => { listeners.add(fn); return () => listeners.delete(fn); } } as unknown as Realtime,
    emit: (event: RealtimeEvent) => act(() => listeners.forEach(fn => fn(event))),
  };
}

describe("friends state", () => {
  it("follows presence and reloads when requests change", async () => {
    const load = vi.spyOn(api, "friends").mockResolvedValue(data);
    const live = realtime();
    const { result } = renderHook(() => useFriends(live.client, 1));
    await waitFor(() => expect(result.current.friends).toHaveLength(1));
    live.emit({ type: "presence.updated", userId: "elisa", status: "online" });
    expect(result.current.friends[0].status).toBe("online");
    live.emit({ type: "friends.changed" });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("reloads after its own changes", async () => {
    const load = vi.spyOn(api, "friends").mockResolvedValue(data);
    const add = vi.spyOn(api, "addFriend").mockResolvedValue({ status: "outgoing" });
    const { result } = renderHook(() => useFriends(realtime().client, 1));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await act(() => result.current.add("bruno"));
    expect(add).toHaveBeenCalledWith("bruno");
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
});
