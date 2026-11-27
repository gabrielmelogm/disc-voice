import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Server, ServerMember } from "@disc-voice/shared";
import { api } from "../lib/api";
import * as files from "../lib/files";
import { ServerSettings } from "./ServerSettings";
import { ServerRolesProvider } from "./ServerRoles";
import { everyone, role, serverRoles } from "../test/serverRoles";

vi.mock("../lib/files", async original => ({ ...await original<typeof import("../lib/files")>(), uploadFile: vi.fn() }));

const person = (id: string, name: string) => ({ id, email: `${id}@example.com`, name });
const member = (user: ReturnType<typeof person>, roles: string[], owner = false): ServerMember =>
  ({ user, owner, roles, status: "online", joinedAt: "2026-11-01T00:00:00Z" });
const ana = person("ana", "Ana Lima");
const bia = person("bia", "Bia Souza");
const members = [member(ana, [], true), member(bia, ["mod"])];
// Moderação only bans: it sees the settings, but not the overview.
const roles = [role("mod", "Moderação", 1, 64), everyone()];
const server = (icon: string | null = null): Server => ({ id: "server", name: "Estúdio", ownerId: "ana", icon, description: "" });

function open(self: string, value: Server = server()) {
  return render(<ServerRolesProvider value={serverRoles(self, members, roles)}>
    <ServerSettings server={value} members={members} onClose={vi.fn()} />
  </ServerRolesProvider>);
}

const image = () => new File(["png"], "logo.png", { type: "image/png" });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(files.uploadFile).mockReset();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); },
  });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:icon") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

describe("server icon", () => {
  it("uploads the picked image and saves it as the icon", async () => {
    const user = userEvent.setup();
    vi.mocked(files.uploadFile).mockImplementation(async (_file, progress) => {
      progress?.(1);
      return { id: "f1", name: "logo.png", url: "/api/files/f1/logo.png", size: 3, contentType: "image/png", width: 16, height: 16, createdAt: "2026-11-27T10:00:00Z" };
    });
    const update = vi.spyOn(api, "updateServer").mockResolvedValue(server("/api/files/f1/logo.png"));
    open("ana");
    await user.upload(screen.getByLabelText("Arquivo do ícone"), image());
    expect(files.uploadFile).toHaveBeenCalledWith(expect.objectContaining({ name: "logo.png" }), expect.any(Function), expect.any(AbortSignal));
    const save = screen.getByRole("button", { name: "Salvar alterações" });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(update).toHaveBeenCalledWith("server", { name: "Estúdio", description: "", icon: "f1" }));
    expect(await screen.findByText("Alterações salvas.")).toBeVisible();
  });

  it("removes the current icon", async () => {
    const user = userEvent.setup();
    const update = vi.spyOn(api, "updateServer").mockResolvedValue(server());
    open("ana", server("https://cdn.discordapp.com/icons/1/a.png"));
    await user.click(screen.getByRole("button", { name: "Remover ícone" }));
    expect(screen.queryByRole("button", { name: "Remover ícone" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("server", { name: "Estúdio", description: "", icon: null }));
  });

  it("refuses files that aren't images before uploading", async () => {
    const user = userEvent.setup({ applyAccept: false });
    open("ana");
    await user.upload(screen.getByLabelText("Arquivo do ícone"), new File(["oi"], "notas.txt", { type: "text/plain" }));
    expect(screen.getByRole("alert")).toHaveTextContent("O ícone deve ser uma imagem");
    expect(files.uploadFile).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeDisabled();
  });

  it("is not shown to who can't manage the server", () => {
    vi.spyOn(api, "bans").mockResolvedValue([]);
    open("bia");
    expect(screen.queryByLabelText("Arquivo do ícone")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Excluir servidor" })).not.toBeInTheDocument();
  });
});
