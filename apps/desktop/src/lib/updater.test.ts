import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = { platform: "windows-x86_64" as string | null, version: "0.1.0-alpha.3" };
  return {
    state,
    isTauri: vi.fn(() => true),
    invoke: vi.fn(async (command: string) => command === "updater_platform" ? state.platform : undefined),
    getVersion: vi.fn(async () => state.version),
    check: vi.fn(),
    relaunch: vi.fn(async () => {}),
  };
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.getVersion }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));

type Event = { event: "Started"; data: { contentLength?: number } } | { event: "Progress"; data: { chunkLength: number } } | { event: "Finished" };

function fakeUpdate(options: { fail?: Error } = {}) {
  return {
    version: "0.1.0-alpha.4",
    body: "Novidades",
    download: vi.fn(async (onEvent: (event: Event) => void) => {
      if (options.fail) throw options.fail;
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 40 } });
      onEvent({ event: "Progress", data: { chunkLength: 60 } });
      onEvent({ event: "Finished" });
    }),
    install: vi.fn(async () => {}),
  };
}

function site(body: unknown, status = 200) {
  const fetch = vi.fn(async () => new Response(status === 204 ? null : JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const latest = { version: "0.1.0-alpha.4", notes: "Novidades", pub_date: "2026-11-27T12:00:00Z", platforms: ["windows-x86_64", "linux-x86_64"] };

async function load() {
  vi.resetModules();
  return import("./updater");
}

describe("updater", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => store.clear(),
    });
    mocks.state.platform = "windows-x86_64";
    mocks.state.version = "0.1.0-alpha.3";
    mocks.isTauri.mockReturnValue(true);
    mocks.check.mockReset();
  });

  it("compares semver versions, prereleases before releases", async () => {
    const { compareVersions } = await load();
    expect(compareVersions("0.1.0-alpha.10", "0.1.0-alpha.9")).toBe(1);
    expect(compareVersions("0.1.0-alpha.3", "0.1.0-beta.1")).toBe(-1);
    expect(compareVersions("0.1.0", "0.1.0-rc.1")).toBe(1);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
  });

  it("follows the installed version's channel until the user picks one", async () => {
    const updater = await load();
    expect(updater.channelOf("0.1.0-alpha.3")).toBe("alpha");
    expect(updater.channelOf("0.2.0-rc.1")).toBe("beta");
    expect(updater.channelOf("1.0.0")).toBe("stable");
    updater.setUpdateChannel("beta");
    expect((await load()).updateChannel("1.0.0")).toBe("beta");
  });

  it("shows a newer version without downloading or signing anything", async () => {
    const fetch = site(latest);
    const updater = await load();
    await updater.lookForUpdates();
    expect(fetch).toHaveBeenCalledWith(`${updater.SITE_URL}/api/update/latest?channel=alpha`, expect.anything());
    expect(updater.updateState()).toMatchObject({ status: "available", version: "0.1.0-alpha.4", notes: "Novidades" });
    // The signed link only comes from check(), on the user's click.
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("shows nothing when there is no newer version for this platform", async () => {
    site({ ...latest, version: "0.1.0-alpha.3" });
    let updater = await load();
    await updater.lookForUpdates();
    expect(updater.updateState()).toMatchObject({ status: "idle", version: null });

    site({ ...latest, platforms: ["linux-x86_64"] });
    updater = await load();
    await updater.lookForUpdates();
    expect(updater.updateState().status).toBe("idle");

    site(null, 204);
    updater = await load();
    await updater.lookForUpdates();
    expect(updater.updateState().status).toBe("idle");
  });

  it("does not look in a build that cannot update itself", async () => {
    mocks.state.platform = null;
    const fetch = site(latest);
    const updater = await load();
    await updater.lookForUpdates();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("signs, downloads, leaves the call and relaunches only when the user clicks", async () => {
    site(latest);
    const update = fakeUpdate();
    mocks.check.mockResolvedValue(update);
    const updater = await load();
    await updater.lookForUpdates();

    const order: string[] = [];
    update.install.mockImplementation(async () => { order.push("install"); });
    expect(await updater.installUpdate(() => { order.push("leave call"); })).toBe(true);
    expect(mocks.check).toHaveBeenCalledWith(expect.objectContaining({ headers: { "X-Update-Channel": "alpha" } }));
    expect(update.download).toHaveBeenCalledOnce();
    expect(order).toEqual(["leave call", "install"]);
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });

  it("rejects an update whose signature does not match, keeping the call", async () => {
    site(latest);
    const update = fakeUpdate({ fail: new Error("signature verification failed") });
    mocks.check.mockResolvedValue(update);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const updater = await load();
    await updater.lookForUpdates();
    const leave = vi.fn();
    expect(await updater.installUpdate(leave)).toBe(false);
    expect(updater.updateState()).toMatchObject({ status: "error", error: expect.stringContaining("assinatura") });
    expect(leave).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it("looks again when the API announces a release on the user's channel", async () => {
    vi.useFakeTimers();
    try {
      const fetch = site(latest);
      const handlers = new Set<(event: { type: string; version: string; channels: string[] }) => void>();
      const realtime = { onEvent: (handler: never) => { handlers.add(handler); return () => handlers.delete(handler); } };
      const updater = await load();
      const { renderHook } = await import("@testing-library/react");
      renderHook(() => updater.useUpdateChecks(realtime as never));
      // The start-up look finds nothing new yet.
      fetch.mockImplementation(async () => new Response(null, { status: 204 }));
      await vi.advanceTimersByTimeAsync(updater.FIRST_CHECK_DELAY);
      expect(fetch).toHaveBeenCalledOnce();
      fetch.mockClear();
      fetch.mockImplementation(async () => new Response(JSON.stringify(latest), { status: 200 }));

      handlers.forEach(handler => handler({ type: "app.update", version: "1.0.0", channels: ["stable"] }));
      await vi.advanceTimersByTimeAsync(updater.ANNOUNCEMENT_JITTER);
      expect(fetch).not.toHaveBeenCalled();

      handlers.forEach(handler => handler({ type: "app.update", version: "0.1.0-alpha.4", channels: ["alpha"] }));
      await vi.advanceTimersByTimeAsync(updater.ANNOUNCEMENT_JITTER);
      expect(fetch).toHaveBeenCalledOnce();
      expect(updater.updateState().status).toBe("available");
    } finally {
      vi.useRealTimers();
    }
  });
});
