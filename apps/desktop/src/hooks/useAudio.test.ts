import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_AUDIO_STATUS } from "@disc-voice/shared";
import { nativeAudio } from "../lib/audio";
import { useAudio } from "./useAudio";

vi.mock("../lib/audio", async (original) => ({
  ...await original<typeof import("../lib/audio")>(),
  nativeAudio: { available: vi.fn(), devices: vi.fn(), status: vi.fn(), action: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(nativeAudio.available).mockReturnValue(true);
  vi.mocked(nativeAudio.devices).mockResolvedValue({
    inputs: [
      { id: "usb", name: "Microfone", isDefault: false },
      { id: "builtin", name: "Microfone", isDefault: true },
    ],
    outputs: [{ id: "speakers", name: "Alto-falantes", isDefault: true }],
  });
  vi.mocked(nativeAudio.status).mockResolvedValue(INITIAL_AUDIO_STATUS);
  vi.mocked(nativeAudio.action).mockResolvedValue(INITIAL_AUDIO_STATUS);
});

describe("native audio controller", () => {
  it("selects defaults and preserves explicit selection across enumeration reorder", async () => {
    const { result } = renderHook(() => useAudio());
    await waitFor(() => expect(result.current.inputId).toBe("builtin"));
    act(() => result.current.setInputId("usb"));
    vi.mocked(nativeAudio.devices).mockResolvedValue({
      inputs: [
        { id: "builtin", name: "Microfone", isDefault: true },
        { id: "usb", name: "Microfone", isDefault: false },
      ],
      outputs: [],
    });
    await act(() => result.current.refresh());
    expect(result.current.inputId).toBe("usb");
    expect(result.current.outputId).toBe("");
    vi.mocked(nativeAudio.devices).mockResolvedValue({
      inputs: [{ id: "builtin", name: "Microfone", isDefault: true }],
      outputs: [],
    });
    await act(() => result.current.refresh());
    expect(result.current.inputId).toBe("builtin");
  });

  it("does not replace newer command state with an older in-flight poll", async () => {
    let resolve!: (status: typeof INITIAL_AUDIO_STATUS) => void;
    vi.mocked(nativeAudio.status).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    vi.mocked(nativeAudio.action).mockResolvedValue({
      ...INITIAL_AUDIO_STATUS, sequence: 2, inputActive: true,
    });
    const { result } = renderHook(() => useAudio());
    await waitFor(() => expect(result.current.inputId).toBe("builtin"));
    await act(() => result.current.act({ type: "startMicrophone", deviceId: "builtin" }));
    await act(async () => { resolve({ ...INITIAL_AUDIO_STATUS, sequence: 1 }); });
    expect(result.current.status.inputActive).toBe(true);
  });

  it("reports native errors and releases devices on teardown", async () => {
    vi.mocked(nativeAudio.action).mockRejectedValueOnce("O microfone foi desconectado");
    const { result, unmount } = renderHook(() => useAudio());
    await act(() => result.current.act({ type: "startMicrophone", deviceId: "usb" }));
    expect(result.current.error).toBe("O microfone foi desconectado");
    expect(result.current.busy).toBe(false);
    unmount();
    expect(nativeAudio.action).toHaveBeenLastCalledWith({ type: "stopAll" });
  });

  it("does not pretend native devices are available in a browser", async () => {
    vi.mocked(nativeAudio.available).mockReturnValue(false);
    const { result } = renderHook(() => useAudio());
    await act(() => result.current.refresh());
    expect(nativeAudio.devices).not.toHaveBeenCalled();
    expect(result.current.devices).toEqual({ inputs: [], outputs: [] });
  });
});
