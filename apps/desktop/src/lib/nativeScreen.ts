import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ScreenInfo, ScreenRequest } from "@disc-voice/shared";

/**
 * Screen captured by the native engine (Linux: ScreenCast portal + PipeWire).
 * Frames are JPEG images pulled from Rust, drawn like the native camera.
 */
export const nativeScreen = {
  supported: async () => isTauri() && (await invoke<boolean>("screen_native").catch(() => false)),
  /** Opens the system picker; `null` when the user dismissed it. */
  start: (request: ScreenRequest) => invoke<ScreenInfo | null>("screen_start", { request }),
  /** Stops sharing, also closing a picker that is still open. */
  stop: () => invoke<void>("screen_stop"),
  /** Next JPEG frame; empty when none arrived in time. */
  frame: () => invoke<ArrayBuffer>("screen_frame"),
};
