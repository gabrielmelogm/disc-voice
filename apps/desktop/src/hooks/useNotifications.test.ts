import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, ChatMessage, ChosenStatus, RealtimeEvent, User, VoiceParticipant } from "@disc-voice/shared";
import type { Realtime } from "../lib/realtime";
import { useNotifications } from "./useNotifications";

const lib = vi.hoisted(() => ({
  prefs: { desktop: true, messageSounds: true, voiceJoin: true },
  playNotificationSound: vi.fn(),
  playVoiceConnectSound: vi.fn(),
  showDesktopNotification: vi.fn(async () => {}),
}));
vi.mock("../lib/notifications", () => ({
  notificationPrefs: () => lib.prefs,
  playNotificationSound: lib.playNotificationSound,
  playVoiceConnectSound: lib.playVoiceConnectSound,
  showDesktopNotification: lib.showDesktopNotification,
}));

const me: User = { id: "me", email: "eu@example.com", name: "Eu" };
const friend: User = { id: "friend", email: "amigo@example.com", name: "Amigo" };
const text: Channel = { id: "text-1", serverId: "server-1", name: "geral", type: "text" };
const other: Channel = { id: "text-2", serverId: "server-1", name: "memes", type: "text" };
const call = { id: "voice-1", serverId: "server-1", name: "Sala", type: "voice" } satisfies Channel;

const chat = (author: User, channelId = text.id): ChatMessage => ({
  id: "m1", channelId, clientId: "c1", author, content: "Olá pessoal", createdAt: "2026-11-18T10:00:00Z",
});
const peer = (peerId: string, user: User): VoiceParticipant =>
  ({ peerId, user, muted: false, deafened: false, screen: false } as VoiceParticipant);

const arrival = (who: User, where: Partial<{ serverId: string; serverName: string; channelId: string; channelName: string }> = {}): RealtimeEvent => ({
  type: "voice.member.joined", serverId: call.serverId, serverName: "Meu servidor", channelId: call.id, channelName: call.name, user: who, ...where,
});

const dm = "dm-1";
/** A message in a channel of a server that is not on screen, named by the API. */
const elsewhere = (author: User): RealtimeEvent => ({
  type: "message.created", message: chat(author, "text-9"), serverId: "server-2", serverName: "Outro", channelName: "geral",
});

function setup({ viewing = text.id as string | null, inCall = false, deafened = false, status = "online" as ChosenStatus } = {}) {
  let listener: (event: RealtimeEvent) => void = () => {};
  const realtime = { onEvent: (fn: typeof listener) => { listener = fn; return () => {}; } } as unknown as Realtime;
  const voiceState = { channel: inCall ? call : null, deafened };
  renderHook(() => useNotifications({ realtime, user: me, status, voiceState, viewingChannelId: viewing, channels: [text, other, call] }));
  return (event: RealtimeEvent) => act(() => listener(event));
}

function focus(value: boolean) {
  vi.spyOn(document, "hasFocus").mockReturnValue(value);
}

