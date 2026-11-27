import type {
  Activity, AuthSession, Ban, Channel, ChatMessage, DirectConversation, DiscordGuildImport, DiscordGuildOption, DiscordImport, DiscordServer, DiscordStatus,
  FileGallery, GifChoice, GifPage, GoogleConfig, GoogleLogin, Invite,
  Friends, MessagePage, ProfileUpdate, Reaction, ReadState, Role, SearchResults, Server, ServerMember, User, UserProfile,
} from "@disc-voice/shared";

/** Only the fields sent change; a null color goes back to the default. */
export type RoleChanges = { name?: string; color?: number | null; permissions?: number };

const TOKEN_KEY = "discvoice.session";
const INVITE_KEY = "discvoice.invite";
// Browser builds use the same origin (Vite proxies /api); the native app uses
// the configured remote API, defaulting to the hosted Disc Voice server.
const env = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env;
const native = "__TAURI_INTERNALS__" in window;
const baseUrl = (env.VITE_API_URL || (native ? "https://discvoice.devgabrielmelo.shop/api" : "/api")).replace(/\/$/, "");

export function realtimeUrl() {
  const url = new URL(`${baseUrl}/realtime`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

// The session survives closing the app: localStorage persists in the Tauri
// webview and the browser. The server revokes it on logout or expiry.
export const sessionToken = {
  get: () => {
    // Sessions used to live in sessionStorage; carry them over once.
    const legacy = sessionStorage.getItem(TOKEN_KEY);
    if (legacy) {
      localStorage.setItem(TOKEN_KEY, legacy);
      sessionStorage.removeItem(TOKEN_KEY);
    }
    return localStorage.getItem(TOKEN_KEY);
  },
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  },
};

export function pendingInvite(): string {
  const value = new URL(window.location.href).searchParams.get("invite");
  if (value) sessionStorage.setItem(INVITE_KEY, value);
  return value || sessionStorage.getItem(INVITE_KEY) || "";
}

export function clearPendingInvite() {
  sessionStorage.removeItem(INVITE_KEY);
  const url = new URL(window.location.href);
  url.searchParams.delete("invite");
  window.history.replaceState(null, "", url);
}

export function parseInvite(value: string): string {
  let code = value.trim();
  if (/^https?:\/\//i.test(code)) {
    try { code = new URL(code).searchParams.get("invite") || ""; }
    catch { code = ""; }
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(code)) {
    throw new Error("Cole um link de convite válido ou o código completo.");
  }
  return code;
}

async function request<T>(path: string, options: {
  method?: "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; signal?: AbortSignal; public?: boolean;
} = {}): Promise<T> {
  const token = options.public ? null : sessionToken.get();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers: {
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error("Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    if (response.status === 401 && token && token === sessionToken.get()) {
      sessionToken.clear();
      window.dispatchEvent(new Event("discvoice:session-expired"));
    }
    throw new ApiError(data?.error || "Não foi possível concluir a operação. Tente novamente.", response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  googleConfig: () => request<GoogleConfig>("/auth/google/config", { public: true }),
  googleLogin: (input: GoogleLogin) => request<AuthSession>("/auth/google", { method: "POST", body: input, public: true }),
  discordAuthConfig: () => request<{ enabled: boolean }>("/auth/discord/config", { public: true }),
  discordAuthStart: (input: { platform: "desktop" | "web"; port?: number; state?: string }) =>
    request<{ url: string }>("/auth/discord/start", { method: "POST", body: input, public: true }),
  discordLogin: (ticket: string) => request<AuthSession>("/auth/discord", { method: "POST", body: { ticket }, public: true }),
  me: (signal?: AbortSignal) => request<User>("/me", { signal }),
  updateProfile: (changes: ProfileUpdate) => request<User>("/me", { method: "PATCH", body: changes }),
  search: (q: string, before?: string, signal?: AbortSignal) =>
    request<SearchResults>(`/search?${new URLSearchParams(before ? { q, before } : { q })}`, { signal }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  servers: (signal?: AbortSignal) => request<Server[]>("/servers", { signal }),
  createServer: (name: string) => request<Invite>("/servers", { method: "POST", body: { name } }),
  invite: (serverId: string) => request<Invite>(`/servers/${serverId}/invite`),
  previewInvite: (code: string) => request<Invite>(`/invites/${encodeURIComponent(code)}`),
  join: (code: string) => request<Server>(`/invites/${encodeURIComponent(code)}/join`, { method: "POST" }),
  /**
   * Changes the name, description or icon (Gerenciar servidor). `icon` is the
   * id of an image sent with `uploadFile`, or null to remove it.
   */
  updateServer: (serverId: string, changes: { name?: string; description?: string; icon?: string | null }) =>
    request<Server>(`/servers/${serverId}`, { method: "PATCH", body: changes }),
  /** The owner deletes the server for everyone. */
  deleteServer: (serverId: string) => request<void>(`/servers/${serverId}`, { method: "DELETE" }),
  members: (serverId: string, signal?: AbortSignal) => request<ServerMember[]>(`/servers/${serverId}/members`, { signal }),
  /** The server's roles, highest first; @everyone is last. */
  roles: (serverId: string, signal?: AbortSignal) => request<Role[]>(`/servers/${serverId}/roles`, { signal }),
  createRole: (serverId: string, role: RoleChanges = {}) => request<Role>(`/servers/${serverId}/roles`, { method: "POST", body: role }),
  updateRole: (serverId: string, roleId: string, changes: RoleChanges) =>
    request<Role>(`/servers/${serverId}/roles/${roleId}`, { method: "PATCH", body: changes }),
  deleteRole: (serverId: string, roleId: string) => request<void>(`/servers/${serverId}/roles/${roleId}`, { method: "DELETE" }),
  /** Every role but @everyone, highest first. */
  reorderRoles: (serverId: string, ids: string[]) => request<Role[]>(`/servers/${serverId}/roles`, { method: "PUT", body: { ids } }),
  /** Gives or takes away a member's role. */
  assignRole: (serverId: string, userId: string, roleId: string, give: boolean) =>
    request<ServerMember>(`/servers/${serverId}/members/${userId}/roles/${roleId}`, { method: give ? "PUT" : "DELETE" }),
  bans: (serverId: string, signal?: AbortSignal) => request<Ban[]>(`/servers/${serverId}/bans`, { signal }),
  ban: (serverId: string, userId: string, reason = "") =>
    request<void>(`/servers/${serverId}/bans/${userId}`, { method: "PUT", body: { reason } }),
  unban: (serverId: string, userId: string) => request<void>(`/servers/${serverId}/bans/${userId}`, { method: "DELETE" }),
  channels: (serverId: string, signal?: AbortSignal) => request<Channel[]>(`/servers/${serverId}/channels`, { signal }),
  createChannel: (serverId: string, name: string, type: Channel["type"] = "text") => request<Channel>(`/servers/${serverId}/channels`, { method: "POST", body: { name, type } }),
  messages: (channelId: string, cursor: { before?: string; after?: string } = {}, signal?: AbortSignal) =>
    request<MessagePage>(`/channels/${channelId}/messages?${new URLSearchParams(cursor)}`, { signal }),
  /** `files`: ids from `uploadFile`, sent with the text (which may then be empty). */
  sendMessage: (channelId: string, clientId: string, content: string, gif?: GifChoice, files?: string[]) =>
    request<ChatMessage>(`/channels/${channelId}/messages`, {
      method: "POST",
      body: { clientId, content, ...(gif ? { gif } : {}), ...(files?.length ? { files } : {}) },
    }),
  /** The author changes the text (mentions as `<@id>`). */
  editMessage: (channelId: string, messageId: string, content: string) =>
    request<ChatMessage>(`/channels/${channelId}/messages/${messageId}`, { method: "PATCH", body: { content } }),
  /** The author, or someone with Gerenciar mensagens, deletes the message for everyone. */
  deleteMessage: (channelId: string, messageId: string) =>
    request<void>(`/channels/${channelId}/messages/${messageId}`, { method: "DELETE" }),
  /** Adds or removes the user's reaction; returns the message's reactions. */
  react: (channelId: string, messageId: string, emoji: string, add: boolean) =>
    request<Reaction[]>(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, { method: add ? "PUT" : "DELETE" }),
  /** The files the user sent and the space they take. */
  files: (signal?: AbortSignal) => request<FileGallery>("/files", { signal }),
  /** Deletes one of the user's files, freeing its space. */
  deleteFile: (id: string) => request<void>(`/files/${id}`, { method: "DELETE" }),
  /** GIFs from Klipy, through the API (which holds the key): trending without `q`. */
  gifs: (q: string, page = 1, signal?: AbortSignal) =>
    request<GifPage>(`/gifs?${new URLSearchParams(q ? { q, page: String(page) } : { page: String(page) })}`, { signal }),
  reads: (signal?: AbortSignal) => request<ReadState[]>("/reads", { signal }),
  markRead: (channelId: string, messageId: string) =>
    request<{ channelId: string; lastReadId: string }>(`/channels/${channelId}/read`, { method: "POST", body: { messageId } }),
  dms: (signal?: AbortSignal) => request<DirectConversation[]>("/dms", { signal }),
  openDm: (userId: string) => request<DirectConversation>("/dms", { method: "POST", body: { userId } }),
  friends: (signal?: AbortSignal) => request<Friends>("/friends", { signal }),
  /** Sends a request, or accepts theirs when they had already asked. */
  addFriend: (userId: string) => request<{ status: "outgoing" | "friends" }>("/friends/requests", { method: "POST", body: { userId } }),
  acceptFriend: (userId: string) => request<{ status: "friends" }>(`/friends/requests/${userId}/accept`, { method: "POST" }),
  /** Declines or cancels a request, or ends a friendship. */
  removeFriend: (userId: string) => request<void>(`/friends/${userId}`, { method: "DELETE" }),
  profile: (userId: string, signal?: AbortSignal) => request<UserProfile>(`/users/${userId}/profile`, { signal }),
  voiceConfig: () => request<{ iceServers: RTCIceServer[] }>("/voice/config"),
  activities: (signal?: AbortSignal) => request<Record<string, Activity>>("/activities", { signal }),
  discord: (signal?: AbortSignal) => request<DiscordStatus>("/discord", { signal }),
  linkDiscord: () => request<{ url: string }>("/discord/link", { method: "POST" }),
  updateDiscord: (changes: { shareActivity?: boolean; useAvatar?: boolean }) => request<void>("/discord/account", { method: "PATCH", body: changes }),
  /** The answer, after signing in with Discord, about what the integration may use. */
  discordConsent: (choices: { useAvatar: boolean; shareActivity: boolean }) => request<void>("/discord/consent", { method: "POST", body: choices }),
  discordGuilds: (signal?: AbortSignal) => request<DiscordGuildOption[]>("/discord/guilds", { signal }),
  importDiscordGuild: (guildId: string) => request<DiscordGuildImport>(`/discord/guilds/${encodeURIComponent(guildId)}/import`, { method: "POST" }),
  unlinkDiscord: () => request<void>("/discord/account", { method: "DELETE" }),
  serverDiscord: (serverId: string, signal?: AbortSignal) => request<DiscordServer>(`/servers/${serverId}/discord`, { signal }),
  installDiscord: (serverId: string) => request<{ url: string }>(`/servers/${serverId}/discord/install`, { method: "POST" }),
  unlinkGuild: (serverId: string, guildId: string) => request<void>(`/servers/${serverId}/discord/guilds/${encodeURIComponent(guildId)}`, { method: "DELETE" }),
  importDiscord: (serverId: string, guildId: string, channelId: string) =>
    request<DiscordImport>(`/servers/${serverId}/discord/imports`, { method: "POST", body: { guildId, channelId } }),
  retryDiscord: (channelId: string) => request<DiscordImport>(`/discord/imports/${channelId}/retry`, { method: "POST" }),
  finishDiscord: (channelId: string) => request<DiscordImport>(`/discord/imports/${channelId}/finish`, { method: "POST" }),
};

/** Absolute URL of an API path such as `/files`. */
export function apiUrl(path: string) {
  return new URL(`${baseUrl}${path}`, window.location.href).href;
}

/** Files kept by the API come as `/api/files/...`; other URLs are absolute. */
export function mediaUrl(url: string) {
  return url.startsWith("/api/") ? new URL(`${baseUrl}${url.slice(4)}`, window.location.href).href : url;
}

export function message(error: unknown) {
  return error instanceof Error ? error.message : "Não foi possível concluir a operação.";
}
