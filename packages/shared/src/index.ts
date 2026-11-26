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
  /** Profile photo URL (from Google or Discord, or a GIF from Klipy), or null for initials. */
  avatar?: string | null;
  /** The account the photo follows, or `gif` for a GIF from Klipy. */
  avatarSource?: "google" | "discord" | "gif" | null;
  /** Still frame of a GIF avatar, shown when the user prefers reduced motion. */
  avatarStill?: string | null;
  /** A GIF from Klipy shown as the banner, over the banner color. */
  bannerGif?: string | null;
  bannerStill?: string | null;
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
  /** Thumbnail (album cover, game art or app icon); absent from older servers. */
  image?: string | null;
  /** Tooltip of the thumbnail, e.g. the album name. */
  imageText?: string | null;
  /** Where it came from; Discord is the only source for now. */
  source: "discord";
}

export interface DiscordAccount {
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  shareActivity: boolean;
  /** The profile photo is the Discord one. Absent from older servers. */
  useAvatar?: boolean;
  /** Signed in with Discord and not yet asked what the integration may use. */
  consentPending?: boolean;
  /** Discord servers can be listed (and imported) with this account. */
  canListGuilds?: boolean;
  /** The bot saw this account in a Discord server it is in. */
  presenceSeen: boolean;
}

/** A Discord server the user manages, which they may import. */
export interface DiscordGuildOption {
  id: string;
  name: string;
  icon: string | null;
  /** The bot is already there: the channels come right away. */
  botInstalled: boolean;
  /** Already imported into this Disc Voice server. */
  importedServerId: string | null;
}

export interface DiscordGuildImport {
  server: Invite;
  /** Open to add the bot to the Discord server; the channels come after. */
  installUrl: string | null;
  channels: number;
  /** The server was created but its channels could not be read. */
  warning: string | null;
}

export interface DiscordStatus {
  /** The integration is configured on the API. */
  enabled: boolean;
  /** The bot is receiving Discord presences right now. */
  presence: boolean;
  account: DiscordAccount | null;
  /** Discord application used for the desktop app's Rich Presence. */
  clientId?: string | null;
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
  /** Empty channel of the server with this name: the history goes there. */
  target?: string | null;
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

/** A file attached to a message: media imported from Discord, or a GIF from Klipy. */
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
  /** `klipy` for a GIF sent from the picker. */
  provider?: "klipy";
  /** Still frame of an animated image, for reduced motion. */
  still?: string | null;
  /** The sender deleted the file from their gallery: only the name is left. */
  deleted?: boolean;
}

/** A file the user sent, kept in their space in the cloud. */
export interface CloudFile {
  id: string;
  name: string;
  /** `/api/files/...` (resolve with `mediaUrl`). */
  url: string;
  size: number;
  contentType: string;
  width: number | null;
  height: number | null;
  createdAt: string;
}

/** Everything the user sent, and how much of their space it takes. */
export interface FileGallery {
  files: CloudFile[];
  used: number;
  quota: number;
  maxFileSize: number;
}

/** A GIF in the Klipy picker. */
export interface Gif {
  id: string;
  slug: string;
  title: string;
  /** Animated, for messages and the preview. */
  url: string;
  /** Animated and small, for the picker grid. */
  thumbnail: string;
  /** Still frame, for reduced motion. */
  still: string | null;
  width: number;
  height: number;
}

export interface GifPage {
  results: Gif[];
  page: number;
  hasNext: boolean;
}

/** A GIF chosen in the picker, as the API keeps it. */
export type GifChoice = Pick<Gif, "slug" | "title" | "url" | "still" | "width" | "height">;

export type ProfileUpdate = Partial<Pick<User, "name" | "pronouns" | "bio" | "banner">> & {
  /** A GIF as the photo, or null to remove it. */
  avatarGif?: GifChoice | null;
  /** A GIF as the banner, or null to go back to the color. */
  bannerGif?: GifChoice | null;
};

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
  /** Signed in with Discord: ask what the integration may use. */
  discordConsent?: boolean;
}

export interface Server {
  id: string;
  name: string;
  ownerId: string;
  /** Icon URL (servers imported from Discord), or null for initials. */
  icon?: string | null;
}

