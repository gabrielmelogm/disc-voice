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
  type: "text" | "voice";
}

export interface ChatMessage {
  id: string;
  channelId: string;
  clientId: string;
  author: User;
  content: string;
  createdAt: string;
}

export interface MessagePage {
  messages: ChatMessage[];
  hasMore: boolean;
}

export interface VoiceParticipant {
  peerId: string;
  user: User;
  muted: boolean;
  deafened: boolean;
}

export type RealtimeEvent =
  | { type: "ready"; peerId: string }
  | { type: "pong" }
  | { type: "session.expired" }
  | { type: "error"; operation: string; message: string }
  | { type: "channel.created"; channel: Channel }
  | { type: "message.created"; message: ChatMessage }
  | { type: "server.snapshot"; serverId: string | null; channels: Record<string, VoiceParticipant[]> }
  | { type: "voice.participants"; serverId: string; channelId: string; participants: VoiceParticipant[] }
  | { type: "voice.joined"; channelId: string; peerId: string; participants: VoiceParticipant[] }
  | { type: "voice.left"; channelId: string; reason: "left" | "replaced" }
  | { type: "voice.signal"; channelId: string; peerId: string; data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } };

export type RealtimeCommand =
  | { type: "ping" }
  | { type: "server.watch"; serverId: string | null }
  | { type: "voice.join"; channelId: string; muted: boolean; deafened: boolean }
  | { type: "voice.leave" }
  | { type: "voice.state"; muted: boolean; deafened: boolean }
  | { type: "voice.signal"; peerId: string; data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } };
