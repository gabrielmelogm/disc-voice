import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Attachment, Gif, RealtimeEvent } from "@disc-voice/shared";
import { api, ApiError } from "../lib/api";
import type { Realtime } from "../lib/realtime";
import { GifPicker } from "./GifPicker";
import { Attachments } from "./MessageContent";
import { TextChannel } from "./TextChannel";

const gif = (id: string, title: string): Gif => ({
  id, slug: `slug-${id}`, title, width: 320, height: 240,
  url: `https://static.klipy.com/ii/${id}/md.webp`, thumbnail: `https://static.klipy.com/ii/${id}/sm.webp`, still: `https://static.klipy.com/ii/${id}/md.jpg`,
});

function reduceMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("reduce"), media: query, addEventListener: () => {}, removeEventListener: () => {},
  }));
}

describe("GIF picker", () => {
  it("shows trending, searches, and previews before picking", async () => {
    const user = userEvent.setup();
    const gifs = vi.spyOn(api, "gifs").mockImplementation(async q => ({
      results: q ? [gif("2", "Gato dançando")] : [gif("1", "Oi")], page: 1, hasNext: false,
    }));
    const onPick = vi.fn();
    render(<GifPicker onPick={onPick} onClose={() => {}} />);
    expect(await screen.findByRole("button", { name: "GIF: Oi" })).toBeVisible();
    expect(screen.getByText("Em alta")).toBeVisible();
    expect(screen.getByText("KLIPY")).toBeVisible();

    await user.type(screen.getByRole("searchbox"), "gato");
    await user.click(await screen.findByRole("button", { name: "GIF: Gato dançando" }));
    expect(gifs).toHaveBeenLastCalledWith("gato", 1, expect.anything());
    // The preview comes first; nothing is picked until confirmed.
    expect(screen.getByRole("img", { name: "Gato dançando" })).toHaveAttribute("src", gif("2", "").url);
    expect(onPick).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(onPick).toHaveBeenCalledWith({
      slug: "slug-2", title: "Gato dançando", url: gif("2", "").url, still: gif("2", "").still, width: 320, height: 240,
    });
  });

  it("explains rate limits and recovers", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "gifs").mockRejectedValueOnce(new ApiError("limite", 429))
      .mockResolvedValue({ results: [gif("1", "Oi")], page: 1, hasNext: false });
    render(<GifPicker onPick={() => {}} onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Muitas buscas de GIF");
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByRole("button", { name: "GIF: Oi" })).toBeVisible();
  });

  it("closes with Escape without submitting the surrounding form", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "gifs").mockResolvedValue({ results: [], page: 1, hasNext: false });
    const onClose = vi.fn();
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    render(<form onSubmit={e => onSubmit(e.nativeEvent)}><GifPicker onPick={() => {}} onClose={onClose} /></form>);
    expect(await screen.findByText(/Nenhum GIF encontrado/)).toBeVisible();
    await user.type(screen.getByRole("searchbox"), "oi{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("GIF messages", () => {
  const file: Attachment = {
    id: "klipy:oi", filename: "Oi.webp", url: "https://static.klipy.com/ii/1/md.webp", still: "https://static.klipy.com/ii/1/md.jpg",
    size: 0, contentType: "image/webp", width: 320, height: 240, provider: "klipy",
  };

  it("plays inline", () => {
    reduceMotion(false);
    render(<Attachments files={[file]} onView={() => {}} />);
    expect(screen.getByRole("button", { name: "Ver GIF Oi" }).querySelector("img")).toHaveAttribute("src", file.url);
    expect(screen.queryByRole("button", { name: /Reproduzir/ })).not.toBeInTheDocument();
  });

  it("starts paused when the user prefers reduced motion", async () => {
    const user = userEvent.setup();
    reduceMotion(true);
    render(<Attachments files={[file]} onView={() => {}} />);
    const image = () => screen.getByRole("button", { name: "Ver GIF Oi" }).querySelector("img");
    expect(image()).toHaveAttribute("src", file.still);
    await user.click(screen.getByRole("button", { name: "Reproduzir Oi" }));
    expect(image()).toHaveAttribute("src", file.url);
  });

  it("sends a GIF from the composer and keeps the typed text", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [], hasMore: false });
    vi.spyOn(api, "gifs").mockResolvedValue({ results: [gif("1", "Oi")], page: 1, hasNext: false });
    const send = vi.spyOn(api, "sendMessage").mockRejectedValue(new Error("offline"));
    const live = { onEvent: (_: (event: RealtimeEvent) => void) => () => {}, send: vi.fn() } as unknown as Realtime;
    render(<TextChannel channel={{ id: "c1", serverId: "s1", name: "geral", type: "text" }} realtime={live} revision={1} />);
    await user.type(screen.getByRole("textbox", { name: "Mensagem em #geral" }), "rascunho");
    await user.click(screen.getByRole("button", { name: "Enviar um GIF" }));
    await user.click(await screen.findByRole("button", { name: "GIF: Oi" }));
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    const [channelId, , content, choice] = send.mock.calls[0];
    expect([channelId, content, choice?.url]).toEqual(["c1", "", gif("1", "").url]);
    expect(screen.queryByRole("dialog", { name: "Enviar um GIF" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Mensagem em #geral" })).toHaveValue("rascunho");
  });
});
