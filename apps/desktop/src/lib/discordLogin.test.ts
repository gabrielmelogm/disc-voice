import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  start: vi.fn(async () => 4321),
  cancel: vi.fn(async () => {}),
  onUrl: vi.fn(),
  openUrl: vi.fn(),
  listener: null as ((url: string) => void) | null,
}));
vi.mock("@fabianlars/tauri-plugin-oauth", () => ({ start: plugin.start, cancel: plugin.cancel, onUrl: plugin.onUrl }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: plugin.openUrl }));

const session = { user: { id: "user-1", email: "a@example.com", name: "Ana" }, token: "t".repeat(64), discordConsent: true };

/** The API: starting returns Discord's page; finishing exchanges the ticket. */
function mockApi() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const path = String(input);
    const body = path.endsWith("/auth/discord/start") ? { url: "https://discord.com/oauth2/authorize?state=api" } : session;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

function startBody(fetch: ReturnType<typeof mockApi>) {
  const [, init] = fetch.mock.calls.find(([url]) => String(url).endsWith("/auth/discord/start"))!;
  return JSON.parse(String(init?.body)) as { platform: string; port: number; state: string };
}

describe("desktop Discord sign-in", () => {
  beforeEach(() => {
    vi.resetModules();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    plugin.onUrl.mockImplementation(async (listener: (url: string) => void) => {
      plugin.listener = listener;
      return () => { plugin.listener = null; };
    });
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
    plugin.start.mockClear(); plugin.cancel.mockClear(); plugin.openUrl.mockReset();
  });

  it("opens Discord and exchanges the ticket the API sends to the loopback server", async () => {
    const fetch = mockApi();
    plugin.openUrl.mockImplementation(async (href: string) => {
      expect(href).toBe("https://discord.com/oauth2/authorize?state=api");
      const { state } = startBody(fetch);
      queueMicrotask(() => plugin.listener?.(`http://127.0.0.1:4321/?state=${state}&ticket=the-ticket`));
    });
    const { signInWithDiscord } = await import("./discordLogin");
    await expect(signInWithDiscord()).resolves.toEqual(session);
    const start = startBody(fetch);
    expect(start).toMatchObject({ platform: "desktop", port: 4321 });
    expect(start.state).toMatch(/^[\w-]{16,128}$/);
    const [, init] = fetch.mock.calls.find(([url]) => String(url).endsWith("/auth/discord"))!;
    expect(JSON.parse(String(init?.body))).toEqual({ ticket: "the-ticket" });
    expect(plugin.cancel).toHaveBeenCalledWith(4321);
  });

  it("shows the API's error and ignores redirects of other sign-ins", async () => {
    const fetch = mockApi();
    plugin.openUrl.mockImplementation(async () => {
      const { state } = startBody(fetch);
      queueMicrotask(() => plugin.listener?.(`http://127.0.0.1:4321/?state=${state}&error=${encodeURIComponent("Confirme seu e-mail no Discord.")}`));
    });
    const { signInWithDiscord } = await import("./discordLogin");
    await expect(signInWithDiscord()).rejects.toThrow("Confirme seu e-mail no Discord.");

    plugin.openUrl.mockImplementation(async () => {
      queueMicrotask(() => plugin.listener?.("http://127.0.0.1:4321/?state=forged&ticket=stolen"));
    });
    await expect(signInWithDiscord()).rejects.toThrow("Resposta de login inválida");
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/auth/discord"))).toBe(false);
  });
});
