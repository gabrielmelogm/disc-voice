import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { VoiceParticipant } from "@disc-voice/shared";
import type { Voice, VoiceState } from "../lib/voice";
import { VoiceChannel } from "./VoiceChannel";

const channel = { id: "voice-1", serverId: "server-1", name: "conversa", type: "voice" as const };
const user = { id: "user-1", email: "amigo@example.com", name: "Amigo" };
const self: VoiceParticipant = { peerId: "self", user, muted: false, deafened: false, screen: false };
const friend: VoiceParticipant = { peerId: "friend", user: { ...user, id: "user-2", name: "Bia" }, muted: false, deafened: false, screen: true };

function state(overrides: Partial<VoiceState> = {}): VoiceState {
  return {
    status: "connected", channel, participants: [self, friend], muted: false, deafened: false, error: "", speaking: [],
    devices: [], inputId: "", outputId: "", playbackBlocked: false, deviceBusy: false, peerId: "self",
    screenSupported: true, native: false, screen: "idle", screenInfo: null, localScreen: null, remoteScreens: {}, ...overrides,
  };
}

function voice() {
  return { startScreen: vi.fn().mockResolvedValue(undefined), stopScreen: vi.fn(), join: vi.fn(), leave: vi.fn(), toggleMute: vi.fn(), toggleDeafen: vi.fn() };
}

describe("VoiceChannel screen sharing", () => {
  it("starts and stops sharing from the call controls", async () => {
    const controls = voice();
    const view = render(<VoiceChannel channel={channel} voice={controls as unknown as Voice} state={state()} participants={[self, friend]} online />);
    await userEvent.click(screen.getByRole("button", { name: "Compartilhar tela" }));
    expect(controls.startScreen).toHaveBeenCalledOnce();
    view.rerender(<VoiceChannel channel={channel} voice={controls as unknown as Voice} state={state({ screen: "picking" })} participants={[self, friend]} online />);
    expect(screen.getByText(/Escolha uma tela ou janela/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar escolha da tela" }));
    expect(controls.stopScreen).toHaveBeenCalledOnce();
  });

  it("hides the button where native capture is unavailable", () => {
    render(<VoiceChannel channel={channel} voice={voice() as unknown as Voice} state={state({ screenSupported: false })} participants={[self]} online />);
    expect(screen.queryByRole("button", { name: "Compartilhar tela" })).toBeNull();
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
