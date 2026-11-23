import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Friends, User, UserProfile } from "@disc-voice/shared";
import type { FriendsState } from "../hooks/useFriends";
import { api } from "../lib/api";
import { DirectProfilePanel } from "./DirectMessages";
import { FriendsPage, friendshipWith } from "./Friends";

const elisa: User = { id: "elisa", email: "elisa@example.com", name: "Elisa Prado", pronouns: "ela/dela", bio: "Gosto de RPG." };
const bruno: User = { id: "bruno", email: "bruno@example.com", name: "Bruno" };
const caio: User = { id: "caio", email: "caio@example.com", name: "Caio" };
const dani: User = { id: "dani", email: "dani@example.com", name: "Dani" };

function state(data: Partial<Friends> = {}): FriendsState {
  return {
    friends: [
      { user: elisa, status: "online", since: "2026-11-01T00:00:00Z" },
      { user: bruno, status: "offline", since: "2026-11-02T00:00:00Z" },
    ],
    incoming: [{ user: caio, createdAt: "2026-11-20T00:00:00Z" }],
    outgoing: [{ user: dani, createdAt: "2026-11-21T00:00:00Z" }],
    ...data,
    loading: false, error: "", retry: vi.fn(),
    add: vi.fn().mockResolvedValue(undefined),
    accept: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

describe("friends page", () => {
  it("opens on pending requests and answers them", async () => {
    const user = userEvent.setup();
    const friends = state();
    render(<FriendsPage friends={friends} selfId="me" onMessage={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Pendentes, 1 pedido" })).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByRole("button", { name: "Aceitar pedido de Caio" }));
    expect(friends.accept).toHaveBeenCalledWith("caio");
    await user.click(screen.getByRole("button", { name: "Recusar pedido de Caio" }));
    await user.click(screen.getByRole("button", { name: "Cancelar pedido para Dani" }));
    expect(vi.mocked(friends.remove).mock.calls).toEqual([["caio"], ["dani"]]);
  });

  it("lists friends online first, and all of them with presence", async () => {
    const user = userEvent.setup();
    render(<FriendsPage friends={state({ incoming: [] })} selfId="me" onMessage={vi.fn()} />);
    const list = () => screen.getByRole("list", { name: "Amigos" });
    expect(list()).toHaveTextContent("Elisa Prado");
    expect(list()).not.toHaveTextContent("Bruno");
    await user.click(screen.getByRole("button", { name: "Todos" }));
    expect(list()).toHaveTextContent("Bruno");
    expect(list()).toHaveTextContent("Offline");
  });

  it("starts a conversation and confirms before removing a friend", async () => {
    const user = userEvent.setup();
    const friends = state({ incoming: [] });
    const onMessage = vi.fn().mockResolvedValue(undefined);
    render(<FriendsPage friends={friends} selfId="me" onMessage={onMessage} />);
    await user.click(screen.getByRole("button", { name: "Enviar mensagem para Elisa Prado" }));
    expect(onMessage).toHaveBeenCalledWith(elisa);
    await user.click(screen.getByRole("button", { name: "Remover Elisa Prado dos amigos" }));
    expect(friends.remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remover" }));
    expect(friends.remove).toHaveBeenCalledWith("elisa");
  });

  it("finds people to add, knowing who is already a friend or asked", async () => {
    const user = userEvent.setup();
    const friends = state();
    const stranger: User = { id: "eva", email: "eva@example.com", name: "Eva" };
    vi.spyOn(api, "search").mockResolvedValue({ channels: [], messages: [], nextCursor: null, people: [elisa, caio, dani, stranger, { ...bruno, id: "me" }] });
    render(<FriendsPage friends={friends} selfId="me" onMessage={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Adicionar amigo" }));
    await user.type(screen.getByLabelText("Buscar pessoas"), "a");
    const found = await screen.findByRole("list", { name: "Pessoas encontradas" });
    await waitFor(() => expect(found).toHaveTextContent("Eva"));
    expect(found).toHaveTextContent("Já são amigos");
    expect(found).toHaveTextContent("Pedido enviado");
    expect(found).not.toHaveTextContent("Bruno");
    await user.click(screen.getByRole("button", { name: "Aceitar pedido" }));
    await user.click(screen.getByRole("button", { name: "Adicionar" }));
    expect(vi.mocked(friends.add).mock.calls).toEqual([["caio"], ["eva"]]);
  });

  it("shows why an action failed", async () => {
    const user = userEvent.setup();
    const friends = state();
    friends.accept = vi.fn().mockRejectedValue(new Error("Pedido de amizade não encontrado."));
    render(<FriendsPage friends={friends} selfId="me" onMessage={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Aceitar pedido de Caio" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Pedido de amizade não encontrado.");
  });

  it("tells the relation with someone", () => {
    const friends = state();
    expect(["elisa", "caio", "dani", "eva"].map(id => friendshipWith(friends, id))).toEqual(["friends", "incoming", "outgoing", "none"]);
  });
});

describe("profile panel in a conversation", () => {
  const profile: UserProfile = {
    user: elisa, memberSince: "2025-03-14T12:00:00Z", friendship: "none", status: null,
    mutualServers: [{ id: "s1", name: "Guilda", ownerId: "x" }],
  };

  it("shows who the other person is and the servers in common", async () => {
    vi.spyOn(api, "profile").mockResolvedValue(profile);
    render(<DirectProfilePanel user={elisa} friendship="friends" status="online" onAddFriend={vi.fn()} />);
    const panel = screen.getByRole("complementary", { name: "Perfil de Elisa Prado" });
    expect(panel).toHaveTextContent("ela/dela");
    expect(panel).toHaveTextContent("Gosto de RPG.");
    expect(await screen.findByText("14 de março de 2025")).toBeVisible();
    expect(panel).toHaveTextContent("Servidores em comum — 1");
    expect(panel).toHaveTextContent("Guilda");
    expect(panel).toHaveTextContent("Vocês são amigos");
  });

  it("offers to add or accept the person as a friend", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "profile").mockResolvedValue(profile);
    const onAddFriend = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<DirectProfilePanel user={elisa} friendship="none" onAddFriend={onAddFriend} />);
    await user.click(screen.getByRole("button", { name: "Adicionar amigo" }));
    expect(onAddFriend).toHaveBeenCalled();
    rerender(<DirectProfilePanel user={elisa} friendship="incoming" onAddFriend={onAddFriend} />);
    expect(screen.getByRole("button", { name: "Aceitar pedido de amizade" })).toBeVisible();
    rerender(<DirectProfilePanel user={elisa} friendship="outgoing" onAddFriend={onAddFriend} />);
    expect(screen.getByText("Pedido de amizade enviado")).toBeVisible();
  });
});
