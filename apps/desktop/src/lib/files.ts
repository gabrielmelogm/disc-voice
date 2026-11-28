import type { CloudFile } from "@disc-voice/shared";
import { apiUrl, ApiError, sessionToken } from "./api";
import { openExternal } from "./external";

/** Largest file anyone can send; the API refuses larger ones too. */
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
/** Space each person has for the files they send. */
export const QUOTA_BYTES = 1024 * 1024 * 1024;
/** Files attached to one message. */
export const MAX_FILES_PER_MESSAGE = 10;

/**
 * Programs, scripts, shortcuts, pages and macro documents: refused before
 * uploading. The API keeps the full list and also checks the file's bytes.
 */
const BLOCKED = new Set([
  "exe", "com", "scr", "pif", "cpl", "dll", "sys", "drv", "ocx", "msi", "msp", "mst", "msc", "gadget", "appx", "appxbundle", "msix", "msixbundle", "application", "xbap",
  "bat", "cmd", "ps1", "ps1xml", "ps2", "psc1", "psd1", "psm1", "vb", "vbe", "vbs", "js", "jse", "mjs", "wsf", "wsh", "wsc", "ws", "hta", "sct", "sh", "bash", "zsh", "csh", "ksh",
  "command", "py", "pyw", "pyc", "rb", "pl", "php", "jar", "class", "scpt", "applescript",
  "lnk", "url", "inf", "reg", "scf", "library-ms", "settingcontent-ms", "desktop",
  "apk", "xapk", "ipa", "app", "dmg", "pkg", "mpkg", "deb", "rpm", "run", "bin", "elf", "appimage", "snap", "flatpakref",
  "docm", "dotm", "xlsm", "xltm", "xlam", "pptm", "potm", "ppam", "ppsm", "sldm",
  "html", "htm", "xhtml", "shtml", "mht", "mhtml", "svg", "svgz", "xml", "xsl",
  "iso", "img", "vhd", "vhdx",
]);

/** Why this file can't be sent, or null when it can. */
export function fileProblem(file: { name: string; size: number }): string | null {
  const name = file.name.replace(/[. ]+$/, "");
  if (name.split(".").slice(1).some(part => BLOCKED.has(part.trim().toLowerCase()))) {
    return `“${file.name}” não pode ser enviado: este tipo de arquivo pode executar programas no computador de quem abrir.`;
  }
  if (file.size > MAX_FILE_BYTES) return `“${file.name}” tem mais de 15 MB, o limite por arquivo.`;
  if (file.size === 0) return `“${file.name}” está vazio.`;
  return null;
}

/**
 * Uploads a file to the user's space, reporting progress from 0 to 1. The
 * file is only sent to a channel when a message lists its id.
 */
export function uploadFile(file: File, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<CloudFile> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", apiUrl(`/files?${new URLSearchParams({ name: file.name })}`));
    const token = sessionToken.get();
    if (token) request.setRequestHeader("Authorization", `Bearer ${token}`);
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.responseType = "json";
    request.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(event.loaded / event.total); };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) return resolve(request.response as CloudFile);
      const error = (request.response as { error?: string } | null)?.error;
      if (request.status === 401) window.dispatchEvent(new Event("discvoice:session-expired"));
      reject(new ApiError(error || (request.status === 413 ? "O arquivo passa do limite de 15 MB." : "Não foi possível enviar o arquivo. Tente novamente."), request.status));
    };
    request.onerror = () => reject(new Error("Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente."));
    request.onabort = () => reject(new DOMException("Envio cancelado.", "AbortError"));
    signal?.addEventListener("abort", () => request.abort(), { once: true });
    request.send(file);
  });
}

/** The name to save media under, with an extension that matches its type. */
export function mediaFileName(name: string, type: string) {
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "video/mp4": "mp4", "video/webm": "webm" }[type.split(";")[0].trim().toLowerCase()];
  const base = name.replace(/\.(png|jpe?g|gif|webp|avif|mp4|webm)$/i, "").trim() || "imagem";
  return extension ? `${base}.${extension}` : name;
}

/**
 * "Fazer download" of an image, GIF or video in the chat. The app writes it to
 * the Downloads folder (the webview ignores `<a download>`); the browser
 * downloads it. When the file can't be fetched here (another site refuses),
 * it opens in the browser instead. Resolves to where it was saved, if known.
 */
export async function saveMedia(url: string, name: string): Promise<string | null> {
  let blob: Blob;
  try {
    const response = await fetch(url, { referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error(String(response.status));
    blob = await response.blob();
  } catch {
    if (url.includes("/api/files/")) downloadFile(url); else await openExternal(url);
    return null;
  }
  const fileName = mediaFileName(name, blob.type);
  if ("__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("save_media", new Uint8Array(await blob.arrayBuffer()), { headers: { "x-file-name": encodeURIComponent(fileName) } });
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  return null;
}

/** Saves a file to the computer: the browser downloads it from the API. */
export function downloadFile(url: string) {
  const target = new URL(url, window.location.href);
  target.searchParams.set("download", "1");
  void openExternal(target.href);
}

/**
 * Files dropped outside a chat would make the webview open them in place of
 * the app (the native drop handler is off so chats receive drops). Chats
 * handle their own drops before this runs.
 */
export function preventFileNavigation(target: Window = window) {
  const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types || []).includes("Files");
  const block = (event: DragEvent) => {
    if (!carriesFiles(event) || event.defaultPrevented) return;
    event.preventDefault();
    // Outside a chat the cursor shows that nothing happens there.
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  };
  target.addEventListener("dragover", block);
  target.addEventListener("drop", block);
  return () => {
    target.removeEventListener("dragover", block);
    target.removeEventListener("drop", block);
  };
}

export function isImage(contentType: string | null | undefined) {
  return /^image\/(png|jpeg|gif|webp|avif)$/.test(contentType || "");
}
