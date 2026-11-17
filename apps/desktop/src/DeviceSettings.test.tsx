import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_AUDIO_STATUS } from "@disc-voice/shared";
import { DeviceSettings } from "./DeviceSettings";
import { nativeAudio } from "./lib/audio";

vi.mock("./lib/audio", async (original) => ({
  ...await original<typeof import("./lib/audio")>(),
  nativeAudio: { available: vi.fn(), devices: vi.fn(), status: vi.fn(), action: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(nativeAudio.available).mockReturnValue(true);
  vi.mocked(nativeAudio.devices).mockResolvedValue({
    inputs: [{ id: "mic", name: "USB Microphone", isDefault: true }],
    outputs: [
      { id: "speakers", name: "Speakers", isDefault: true },
      { id: "headset", name: "USB Headset", isDefault: false },
    ],
  });
  vi.mocked(nativeAudio.status).mockResolvedValue(INITIAL_AUDIO_STATUS);
  vi.mocked(nativeAudio.action).mockResolvedValue(INITIAL_AUDIO_STATUS);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: Object.assign(new EventTarget(), { enumerateDevices: vi.fn().mockResolvedValue([]), getUserMedia: vi.fn() }),
  });
});

describe("device dashboard", () => {
  it("plays the test on the selected output and keeps empty recordings disabled", async () => {
    const user = userEvent.setup();
    render(<DeviceSettings />);
    await waitFor(() => expect(screen.getByLabelText("Dispositivo de saída")).toBeEnabled());
    expect(screen.getByRole("button", { name: "Ouvir gravação" })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Dispositivo de saída"), "headset");
    await user.click(screen.getByRole("button", { name: "Tocar som" }));
    expect(nativeAudio.action).toHaveBeenCalledWith({
      type: "playTone", deviceId: "headset", volume: 0.35,
    });
  });

  it("locks the input while recording and exposes a stop action", async () => {
    const user = userEvent.setup();
    vi.mocked(nativeAudio.action).mockResolvedValue({
      ...INITIAL_AUDIO_STATUS, sequence: 3, inputActive: true, peak: 0.5, recordedSeconds: 1,
    });
    render(<DeviceSettings />);
    const start = screen.getByRole("button", { name: "Testar microfone" });
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);
    expect(nativeAudio.action).toHaveBeenCalledWith({ type: "startMicrophone", deviceId: "mic" });
    expect(screen.getByLabelText("Dispositivo de entrada")).toBeDisabled();
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "50");
    await user.click(screen.getByRole("button", { name: "Finalizar gravação" }));
    expect(nativeAudio.action).toHaveBeenLastCalledWith({ type: "stopMicrophone" });
  });

  it("explains browser preview and disables native audio controls", () => {
    vi.mocked(nativeAudio.available).mockReturnValue(false);
    render(<DeviceSettings />);
    expect(screen.getByText("Abra o app no Windows para testar o áudio.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Testar microfone" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Tocar som" })).toBeDisabled();
  });
});
