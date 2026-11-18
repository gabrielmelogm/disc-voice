import { invoke, isTauri } from "@tauri-apps/api/core";
import type { CameraDevice, CameraInfo } from "@disc-voice/shared";

/**
 * Webcam captured by the native engine (Linux). WebKitGTK's getUserMedia
 * corrupts PipeWire camera frames, so the page never touches
 * navigator.mediaDevices there and draws JPEG frames pulled from Rust.
 */
export const nativeCamera = {
  supported: async () => isTauri() && (await invoke<boolean>("camera_native").catch(() => false)),
  devices: () => invoke<CameraDevice[]>("camera_devices"),
  start: (deviceId: string) => invoke<CameraInfo>("camera_start", { deviceId }),
  stop: () => invoke<void>("camera_stop"),
  /** Next JPEG frame; empty when none arrived in time. */
  frame: () => invoke<ArrayBuffer>("camera_frame"),
};
