import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  icon?: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  onSelect: () => void;
  danger?: boolean;
}

/** A line between groups of items. */
export const SEPARATOR = "separator";

/** Items left out (`false`, `null`) are dropped, as are separators at the ends or in a row. */
export type MenuEntry = MenuItem | typeof SEPARATOR | false | null | undefined;

export function menuEntries(entries: MenuEntry[]): (MenuItem | typeof SEPARATOR)[] {
  const kept: (MenuItem | typeof SEPARATOR)[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === SEPARATOR && (!kept.length || kept.at(-1) === SEPARATOR)) continue;
    kept.push(entry);
  }
  if (kept.at(-1) === SEPARATOR) kept.pop();
  return kept;
}

/** Where a menu of this size opens so it stays on screen: flipped to the left of (or above) the cursor near an edge. */
export function menuPosition(x: number, y: number, width: number, height: number, viewport = { width: window.innerWidth, height: window.innerHeight }, margin = 8) {
  let left = x + width > viewport.width - margin ? x - width : x;
  let top = y + height > viewport.height - margin ? y - height : y;
  left = Math.max(margin, Math.min(left, viewport.width - width - margin));
  top = Math.max(margin, Math.min(top, viewport.height - height - margin));
  return { left, top };
}

interface OpenMenu { x: number; y: number; label: string; items: (MenuItem | typeof SEPARATOR)[]; trigger: HTMLElement | null }

/**
 * A right-click menu: `open` from an `onContextMenu` handler, and render
 * `element`. It also opens from the keyboard (the Menu key or Shift+F10),
 * under the focused element.
 */
export function useContextMenu() {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const open = useCallback((event: ReactMouseEvent, label: string, entries: MenuEntry[]) => {
    const items = menuEntries(entries);
    if (!items.length) return;
    // The app's menu replaces the webview's, and an outer element's menu.
    event.preventDefault();
    event.stopPropagation();
    const trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    let { clientX: x, clientY: y } = event;
    // From the keyboard there is no cursor: open under the element.
    if (!x && !y && trigger) {
      const box = trigger.getBoundingClientRect();
      x = box.left + Math.min(24, box.width / 2);
      y = box.top + Math.min(24, box.height);
    }
    setMenu({ x, y, label, items, trigger });
  }, []);
  const element = menu && <ContextMenu {...menu} onClose={close} />;
  return { open, close, element, isOpen: !!menu };
}

function ContextMenu({ x, y, label, items, trigger, onClose }: OpenMenu & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const box = ref.current!.getBoundingClientRect();
    setPosition(menuPosition(x, y, box.width, box.height));
  }, [x, y, items]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
    const outside = (event: Event) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const away = () => onClose();
    document.addEventListener("pointerdown", outside, true);
    // Scrolling or resizing would leave it pointing at nothing.
    document.addEventListener("scroll", outside, true);
    window.addEventListener("resize", away);
    window.addEventListener("blur", away);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", away);
      window.removeEventListener("blur", away);
    };
  }, [onClose]);

  /** Closes, and gives the focus back to what the menu was opened on. */
  const dismiss = useCallback(() => {
    onClose();
    if (trigger?.isConnected) trigger.focus();
  }, [onClose, trigger]);

  function keys(event: KeyboardEvent) {
    const buttons = Array.from(ref.current!.querySelectorAll<HTMLElement>("[role='menuitem']"));
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    const go = (next: number) => { event.preventDefault(); buttons[(next + buttons.length) % buttons.length]?.focus(); };
    if (event.key === "ArrowDown") go(index + 1);
    else if (event.key === "ArrowUp") go(index < 0 ? -1 : index - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(-1);
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
    else if (event.key === "Tab") { event.preventDefault(); dismiss(); }
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      // Typing a letter jumps to the next item that starts with it.
      const letter = event.key.toLocaleLowerCase("pt-BR");
      const after = [...buttons.slice(index + 1), ...buttons.slice(0, index + 1)];
      const found = after.find(button => button.textContent?.trim().toLocaleLowerCase("pt-BR").startsWith(letter));
      if (found) { event.preventDefault(); found.focus(); }
    }
  }

  // Inside a modal dialog the rest of the page is inert: the menu lives in it.
  return createPortal(<div ref={ref} className="context-menu" role="menu" aria-label={label} tabIndex={-1} onKeyDown={keys}
    onContextMenu={event => event.preventDefault()}
    style={position ? { left: position.left, top: position.top } : { visibility: "hidden" }}>
    {items.map((item, index) => item === SEPARATOR
      ? <div key={`separator-${index}`} role="separator" className="context-menu-separator" />
      : <button key={item.label} type="button" role="menuitem" tabIndex={-1} className={item.danger ? "danger" : ""}
        onPointerEnter={event => event.currentTarget.focus()}
        onClick={() => { dismiss(); item.onSelect(); }}>
        {item.icon && <item.icon size={16} aria-hidden={true} />}<span>{item.label}</span>
      </button>)}
  </div>, trigger?.closest("dialog[open]") ?? document.body);
}
