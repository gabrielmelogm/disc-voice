import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { VoiceParticipant } from "@disc-voice/shared";
import type { Voice, VoiceState } from "../lib/voice";
import { CameraButton, ScreenButton } from "./AppBar";
import { arrangeTiles, moveTile, signalLevel, VoiceChannel } from "./VoiceChannel";

const channel = { id: "voice-1", serverId: "server-1", name: "conversa", type: "voice" as const };
const user = { id: "user-1", email: "amigo@example.com", name: "Amigo" };
const self: VoiceParticipant = { peerId: "self", user, muted: false, deafened: false, screen: false };
const friend: VoiceParticipant = { peerId: "friend", user: { ...user, id: "user-2", name: "Bia" }, muted: false, deafened: false, screen: true };

function state(overrides: Partial<VoiceState> = {}): VoiceState {
  return {
    status: "connected", channel, participants: [self, friend], muted: false, deafened: false, error: "", speaking: [],
    devices: [], inputId: "", outputId: "", playbackBlocked: false, deviceBusy: false, peerId: "self",
    screenSupported: true, native: false, screen: "idle", screenInfo: null, localScreen: null, remoteScreens: {},
    cameraSupported: true, camera: "idle", cameraId: "", cameraQuality: "360p", cameras: [], localCamera: null, remoteCameras: {},
    latency: {}, serverLatency: null, ...overrides,
  };
}

function voice() {
  return {
    startScreen: vi.fn().mockResolvedValue(undefined), stopScreen: vi.fn(), join: vi.fn(), leave: vi.fn(), hangUp: vi.fn(), toggleMute: vi.fn(), toggleDeafen: vi.fn(),
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

describe("VoiceChannel ping", () => {
  it("shows a signal for everyone in the call, with the ping on hover", async () => {
    render(<VoiceChannel channel={channel} voice={voice() as unknown as Voice} state={state({ latency: { friend: 212 }, serverLatency: 34 })} participants={[self, friend]} online />);
    const friendTile = screen.getByRole("listitem", { name: /^Bia\./ });
    const signal = within(friendTile).getByLabelText("Ping: 212 ms");
    expect(signal).toHaveClass("fair");
    expect(within(signal).getByRole("tooltip", { hidden: true })).toHaveTextContent("Ping: 212 ms");
    const ours = within(screen.getByRole("listitem", { name: /^Amigo \(você\)/ })).getByLabelText("Ping com o servidor: 34 ms");
    expect(ours).toHaveClass("good");
  });

  it("says it is measuring until a ping arrives, and hides it outside the call", () => {
    const view = render(<VoiceChannel channel={channel} voice={voice() as unknown as Voice} state={state()} participants={[self, friend]} online />);
    expect(screen.getByLabelText("Ping: medindo…")).toHaveClass("unknown");
    view.rerender(<VoiceChannel channel={channel} voice={voice() as unknown as Voice} state={state({ channel: null, status: "idle" })} participants={[self, friend]} online />);
    expect(screen.queryByLabelText(/Ping/)).toBeNull();
  });

  it("grades the signal like a phone", () => {
    expect(signalLevel(40).tone).toBe("good");
    expect(signalLevel(120).tone).toBe("good");
    expect(signalLevel(200).tone).toBe("fair");
    expect(signalLevel(450).tone).toBe("poor");
    expect(signalLevel(null).tone).toBe("unknown");
  });
});

describe("VoiceChannel tile order", () => {
  const bob = { ...friend, peerId: "bob", screen: false, user: { ...user, id: "user-3", name: "Bob" } };
  const names = () => screen.getAllByRole("listitem").map(tile => tile.getAttribute("aria-label")!.split(/[ .]/)[0]);

  it("reorders tiles by dragging and keeps the order while the app runs", () => {
    const room = { ...channel, id: "voice-drag" };
    const view = render(<VoiceChannel channel={room} voice={voice() as unknown as Voice} state={state({ channel: room })} participants={[self, friend, bob]} online />);
    expect(names()).toEqual(["Amigo", "Bia", "Bob"]);
    const [first, , last] = screen.getAllByRole("listitem");
    fireEvent.dragStart(last);
    fireEvent.dragEnter(first);
    expect(first).toHaveClass("drop-target");
    fireEvent.drop(first);
    expect(names()).toEqual(["Bob", "Amigo", "Bia"]);
    // Leaving the channel view and coming back keeps it; newcomers go last.
    view.unmount();
    const carol = { ...bob, peerId: "carol", user: { ...user, id: "user-4", name: "Carol" } };
    render(<VoiceChannel channel={room} voice={voice() as unknown as Voice} state={state({ channel: room })} participants={[carol, self, friend, bob]} online />);
    expect(names()).toEqual(["Bob", "Amigo", "Bia", "Carol"]);
  });

  it("moves the focused tile with Alt and the arrow keys", () => {
    const room = { ...channel, id: "voice-keys" };
    render(<VoiceChannel channel={room} voice={voice() as unknown as Voice} state={state({ channel: room })} participants={[self, friend, bob]} online />);
    fireEvent.keyDown(screen.getAllByRole("listitem")[0], { key: "ArrowRight", altKey: true });
    expect(names()).toEqual(["Bia", "Amigo", "Bob"]);
    fireEvent.keyDown(screen.getAllByRole("listitem")[0], { key: "ArrowLeft", altKey: true });
    expect(names()).toEqual(["Bia", "Amigo", "Bob"]);
    fireEvent.keyDown(screen.getAllByRole("listitem")[2], { key: "ArrowRight" });
    expect(names()).toEqual(["Bia", "Amigo", "Bob"]);
  });

  it("orders by user and moves items", () => {
    const people = [{ user: { id: "a" } }, { user: { id: "b" } }, { user: { id: "c" } }];
    expect(arrangeTiles(people, ["c", "a"]).map(p => p.user.id)).toEqual(["c", "a", "b"]);
    expect(moveTile(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveTile(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });
});
