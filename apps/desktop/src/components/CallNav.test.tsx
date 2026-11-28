import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Channel, RealtimeEvent, Server, VoiceParticipant } from "@disc-voice/shared";
import { api } from "../lib/api";
import type { Realtime } from "../lib/realtime";
import type { Voice, VoiceState } from "../lib/voice";
import { AppBar } from "./AppBar";
import { CallChip, formatElapsed, MiniCall } from "./CallNav";
import { ChannelSidebar } from "./ChannelSidebar";
import { VoiceChannel } from "./VoiceChannel";

const room: Channel = { id: "voice-1", serverId: "server-1", name: "Sala de reunião", type: "voice" };
const studio: Server = { id: "server-1", name: "Estúdio Norte", ownerId: "user-1" } as Server;
const club: Server = { id: "server-2", name: "Clube do Livro", ownerId: "user-9" } as Server;
const user = { id: "user-1", email: "levi@example.com", name: "Levi" };
const self: VoiceParticipant = { peerId: "self", user, muted: false, deafened: false, screen: false };
const ana: VoiceParticipant = { peerId: "ana", user: { ...user, id: "user-2", name: "Ana Souza" }, muted: false, deafened: false, screen: false };

function state(overrides: Partial<VoiceState> = {}): VoiceState {
  return {
    status: "connected", channel: room, since: Date.now() - 65_000, participants: [self, ana], muted: false, deafened: false, error: "", speaking: [],
    devices: [], inputId: "", outputId: "", playbackBlocked: false, deviceBusy: false, peerId: "self",
    screenSupported: true, native: false, screen: "idle", screenInfo: null, localScreen: null, remoteScreens: {}, focusedScreen: null,
    shareAudio: true, screenAudio: false, screenVolumes: {}, screenQuality: "1080p", screenFrameRate: 30, screenShare: null,
    cameraSupported: true, camera: "idle", cameraId: "", cameraQuality: "360p", cameras: [], localCamera: null, remoteCameras: {},
    cameraError: "", cameraPresence: "unknown", cameraLabel: "",
    latency: {}, serverLatency: null, ...overrides,
  };
}

function voice() {
  return {
    join: vi.fn(), leave: vi.fn(), hangUp: vi.fn(), toggleMute: vi.fn(), toggleDeafen: vi.fn(), startScreen: vi.fn(), stopScreen: vi.fn(),
    startCamera: vi.fn(), stopCamera: vi.fn(), refreshCameras: vi.fn(), refreshDevices: vi.fn(),
  };
}

function bar(voiceState: VoiceState, viewingCall: boolean, onOpenCall = vi.fn()) {
  return <AppBar user={user} servers={[studio, club]} server={studio} view="server" voice={voice() as unknown as Voice} voiceState={voiceState}
    viewingCall={viewingCall} onOpenCall={onOpenCall} canJoinVoice onSelectServer={vi.fn()} onCreateServer={vi.fn()} onJoinServer={vi.fn()}
    onDms={vi.fn()} onVoice={vi.fn()} onSettings={vi.fn()} onVoiceSettings={vi.fn()} onSearch={vi.fn()} />;
}

