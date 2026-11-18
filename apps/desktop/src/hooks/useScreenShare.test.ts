import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenInfo, ScreenRequest } from "@disc-voice/shared";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
vi.mock("@tauri-apps/api/core", () => tauri);

import { useScreenShare } from "./useScreenShare";

const request: ScreenRequest = { maxWidth: 1280, maxHeight: 720, frameRate: 30, cursor: true };
const info: ScreenInfo = {
  source: "monitor", width: 2560, height: 1440, maxWidth: 1280, maxHeight: 720, frameRate: 30, cursor: true,
};

function backend(overrides: Record<string, (args?: unknown) => unknown> = {}) {
  const handlers: Record<string, (args?: unknown) => unknown> = {
    screen_native: () => true,
    screen_start: () => info,
    screen_stop: () => undefined,
    ...overrides,
  };
  tauri.invoke.mockImplementation(async (command: string, args?: unknown) => {
    const handler = handlers[command];
    if (!handler) throw new Error(`unexpected command ${command}`);
    return handler(args);
  });
}

const calls = (command: string) => tauri.invoke.mock.calls.filter(([name]) => name === command);

async function ready() {
  const hook = renderHook(() => useScreenShare());
  await waitFor(() => expect(hook.result.current.status).toBe("idle"));
  return hook;
}

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.isTauri.mockReturnValue(true);
});

describe("screen share controller", () => {
  it("is unavailable outside the desktop app", () => {
    tauri.isTauri.mockReturnValue(false);
    const { result } = renderHook(() => useScreenShare());
    expect(result.current.status).toBe("unavailable");
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("is unavailable when the platform has no native backend", async () => {
    backend({ screen_native: () => false });
    const { result } = renderHook(() => useScreenShare());
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });

  it("shares what the user picked and stops it", async () => {
    backend();
    const { result } = await ready();
    await act(() => result.current.start(request));
    expect(calls("screen_start")[0][1]).toEqual({ request });
    expect(result.current.status).toBe("live");
    expect(result.current.info).toEqual(info);

    act(() => result.current.stop());
    expect(result.current.status).toBe("idle");
    expect(result.current.info).toBeNull();
    expect(calls("screen_stop")).toHaveLength(1);
  });

  it("returns to idle without an error when the picker is dismissed", async () => {
    backend({ screen_start: () => null });
    const { result } = await ready();
    await act(() => result.current.start(request));
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  it("cancelling while picking ignores the late answer", async () => {
    let answer: (value: ScreenInfo | null) => void = () => {};
    backend({ screen_start: () => new Promise((resolve) => { answer = resolve; }) });
    const { result } = await ready();
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.start(request); });
    expect(result.current.status).toBe("picking");
    act(() => result.current.stop());
    expect(calls("screen_stop")).toHaveLength(1);
    await act(async () => { answer(info); await pending; });
    expect(result.current.status).toBe("idle");
    expect(result.current.info).toBeNull();
  });

  it("shows backend errors", async () => {
    backend({ screen_start: () => { throw "O sistema recusou o compartilhamento de tela."; } });
    const { result } = await ready();
    await act(() => result.current.start(request));
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBe("O sistema recusou o compartilhamento de tela.");
  });

  it("a failed preview stops sharing and explains why", async () => {
    backend();
    const { result } = await ready();
    await act(() => result.current.start(request));
    act(() => result.current.previewFailed("O compartilhamento de tela foi encerrado."));
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBe("O compartilhamento de tela foi encerrado.");
    expect(calls("screen_stop")).toHaveLength(1);
  });

  it("releases the capture on unmount", async () => {
    backend();
    const { result, unmount } = await ready();
    await act(() => result.current.start(request));
    unmount();
    expect(calls("screen_stop")).toHaveLength(1);
  });
});
