/**
 * Opens a web page outside the app: the system browser on desktop, a new tab
 * on the web. On desktop the native `open_url` runs the browser launcher; in
 * the Linux AppImage it first removes the bundled libraries from the launcher's
 * environment, which tauri-plugin-opener does not do.
 */
export async function openExternal(url: string) {
  if ("__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_url", { url });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
