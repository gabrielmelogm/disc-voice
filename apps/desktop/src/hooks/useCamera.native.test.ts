import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
vi.mock("@tauri-apps/api/core", () => tauri);

import { useCamera } from "./useCamera";

const info = { deviceId: "cam-1", width: 1280, height: 720, frameRate: 30, passthrough: true };

function backend(overrides: Record<string, (args?: unknown) => unknown> = {}) {
  const handlers: Record<string, (args?: unknown) => unknown> = {
    camera_native: () => true,
    camera_devices: () => [{ id: "cam-1", name: "HD Webcam" }, { id: "cam-2", name: "USB Cam" }],
    camera_start: () => info,
    camera_stop: () => undefined,
    ...overrides,
  };
  tauri.invoke.mockImplementation(async (command: string, args?: unknown) => {
    const handler = handlers[command];
    if (!handler) throw new Error(`unexpected command ${command}`);
    return handler(args);
  });
}

const calls = (command: string) => tauri.invoke.mock.calls.filter(([name]) => name === command);

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.isTauri.mockReturnValue(true);
  const untouchable = new Proxy({}, { get: () => { throw new Error("navigator.mediaDevices used"); } });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, get: () => untouchable });
});

describe("native webcam controller", () => {
  it("lists native cameras without touching navigator.mediaDevices", async () => {
    backend();
    const { result } = renderHook(() => useCamera());
    await waitFor(() => expect(result.current.native).toBe(true));
    await waitFor(() => expect(result.current.deviceId).toBe("cam-1"));
    expect(result.current.devices).toEqual([
      { deviceId: "cam-1", label: "HD Webcam" },
      { deviceId: "cam-2", label: "USB Cam" },
    ]);
    expect(calls("camera_start")).toHaveLength(0);
  });

  it("starts the selected camera, reports its mode and stops it", async () => {
    backend({ camera_start: () => ({ ...info, deviceId: "cam-2", width: 640, height: 480 }) });
    const { result } = renderHook(() => useCamera());
    await waitFor(() => expect(result.current.deviceId).toBe("cam-1"));
    act(() => result.current.setDeviceId("cam-2"));
    await act(() => result.current.start());
    expect(calls("camera_start")[0][1]).toEqual({ deviceId: "cam-2" });
    expect(result.current.live).toBe(true);
    expect(result.current.stream).toBeNull();
    expect(result.current.settings).toMatchObject({ width: 640, height: 480, frameRate: 30 });

    act(() => result.current.stop());
    expect(result.current.live).toBe(false);
    expect(calls("camera_stop").length).toBeGreaterThan(0);
  });

  it("releases a camera that finished opening after the test was cancelled", async () => {
    let finish: (value: typeof info) => void = () => {};
    backend({ camera_start: () => new Promise((resolve) => { finish = resolve; }) });
    const { result } = renderHook(() => useCamera());
    await waitFor(() => expect(result.current.deviceId).toBe("cam-1"));
    let starting: Promise<void> = Promise.resolve();
    act(() => { starting = result.current.start(); });
    expect(result.current.busy).toBe(true);
    act(() => result.current.stop());
    const stopsBefore = calls("camera_stop").length;
    await act(async () => { finish(info); await starting; });
    expect(result.current.live).toBe(false);
    expect(calls("camera_stop").length).toBe(stopsBefore + 1);
  });

  it("shows backend errors and stops the camera on preview failure", async () => {
    backend({ camera_start: () => { throw "Acesso à câmera negado."; } });
    const { result } = renderHook(() => useCamera());
    await waitFor(() => expect(result.current.deviceId).toBe("cam-1"));
    await act(() => result.current.start());
    expect(result.current.error).toBe("Acesso à câmera negado.");
    expect(result.current.busy).toBe(false);

    backend();
    await act(() => result.current.start());
    expect(result.current.error).toBeNull();
    act(() => result.current.previewFailed("A webcam parou de enviar vídeo."));
    expect(result.current.live).toBe(false);
    expect(result.current.error).toBe("A webcam parou de enviar vídeo.");
  });

  it("stops the native camera on unmount", async () => {
    backend();
    const { result, unmount } = renderHook(() => useCamera());
    await waitFor(() => expect(result.current.deviceId).toBe("cam-1"));
    await act(() => result.current.start());
    const stopsBefore = calls("camera_stop").length;
    unmount();
    expect(calls("camera_stop").length).toBe(stopsBefore + 1);
  });

  it("uses getUserMedia when the native camera is not supported", async () => {
    backend({ camera_native: () => false });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    const { result } = renderHook(() => useCamera());
    await waitFor(() => expect(result.current.error).toContain("WebView2"));
    expect(result.current.native).toBe(false);
    expect(calls("camera_devices")).toHaveLength(0);
  });
});
