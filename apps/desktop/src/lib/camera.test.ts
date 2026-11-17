import { describe, expect, it, vi } from "vitest";
import { CameraSession, cameraError } from "./camera";

function fakeStream() {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  return { stream, stop };
}

describe("CameraSession", () => {
  it("requests the exact selected camera without capturing microphone audio", async () => {
    const { stream, stop } = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const session = new CameraSession({ getUserMedia });
    expect(await session.start("camera-usb")).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        deviceId: { exact: "camera-usb" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    session.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("releases a stream when permission resolves after cancel/unmount", async () => {
    const { stream, stop } = fakeStream();
    let resolve!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((done) => { resolve = done; }));
    const session = new CameraSession({ getUserMedia });
    const opening = session.start("");
    session.stop();
    resolve(stream);
    expect(await opening).toBeNull();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("discards a stale permission response without stopping a newer camera", async () => {
    const first = fakeStream();
    const second = fakeStream();
    let resolve!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn()
      .mockImplementationOnce(() => new Promise<MediaStream>((done) => { resolve = done; }))
      .mockResolvedValueOnce(second.stream);
    const session = new CameraSession({ getUserMedia });
    const stale = session.start("first");
    expect(await session.start("second")).toBe(second.stream);
    resolve(first.stream);
    expect(await stale).toBeNull();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).not.toHaveBeenCalled();
    session.stop();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it("releases the previous camera before switching devices", async () => {
    const first = fakeStream();
    const second = fakeStream();
    const session = new CameraSession({
      getUserMedia: vi.fn().mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream),
    });
    await session.start("one");
    await session.start("two");
    expect(first.stop).toHaveBeenCalledOnce();
    session.stop();
    session.stop();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it.each([
    ["NotAllowedError", "Acesso à câmera negado"],
    ["NotFoundError", "Nenhuma webcam"],
    ["NotReadableError", "outro aplicativo"],
    ["OverconstrainedError", "selecione novamente"],
  ])("explains %s failures", (name, text) => {
    expect(cameraError(new DOMException("failure", name))).toContain(text);
  });
});
