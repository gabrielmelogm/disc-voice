import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCamera } from "./useCamera";

function mediaMock() {
  const track = Object.assign(new EventTarget(), {
    stop: vi.fn(),
    getSettings: () => ({ deviceId: "webcam", width: 1280, height: 720, frameRate: 30 }),
  });
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  const media = Object.assign(new EventTarget(), {
    getUserMedia: vi.fn().mockResolvedValue(stream),
    enumerateDevices: vi.fn().mockResolvedValue([
      { kind: "videoinput", deviceId: "webcam", label: "USB Webcam" },
    ]),
  });
  return { media, stream, track };
}

beforeEach(() => {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

describe("webcam controller", () => {
  it("does not capture on mount and stops a disconnected camera", async () => {
    const { media, stream, track } = mediaMock();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: media });
    const { result } = renderHook(() => useCamera());
    await waitFor(() => expect(result.current.deviceId).toBe("webcam"));
    expect(media.getUserMedia).not.toHaveBeenCalled();
    await act(() => result.current.start());
    expect(result.current.stream).toBe(stream);
    act(() => track.dispatchEvent(new Event("ended")));
    expect(result.current.stream).toBeNull();
    expect(result.current.error).toContain("desconectada");
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("releases tracks on unmount", async () => {
    const { media, track } = mediaMock();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: media });
    const { result, unmount } = renderHook(() => useCamera());
    await act(() => result.current.start());
    unmount();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("shows denied permissions and allows retry", async () => {
    const { media, stream } = mediaMock();
    media.getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: media });
    const { result } = renderHook(() => useCamera());
    await act(() => result.current.start());
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toContain("Acesso à câmera negado");
    await act(() => result.current.start());
    expect(result.current.error).toBeNull();
    expect(result.current.stream).toBe(stream);
  });
});