describe("useNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lib.prefs = { desktop: true, messageSounds: true, voiceJoin: true };
    focus(true);
  });

  it("stays quiet for our own messages", () => {
    const emit = setup({ viewing: null });
    emit({ type: "message.created", message: chat(me) });
    expect(lib.playNotificationSound).not.toHaveBeenCalled();
  });

  it("stays quiet for the channel on screen while the window has focus", () => {
    const emit = setup();
    emit({ type: "message.created", message: chat(friend) });
    expect(lib.playNotificationSound).not.toHaveBeenCalled();
  });

  it("plays a sound for messages in another channel", () => {
    const emit = setup();
    emit({ type: "message.created", message: chat(friend, other.id) });
    expect(lib.playNotificationSound).toHaveBeenCalledTimes(1);
    expect(lib.showDesktopNotification).not.toHaveBeenCalled();
  });

  it("plays a sound and shows an OS notification in the background", () => {
    focus(false);
    const emit = setup();
    emit({ type: "message.created", message: chat(friend) });
    expect(lib.playNotificationSound).toHaveBeenCalledTimes(1);
    expect(lib.showDesktopNotification).toHaveBeenCalledWith("Amigo em #geral", "Olá pessoal", "Amigo");
  });

  it("notifies direct messages in the background, titled with the sender only", () => {
    focus(false);
    setup()({ type: "message.created", message: chat(friend, dm) });
    expect(lib.playNotificationSound).toHaveBeenCalledTimes(1);
    expect(lib.showDesktopNotification).toHaveBeenCalledWith("Amigo", "Olá pessoal", "Amigo");
  });

  it("stays quiet for the conversation on screen, but sounds for another one", () => {
    setup({ viewing: dm })({ type: "message.created", message: chat(friend, dm) });
    expect(lib.playNotificationSound).not.toHaveBeenCalled();
    setup({ viewing: dm })({ type: "message.created", message: chat(friend, "dm-2") });
    expect(lib.playNotificationSound).toHaveBeenCalledTimes(1);
    expect(lib.showDesktopNotification).not.toHaveBeenCalled();
  });

  it("notifies channel messages of servers not on screen, named with channel and server", () => {
    focus(false);
    setup()(elsewhere(friend));
    expect(lib.playNotificationSound).toHaveBeenCalledTimes(1);
    expect(lib.showDesktopNotification).toHaveBeenCalledWith("Amigo em #geral (Outro)", "Olá pessoal", "Amigo");
  });

  it("silences messages and room arrivals in do not disturb, but keeps the cue for our call", () => {
    focus(false);
    setup({ status: "dnd" })({ type: "message.created", message: chat(friend, dm) });
    setup({ status: "dnd" })(elsewhere(friend));
    setup({ status: "dnd" })(arrival(friend));
    expect(lib.playNotificationSound).not.toHaveBeenCalled();
    expect(lib.showDesktopNotification).not.toHaveBeenCalled();
    setup({ status: "dnd", inCall: true })(arrival(friend));
    expect(lib.playVoiceConnectSound).toHaveBeenCalledTimes(1);
  });

  it("still notifies while idle", () => {
    setup({ status: "idle", viewing: null })({ type: "message.created", message: chat(friend) });
    expect(lib.playNotificationSound).toHaveBeenCalledTimes(1);
  });

  it("respects the message sound preference", () => {
    lib.prefs = { ...lib.prefs, messageSounds: false };
    const emit = setup({ viewing: null });
    emit({ type: "message.created", message: chat(friend) });
    expect(lib.playNotificationSound).not.toHaveBeenCalled();
  });

  it("alerts when someone enters a voice room while we are not in a call, in any server", () => {
    const emit = setup();
    emit(arrival(friend));
    emit(arrival(friend, { serverId: "server-2", serverName: "Outro", channelId: "voice-9", channelName: "Jogos" }));
    expect(lib.playNotificationSound).toHaveBeenCalledTimes(2);
    expect(lib.showDesktopNotification).not.toHaveBeenCalled();
  });

  it("shows an OS notification for an arrival in the background", () => {
    focus(false);
    const emit = setup();
    emit(arrival(friend));
    expect(lib.playNotificationSound).toHaveBeenCalledTimes(1);
    expect(lib.showDesktopNotification).toHaveBeenCalledWith("Amigo entrou em #Sala", "Meu servidor", "Amigo");
  });

  it("in a call, plays only the connect cue for who connects to ours, with no OS notification", () => {
    focus(false);
    const emit = setup({ inCall: true });
    emit(arrival(friend));
    expect(lib.playVoiceConnectSound).toHaveBeenCalledTimes(1);
    expect(lib.playNotificationSound).not.toHaveBeenCalled();
    expect(lib.showDesktopNotification).not.toHaveBeenCalled();
  });

  it("in a call, stays quiet for other rooms, while deafened and with the preference off", () => {
    setup({ inCall: true })(arrival(friend, { channelId: "voice-2", channelName: "Outra" }));
    setup({ inCall: true, deafened: true })(arrival(friend));
    lib.prefs = { ...lib.prefs, voiceJoin: false };
    setup({ inCall: true })(arrival(friend));
    expect(lib.playVoiceConnectSound).not.toHaveBeenCalled();
    expect(lib.playNotificationSound).not.toHaveBeenCalled();
    expect(lib.showDesktopNotification).not.toHaveBeenCalled();
  });

  it("plays no connect cue for our own arrival in our call", () => {
    setup({ inCall: true })(arrival(me));
    expect(lib.playVoiceConnectSound).not.toHaveBeenCalled();
  });

  it("stays quiet for our own arrival (e.g. from another device)", () => {
    const emit = setup();
    emit(arrival(me));
    expect(lib.playNotificationSound).not.toHaveBeenCalled();
  });

  it("respects the voice join and desktop preferences", () => {
    focus(false);
    lib.prefs = { ...lib.prefs, voiceJoin: false };
    setup()(arrival(friend));
    expect(lib.playNotificationSound).not.toHaveBeenCalled();
    expect(lib.showDesktopNotification).not.toHaveBeenCalled();

    lib.prefs = { ...lib.prefs, voiceJoin: true, desktop: false };
    setup()(arrival(friend));
    expect(lib.playNotificationSound).toHaveBeenCalledTimes(1);
    expect(lib.showDesktopNotification).not.toHaveBeenCalled();
  });

  it("ignores participant updates of rooms", () => {
    const emit = setup();
    emit({ type: "voice.participants", serverId: call.serverId, channelId: call.id, participants: [peer("p-1", friend)] });
    expect(lib.playNotificationSound).not.toHaveBeenCalled();
  });
});
