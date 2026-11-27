/**
 * Hides the webview's default context menu ("Back", "Reload", "Inspect"…), which makes
 * the app feel like a web page. Text fields and selected text keep it, for copy and paste.
 */
export function preventDefaultContextMenu(target: Window = window) {
  const block = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    const element = event.target instanceof Element ? event.target : null;
    if (element?.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")) return;
    if (target.getSelection()?.toString()) return;
    event.preventDefault();
  };
  target.addEventListener("contextmenu", block);
  return () => target.removeEventListener("contextmenu", block);
}
