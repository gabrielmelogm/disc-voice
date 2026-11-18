import { invoke, isTauri } from "@tauri-apps/api/core";
import type { CameraDevice, CameraInfo } from "@disc-voice/shared";

/** Who is using the camera engine right now (the call or the settings test). */
export interface CameraClaim {
  /** Whether no other user took the engine since. */
  held: () => boolean;
  /** Stops the camera if still held. */
  release: () => void;
}

let current: { onTaken: () => void } | null = null;

/**
 * Webcam captured by the native engine (Linux). WebKitGTK's getUserMedia
 * corrupts PipeWire camera frames, so the page never touches
 * navigator.mediaDevices there and draws JPEG frames pulled from Rust.
 */
export const nativeCamera = {
  supported: async () => isTauri() && (await invoke<boolean>("camera_native").catch(() => false)),
  devices: () => invoke<CameraDevice[]>("camera_devices"),
  start: (deviceId: string) => invoke<CameraInfo>("camera_start", { deviceId }),
  /** Like `start`, also making the raw frames a call sends, at most `maxHeight` tall. */
  startForCall: (deviceId: string, maxHeight: number) => invoke<CameraInfo>("camera_start_call", { deviceId, maxHeight }),
  stop: () => invoke<void>("camera_stop"),
  /** Next JPEG frame; empty when none arrived in time. */
  frame: () => invoke<ArrayBuffer>("camera_frame"),
  /**
   * The engine runs one capture and its frames go to one reader. Claiming it
   * before starting tells the previous user (synchronously, through
   * `onTaken`) that its camera is gone, so it resets without stopping the
   * new one.
   */
  /**
   * Stops a camera that finished opening after its user gave it up, unless
   * someone claimed the engine since (their start replaces it anyway).
   */
  releaseLate() {
    if (!current) void nativeCamera.stop().catch(() => {});
  },
  claim(onTaken: () => void): CameraClaim {
    const claim = { onTaken };
    const previous = current;
    current = claim;
    previous?.onTaken();
    return {
      held: () => current === claim,
      release: () => {
        if (current !== claim) return;
        current = null;
        void nativeCamera.stop().catch(() => {});
      },
    };
  },
};
