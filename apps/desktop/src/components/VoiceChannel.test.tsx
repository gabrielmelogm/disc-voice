import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, RealtimeEvent, VoiceParticipant } from "@disc-voice/shared";
import { api } from "../lib/api";
import type { Realtime } from "../lib/realtime";
import type { Voice, VoiceState } from "../lib/voice";
import { CameraButton, DeafenButton, MicButton, ScreenButton } from "./AppBar";
import { arrangeTiles, CallStatus, moveTile, signalLevel, VoiceChannel } from "./VoiceChannel";
import { ServerRolesProvider } from "./ServerRoles";
import { serverRoles } from "../test/serverRoles";

const channel = { id: "voice-1", serverId: "server-1", name: "conversa", type: "voice" as const };
const user = { id: "user-1", email: "amigo@example.com", name: "Amigo" };
const self: VoiceParticipant = { peerId: "self", user, muted: false, deafened: false, screen: false };
const friend: VoiceParticipant = { peerId: "friend", user: { ...user, id: "user-2", name: "Bia" }, muted: false, deafened: false, screen: true };

function state(overrides: Partial<VoiceState> = {}): VoiceState {
  return {
    status: "connected", channel, since: null, participants: [self, friend], muted: false, deafened: false, error: "", speaking: [],
    devices: [], inputId: "", outputId: "", playbackBlocked: false, deviceBusy: false, peerId: "self",
    screenSupported: true, native: false, screen: "idle", screenInfo: null, localScreen: null, remoteScreens: {}, focusedScreen: null,
    shareAudio: true, screenAudio: false, screenVolumes: {}, screenQuality: "1080p", screenFrameRate: 30, screenShare: null,
    cameraSupported: true, camera: "idle", cameraId: "", cameraQuality: "360p", cameras: [], localCamera: null, remoteCameras: {},
    cameraError: "", cameraPresence: "unknown", cameraLabel: "",
    latency: {}, serverLatency: null, ...overrides,
  };
}

