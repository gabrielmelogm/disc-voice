import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, RealtimeCommand, RealtimeEvent, ServerMember, VoiceParticipant } from "@disc-voice/shared";
import { useMembers } from "../hooks/useMembers";
import { IDLE_AFTER_MS, usePresenceStatus } from "../hooks/usePresenceStatus";
import { api } from "../lib/api";
import type { Realtime } from "../lib/realtime";
import { ChannelHeader, roomPresence } from "./ChannelDetails";
import { activityText, MembersDialog, PeoplePanel } from "./Members";
import { ProfileCardProvider } from "./ProfileCard";

const person = (id: string, name: string) => ({ id, email: `${id}@example.com`, name });
const ana = person("ana", "Ana Lima");
const joao = person("joao", "João Reis");
const bia = person("bia", "Bia Souza");
const caio = person("caio", "Caio Prado");
const duda = person("duda", "Duda Alves");
const member = (user: ReturnType<typeof person>, role: ServerMember["role"], status: ServerMember["status"]): ServerMember =>
  ({ user, role, status, joinedAt: "2026-11-01T00:00:00Z" });
const members = [
  member(ana, "owner", "online"),
  member(joao, "moderator", "dnd"),
  member(bia, "member", "online"),
  member(caio, "member", "offline"),
  member(duda, "member", "offline"),
];
const room: Channel = { id: "room", serverId: "server", name: "Sala de reunião", type: "voice" };
const server = { id: "server", name: "Estúdio", ownerId: "ana" };

function realtime() {
  const listeners = new Set<(event: RealtimeEvent) => void>();
  const sent: RealtimeCommand[] = [];
  return {
    sent,
    client: {
      onEvent: (fn: (event: RealtimeEvent) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
      send: (command: RealtimeCommand) => { sent.push(command); },
    } as unknown as Realtime,
    emit: (event: RealtimeEvent) => act(() => listeners.forEach(fn => fn(event))),
  };
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); },
  });
});

function panel(onShowAll = vi.fn()) {
  const participant = (user: typeof bia, screen: boolean): VoiceParticipant => ({ peerId: `peer-${user.id}`, user, muted: false, deafened: false, screen });
  const rooms = roomPresence([room], () => [participant(bia, false), participant(ana, true)]);
  render(<ProfileCardProvider profiles={{}}><PeoplePanel self={ana} selfStatus="online" members={members} loading={false} error=""
    rooms={rooms} onRetry={vi.fn()} onShowAll={onShowAll} /></ProfileCardProvider>);
  return onShowAll;
}

