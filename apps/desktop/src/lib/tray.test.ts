import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => {
  const state = { supported: true };
  return {
    state,
    isTauri: vi.fn(() => false),
    invoke: vi.fn(async (command: string, ..._args: unknown[]): Promise<unknown> => command === "tray_supported" ? state.supported : undefined),
  };
});
const events = vi.hoisted(() => {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const unlisten = vi.fn();
  return {
    handlers,
    unlisten,
    listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(name, handler);
      return unlisten;
    }),
  };
});
vi.mock("@tauri-apps/api/core", () => tauri);
vi.mock("@tauri-apps/api/event", () => ({ listen: events.listen }));

async function load() {
  vi.resetModules();
  return import("./tray");
}

const servers = (...ids: string[]) => ids.map(id => ({ id, name: `Servidor ${id}`, ownerId: "x" }));

describe("tray", () => {
  beforeEach(() => {
    // Node's own localStorage global can shadow jsdom's, so use an in-memory one.
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => store.clear(),
    });
    vi.clearAllMocks();
    events.handlers.clear();
    tauri.isTauri.mockReturnValue(false);
    tauri.state.supported = true;
  });

  it("closes to the tray by default and persists the choice", async () => {
    const first = await load();
    expect(first.windowPrefs()).toEqual({ closeToTray: true });
    first.setWindowPrefs({ closeToTray: false });
    const second = await load();
    expect(second.windowPrefs()).toEqual({ closeToTray: false });
  });

  it("ignores a corrupt saved value", async () => {
    localStorage.setItem("discvoice.window", "{nope");
    expect((await load()).windowPrefs()).toEqual({ closeToTray: true });
  });

  it("tells the app the saved choice on load and on change", async () => {
    tauri.isTauri.mockReturnValue(true);
    localStorage.setItem("discvoice.window", JSON.stringify({ closeToTray: false }));
    const tray = await load();
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("set_close_to_tray", { enabled: false }));
    tray.setWindowPrefs({ closeToTray: true });
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenLastCalledWith("set_close_to_tray", { enabled: true }));
  });

  it("does not call the app outside of it", async () => {
    const tray = await load();
    tray.syncTray({ call: "Geral", muted: false, recent: [] });
    expect(await tray.traySupported()).toBe(false);
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("does nothing where the app has no tray", async () => {
    tauri.isTauri.mockReturnValue(true);
    tauri.state.supported = false;
    const tray = await load();
    tray.syncTray({ call: "Geral", muted: false, recent: [] });
    tray.setWindowPrefs({ closeToTray: false });
    expect(await tray.traySupported()).toBe(false);
    await Promise.resolve();
    expect(tauri.invoke.mock.calls.map(([command]) => command)).toEqual(["tray_supported"]);
  });

  it("sends the tray status", async () => {
    tauri.isTauri.mockReturnValue(true);
    const tray = await load();
    const status = { call: "Geral", muted: true, recent: [{ id: "a", name: "A" }] };
    tray.syncTray(status);
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenLastCalledWith("set_tray_status", { status }));
  });

  it("keeps the five most recent servers the user still has, newest first", async () => {
    const tray = await load();
    for (const id of ["a", "b", "c", "a", "d", "e", "f", "g"]) tray.rememberServer(id);
    expect(tray.recentServers(servers("a", "b", "c", "d", "e", "f", "g")).map(s => s.id)).toEqual(["g", "f", "e", "d", "a"]);
    // Servers the user left are skipped; only id and name go to the menu.
    expect(tray.recentServers(servers("a", "e"))).toEqual([{ id: "e", name: "Servidor e" }, { id: "a", name: "Servidor a" }]);
  });

  it("ignores a corrupt recent list", async () => {
    localStorage.setItem("discvoice.recentServers", "{nope");
    const tray = await load();
    expect(tray.recentServers(servers("a"))).toEqual([]);
    tray.rememberServer("a");
    expect(tray.recentServers(servers("a")).map(s => s.id)).toEqual(["a"]);
  });

  it("runs the actions picked in the tray menu until stopped", async () => {
    tauri.isTauri.mockReturnValue(true);
    const tray = await load();
    const openServer = vi.fn();
    const toggleMute = vi.fn();
    const stop = tray.onTrayAction({ openServer, toggleMute });
    await vi.waitFor(() => expect(events.handlers.size).toBe(2));
    events.handlers.get("tray-open-server")!({ payload: "s1" });
    events.handlers.get("tray-toggle-mute")!({ payload: null });
    expect(openServer).toHaveBeenCalledWith("s1");
    expect(toggleMute).toHaveBeenCalledOnce();
    stop();
    await vi.waitFor(() => expect(events.unlisten).toHaveBeenCalledTimes(2));
  });
});