function realtime() {
  const listeners = new Set<(event: RealtimeEvent) => void>();
  return {
    client: {
      onEvent: (fn: (event: RealtimeEvent) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
      send: vi.fn(),
    } as unknown as Realtime,
    emit: (event: RealtimeEvent) => act(() => listeners.forEach(listener => listener(event))),
  };
}

/** Props of the room chat, with an empty history. */
function chat() {
  vi.spyOn(api, "messages").mockResolvedValue({ messages: [], hasMore: false });
  return { realtime: realtime().client, revision: 1 };
}

function voice() {
  return {
    startScreen: vi.fn().mockResolvedValue(undefined), stopScreen: vi.fn(), join: vi.fn(), leave: vi.fn(), hangUp: vi.fn(), toggleMute: vi.fn(), toggleDeafen: vi.fn(),
    startCamera: vi.fn().mockResolvedValue(undefined), stopCamera: vi.fn(), setCamera: vi.fn(), setCameraQuality: vi.fn(), refreshCameras: vi.fn().mockResolvedValue(undefined),
    setInput: vi.fn().mockResolvedValue(undefined), setOutput: vi.fn().mockResolvedValue(undefined), refreshDevices: vi.fn().mockResolvedValue(undefined),
  };
}

const device = (kind: MediaDeviceKind, deviceId: string, label: string) => ({ kind, deviceId, label, groupId: "", toJSON: () => ({}) }) as MediaDeviceInfo;

describe("VoiceChannel audio controls in the app bar", () => {
  const devices = [device("audioinput", "mic-usb", "Headset USB"), device("audiooutput", "out-usb", "Fone USB")];

  it("switches the microphone and the output in the middle of the call", async () => {
    const controls = voice();
    const onMenu = vi.fn();
    const onPicked = vi.fn();
    const props = { voice: controls as unknown as Voice, onMenu, onPicked, onVoiceSettings: vi.fn() };
    const view = render(<MicButton {...props} state={state({ devices, native: true })} menuOpen={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Escolher microfone e saída de áudio" }));
    expect(controls.refreshDevices).toHaveBeenCalledOnce();
    expect(onMenu).toHaveBeenCalledOnce();
    view.rerender(<MicButton {...props} state={state({ devices, native: true })} menuOpen />);
    const [systemInput] = screen.getAllByRole("menuitemradio", { name: "Padrão do sistema" });
    expect(systemInput).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Headset USB" }));
    expect(controls.setInput).toHaveBeenCalledWith("mic-usb");
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Fone USB" }));
    expect(controls.setOutput).toHaveBeenCalledWith("out-usb");
    expect(onPicked).toHaveBeenCalledTimes(2);
  });

  it("marks the chosen devices and warns when one is unplugged", () => {
    render(<MicButton voice={voice() as unknown as Voice} state={state({ devices, native: true, inputId: "gone", outputId: "out-usb" })} menuOpen onMenu={vi.fn()} onPicked={vi.fn()} onVoiceSettings={vi.fn()} />);
    expect(screen.getByText("O microfone escolhido não está conectado.")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Fone USB" })).toHaveAttribute("aria-checked", "true");
  });

  it("does not switch the microphone while a device change is in progress", () => {
    render(<MicButton voice={voice() as unknown as Voice} state={state({ devices, native: true, deviceBusy: true })} menuOpen onMenu={vi.fn()} onPicked={vi.fn()} onVoiceSettings={vi.fn()} />);
    expect(screen.getByRole("menuitemradio", { name: "Headset USB" })).toBeDisabled();
  });

  it("mutes from the main part of the button", async () => {
    const controls = voice();
    render(<MicButton voice={controls as unknown as Voice} state={state()} menuOpen={false} onMenu={vi.fn()} onPicked={vi.fn()} onVoiceSettings={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Silenciar microfone" }));
    expect(controls.toggleMute).toHaveBeenCalledOnce();
  });

  it("turns the received audio off and on next to the microphone", async () => {
    const controls = voice();
    const view = render(<DeafenButton voice={controls as unknown as Voice} state={state()} />);
    await userEvent.click(screen.getByRole("button", { name: "Desativar áudio recebido" }));
    expect(controls.toggleDeafen).toHaveBeenCalledOnce();
    view.rerender(<DeafenButton voice={controls as unknown as Voice} state={state({ deafened: true })} />);
    expect(screen.getByRole("button", { name: "Ativar áudio recebido" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("VoiceChannel screen sharing", () => {
  beforeEach(() => {
    // jsdom has no modal dialogs.
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); },
    });
  });

  it("starts and stops sharing from the app bar call controls", async () => {
    const controls = voice();
    const view = render(<><ScreenButton voice={controls as unknown as Voice} state={state()} /><VoiceChannel {...chat()} channel={channel} voice={controls as unknown as Voice} state={state()} participants={[self, friend]} online /></>);
    await userEvent.click(screen.getByRole("button", { name: "Compartilhar tela" }));
    await userEvent.click(screen.getByRole("button", { name: "Escolher tela" }));
    expect(controls.startScreen).toHaveBeenCalledOnce();
    view.rerender(<><ScreenButton voice={controls as unknown as Voice} state={state({ screen: "picking" })} /><VoiceChannel {...chat()} channel={channel} voice={controls as unknown as Voice} state={state({ screen: "picking" })} participants={[self, friend]} online /></>);
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
    const view = render(<VoiceChannel {...chat()} channel={channel} voice={controls} state={state()} participants={[self, friend]} online />);
    expect(screen.getByLabelText("Compartilhando a tela")).toBeVisible();
    expect(screen.getByText("Recebendo a tela de Bia…")).toBeVisible();
    const stream = {} as MediaStream;
    view.rerender(<VoiceChannel {...chat()} channel={channel} voice={controls} state={state({ remoteScreens: { friend: stream } })} participants={[self, friend]} online />);
    expect(screen.getByLabelText<HTMLVideoElement>("Tela de Bia").srcObject).toBe(stream);
  });

  it("puts a screen in full screen from its button, apart from expanding it in the call", async () => {
    const requestFullscreen = vi.fn(function (this: HTMLElement) {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: this });
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    });
    const exitFullscreen = vi.fn(() => {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    });
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: requestFullscreen });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen });
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
    const stream = {} as MediaStream;
    render(<VoiceChannel {...chat()} channel={channel} voice={voice() as unknown as Voice} state={state({ remoteScreens: { friend: stream } })} participants={[self, friend]} online />);

    await userEvent.click(screen.getByRole("button", { name: "Tela cheia de Tela de Bia" }));
    expect(requestFullscreen).toHaveBeenCalledOnce();
    // The whole frame, so the caption (and its volume) stays visible.
    expect(requestFullscreen.mock.contexts[0]).toBe(screen.getByLabelText("Tela de Bia").closest("figure"));
    expect(screen.queryByRole("button", { name: "Ampliar Tela de Bia" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Sair da tela cheia de Tela de Bia" }));
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Ampliar Tela de Bia" })).toBeVisible();
  });

  it("draws screens from the native call engine on a canvas", () => {
    const pull = vi.fn(() => new Promise<ArrayBuffer>(() => {}));
    render(<VoiceChannel {...chat()} channel={channel} voice={voice() as unknown as Voice} state={state({ native: true, remoteScreens: { friend: { pull } } })} participants={[self, friend]} online />);
    expect(screen.getByLabelText("Tela de Bia").tagName).toBe("CANVAS");
  });

  it("asks for the quality, the frame rate and the audio every time it shares", async () => {
    const controls = voice();
    render(<ScreenButton voice={controls as unknown as Voice} state={state({ screenQuality: "720p", screenFrameRate: 60, shareAudio: false })} />);
    await userEvent.click(screen.getByRole("button", { name: "Compartilhar tela" }));
    expect(controls.startScreen).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Compartilhar tela" });
    // Starts from the last choices.
    expect(within(dialog).getByRole("radio", { name: /720p/ })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /^60 fps/ })).toBeChecked();
    expect(within(dialog).getByRole("switch", { name: /Compartilhar o áudio do computador/ })).not.toBeChecked();
    expect(within(dialog).getAllByRole("radio").map(radio => (radio as HTMLInputElement).value)).toEqual(["360p", "720p", "1080p", "30", "60"]);

    await userEvent.click(within(dialog).getByRole("radio", { name: /1080p/ }));
    await userEvent.click(within(dialog).getByRole("radio", { name: /^30 fps/ }));
    await userEvent.click(within(dialog).getByRole("switch", { name: /Compartilhar o áudio do computador/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Escolher tela" }));
    expect(controls.startScreen).toHaveBeenCalledWith({ quality: "1080p", frameRate: 30, audio: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancelling the share dialog shares nothing", async () => {
    const controls = voice();
    render(<ScreenButton voice={controls as unknown as Voice} state={state()} />);
    await userEvent.click(screen.getByRole("button", { name: "Compartilhar tela" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(controls.startScreen).not.toHaveBeenCalled();
  });

  it("shows the quality being shared", () => {
    const stream = {} as MediaStream;
    const live = state({ screen: "live", localScreen: stream, screenAudio: true, screenShare: { quality: "720p", frameRate: 60 } });
    render(<><ScreenButton voice={voice() as unknown as Voice} state={live} /><VoiceChannel {...chat()} channel={channel} voice={voice() as unknown as Voice} state={live} participants={[self, friend]} online /></>);
    expect(screen.getByLabelText("Qualidade: 720p · 60 fps")).toBeVisible();
    expect(screen.getByRole("button", { name: "Parar compartilhamento de tela (720p · 60 fps, com áudio)" })).toBeVisible();
  });

  it("marks screens with audio and sets each one's volume locally", async () => {
    const controls = { ...voice(), setScreenVolume: vi.fn(), toggleScreenMute: vi.fn() };
    const withAudio = { ...friend, screenAudio: true };
    const stream = {} as MediaStream;
    const view = render(<VoiceChannel {...chat()} channel={channel} voice={controls as unknown as Voice}
      state={state({ participants: [self, withAudio], remoteScreens: { friend: stream }, screenVolumes: { "user-2": { volume: 0.4, muted: false } } })}
      participants={[self, withAudio]} online />);
    const slider = screen.getByRole("slider", { name: "Volume da tela de Bia" });
    expect(slider).toHaveValue("40");
    fireEvent.change(slider, { target: { value: "75" } });
    expect(controls.setScreenVolume).toHaveBeenCalledWith("user-2", 0.75);
    await userEvent.click(screen.getByRole("button", { name: "Silenciar o áudio da tela de Bia" }));
    expect(controls.toggleScreenMute).toHaveBeenCalledWith("user-2");

    // Without audio: no volume control. Our own screen only shows that it has audio.
    view.rerender(<VoiceChannel {...chat()} channel={channel} voice={controls as unknown as Voice}
      state={state({ localScreen: stream, screen: "live", screenAudio: true, remoteScreens: { friend: stream } })}
      participants={[self, friend]} online />);
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.getByRole("img", { name: "Com áudio do computador" })).toBeVisible();
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

  it("shows the camera off in red, and dims it with the reason when the webcam is missing", async () => {
    const controls = voice();
    const props = { voice: controls as unknown as Voice, menuOpen: false, onMenu: vi.fn(), onPicked: vi.fn() };
    const view = render(<CameraButton {...props} state={state()} />);
    expect(screen.getByRole("button", { name: "Ligar câmera" })).toHaveClass("off");
    expect(screen.queryByRole("tooltip")).toBeNull();

    view.rerender(<CameraButton {...props} state={state({ cameraId: "cam-9", cameraLabel: "Logitech C920", cameraPresence: "missing" })} />);
    const button = screen.getByRole("button", { name: "Câmera indisponível" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toBeEnabled();
    expect(button).toHaveAccessibleDescription("Logitech C920 não está disponívelReconecte a câmera ou escolha outra na seta ao lado.");
    expect(screen.getByRole("button", { name: "Escolher câmera e qualidade" })).toBeEnabled();

    view.rerender(<CameraButton {...props} state={state({ cameraPresence: "none" })} />);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Nenhuma câmera encontrada");

    // Other failures keep the button usable and say why.
    view.rerender(<CameraButton {...props} state={state({ cameraPresence: "ready", cameraError: "Acesso à câmera negado." })} />);
    expect(screen.getByRole("button", { name: "Ligar câmera" })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Acesso à câmera negado.");
  });

  it("keeps camera errors out of the call status", () => {
    render(<CallStatus voice={voice() as unknown as Voice} state={state({ cameraError: "A câmera selecionada não está disponível.", cameraPresence: "missing" })} onOpen={vi.fn()} />);
    expect(screen.queryByText(/câmera/)).toBeNull();
    expect(screen.queryByLabelText("Chamada atual")).toBeNull();
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
    const view = render(<VoiceChannel {...chat()} channel={channel} voice={controls} state={state({ camera: "live", localCamera: local })} participants={[self, camFriend]} online />);
    expect(screen.getByLabelText<HTMLVideoElement>("Sua câmera").srcObject).toBe(local);
    expect(screen.getByLabelText("Sua câmera")).toHaveClass("mirrored");
    expect(screen.getByText("Carregando câmera…")).toBeVisible();
    const pull = vi.fn(() => new Promise<ArrayBuffer>(() => {}));
    view.rerender(<VoiceChannel {...chat()} channel={channel} voice={controls} state={state({ camera: "live", localCamera: local, remoteCameras: { friend: { pull } } })} participants={[self, camFriend]} online />);
    expect(screen.getByLabelText("Câmera de Bia").tagName).toBe("CANVAS");
    expect(screen.getByLabelText("Câmera de Bia")).not.toHaveClass("mirrored");
    // A camera that was turned off shows the avatar again, even if its track remains.
    view.rerender(<VoiceChannel {...chat()} channel={channel} voice={controls} state={state({ remoteCameras: { friend: { pull } } })} participants={[self, { ...camFriend, camera: false }]} online />);
    expect(screen.queryByLabelText("Câmera de Bia")).toBeNull();
    expect(screen.queryByLabelText("Sua câmera")).toBeNull();
  });
});

describe("VoiceChannel ping", () => {
  it("shows a signal for everyone in the call, with the ping on hover", async () => {
    render(<VoiceChannel {...chat()} channel={channel} voice={voice() as unknown as Voice} state={state({ latency: { friend: 212 }, serverLatency: 34 })} participants={[self, friend]} online />);
    const friendTile = screen.getByRole("listitem", { name: /^Bia\./ });
    const signal = within(friendTile).getByLabelText("Ping: 212 ms");
    expect(signal).toHaveClass("fair");
    expect(within(signal).getByRole("tooltip", { hidden: true })).toHaveTextContent("Ping: 212 ms");
    const ours = within(screen.getByRole("listitem", { name: /^Amigo \(você\)/ })).getByLabelText("Ping com o servidor: 34 ms");
    expect(ours).toHaveClass("good");
  });

  it("says it is measuring until a ping arrives, and hides it outside the call", () => {
    const view = render(<VoiceChannel {...chat()} channel={channel} voice={voice() as unknown as Voice} state={state()} participants={[self, friend]} online />);
    expect(screen.getByLabelText("Ping: medindo…")).toHaveClass("unknown");
    view.rerender(<VoiceChannel {...chat()} channel={channel} voice={voice() as unknown as Voice} state={state({ channel: null, status: "idle" })} participants={[self, friend]} online />);
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
    const view = render(<VoiceChannel {...chat()} channel={room} voice={voice() as unknown as Voice} state={state({ channel: room })} participants={[self, friend, bob]} online />);
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
    render(<VoiceChannel {...chat()} channel={room} voice={voice() as unknown as Voice} state={state({ channel: room })} participants={[carol, self, friend, bob]} online />);
    expect(names()).toEqual(["Bob", "Amigo", "Bia", "Carol"]);
  });

  it("moves the focused tile with Alt and the arrow keys", () => {
    const room = { ...channel, id: "voice-keys" };
    render(<VoiceChannel {...chat()} channel={room} voice={voice() as unknown as Voice} state={state({ channel: room })} participants={[self, friend, bob]} online />);
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

describe("VoiceChannel room chat", () => {
  afterEach(() => vi.restoreAllMocks());
  const owner = { ...user, id: "user-2", name: "Bia" };
  const sent = (id: string, content: string, author = user): ChatMessage => ({
    id, channelId: channel.id, clientId: `c-${id}`, author, content, createdAt: new Date().toISOString(),
  });

  it("loads the room history, shows roles and takes messages live", async () => {
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [sent("1", "Começando a pauta", owner)], hasMore: false });
    const live = realtime();
    render(<ServerRolesProvider value={serverRoles(user.id, [{ user: owner, owner: true, roles: [] }])}>
      <VoiceChannel channel={channel} voice={voice() as unknown as Voice} state={state()} participants={[self, friend]} online
        realtime={live.client} revision={1} self={user} /></ServerRolesProvider>);
    const panel = screen.getByRole("complementary", { name: "Chat da chamada" });
    expect(await within(panel).findByText("Começando a pauta")).toBeVisible();
    expect(within(panel).getByText("Dono")).toHaveClass("role-badge");
    expect(api.messages).toHaveBeenCalledWith(channel.id, {}, expect.anything());

    live.emit({ type: "message.created", message: sent("2", "Link: https://example.com", owner), channelType: "voice" });
    expect(within(panel).getByText(/Link:/)).toBeVisible();
    // Messages of other channels stay out.
    live.emit({ type: "message.created", message: { ...sent("3", "Em outro canal"), channelId: "text-1" } });
    expect(within(panel).queryByText("Em outro canal")).not.toBeInTheDocument();
  });

  it("sends messages to the voice channel", async () => {
    const chatProps = chat();
    const send = vi.spyOn(api, "sendMessage").mockImplementation(async (_channel, clientId, content) => ({ ...sent("5", content), clientId }));
    render(<VoiceChannel channel={channel} voice={voice() as unknown as Voice} state={state()} participants={[self, friend]} online {...chatProps} self={user} />);
    const field = screen.getByRole("textbox", { name: "Mensagem para o chat da sala" });
    expect(field).toHaveAttribute("placeholder", "Escrever em conversa");
    await userEvent.type(field, "Sem microfone hoje{Enter}");
    expect(send).toHaveBeenCalledWith(channel.id, expect.any(String), "Sem microfone hoje");
    expect(await screen.findByText("Sem microfone hoje")).toBeVisible();
    expect(field).toHaveValue("");
  });

  it("closes and reopens the panel without leaving the call", async () => {
    const controls = voice();
    render(<VoiceChannel {...chat()} channel={channel} voice={controls as unknown as Voice} state={state()} participants={[self, friend]} online />);
    await userEvent.click(screen.getByRole("button", { name: "Fechar chat da sala" }));
    expect(screen.queryByRole("complementary", { name: "Chat da chamada" })).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Participantes do canal de voz" })).toBeVisible();
    expect(controls.leave).not.toHaveBeenCalled();
    expect(controls.hangUp).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Abrir chat da sala" }));
    expect(screen.getByRole("textbox", { name: "Mensagem para o chat da sala" })).toBeVisible();
  });
});
