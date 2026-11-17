/** IPC contracts. Keep in sync with src-tauri/src/audio.rs. */
export interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface AudioDevices {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
}

export interface AudioStatus {
  sequence: number;
  inputActive: boolean;
  outputActive: boolean;
  peak: number;
  recordedSeconds: number;
  recordingReady: boolean;
  sampleRate: number | null;
  error: string | null;
}

export type AudioAction =
  | { type: "startMicrophone"; deviceId: string }
  | { type: "stopMicrophone" }
  | { type: "playTone"; deviceId: string; volume: number }
  | { type: "playRecording"; deviceId: string; volume: number }
  | { type: "stopOutput" }
  | { type: "stopAll" };

export const MAX_RECORDING_SECONDS = 10;

export const INITIAL_AUDIO_STATUS: AudioStatus = {
  sequence: 0,
  inputActive: false,
  outputActive: false,
  peak: 0,
  recordedSeconds: 0,
  recordingReady: false,
  sampleRate: null,
  error: null,
};
