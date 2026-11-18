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

/** Native camera (Linux). Keep in sync with packages/video-engine/src/linux.rs. */
export interface CameraDevice {
  id: string;
  name: string;
}

export interface CameraInfo {
  deviceId: string;
  width: number;
  height: number;
  frameRate: number;
  passthrough: boolean;
}

export interface User {
  id: string;
  email: string;
}

export interface AuthSession {
  user: User;
  token: string;
}

export interface Server {
  id: string;
  name: string;
  ownerId: string;
}

export interface Invite {
  code: string;
  url: string;
  server: Server;
}

export interface Channel {
  id: string;
  serverId: string;
  name: string;
}
