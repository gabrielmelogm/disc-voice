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

/** Native screen capture (Windows and Linux). Keep in sync with packages/video-engine/src/screen.rs. */
export type ScreenSourceKind = "monitor" | "window" | "virtual" | "unknown";

export interface ScreenRequest {
  /** Larger sources are scaled down to fit, keeping their aspect ratio. */
  maxWidth: number;
  maxHeight: number;
  /** Upper bound; an unchanged screen sends fewer frames. */
  frameRate: number;
  cursor: boolean;
}

export interface ScreenInfo {
  source: ScreenSourceKind;
  /** Native size of the shared source; 0 when the system does not report it. */
  width: number;
  height: number;
  maxWidth: number;
  maxHeight: number;
  frameRate: number;
  cursor: boolean;
}

/** Banner colors from the design system palette. */
export type BannerColor = "brand" | "green" | "amber" | "red" | "graphite";

export interface User {
  id: string;
  email: string;
  name: string;
  /** Profile fields; absent from older servers. */
  pronouns?: string;
  bio?: string;
  banner?: BannerColor;
  /** Profile photo URL (from the Google account), or null for initials. */
  avatar?: string | null;
  /** Discord username of an author known only from imported Discord messages. */
  discord?: string;
}

export type ActivityKind = "playing" | "streaming" | "listening" | "watching" | "competing";

/** What a user is doing right now, e.g. playing a game. */
export interface Activity {
  kind: ActivityKind;
  name: string;
  details: string | null;
  state: string | null;
  startedAt: string | null;
  /** Where it came from; Discord is the only source for now. */
  source: "discord";
}

export interface DiscordAccount {
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  shareActivity: boolean;
  /** The bot saw this account in a Discord server it is in. */
  presenceSeen: boolean;
}

export interface DiscordStatus {
  /** The integration is configured on the API. */
  enabled: boolean;
  /** The bot is receiving Discord presences right now. */
  presence: boolean;
  account: DiscordAccount | null;
}

export interface DiscordImport {
  channelId: string;
  serverId: string;
  guildId: string;
  discordChannelId: string;
  discordChannelName: string;
  /** `history` while importing; `done` once the channel belongs to Disc Voice. */
  phase: "history" | "done";
  status: "queued" | "running" | "idle" | "error";
  imported: number;
  error: string | null;
  syncedAt: string | null;
}

export interface DiscordChannel {
  id: string;
  name: string;
  category: string | null;
  /** The bot can view the channel and read its history. */
  readable: boolean;
  import: DiscordImport | null;
}

export interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
  available: boolean;
  error: string | null;
  channels: DiscordChannel[];
}

export interface DiscordServer {
  /** Message Content intent of the bot; null when unknown. */
  messageContent: boolean | null;
  guilds: DiscordGuild[];
  imports: DiscordImport[];
}

/** A file attached to a message (for now, media imported from Discord). */
export interface Attachment {
  id: string;
  filename: string;
  /** `/api/files/...` for files kept by the API (resolve with `mediaUrl`). */
  url: string;
  /** Could not be copied from Discord: the link may no longer open. */
  unavailable?: boolean;
  size: number;
  contentType: string | null;
  width: number | null;
  height: number | null;
}

export type ProfileUpdate = Partial<Pick<User, "name" | "pronouns" | "bio" | "banner">>;

export interface ChannelHit {
  id: string;
  serverId: string;
  serverName: string;
  name: string;
  type: Channel["type"];
}

export interface MessageHit {
  id: string;
  channelId: string;
  channelName: string;
  serverId: string;
  serverName: string;
  author: User;
  content: string;
  createdAt: string;
}

export interface SearchResults {
  channels: ChannelHit[];
  people: User[];
  messages: MessageHit[];
  /** Pass as `before` for older messages; null on the last page. */
  nextCursor: string | null;
}

/** OAuth client IDs; null when that platform isn't configured on the server. */
export interface GoogleConfig {
  desktopClientId: string | null;
  webClientId: string | null;
}

export interface GoogleLogin {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  platform: "desktop" | "web";
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
  /** `discord` for channels imported from Discord. Absent from older servers. */
  source?: "local" | "discord";
  /** Still importing its Discord history: nobody can send messages yet. */
  readOnly?: boolean;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  clientId: string;
  author: User;
  content: string;
  createdAt: string;
  /** Present on messages imported from Discord. */
  discordId?: string;
  attachments?: Attachment[];
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
  /** Sharing the screen; the video arrives over the peer connection. */
  screen: boolean;
  /** Webcam on; the video arrives over the peer connection. Absent from older servers. */
  camera?: boolean;
}

/**
 * WebRTC signaling between two call peers, relayed as is by the API.
 * Descriptions name the sender's video streams, since browsers cannot
 * choose stream IDs.
 */
export interface SignalPayload {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  streams?: Record<string, "screen" | "camera">;
}

export type RealtimeEvent =
  | { type: "ready"; peerId: string }
  | { type: "pong" }
  | { type: "session.expired" }
  | { type: "error"; operation: string; message: string }
  | { type: "channel.created"; channel: Channel }
  | { type: "message.created"; message: ChatMessage }
  | { type: "user.updated"; user: User }
  | { type: "server.snapshot"; serverId: string | null; channels: Record<string, VoiceParticipant[]> }
  | { type: "voice.participants"; serverId: string; channelId: string; participants: VoiceParticipant[] }
  | { type: "voice.joined"; channelId: string; peerId: string; participants: VoiceParticipant[] }
  | { type: "voice.left"; channelId: string; reason: "left" | "replaced" }
  | { type: "voice.signal"; channelId: string; peerId: string; data: SignalPayload }
  /** Someone entered a voice room of one of the user's servers (sent to every online member). */
  | { type: "voice.member.joined"; serverId: string; serverName: string; channelId: string; channelName: string; user: User }
  | { type: "activity.updated"; userId: string; activity: Activity | null }
  /** The user's Discord account or a server's Discord connections changed. */
  | { type: "discord.updated"; serverId: string | null }
  | { type: "discord.import"; serverId: string; import: DiscordImport };

export type RealtimeCommand =
  | { type: "ping" }
  | { type: "server.watch"; serverId: string | null }
  | { type: "voice.join"; channelId: string; muted: boolean; deafened: boolean }
  | { type: "voice.leave" }
  | { type: "voice.state"; muted: boolean; deafened: boolean; screen: boolean; camera: boolean }
  | { type: "voice.signal"; peerId: string; data: SignalPayload };