describe("in-call navigation", () => {
  it("formats the elapsed time", () => {
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
  });

  it("shows the full controls on the call screen and the green chip elsewhere", async () => {
    const onOpenCall = vi.fn();
    const { rerender } = render(bar(state(), true, onOpenCall));
    expect(screen.getByRole("toolbar", { name: "Controles da chamada" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Você está em uma chamada" })).not.toBeInTheDocument();

    rerender(bar(state(), false, onOpenCall));
    expect(screen.queryByRole("toolbar", { name: "Controles da chamada" })).not.toBeInTheDocument();
    expect(screen.getByText("Estúdio Norte · 1:05")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Voltar para a chamada em Sala de reunião, Estúdio Norte" }));
    expect(onOpenCall).toHaveBeenCalled();
  });

  it("marks the server with the call in the switcher menu", async () => {
    render(bar(state(), false));
    expect(screen.getByRole("button", { name: /Trocar de servidor.*Em chamada em Estúdio Norte/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Trocar de servidor/ }));
    expect(screen.getByRole("menuitem", { name: "Abrir servidor Estúdio Norte, em chamada" })).toHaveTextContent("Sala de reunião · você está lá");
    expect(screen.getByRole("menuitem", { name: "Abrir servidor Clube do Livro" })).not.toHaveTextContent("Em chamada");
  });

  it("hides every indicator once the call ends", () => {
    render(bar(state({ status: "idle", channel: null, since: null, participants: [] }), false));
    expect(screen.queryByRole("group", { name: "Você está em uma chamada" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trocar de servidor. Atual: Estúdio Norte" })).toBeInTheDocument();
  });

  it("opens and collapses the chip's quick controls", async () => {
    const controls = voice();
    render(<CallChip voice={controls as unknown as Voice} state={state()} serverName="Estúdio Norte" onOpen={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: "Mostrar controles da chamada" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(screen.getByRole("button", { name: "Silenciar microfone" }));
    expect(controls.toggleMute).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Sair da chamada" }));
    expect(controls.hangUp).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Recolher controles da chamada" }));
    expect(screen.queryByRole("button", { name: "Sair da chamada" })).not.toBeInTheDocument();
  });

  it("says the microphone is off while muted", () => {
    render(<CallChip voice={voice() as unknown as Voice} state={state({ muted: true })} serverName="Estúdio Norte" onOpen={vi.fn()} />);
    expect(screen.getByText("Microfone desligado")).toHaveClass("is-muted");
  });

  it("shows a banner on another server's sidebar and the call on the room card", async () => {
    const onOpenCall = vi.fn();
    const sidebar = (server: Server, channels: Channel[], viewingCall = false) => <ChannelSidebar server={server} channels={channels} channelId={null} participants={{}}
      voiceState={state()} callServerName="Estúdio Norte" viewingCall={viewingCall} onOpenCall={onOpenCall} loading={false} error=""
      onSelect={vi.fn()} onJoin={vi.fn()} onReload={vi.fn()} />;
    const { rerender } = render(sidebar(club, []));
    await userEvent.click(screen.getByRole("button", { name: "Você está em uma chamada em Estúdio Norte · Sala de reunião. Voltar para a chamada" }));
    expect(onOpenCall).toHaveBeenCalledTimes(1);

    rerender(sidebar(studio, [room]));
    expect(screen.queryByText("Você está em uma chamada")).not.toBeInTheDocument();
    expect(screen.getByText("2 na sala, com você")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Em chamada em Sala de reunião. Voltar para a chamada" }));
    expect(onOpenCall).toHaveBeenCalledTimes(2);

    rerender(sidebar(studio, [room], true));
    expect(screen.getByText("Você está aqui")).toBeInTheDocument();
  });

  it("features whoever is speaking in the mini window", async () => {
    const onOpen = vi.fn();
    render(<MiniCall state={state({ speaking: ["ana"] })} serverName="Estúdio Norte" onOpen={onOpen} />);
    expect(screen.getByRole("region", { name: "Mini janela da chamada em Sala de reunião" })).toBeInTheDocument();
    expect(screen.getByText("Ana está falando")).toBeInTheDocument();
    expect(screen.getByText("Estúdio Norte · 1:05")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Voltar para a chamada" }));
    expect(onOpen).toHaveBeenCalled();
  });

  it("offers to rejoin after leaving from the call screen", async () => {
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [], hasMore: false });
    const realtime = { onEvent: (_fn: (event: RealtimeEvent) => void) => () => {}, send: vi.fn() } as unknown as Realtime;
    const controls = voice();
    const onBack = vi.fn();
    const view = (voiceState: VoiceState) => <VoiceChannel channel={room} voice={controls as unknown as Voice} state={voiceState} participants={[ana]} online
      realtime={realtime} revision={1} self={user} onBack={onBack} />;
    const { rerender } = render(view(state()));
    act(() => { rerender(view(state({ status: "idle", channel: null, since: null, participants: [] }))); });
    expect(screen.getByText("Você saiu da Sala de reunião")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Chat da chamada" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Entrar de novo" }));
    expect(controls.join).toHaveBeenCalledWith(room);
    await userEvent.click(screen.getByRole("button", { name: "Voltar para geral" }));
    expect(onBack).toHaveBeenCalled();
  });
});