export interface Invite {
  code: string;
  url: string;
  server: Server;
}

export interface Channel {
  id: string;
  /** Null for direct message conversations (`type: "dm"`). */
  serverId: string | null;
  name: string;
  type: "text" | "voice" | "dm";
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

/** A private conversation between the user and one other person. */
export interface DirectConversation {
  channel: Channel;
  /** The other person. */
  user: User;
  /** Newest message, or null while the conversation is empty. */
  lastMessageId: string | null;
  /** Preview of the newest message. Absent from older servers. */
  lastMessage?: MessagePreview | null;
}

export interface MessagePreview {
  id: string;
  authorId: string | null;
  content: string;
  createdAt: string;
}

/** `offline` without the app open; otherwise the status the person chose. */
export type PresenceStatus = "online" | "idle" | "dnd" | "offline";

/** A status the user can choose for themselves. */
export type ChosenStatus = Exclude<PresenceStatus, "offline">;

/** `owner` is the server's creator; the owner names moderators. */
export type MemberRole = "owner" | "moderator" | "member";

/** Someone in a server, with their role and presence. */
export interface ServerMember {
  user: User;
  role: MemberRole;
  status: PresenceStatus;
  joinedAt: string;
}

export interface Friend {
  user: User;
  status: PresenceStatus;
  /** When the friendship started. */
  since: string;
}

export interface FriendRequest {
  user: User;
  createdAt: string;
}

export interface Friends {
  friends: Friend[];
  /** Requests waiting for the user's answer. */
  incoming: FriendRequest[];
  /** Requests the user sent. */
  outgoing: FriendRequest[];
}

/** Where the user stands with someone: `outgoing` means the user asked. */
export type Friendship = "none" | "outgoing" | "incoming" | "friends";

/** Someone's profile as the user sees it. */
export interface UserProfile {
  user: User;
  memberSince: string;
  /** Servers both people are in. */
  mutualServers: Server[];
  friendship: Friendship;
  /** Shared between friends and people in a mutual server. */
  status: PresenceStatus | null;
}

/** How far the user has read a text channel or conversation. */
export interface ReadState {
  channelId: string;
  /** Null for direct message conversations. */
  serverId: string | null;
  /** Last message read, as a message id; "0" when nothing was read. */
  lastReadId: string;
  /** Messages from other people after it, capped at 100. */
  unread: number;
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
  /** The shared screen carries the computer's audio. Absent from older servers. */
  screenAudio?: boolean;
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
  /**
   * In a server channel, also names the server and channel (it reaches members with any server open)
   * and its type: `voice` for the chat of a voice room. Absent in direct messages.
   */
  | { type: "message.created"; message: ChatMessage; serverId?: string; serverName?: string; channelName?: string; channelType?: Channel["type"] }
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
  | { type: "discord.import"; serverId: string; import: DiscordImport }
  /** Someone is typing; repeated every few seconds while they keep typing. */
  | { type: "typing"; channelId: string; user: User }
  /** The user read a channel, possibly on another device. */
  | { type: "read.updated"; channelId: string; lastReadId: string }
  /** A conversation with the user was started. */
  | { type: "dm.created"; conversation: DirectConversation }
  /** A friend request was sent, answered or removed: reload the friends list. */
  | { type: "friends.changed" }
  /** A friend or someone in a shared server opened or closed the app, or changed status. */
  | { type: "presence.updated"; userId: string; status: PresenceStatus }
  /** Someone joined a server the user has open. */
  | { type: "member.joined"; serverId: string; member: ServerMember }
  /** A member's role changed in a server the user has open. */
  | { type: "member.updated"; serverId: string; member: ServerMember };

export type RealtimeCommand =
  | { type: "ping" }
  | { type: "server.watch"; serverId: string | null }
  | { type: "voice.join"; channelId: string; muted: boolean; deafened: boolean }
  | { type: "voice.leave" }
  | { type: "voice.state"; muted: boolean; deafened: boolean; screen: boolean; camera: boolean; screenAudio?: boolean }
  | { type: "voice.signal"; peerId: string; data: SignalPayload }
  | { type: "typing.start"; channelId: string }
  | { type: "presence.set"; status: ChosenStatus };
