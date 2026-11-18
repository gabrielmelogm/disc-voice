import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ isTauri: vi.fn(() => false), invoke: vi.fn(async (..._args: unknown[]) => {}) }));
const plugin = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => tauri);
vi.mock("@tauri-apps/plugin-notification", () => plugin);

async function load() {
  vi.resetModules();
  return import("./notifications");
}

describe("notifications", () => {
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
    tauri.isTauri.mockReturnValue(false);
  });

  it("turns every alert on by default and persists changes", async () => {
    const first = await load();
    expect(first.notificationPrefs()).toEqual({ desktop: true, messageSounds: true, voiceJoin: true });
    first.setNotificationPrefs({ voiceJoin: false });
    const second = await load();
    expect(second.notificationPrefs()).toEqual({ desktop: true, messageSounds: true, voiceJoin: false });
  });

  it("ignores a corrupt saved value", async () => {
    localStorage.setItem("discvoice.notifications", "{nope");
    const { notificationPrefs } = await load();
    expect(notificationPrefs().messageSounds).toBe(true);
  });

  it("plays the sound once per burst", async () => {
    const play = vi.fn(() => Promise.resolve());
    const Audio = vi.fn(function (this: Record<string, unknown>, src: string) { Object.assign(this, { src, play, currentTime: 5 }); });
    vi.stubGlobal("Audio", Audio);
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const { playNotificationSound } = await load();
    playNotificationSound();
    playNotificationSound();
    expect(play).toHaveBeenCalledTimes(1);
    expect(Audio).toHaveBeenCalledWith("/songs/notification.mp3");
    now.mockReturnValue(11_000);
    playNotificationSound();
    expect(play).toHaveBeenCalledTimes(2);
    expect(Audio).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });

  it("only sends OS notifications inside the desktop app, through the native command", async () => {
    const { showDesktopNotification } = await load();
    await showDesktopNotification("Amigo", "Oi");
    expect(tauri.invoke).not.toHaveBeenCalled();
    tauri.isTauri.mockReturnValue(true);
    await showDesktopNotification("Amigo", "Oi");
    expect(tauri.invoke).toHaveBeenCalledWith("show_notification", { title: "Amigo", body: "Oi", avatar: null });
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it("sends the sender's avatar along", async () => {
    tauri.isTauri.mockReturnValue(true);
    const notifications = await load();
    const context = { beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillText: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback =>
      callback({ arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer } as Blob));
    await notifications.showDesktopNotification("Gabriel Melo em #main", "Oi", "Gabriel Melo");
    expect(context.fillText).toHaveBeenCalledWith("GM", 64, expect.any(Number));
    expect(tauri.invoke).toHaveBeenCalledWith("show_notification", {
      title: "Gabriel Melo em #main", body: "Oi", avatar: { key: "47-4d-6410c9", png: [137, 80, 78, 71] },
    });
  });

  it("falls back to the plugin when the native command fails", async () => {
    tauri.isTauri.mockReturnValue(true);
    tauri.invoke.mockRejectedValueOnce(new Error("sem comando"));
    const { showDesktopNotification } = await load();
    await showDesktopNotification("Amigo", "Oi");
    expect(plugin.sendNotification).toHaveBeenCalledWith({ title: "Amigo", body: "Oi" });
  });

  it("skips OS notifications when permission is denied", async () => {
    tauri.isTauri.mockReturnValue(true);
    plugin.isPermissionGranted.mockResolvedValueOnce(false);
    plugin.requestPermission.mockResolvedValueOnce("denied");
    const { showDesktopNotification } = await load();
    await showDesktopNotification("Amigo", "Oi");
    expect(tauri.invoke).not.toHaveBeenCalled();
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });
});
