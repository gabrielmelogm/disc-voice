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

const session = { user: { id: "user-1", email: "a@example.com", name: "Ana" }, token: "t".repeat(64) };

function mockApi() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const path = String(input);
    const body = path.endsWith("/auth/google/config") ? { desktopClientId: "desktop-id", webClientId: null } : session;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

describe("desktop Google Sign-In", () => {
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

  it("opens Google in the browser and exchanges the loopback code with PKCE", async () => {
    const fetch = mockApi();
    plugin.openUrl.mockImplementation(async (href: string) => {
      const url = new URL(href);
      expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(url.searchParams.get("client_id")).toBe("desktop-id");
      expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:4321");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("scope")).toBe("openid email profile");
      queueMicrotask(() => plugin.listener?.(`http://127.0.0.1:4321/?code=the-code&state=${url.searchParams.get("state")}`));
    });
    const { signInWithGoogle } = await import("./google");
    await expect(signInWithGoogle()).resolves.toEqual(session);
    const [, init] = fetch.mock.calls.find(([url]) => String(url).endsWith("/auth/google"))!;
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ code: "the-code", redirectUri: "http://127.0.0.1:4321", platform: "desktop" });
    expect(body.codeVerifier).toMatch(/^[\w-]{43,128}$/);
    expect(plugin.cancel).toHaveBeenCalledWith(4321);
    expect(plugin.listener).toBeNull();
  });

  it("stops the loopback server when the user cancels", async () => {
    mockApi();
    plugin.openUrl.mockResolvedValue(undefined);
    const { signInWithGoogle } = await import("./google");
    const controller = new AbortController();
    const pending = signInWithGoogle(controller.signal);
    await vi.waitFor(() => expect(plugin.openUrl).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toThrow("Login cancelado.");
    expect(plugin.cancel).toHaveBeenCalledWith(4321);
  });
});
