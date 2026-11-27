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
import { ServerRolesProvider } from "./ServerRoles";
import { everyone, role, serverRoles } from "../test/serverRoles";

const person = (id: string, name: string) => ({ id, email: `${id}@example.com`, name });
const ana = person("ana", "Ana Lima");
const joao = person("joao", "João Reis");
const bia = person("bia", "Bia Souza");
const caio = person("caio", "Caio Prado");
const duda = person("duda", "Duda Alves");
const member = (user: ReturnType<typeof person>, roles: string[], status: ServerMember["status"], owner = false): ServerMember =>
  ({ user, owner, roles, status, joinedAt: "2026-11-01T00:00:00Z" });
const members = [
  member(ana, [], "online", true),
  member(joao, ["mod"], "dnd"),
  member(bia, [], "online"),
  member(caio, [], "offline"),
  member(duda, [], "offline"),
];
// Moderação manages roles and bans; Ajudante is below it.
const roles = [role("mod", "Moderação", 2, 4 | 64, 0x2ecc71), role("help", "Ajudante", 1), everyone()];
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
  render(<ServerRolesProvider value={serverRoles(ana.id, members, roles)}><ProfileCardProvider profiles={{}}><PeoplePanel self={ana} selfStatus="online" members={members} loading={false} error=""
    rooms={rooms} onRetry={vi.fn()} onShowAll={onShowAll} /></ProfileCardProvider></ServerRolesProvider>);
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
      "JRJoão ReisModeraçãoNão perturbe",
      "BSBia SouzaNa Sala de reunião",
    ]);
    expect(screen.getByText("Offline · 2")).toBeVisible();
    expect(screen.queryByRole("list", { name: "Pessoas offline" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Ver todas as pessoas (2 offline)" }));
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
  const open = (self: typeof ana) => render(<ServerRolesProvider value={serverRoles(self.id, members, roles)}><ProfileCardProvider profiles={{}}>
    <MembersDialog server={server} self={self} selfStatus="idle" members={members} rooms={{}} onClose={vi.fn()} /></ProfileCardProvider></ServerRolesProvider>);

  it("groups everyone by highest role and status, and lets the owner give roles and ban", async () => {
    const user = userEvent.setup();
    const assign = vi.spyOn(api, "assignRole").mockResolvedValue(member(bia, ["help"], "online"));
    const ban = vi.spyOn(api, "ban").mockResolvedValue(undefined);
    open(ana);
    const groups = screen.getAllByRole("group").map(group => group.getAttribute("aria-label"));
    expect(groups).toEqual(["Dono", "Moderação", "Online", "Offline"]);
    // The user's own status is the one they chose just now.
    expect(within(screen.getByRole("group", { name: "Dono" })).getByText("Ausente")).toBeVisible();
    // Nobody acts on the owner.
    expect(within(screen.getByRole("group", { name: "Dono" })).queryByRole("button", { name: /Banir|Cargos/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cargos de Bia Souza" }));
    await user.click(within(screen.getByRole("group", { name: "Cargos de Bia Souza" })).getByRole("checkbox", { name: "Ajudante" }));
    expect(assign).toHaveBeenCalledWith("server", "bia", "help", true);
    await user.click(screen.getByRole("button", { name: "Banir João Reis" }));
    const dialog = screen.getByRole("dialog", { name: "Banir João Reis" });
    await user.type(within(dialog).getByLabelText("Motivo (opcional)"), "spam");
    await user.click(within(dialog).getByRole("button", { name: "Banir" }));
    expect(ban).toHaveBeenCalledWith("server", "joao", "spam");
  });

  it("offers moderators only roles and people below their own role", async () => {
    const user = userEvent.setup();
    open(joao);
    expect(screen.queryByRole("button", { name: "Banir Ana Lima" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Banir João Reis" })).toBeNull();
    expect(screen.getByRole("button", { name: "Banir Bia Souza" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cargos de Bia Souza" }));
    const menu = within(screen.getByRole("group", { name: "Cargos de Bia Souza" }));
    expect(menu.getAllByRole("checkbox").map(box => box.parentElement?.textContent)).toEqual(["Ajudante"]);
  });

  it("does not offer role changes or bans to plain members", () => {
    open(bia);
    expect(screen.queryByRole("button", { name: /^Cargos de|^Banir/ })).toBeNull();
  });
});
describe("members state", () => {
  it("loads the server's members and follows presence, arrivals, role changes and bans", async () => {
    const load = vi.spyOn(api, "members").mockResolvedValue([members[0], members[3]]);
    const live = realtime();
    const { result } = renderHook(() => useMembers(live.client, 1, "server"));
    await waitFor(() => expect(result.current.members).toHaveLength(2));
    expect(load).toHaveBeenCalledWith("server", expect.any(AbortSignal));
    live.emit({ type: "presence.updated", userId: "caio", status: "idle" });
    expect(result.current.members[1].status).toBe("idle");
    live.emit({ type: "member.joined", serverId: "server", member: members[2] });
    expect(result.current.members.map(m => m.user.id)).toEqual(["ana", "caio", "bia"]);
    live.emit({ type: "member.updated", serverId: "server", member: { ...members[2], roles: ["mod"] } });
    expect(result.current.members[2].roles).toEqual(["mod"]);
    // Another server's news is not this list's.
    live.emit({ type: "member.joined", serverId: "other", member: members[4] });
    expect(result.current.members).toHaveLength(3);
    live.emit({ type: "member.left", serverId: "server", userId: "caio" });
    expect(result.current.members.map(m => m.user.id)).toEqual(["ana", "bia"]);
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
