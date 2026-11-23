import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { imageLinks, mediaKind, MessageText, parseMessage } from "./MessageContent";

describe("message text", () => {
  it("finds links without the punctuation around them", () => {
    expect(parseMessage("veja https://exemplo.com/a?b=1. e (https://x.dev/y)!")).toEqual([
      { kind: "text", text: "veja " },
      { kind: "link", url: "https://exemplo.com/a?b=1" },
      { kind: "text", text: ". e (" },
      { kind: "link", url: "https://x.dev/y" },
      { kind: "text", text: ")!" },
    ]);
    // Parentheses that belong to the URL stay.
    expect(parseMessage("https://pt.wikipedia.org/wiki/Java_(linguagem)")[0]).toEqual({ kind: "link", url: "https://pt.wikipedia.org/wiki/Java_(linguagem)" });
    expect(parseMessage("javascript:alert(1)")).toEqual([{ kind: "text", text: "javascript:alert(1)" }]);
  });

  it("understands the basic Discord markdown", () => {
    expect(parseMessage("**forte** *leve* ~~riscado~~ `x = 1`")).toEqual([
      { kind: "bold", children: [{ kind: "text", text: "forte" }] },
      { kind: "text", text: " " },
      { kind: "italic", children: [{ kind: "text", text: "leve" }] },
      { kind: "text", text: " " },
      { kind: "strike", children: [{ kind: "text", text: "riscado" }] },
      { kind: "text", text: " " },
      { kind: "code", text: "x = 1" },
    ]);
    expect(parseMessage("antes\n```js\nconst a = 1;\n```\ndepois")).toEqual([
      { kind: "text", text: "antes\n" },
      { kind: "codeblock", text: "const a = 1;" },
      { kind: "text", text: "\ndepois" },
    ]);
    // Links inside code are not links, and lone asterisks are just text.
    expect(parseMessage("`https://a.com`")).toEqual([{ kind: "code", text: "https://a.com" }]);
    expect(parseMessage("2 * 3 * 4")).toEqual([{ kind: "text", text: "2 * 3 * 4" }]);
  });

  it("opens links outside the app", async () => {
    const popup = vi.spyOn(window, "open").mockReturnValue(null);
    render(<MessageText text="olha **isso** https://exemplo.com" />);
    expect(screen.getByText("isso").tagName).toBe("STRONG");
    await userEvent.setup().click(screen.getByRole("link", { name: "https://exemplo.com" }));
    expect(popup).toHaveBeenCalledWith("https://exemplo.com", "_blank", "noopener,noreferrer");
  });

  it("previews links to images and recognizes media", () => {
    expect(imageLinks("a https://i.imgur.com/x.PNG e https://site.com/pagina e https://c.com/f.gif?w=1")).toEqual([
      "https://i.imgur.com/x.PNG", "https://c.com/f.gif?w=1",
    ]);
    const file = { id: "1", url: "/api/files/x/a", size: 1, width: null, height: null };
    expect(mediaKind({ ...file, filename: "a.png", contentType: "image/png" })).toBe("image");
    expect(mediaKind({ ...file, filename: "a.svg", contentType: "image/svg+xml" })).toBe("file");
    expect(mediaKind({ ...file, filename: "a.mp4", contentType: null })).toBe("video");
    expect(mediaKind({ ...file, filename: "a.mp3", contentType: "audio/mpeg" })).toBe("audio");
    expect(mediaKind({ ...file, filename: "a.png", contentType: "image/png", unavailable: true })).toBe("file");
  });
});
