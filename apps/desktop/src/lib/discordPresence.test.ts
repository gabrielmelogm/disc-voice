import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve()),
  isTauri: vi.fn(() => true),
}));
vi.mock("@tauri-apps/api/core", () => tauri);

import { api } from "./api";
import { resetDiscordPresence, setShowCallOnDiscord, syncDiscordPresence, useDiscordCallPresence } from "./discordPresence";

const status = { enabled: true, presence: true, account: null, clientId: "123" };
const room = { channel: "Sala", server: "Amigos", startedAt: 1000 };

beforeEach(() => {
  localStorage.clear();
  tauri.invoke.mockClear();
  tauri.isTauri.mockReturnValue(true);
  vi.restoreAllMocks();
  resetDiscordPresence();
});

describe("Discord Rich Presence", () => {
  it("shows the call once and clears it when the call ends", async () => {
    const discord = vi.spyOn(api, "discord").mockResolvedValue(status);
    syncDiscordPresence(room);
    syncDiscordPresence({ ...room });
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledTimes(1));
    expect(tauri.invoke).toHaveBeenCalledWith("discord_presence", { clientId: "123", presence: room });
    syncDiscordPresence(null);
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledTimes(2));
    expect(tauri.invoke).toHaveBeenLastCalledWith("discord_presence", { clientId: "123", presence: null });
    // The application is loaded once.
    expect(discord).toHaveBeenCalledTimes(1);
  });

  it("respects the preference and does nothing outside the desktop app", async () => {
    vi.spyOn(api, "discord").mockResolvedValue(status);
    setShowCallOnDiscord(false);
    syncDiscordPresence(room);
    await Promise.resolve();
    expect(tauri.invoke).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("discvoice.discordPresence")!)).toEqual({ showCall: false });
    setShowCallOnDiscord(true);
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("discord_presence", { clientId: "123", presence: room }));

    resetDiscordPresence();
    tauri.invoke.mockClear();
    tauri.isTauri.mockReturnValue(false);
    syncDiscordPresence(room);
    await Promise.resolve();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("keeps the join time while in the same channel and clears on unmount", async () => {
    vi.spyOn(api, "discord").mockResolvedValue(status);
    const { rerender, unmount } = renderHook(({ call }) => useDiscordCallPresence(call), {
      initialProps: { call: { channelId: "c1", channel: "Sala", server: "Amigos" } as { channelId: string; channel: string; server: string } | null },
    });
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledTimes(1));
    const first = (tauri.invoke.mock.calls[0] as unknown[])[1] as { presence: { startedAt: number } };
    rerender({ call: { channelId: "c1", channel: "Sala", server: "Amigos" } });
    await Promise.resolve();
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
    expect(first.presence.startedAt).toBeGreaterThan(0);
    unmount();
    await waitFor(() => expect(tauri.invoke).toHaveBeenLastCalledWith("discord_presence", { clientId: "123", presence: null }));
  });
});