describe("people panel", () => {
  it("lists online people by role with badges and activity, and offline people compactly", async () => {
    const onShowAll = panel();
    expect(screen.getByRole("heading", { name: "Pessoas · 3 online" })).toBeVisible();
    const online = within(screen.getByRole("list", { name: "Pessoas online" })).getAllByRole("listitem");
    expect(online.map(item => item.textContent)).toEqual([
      // Initials, name, role badge and activity.
      "ALAna LimaDonoCompartilhando a tela",
      "JRJoão ReisModeradorNão perturbe",
      "BSBia SouzaNa Sala de reunião",
    ]);
    expect(screen.getByText("Offline · 2")).toBeVisible();
    expect(screen.queryByRole("list", { name: "Pessoas offline" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Ver todos" }));
    expect(onShowAll).toHaveBeenCalled();
  });

  it("filters everyone by name, ignoring case and accents", async () => {
    const user = userEvent.setup();
    panel();
    await user.click(screen.getByRole("button", { name: "Buscar pessoas" }));
    await user.type(screen.getByLabelText("Buscar pessoas pelo nome"), "JOAO");
    expect(within(screen.getByRole("list", { name: "Pessoas online" })).getByText("João Reis")).toBeVisible();
    expect(screen.queryByText("Bia Souza")).toBeNull();
    await user.clear(screen.getByLabelText("Buscar pessoas pelo nome"));
    await user.type(screen.getByLabelText("Buscar pessoas pelo nome"), "prado");
    // Offline matches are listed in full while searching.
    expect(within(screen.getByRole("list", { name: "Pessoas offline" })).getByText("Caio Prado")).toBeVisible();
    await user.type(screen.getByLabelText("Buscar pessoas pelo nome"), "zzz");
    expect(screen.getByText("Ninguém encontrado com esse nome.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Fechar busca de pessoas" }));
    expect(screen.getByText("Bia Souza")).toBeVisible();
  });

  it("describes what someone is doing, most specific first", () => {
    const game = { kind: "playing" as const, name: "Minecraft", details: null, state: null, startedAt: null, source: "discord" as const };
    expect(activityText("online", { channel: room, screen: true }, game)).toBe("Compartilhando a tela");
    expect(activityText("online", { channel: room, screen: false }, game)).toBe("Na Sala de reunião");
    expect(activityText("online", undefined, game)).toBe("Jogando Minecraft");
    expect(activityText("idle", undefined, undefined)).toBe("Ausente");
    expect(activityText("online", undefined, undefined)).toBe("");
    expect(activityText("offline", undefined, game)).toBe("Offline");
  });

  it("shows the member count in the channel header", () => {
    render(<ChannelHeader channel={{ id: "c", serverId: "server", name: "geral", type: "text" }} memberCount={9} />);
    expect(screen.getByText("Canal de texto · 9 pessoas")).toBeVisible();
  });
});

describe("members dialog", () => {
  it("groups everyone by role and status, and lets the owner name moderators", async () => {
    const user = userEvent.setup();
    const setRole = vi.spyOn(api, "setRole").mockResolvedValue(member(bia, "moderator", "online"));
    render(<ProfileCardProvider profiles={{}}><MembersDialog server={server} self={ana} selfStatus="idle" members={members} rooms={{}} onClose={vi.fn()} /></ProfileCardProvider>);
    const groups = screen.getAllByRole("group").map(group => group.getAttribute("aria-label"));
    expect(groups).toEqual(["Dono", "Moderadores", "Online", "Offline"]);
    // The user's own status is the one they chose just now.
    expect(within(screen.getByRole("group", { name: "Dono" })).getByText("Ausente")).toBeVisible();
    expect(within(screen.getByRole("group", { name: "Dono" })).queryByRole("button", { name: /moderador/ })).toBeNull();
    await user.click(within(screen.getByRole("group", { name: "Online" })).getByRole("button", { name: "Tornar moderador" }));
    expect(setRole).toHaveBeenCalledWith("server", "bia", "moderator");
    await user.click(within(screen.getByRole("group", { name: "Moderadores" })).getByRole("button", { name: "Remover moderador" }));
    expect(setRole).toHaveBeenLastCalledWith("server", "joao", "member");
  });

  it("does not offer role changes to other members", () => {
    render(<ProfileCardProvider profiles={{}}><MembersDialog server={server} self={bia} selfStatus="online" members={members} rooms={{}} onClose={vi.fn()} /></ProfileCardProvider>);
    expect(screen.queryByRole("button", { name: "Tornar moderador" })).toBeNull();
  });
});

describe("members state", () => {
  it("loads the server's members and follows presence, arrivals and role changes", async () => {
    const load = vi.spyOn(api, "members").mockResolvedValue([members[0], members[3]]);
    const live = realtime();
    const { result } = renderHook(() => useMembers(live.client, 1, "server"));
    await waitFor(() => expect(result.current.members).toHaveLength(2));
    expect(load).toHaveBeenCalledWith("server", expect.any(AbortSignal));
    live.emit({ type: "presence.updated", userId: "caio", status: "idle" });
    expect(result.current.members[1].status).toBe("idle");
    live.emit({ type: "member.joined", serverId: "server", member: members[2] });
    expect(result.current.members.map(m => m.user.id)).toEqual(["ana", "caio", "bia"]);
    live.emit({ type: "member.updated", serverId: "server", member: { ...members[2], role: "moderator" } });
    expect(result.current.members[2].role).toBe("moderator");
    // Another server's news is not this list's.
    live.emit({ type: "member.joined", serverId: "other", member: members[4] });
    expect(result.current.members).toHaveLength(3);
  });
});

describe("own status", () => {
  it("sends the chosen status on connection and keeps it on this device", () => {
    const live = realtime();
    const { result, rerender } = renderHook(({ revision }) => usePresenceStatus(live.client, revision), { initialProps: { revision: 0 } });
    expect(live.sent).toEqual([]);
    rerender({ revision: 1 });
    expect(live.sent).toEqual([{ type: "presence.set", status: "online" }]);
    act(() => result.current.choose("dnd"));
    expect(live.sent.at(-1)).toEqual({ type: "presence.set", status: "dnd" });
    expect(localStorage.getItem("discvoice.status")).toBe("dnd");
    // A new connection sends it again: the API keeps statuses in memory only.
    rerender({ revision: 2 });
    expect(live.sent.at(-1)).toEqual({ type: "presence.set", status: "dnd" });
  });

  it("shows as idle after a while without use, and online again on input", () => {
    vi.useFakeTimers();
    try {
      const live = realtime();
      const { result } = renderHook(() => usePresenceStatus(live.client, 1));
      act(() => { vi.advanceTimersByTime(IDLE_AFTER_MS); });
      expect(result.current.status).toBe("idle");
      expect(result.current.chosen).toBe("online");
      expect(live.sent.at(-1)).toEqual({ type: "presence.set", status: "idle" });
      act(() => { window.dispatchEvent(new KeyboardEvent("keydown")); });
      expect(result.current.status).toBe("online");
      // Do not disturb stays as chosen, whatever the activity.
      act(() => result.current.choose("dnd"));
      act(() => { vi.advanceTimersByTime(IDLE_AFTER_MS); });
      expect(result.current.status).toBe("dnd");
    } finally {
      vi.useRealTimers();
    }
  });
});
