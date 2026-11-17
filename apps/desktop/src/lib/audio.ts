import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AudioAction, AudioDevices, AudioStatus } from "@disc-voice/shared";

export const nativeAudio = {
  available: () => isTauri(),
  devices: () => invoke<AudioDevices>("list_audio_devices"),
  status: () => invoke<AudioStatus>("get_audio_status"),
  action: (action: AudioAction) => invoke<AudioStatus>("audio_action", { action }),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function selectDevice(
  devices: { id: string; isDefault?: boolean }[],
  current: string,
): string {
  return devices.find((device) => device.id === current)?.id
    ?? devices.find((device) => device.isDefault)?.id
    ?? devices[0]?.id
    ?? "";
}
