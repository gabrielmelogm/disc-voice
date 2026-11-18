import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { VoiceParticipant } from "@disc-voice/shared";
import type { Voice, VoiceState } from "../lib/voice";
import { CameraButton, ScreenButton } from "./AppBar";
import { VoiceChannel } from "./VoiceChannel";

const channel = { id: "voice-1", serverId: "server-1", name: "conversa", type: "voice" as const };
const user = { id: "user-1", email: "amigo@example.com", name: "Amigo" };
const self: VoiceParticipant = { peerId: "self", user, muted: false, deafened: false, screen: false };
const friend: VoiceParticipant = { peerId: "friend", user: { ...user, id: "user-2", name: "Bia" }, muted: false, deafened: false, screen: true };

function state(overrides: Partial<VoiceState> = {}): VoiceState {
  return {
    status: "connected", channel, participants: [self, friend], muted: false, deafened: false, error: "", speaking: [],
    devices: [], inputId: "", outputId: "", playbackBlocked: false, deviceBusy: false, peerId: "self",
    screenSupported: true, native: false, screen: "idle", screenInfo: null, localScreen: null, remoteScreens: {},
    cameraSupported: true, camera: "idle", cameraId: "", cameraQuality: "360p", cameras: [], localCamera: null, remoteCameras: {}, ...overrides,
  };
}

function voice() {
  return {
    startScreen: vi.fn().mockResolvedValue(undefined), stopScreen: vi.fn(), join: vi.fn(), leave: vi.fn(), toggleMute: vi.fn(), toggleDeafen: vi.fn(),
    startCamera: vi.fn().mockResolvedValue(undefined), stopCamera: vi.fn(), setCamera: vi.fn(), setCameraQuality: vi.fn(), refreshCameras: vi.fn().mockResolvedValue(undefined),
  };
}

describe("VoiceChannel screen sharing", () => {
  it("starts and stops sharing from the app bar call controls", async () => {
    const controls = voice();
    const view = render(<><ScreenButton voice={controls as unknown as Voice} state={state()} /><VoiceChannel channel={channel} voice={controls as unknown as Voice} state={state()} participants={[self, friend]} online /></>);
    await userEvent.click(screen.getByRole("button", { name: "Compartilhar tela" }));
    expect(controls.startScreen).toHaveBeenCalledOnce();
    view.rerender(<><ScreenButton voice={controls as unknown as Voice} state={state({ screen: "picking" })} /><VoiceChannel channel={channel} voice={controls as unknown as Voice} state={state({ screen: "picking" })} participants={[self, friend]} online /></>);
    expect(screen.getByText(/Escolha uma tela ou janela/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar escolha da tela" }));
    expect(controls.stopScreen).toHaveBeenCalledOnce();
  });

  it("disables sharing where native capture is unavailable", () => {
    render(<ScreenButton voice={voice() as unknown as Voice} state={state({ screenSupported: false })} />);
    expect(screen.queryByRole("button", { name: "Compartilhar tela" })).toBeNull();
    expect(screen.getByRole("button", { name: "Compartilhar tela (indisponível)" })).toBeDisabled();
  });

  it("shows who is sharing and their screen once it arrives", () => {
    const controls = voice() as unknown as Voice;
    const view = render(<VoiceChannel channel={channel} voice={controls} state={state()} participants={[self, friend]} online />);
    expect(screen.getByLabelText("Compartilhando a tela")).toBeVisible();
    expect(screen.getByText("Recebendo a tela de Bia…")).toBeVisible();
    const stream = {} as MediaStream;
    view.rerender(<VoiceChannel channel={channel} voice={controls} state={state({ remoteScreens: { friend: stream } })} participants={[self, friend]} online />);
    expect(screen.getByLabelText<HTMLVideoElement>("Tela de Bia").srcObject).toBe(stream);
  });

  it("draws screens from the native call engine on a canvas", () => {
    const pull = vi.fn(() => new Promise<ArrayBuffer>(() => {}));
    render(<VoiceChannel channel={channel} voice={voice() as unknown as Voice} state={state({ native: true, remoteScreens: { friend: { pull } } })} participants={[self, friend]} online />);
    expect(screen.getByLabelText("Tela de Bia").tagName).toBe("CANVAS");
  });
});

describe("VoiceChannel webcam", () => {
  it("turns the camera on and off from the app bar", async () => {
    const controls = voice();
    const view = render(<CameraButton voice={controls as unknown as Voice} state={state()} menuOpen={false} onMenu={vi.fn()} onPicked={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Ligar câmera" }));
    expect(controls.startCamera).toHaveBeenCalledOnce();
    view.rerender(<CameraButton voice={controls as unknown as Voice} state={state({ camera: "live" })} menuOpen={false} onMenu={vi.fn()} onPicked={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Desligar câmera" }));
    expect(controls.stopCamera).toHaveBeenCalledOnce();
  });

  it("chooses the camera and the quality before turning it on", async () => {
    const controls = voice();
    const onMenu = vi.fn();
    const cameras = [{ deviceId: "cam-2", label: "Webcam USB" }];
    const view = render(<CameraButton voice={controls as unknown as Voice} state={state({ cameras })} menuOpen={false} onMenu={onMenu} onPicked={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Escolher câmera e qualidade" }));
    expect(controls.refreshCameras).toHaveBeenCalledOnce();
    expect(onMenu).toHaveBeenCalledOnce();
    view.rerender(<CameraButton voice={controls as unknown as Voice} state={state({ cameras })} menuOpen onMenu={onMenu} onPicked={vi.fn()} />);
    expect(screen.getByRole("menuitemradio", { name: /360p/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Webcam USB" }));
    expect(controls.setCamera).toHaveBeenCalledWith("cam-2");
    await userEvent.click(screen.getByRole("menuitemradio", { name: /720p/ }));
    expect(controls.setCameraQuality).toHaveBeenCalledWith("720p");
  });

  it("shows cameras in the tiles: ours mirrored, others as they arrive", () => {
    const controls = voice() as unknown as Voice;
    const camFriend = { ...friend, screen: false, camera: true };
    const local = {} as MediaStream;
    const view = render(<VoiceChannel channel={channel} voice={controls} state={state({ camera: "live", localCamera: local })} participants={[self, camFriend]} online />);
    expect(screen.getByLabelText<HTMLVideoElement>("Sua câmera").srcObject).toBe(local);
    expect(screen.getByLabelText("Sua câmera")).toHaveClass("mirrored");
    expect(screen.getByText("Carregando câmera…")).toBeVisible();
    const pull = vi.fn(() => new Promise<ArrayBuffer>(() => {}));
    view.rerender(<VoiceChannel channel={channel} voice={controls} state={state({ camera: "live", localCamera: local, remoteCameras: { friend: { pull } } })} participants={[self, camFriend]} online />);
    expect(screen.getByLabelText("Câmera de Bia").tagName).toBe("CANVAS");
    expect(screen.getByLabelText("Câmera de Bia")).not.toHaveClass("mirrored");
    // A camera that was turned off shows the avatar again, even if its track remains.
    view.rerender(<VoiceChannel channel={channel} voice={controls} state={state({ remoteCameras: { friend: { pull } } })} participants={[self, { ...camFriend, camera: false }]} online />);
    expect(screen.queryByLabelText("Câmera de Bia")).toBeNull();
    expect(screen.queryByLabelText("Sua câmera")).toBeNull();
  });
});
