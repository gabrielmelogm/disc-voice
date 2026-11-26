import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceParticipant } from "@disc-voice/shared";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn((_command: string, _args?: unknown) => Promise.resolve()),
  emit: (_active: boolean) => {},
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: boolean }) => void) => {
    tauri.emit = active => handler({ payload: active });
    return () => {};
  }),
}));

const { pipScreen, setPipEnabled, usePictureInPicture, pipEnabled } = await import("./pip");
const { PipView } = await import("../components/PipView");
type State = import("./voice").VoiceState;

const user = (id: string, name: string) => ({ id, email: `${id}@example.com`, name });
const self: VoiceParticipant = { peerId: "self", user: user("u0", "Eu"), muted: false, deafened: false, screen: false };
const ana: VoiceParticipant = { peerId: "ana", user: user("u1", "Ana"), muted: false, deafened: false, screen: true };
const bia: VoiceParticipant = { peerId: "bia", user: user("u2", "Bia"), muted: false, deafened: false, screen: true };
const anaScreen = { id: "ana-stream" } as MediaStream;
const biaScreen = { id: "bia-stream" } as MediaStream;

function call(overrides: Partial<State> = {}) {
  return {
    channel: { id: "voice-1", serverId: "s", name: "sala", type: "voice" }, status: "connected", peerId: "self",
    participants: [self, ana, bia], remoteScreens: { ana: anaScreen, bia: biaScreen }, focusedScreen: null,
    muted: false, deafened: false,
    ...overrides,
  } as unknown as State;
}

const readyCalls = () => tauri.invoke.mock.calls.filter(([command]) => command === "set_pip_ready").map(([, args]) => (args as { ready: boolean }).ready);

beforeEach(() => {
  localStorage.clear();
  setPipEnabled(true);
  tauri.invoke.mockClear();
});

describe("which screen floats", () => {
  it("is the expanded one, else the one shared last", () => {
    expect(pipScreen(call())?.peerId).toBe("bia");
    expect(pipScreen(call({ focusedScreen: "ana" }))?.peerId).toBe("ana");
    // A focused screen that ended falls back to the latest.
    expect(pipScreen(call({ focusedScreen: "ana", participants: [self, { ...ana, screen: false }, bia] }))?.peerId).toBe("bia");
  });

  it("never is ours, and nothing without screens", () => {
    expect(pipScreen(call({ remoteScreens: {} }))).toBeNull();
    expect(pipScreen(call({ remoteScreens: { self: anaScreen }, participants: [{ ...self, screen: true }] }))).toBeNull();
  });
});

describe("picture-in-picture", () => {
  it("is ready only with the option on, in a call, with a screen shown, and tracks the window", async () => {
    const { result, rerender } = renderHook(({ state }) => usePictureInPicture(state), { initialProps: { state: call() } });
    expect(readyCalls().at(-1)).toBe(true);
    await act(async () => { tauri.emit(true); });
    expect(result.current.active).toBe(true);
    expect(result.current.screen?.peerId).toBe("bia");

    // The share ended: the app leaves picture-in-picture.
    rerender({ state: call({ remoteScreens: {} }) });
    expect(readyCalls().at(-1)).toBe(false);
    expect(result.current.active).toBe(false);

    rerender({ state: call() });
    expect(readyCalls().at(-1)).toBe(true);
    // Left the call.
    rerender({ state: call({ channel: null }) });
    expect(readyCalls().at(-1)).toBe(false);

    rerender({ state: call() });
    act(() => setPipEnabled(false));
    expect(readyCalls().at(-1)).toBe(false);
  });

  it("remembers the option", async () => {
    setPipEnabled(false);
    expect(localStorage.getItem("discvoice.voice.pip")).toBe("off");
    expect(pipEnabled()).toBe(false);
    vi.resetModules();
    expect((await import("./pip")).pipEnabled()).toBe(false);
  });
});

describe("the floating window", () => {
  it("shows the screen with the call controls", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const voice = { toggleMute: vi.fn(), hangUp: vi.fn() };
    render(<PipView voice={voice as never} state={call()} screen={{ peerId: "bia", feed: biaScreen }} />);
    expect(screen.getByLabelText<HTMLVideoElement>("Tela de Bia").srcObject).toBe(biaScreen);
    await userEvent.click(screen.getByRole("button", { name: "Silenciar microfone" }));
    expect(voice.toggleMute).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Sair da chamada" }));
    expect(voice.hangUp).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Voltar ao app" }));
    expect(tauri.invoke).toHaveBeenCalledWith("pip_exit");
  });
});
