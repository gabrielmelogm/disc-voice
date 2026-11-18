import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ScreenInfo, ScreenRequest } from "@disc-voice/shared";

/** Who is using the capture engine right now (the call or the settings test). */
export interface ScreenClaim {
  /** Whether no other user took the engine since. */
  held: () => boolean;
  /** Stops the capture (and an open picker) if still held. */
  release: () => void;
}

let current: { onTaken: () => void } | null = null;

/**
 * Screen captured by the native engine (Linux: ScreenCast portal + PipeWire;
 * Windows: Windows.Graphics.Capture). Frames are JPEG images pulled from
 * Rust, drawn like the native camera.
 */
export const nativeScreen = {
  supported: async () => isTauri() && (await invoke<boolean>("screen_native").catch(() => false)),
  /** Opens the system picker; `null` when the user dismissed it. */
  start: (request: ScreenRequest) => invoke<ScreenInfo | null>("screen_start", { request }),
  /** Stops sharing, also closing a picker that is still open. */
  stop: () => invoke<void>("screen_stop"),
  /** Next JPEG frame; empty when none arrived in time. */
  frame: () => invoke<ArrayBuffer>("screen_frame"),
  /**
   * The engine runs one capture and its frames go to one reader. Claiming it
   * before starting tells the previous user (synchronously, through
   * `onTaken`) that its capture is gone, so it resets without stopping the
   * new one.
   */
  claim(onTaken: () => void): ScreenClaim {
    const claim = { onTaken };
    const previous = current;
    current = claim;
    previous?.onTaken();
    return {
      held: () => current === claim,
      release: () => {
        if (current !== claim) return;
        current = null;
        void nativeScreen.stop().catch(() => {});
      },
    };
  },
};
