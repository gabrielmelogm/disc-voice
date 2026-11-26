import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudFile, RealtimeEvent } from "@disc-voice/shared";
import { clipboardFiles, TextChannel } from "./TextChannel";
import { FilesDrawer } from "./FilesDrawer";
import type { Realtime } from "../lib/realtime";
import { api } from "../lib/api";
import * as files from "../lib/files";
import * as external from "../lib/external";

vi.mock("../lib/files", async original => ({ ...await original<typeof import("../lib/files")>(), uploadFile: vi.fn() }));

const channel = { id: "channel-1", serverId: "server-1", name: "geral", type: "text" as const };
const realtime = {
  onEvent: (_fn: (event: RealtimeEvent) => void) => () => {},
  send: vi.fn(),
} as unknown as Realtime;
const cloud = (id: string, name: string, size = 1024, contentType = "text/plain"): CloudFile => ({
  id, name, url: `/api/files/${id}/${name}`, size, contentType, width: null, height: null, createdAt: "2026-11-20T10:00:00Z",
});
const sized = (name: string, size: number, type = "") => {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
};

describe("sending files", () => {
  it("uploads picked files and sends them with the message", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [], hasMore: false });
    const uploaded = cloud("f1", "notas.txt");
    vi.mocked(files.uploadFile).mockImplementation(async (_file, progress) => { progress?.(1); return uploaded; });
    const send = vi.spyOn(api, "sendMessage").mockResolvedValue({
      id: "1", channelId: channel.id, clientId: "c", author: { id: "me", email: "", name: "Eu" }, content: "", createdAt: "2026-11-20T10:00:00Z",
      attachments: [{ id: "f1", filename: "notas.txt", url: uploaded.url, size: 1024, contentType: "text/plain", width: null, height: null }],
    });
    render(<TextChannel channel={channel} realtime={realtime} revision={1} />);
    await user.upload(screen.getByTestId("file-input"), new File(["oi"], "notas.txt", { type: "text/plain" }));
    const drafts = screen.getByRole("list", { name: "Arquivos para enviar" });
    expect(within(drafts).getByText("notas.txt")).toBeVisible();
    // Only the file, no text: still sends.
    await waitFor(() => expect(screen.getByRole("button", { name: "Enviar mensagem" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Enviar mensagem" }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0]).toEqual([channel.id, expect.any(String), "", undefined, ["f1"]]);
    expect(screen.queryByRole("list", { name: "Arquivos para enviar" })).not.toBeInTheDocument();
  });

  it("refuses files over 15 MB and dangerous types before uploading", async () => {
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [], hasMore: false });
    vi.mocked(files.uploadFile).mockReset();
    render(<TextChannel channel={channel} realtime={realtime} revision={1} />);
    const input = screen.getByTestId("file-input");
    fireEvent.change(input, { target: { files: [sized("video.mp4", 15 * 1024 * 1024 + 1)] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("“video.mp4” tem mais de 15 MB, o limite por arquivo.");
    fireEvent.change(input, { target: { files: [sized("foto.png.exe", 10)] } });
    expect(screen.getByRole("alert")).toHaveTextContent("pode executar programas");
    expect(files.uploadFile).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Enviar mensagem" })).toBeDisabled();
  });

  it("accepts files dropped on the chat", async () => {
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [], hasMore: false });
    vi.mocked(files.uploadFile).mockResolvedValue(cloud("f2", "mapa.pdf"));
    render(<TextChannel channel={channel} realtime={realtime} revision={1} />);
    const chat = screen.getByRole("region", { name: "Chat de texto geral" });
    const dataTransfer = { types: ["Files"], files: [new File(["%PDF"], "mapa.pdf")], dropEffect: "none" };
    fireEvent.dragEnter(chat, { dataTransfer });
    expect(screen.getByText("Solte para anexar")).toBeInTheDocument();
    fireEvent.drop(chat, { dataTransfer });
    expect(screen.queryByText("Solte para anexar")).not.toBeInTheDocument();
    expect(await screen.findByText("mapa.pdf")).toBeVisible();
    expect(files.uploadFile).toHaveBeenCalledWith(expect.objectContaining({ name: "mapa.pdf" }), expect.any(Function), expect.any(AbortSignal));
  });

  it("names screenshots pasted from the clipboard", () => {
    const shot = new File(["png"], "image.png", { type: "image/png" });
    const items = { files: [], items: [{ kind: "string", getAsFile: () => null }, { kind: "file", getAsFile: () => shot }] } as unknown as DataTransfer;
    const [file] = clipboardFiles(items, new Date(2026, 10, 25, 9, 5, 3));
    expect(file.name).toBe("Captura de tela 2026-11-25 09.05.03.png");
    expect(file.type).toBe("image/png");
    const named = new File(["x"], "relatorio.pdf");
    expect(clipboardFiles({ files: [named], items: [] } as unknown as DataTransfer)).toEqual([named]);
    expect(clipboardFiles(null)).toEqual([]);
  });

  it("attaches a screenshot pasted with Ctrl+V and shows the upload progress", async () => {
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [], hasMore: false });
    let progress: ((fraction: number) => void) | undefined;
    let finish: (file: CloudFile) => void = () => {};
    vi.mocked(files.uploadFile).mockReset().mockImplementation((_file, onProgress) => {
      progress = onProgress;
      return new Promise(resolve => { finish = resolve; });
    });
    render(<TextChannel channel={channel} realtime={realtime} revision={1} />);
    const shot = new File(["png"], "image.png", { type: "image/png" });
    // A screenshot comes as a clipboard item, not in `files`.
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [], items: [{ kind: "file", getAsFile: () => shot }] } });
    const drafts = await screen.findByRole("list", { name: "Arquivos para enviar" });
    expect(within(drafts).getByText(/^Captura de tela .*\.png$/)).toBeInTheDocument();
    expect(files.uploadFile).toHaveBeenCalledWith(expect.objectContaining({ type: "image/png" }), expect.any(Function), expect.any(AbortSignal));

    act(() => progress?.(0.4));
    const bar = screen.getByRole("progressbar", { name: /Enviando Captura de tela/ });
    expect(bar).toHaveAttribute("aria-valuenow", "40");
    expect(within(drafts).getByText(/Enviando… 40%/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar mensagem" })).toBeDisabled();
    expect(screen.getByText("Aguardando o envio dos arquivos…")).toBeInTheDocument();

    await act(async () => finish(cloud("f9", "Captura de tela.png", 3, "image/png")));
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(within(drafts).getByText(/pronto/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar mensagem" })).toBeEnabled();
  });

  it("attaches pasted files with the focus outside the message field", async () => {
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [], hasMore: false });
    vi.mocked(files.uploadFile).mockReset().mockResolvedValue(cloud("f3", "print.png", 3, "image/png"));
    render(<TextChannel channel={channel} realtime={realtime} revision={1} />);
    fireEvent.paste(document.body, { clipboardData: { files: [new File(["png"], "image.png", { type: "image/png" })], items: [] } });
    expect(await screen.findByRole("list", { name: "Arquivos para enviar" })).toBeInTheDocument();
    expect(files.uploadFile).toHaveBeenCalledTimes(1);
    // Text pasted into the field stays text.
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [], items: [{ kind: "string", getAsFile: () => null }] } });
    expect(files.uploadFile).toHaveBeenCalledTimes(1);
  });

  it("shows deleted files by name only", async () => {
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [{
      id: "1", channelId: channel.id, clientId: "c", author: { id: "a", email: "", name: "Bia" }, content: "", createdAt: "2026-11-20T10:00:00Z",
      attachments: [{ id: "f1", filename: "foto.png", url: "/api/files/f1/foto.png", size: 10, contentType: "image/png", width: null, height: null, deleted: true }],
    }], hasMore: false });
    render(<TextChannel channel={channel} realtime={realtime} revision={1} />);
    expect(await screen.findByText("Arquivo apagado por quem enviou")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Ver imagem foto.png" })).not.toBeInTheDocument();
  });
});

