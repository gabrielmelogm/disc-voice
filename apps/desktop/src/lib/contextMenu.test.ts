import { afterEach, describe, expect, it } from "vitest";
import { preventDefaultContextMenu } from "./contextMenu";

function rightClick(element: Element) {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("default context menu", () => {
  let stop = () => {};
  afterEach(() => { stop(); document.body.innerHTML = ""; window.getSelection()?.removeAllRanges(); });

  it("is hidden on the app but kept on text fields and selected text", () => {
    stop = preventDefaultContextMenu();
    document.body.innerHTML = `<p>Olá</p><input /><textarea></textarea>`;
    const paragraph = document.querySelector("p")!;
    expect(rightClick(paragraph)).toBe(true);
    expect(rightClick(document.querySelector("input")!)).toBe(false);
    expect(rightClick(document.querySelector("textarea")!)).toBe(false);
    window.getSelection()!.selectAllChildren(paragraph);
    expect(rightClick(paragraph)).toBe(false);
  });
});