describe("files gallery", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); },
    });
  });

  it("shows the space used, downloads and deletes files", async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(external, "openExternal").mockResolvedValue();
    vi.spyOn(api, "files").mockResolvedValue({
      files: [cloud("f1", "foto.png", 512 * 1024 * 1024, "image/png"), cloud("f2", "notas.txt", 1024)],
      used: 512 * 1024 * 1024 + 1024, quota: 1024 ** 3, maxFileSize: 15 * 1024 ** 2,
    });
    const remove = vi.spyOn(api, "deleteFile").mockResolvedValue();
    render(<FilesDrawer onClose={() => {}} />);
    expect(await screen.findByText("foto.png")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Espaço usado" })).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("de 1 GB usados", { exact: false })).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Imagens" }));
    expect(screen.queryByText("notas.txt")).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Todos" }));

    await user.click(screen.getByRole("button", { name: "Baixar notas.txt" }));
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/\/api\/files\/f2\/notas\.txt\?download=1$/));

    await user.click(screen.getByRole("button", { name: "Apagar foto.png" }));
    await user.click(screen.getByRole("button", { name: "Apagar" }));
    await waitFor(() => expect(screen.queryByText("foto.png")).not.toBeInTheDocument());
    expect(remove).toHaveBeenCalledWith("f1");
    expect(screen.getByRole("meter", { name: "Espaço usado" })).toHaveAttribute("aria-valuenow", "0");
  });
});

describe("dropping files on the window", () => {
  const drag = (type: string, types: string[], handled = false) => {
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: { types, dropEffect: "copy" } });
    if (handled) event.preventDefault();
    return event;
  };

  it("never lets a file dropped outside a chat replace the app", () => {
    const stop = files.preventFileNavigation(window);
    const outside = drag("drop", ["Files"]);
    window.dispatchEvent(outside);
    expect(outside.defaultPrevented).toBe(true);
    const over = drag("dragover", ["Files"]);
    window.dispatchEvent(over);
    expect(over.dataTransfer!.dropEffect).toBe("none");
    // A chat that took the drop keeps its "copy" cursor.
    const chat = drag("dragover", ["Files"], true);
    window.dispatchEvent(chat);
    expect(chat.dataTransfer!.dropEffect).toBe("copy");
    // Dragging text is left alone.
    const text = drag("drop", ["text/plain"]);
    window.dispatchEvent(text);
    expect(text.defaultPrevented).toBe(false);
    stop();
  });

  it("lets the webview, not the native window, receive dropped files", async () => {
    const { readFileSync } = await import("node:fs");
    const config = JSON.parse(readFileSync(`${process.cwd()}/src-tauri/tauri.conf.json`, "utf8"));
    // With Tauri's native drop handler on, WebView2 never fires `drop` with the files.
    expect(config.app.windows[0].dragDropEnabled).toBe(false);
  });
});
