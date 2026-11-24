import { useEffect, useRef, useState } from "react";
import { LogIn, MessageSquareText, Plus, RefreshCw, WifiOff } from "lucide-react";
import type { Channel, Server, User, VoiceParticipant } from "@disc-voice/shared";
import { api, message } from "../lib/api";
import { onTrayAction, recentServers, rememberServer, syncTray } from "../lib/tray";
import { useActivities } from "../hooks/useActivities";
import { useDirectMessages } from "../hooks/useDirectMessages";
import { useFriends } from "../hooks/useFriends";
import { useMembers } from "../hooks/useMembers";
import { usePresenceStatus } from "../hooks/usePresenceStatus";
import { useNotifications } from "../hooks/useNotifications";
import { useRealtime } from "../hooks/useRealtime";
import { useUnread } from "../hooks/useUnread";
import { useVoice } from "../hooks/useVoice";
import { AppBar } from "./AppBar";
import { ChannelDetails, ChannelHeader, roomPresence, voiceOccupants } from "./ChannelDetails";
import { MembersDialog } from "./Members";
import { ChannelSidebar } from "./ChannelSidebar";
import { DirectMessages, DirectMessagesSidebar, DirectProfilePanel, NewMessageDialog } from "./DirectMessages";
import { FriendsPage, friendshipWith } from "./Friends";
import { DiscordImportDialog } from "./DiscordImportDialog";
import { ProfileCardProvider, useProfileCard } from "./ProfileCard";
import { SearchDialog, type SearchPick } from "./SearchDialog";
import { ServerDialog, type DialogMode } from "./ServerDialog";
import { Settings, type SettingsPage } from "./Settings";
import { TextChannel } from "./TextChannel";
import { CallStatus, VoiceChannel, VoiceDevices } from "./VoiceChannel";

type View = "server" | "dms";

export function ServerWorkspace({ user, joinedServer, onLogout, onUserChange }: {
  user: User; joinedServer: Server | null; onLogout: () => Promise<void>; onUserChange: (user: User) => void;
}) {
  const [servers, setServers] = useState<Server[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>("server");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("overview");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [channelLoading, setChannelLoading] = useState(false);
  const [error, setError] = useState("");
  const [channelError, setChannelError] = useState("");
  const [logoutError, setLogoutError] = useState("");
  const [reload, setReload] = useState(0);
  const [channelReload, setChannelReload] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [searching, setSearching] = useState(false);
  // Message to scroll to when its text channel opens (from a search result).
  const [focusMessage, setFocusMessage] = useState<{ channelId: string; messageId: string; nonce: number } | null>(null);
  // Channel to open once another server's channel list arrives (e.g. returning to a call).
  const pendingChannel = useRef<string | null>(null);
  const realtime = useRealtime(selected);
  const activities = useActivities(realtime.client, realtime.revision);
  const [discordOpen, setDiscordOpen] = useState(false);
  const { voice, state: voiceState } = useVoice(realtime.client);
  const [participants, setParticipants] = useState<Record<string, VoiceParticipant[]>>({});
  // Latest profile of each user seen in a profile update, for the profile cards.
  const [profiles, setProfiles] = useState<Record<string, User>>({});
  const dms = useDirectMessages(realtime.client, realtime.revision);
  const friends = useFriends(realtime.client, realtime.revision);
  const members = useMembers(realtime.client, realtime.revision, selected);
  const myStatus = usePresenceStatus(realtime.client, realtime.revision);
  const [membersOpen, setMembersOpen] = useState(false);
  const presence = Object.fromEntries(friends.friends.map(f => [f.user.id, f.status]));
  const roles = Object.fromEntries(members.members.map(m => [m.user.id, m.role]));
  // The open conversation; none shows the friends page.
  const [dmId, setDmId] = useState<string | null>(null);
  const [newDm, setNewDm] = useState(false);
  const [dmError, setDmError] = useState("");
  const unread = useUnread(realtime.client, realtime.revision, { userId: user.id, serverId: selected });
  const server = servers.find(s => s.id === selected);
  const channel = channels.find(c => c.id === channelId);
  const conversation = dms.conversations.find(c => c.channel.id === dmId);
  const inCall = !!voiceState.channel && voiceState.status !== "error";
  const voiceChannels = channels.filter(c => c.type === "voice");
  useNotifications({
    realtime: realtime.client,
    user,
    status: myStatus.status,
    voiceState,
    viewingChannelId: view === "dms" ? conversation?.channel.id ?? null : view === "server" && channel?.type === "text" ? channel.id : null,
    channels,
  });

  useEffect(() => realtime.client.onEvent(event => {
    if (event.type === "channel.created" && event.channel.serverId === selected) {
      setChannels(current => current.some(c => c.id === event.channel.id) ? current : [...current, event.channel]);
    }
    // An imported channel opens for messages when its import is done.
    if (event.type === "discord.import" && event.serverId === selected) {
      const readOnly = event.import.phase === "history";
      setChannels(current => current.map(c => c.id === event.import.channelId && !!c.readOnly !== readOnly ? { ...c, readOnly } : c));
    }
    if (event.type === "server.snapshot" && event.serverId === selected) {
      setParticipants(event.channels);
    }
    if (event.type === "voice.participants" && event.serverId === selected) {
      setParticipants(current => ({ ...current, [event.channelId]: event.participants }));
    }
    if (event.type === "user.updated") {
      setProfiles(current => ({ ...current, [event.user.id]: event.user }));
      if (event.user.id === user.id) onUserChange(event.user);
    }
  }), [realtime.client, selected, user.id, onUserChange]);

  useEffect(() => { if (realtime.status !== "connected") setParticipants({}); }, [realtime.status]);

  // The tray icon shows whether the user is in a call; its menu lists the recent servers.
  useEffect(() => { if (selected) rememberServer(selected); }, [selected]);
  const callName = inCall ? voiceState.channel?.name ?? null : null;
  useEffect(() => {
    syncTray({ call: callName, muted: voiceState.muted, recent: recentServers(servers) });
  }, [callName, voiceState.muted, servers, selected]);
  // Logged out: back to the plain icon, with no servers in the menu.
  useEffect(() => () => syncTray({ call: null, muted: false, recent: [] }), []);

  const trayActions = useRef({ openServer: (_id: string) => {}, toggleMute: () => {} });
  useEffect(() => {
    trayActions.current = {
      openServer: id => {
        const next = servers.find(s => s.id === id);
        if (!next) return;
        setSettingsOpen(false);
        setSearching(false);
        selectServer(next);
      },
      toggleMute: () => { if (inCall) voice.toggleMute(); },
    };
  });
  useEffect(() => onTrayAction({
    openServer: id => trayActions.current.openServer(id),
    toggleMute: () => trayActions.current.toggleMute(),
  }), []);

  // Ctrl+K (⌘K on macOS) opens the search from anywhere in the app.
  useEffect(() => {
    const open = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener("keydown", open);
    return () => window.removeEventListener("keydown", open);
  }, []);
  useEffect(() => { setParticipants({}); setChannels([]); setChannelId(null); setDiscordOpen(false); setMembersOpen(false); }, [selected]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api.servers(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      // A server joined from the invite page may not be listed yet.
      const all = joinedServer && !result.some(s => s.id === joinedServer.id) ? [...result, joinedServer] : result;
      setServers(all);
      setSelected(current => joinedServer && reload === 0 ? joinedServer.id : all.some(s => s.id === current) ? current : all[0]?.id || null);
    }).catch(cause => { if (!controller.signal.aborted) setError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload, joinedServer]);

  useEffect(() => {
    setChannelError("");
    if (!selected) { setChannels([]); setChannelId(null); setChannelLoading(false); return; }
    const controller = new AbortController();
    setChannelLoading(true);
    void api.channels(selected, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setChannels(current => [...result, ...current.filter(c => c.serverId === selected && !result.some(r => r.id === c.id))]);
      const pending = pendingChannel.current;
      pendingChannel.current = null;
      setChannelId(current => pending && result.some(c => c.id === pending) ? pending
        : result.some(c => c.id === current) ? current : (result.find(c => c.type === "text") || result[0])?.id || null);
    }).catch(cause => { if (!controller.signal.aborted) setChannelError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setChannelLoading(false); });
    return () => controller.abort();
  }, [selected, channelReload, realtime.revision]);

  function show(next: View) {
    setView(next);
  }

  function openSettings(page: SettingsPage) {
    setSettingsPage(page);
    setSettingsOpen(true);
  }

  function acceptServer(next: Server) {
    setServers(current => current.some(s => s.id === next.id) ? current : [...current, next]);
    setSelected(next.id);
    show("server");
    setError("");
  }

  function selectServer(next: Server) {
    setFocusMessage(null);
    setSelected(next.id);
    show("server");
  }

  function openChannel(next: Channel) {
    setFocusMessage(null);
    if (next.serverId === selected) setChannelId(next.id);
    show("server");
  }

  /** Opens a channel of any of the user's servers. */
  function goToChannel(serverId: string, id: string) {
    if (serverId !== selected) {
      pendingChannel.current = id;
      setSelected(serverId);
    } else setChannelId(id);
    show("server");
  }

  function pickResult(pick: SearchPick) {
    setSettingsOpen(false);
    if (pick.kind === "channel") goToChannel(pick.channel.serverId, pick.channel.id);
    if (pick.kind === "message") {
      setFocusMessage({ channelId: pick.message.channelId, messageId: pick.message.id, nonce: Date.now() });
      goToChannel(pick.message.serverId, pick.message.channelId);
    }
  }

  /** Opens (or starts) the conversation with someone and shows it. */
  async function messagePerson(person: User) {
    const opened = await dms.open(person.id);
    setDmError("");
    setDmId(opened.channel.id);
    setSettingsOpen(false);
    show("dms");
  }

  function joinVoice(next: Channel) {
    openChannel(next);
    if (voiceState.channel?.id !== next.id || voiceState.status === "error") void voice.join(next);
  }

  function goToVoice() {
    if (inCall && voiceState.channel) {
      if (voiceState.channel.serverId !== selected) {
        pendingChannel.current = voiceState.channel.id;
        setSelected(voiceState.channel.serverId);
      } else setChannelId(voiceState.channel.id);
      show("server");
      return;
    }
    const target = voiceChannels.find(c => (participants[c.id] || []).length > 0) || voiceChannels[0];
    if (target) openChannel(target);
  }

  async function logout() {
    setLeaving(true);
    setLogoutError("");
    try { voice.leave(); realtime.client.stop(); await onLogout(); }
    catch (cause) { setLogoutError(message(cause)); realtime.client.start(); }
    finally { setLeaving(false); }
  }

  const callDevices = <VoiceDevices voice={voice} state={voiceState} />;
  const visibleProfiles = { ...profiles, [user.id]: user };
  const search = searching && <SearchResultsHost onClose={() => setSearching(false)} onPick={pickResult} />;

  const viewingCall = view === "server" && channel?.type === "voice";
  const showDetails = view === "server" && channel?.type === "text";
  const showProfile = view === "dms" && !!conversation;

  const profileMessage = (person: User) => {
    void messagePerson(person).catch(cause => { setDmError(message(cause)); show("dms"); });
  };

  return <ProfileCardProvider profiles={visibleProfiles} activities={activities} selfId={user.id} onMessage={profileMessage}><div className={`app-shell workspace-shell ${showDetails || showProfile ? "with-details" : ""}`}>
    {view === "dms" ? <DirectMessagesSidebar conversations={dms.conversations} selectedId={dmId} selfId={user.id} unread={unread.counts} presence={presence}
      friendsOpen={!dmId} requests={friends.incoming.length} loading={dms.loading}
      error={dmError || dms.error} onSelect={next => { setDmError(""); setDmId(next.channel.id); }} onFriends={() => { setDmError(""); setDmId(null); }}
      onNew={() => setNewDm(true)} onRetry={() => { setDmError(""); dms.retry(); }} />
    : server ? <ChannelSidebar server={server} channels={channels} channelId={channelId} unread={unread.counts}
      participants={participants} voiceState={voiceState} loading={channelLoading} error={channelError}
      onSelect={openChannel} onJoin={joinVoice} onCreate={type => setDialog({ kind: "channel", server, channelType: type })}
      onInvite={() => setDialog({ kind: "invite", server })} onReload={() => setChannelReload(n => n + 1)}
      onDiscord={server.ownerId === user.id ? () => setDiscordOpen(true) : undefined} /> : <aside className="sidebar">
      <div className="sidebar-title"><h2>Seu espaço</h2></div>
      <p className="sidebar-status">{loading ? "Carregando…" : "Crie um servidor ou entre pelo link de um amigo."}</p>
    </aside>}

    <div className={`stage ${viewingCall ? "dark-stage" : ""}`}>
      {realtime.status !== "connected" && !loading && <p className="connection-banner" role="status"><WifiOff size={15} />{realtime.status === "reconnecting" ? "Reconectando ao servidor…" : "Conectando ao servidor…"}</p>}
      {error && <div className="workspace-error"><p className="error-banner" role="alert">{error}</p><button className="button secondary" onClick={() => setReload(n => n + 1)} disabled={loading}>Tentar novamente</button></div>}

      {view === "dms" ? (dmId
        ? <DirectMessages conversation={conversation} realtime={realtime.client} revision={realtime.revision} self={user}
          onRead={unread.markRead} onNew={() => setNewDm(true)} />
        : <FriendsPage friends={friends} selfId={user.id} onMessage={messagePerson} />) : loading ? <div className="empty-state" role="status"><RefreshCw size={30} className="spin" /><h1>Carregando seus servidores…</h1></div> : server ? (
        channelError && !channel ? <div className="empty-state"><p role="alert">{channelError}</p><button className="button secondary" onClick={() => setChannelReload(n => n + 1)}>Tentar novamente</button></div>
        : channelLoading && !channel ? <div className="empty-state" role="status">Carregando canais…</div>
        : channel?.type === "text" ? <main className="channel-main"><ChannelHeader channel={channel} memberCount={members.members.length} /><TextChannel key={`${channel.id}:${focusMessage?.channelId === channel.id ? focusMessage.nonce : ""}`} channel={channel} realtime={realtime.client} revision={realtime.revision} self={user}
          roles={roles} focusId={focusMessage?.channelId === channel.id ? focusMessage.messageId : undefined} onRead={messageId => unread.markRead(channel.id, messageId)} /></main>
        : channel?.type === "voice" ? <VoiceChannel channel={channel} voice={voice} state={voiceState} online={realtime.status === "connected"}
          participants={voiceState.channel?.id === channel.id && inCall ? voiceState.participants : participants[channel.id] || []} />
        : <div className="empty-state">
          <span className="empty-icon"><MessageSquareText size={34} /></span>
          <h2>{`Bem-vindo a ${server.name}`}</h2>
          <p>Organize sua comunidade criando uma conversa de texto ou uma sala de voz.</p>
          <button className="button primary" onClick={() => setDialog({ kind: "channel", server })}><Plus size={16} />Criar primeiro canal</button>
        </div>
      ) : <div className="empty-state welcome-state">
        <span className="eyebrow">Seu próximo encontro começa aqui</span>
        <h1>Um lugar para chamar de seu.</h1>
        <p>Crie um servidor para seus amigos ou entre em uma comunidade com um convite.</p>
        <div className="button-row"><button className="button primary large" onClick={() => setDialog({ kind: "create" })}><Plus size={18} />Criar meu servidor</button><button className="button secondary large" onClick={() => setDialog({ kind: "join" })}><LogIn size={18} />Tenho um convite</button></div>
      </div>}

      <div className="bar-dock">
        <CallStatus voice={voice} state={voiceState} serverName={servers.find(s => s.id === voiceState.channel?.serverId)?.name} onOpen={goToVoice} />
        <AppBar user={user} status={myStatus.status} chosenStatus={myStatus.chosen} onStatus={myStatus.choose} servers={servers} server={server} view={view} voice={voice} voiceState={voiceState}
          canJoinVoice={voiceChannels.length > 0} dmUnread={unread.dmUnread} onSelectServer={selectServer}
          onCreateServer={() => setDialog({ kind: "create" })} onJoinServer={() => setDialog({ kind: "join" })}
          onDms={() => show(view === "dms" ? "server" : "dms")} onVoice={goToVoice}
          onSettings={() => openSettings("overview")} onVoiceSettings={() => openSettings("voice")} onSearch={() => setSearching(true)} />
      </div>
    </div>

    {showDetails && <ChannelDetails user={user} selfStatus={myStatus.status} members={members} voiceChannels={voiceChannels} participants={participants}
      voiceState={voiceState} onJoin={joinVoice} onShowMembers={() => setMembersOpen(true)} />}
    {membersOpen && server && <MembersDialog server={server} self={user} selfStatus={myStatus.status} members={members.members}
      rooms={roomPresence(voiceChannels, voiceOccupants(participants, voiceState))} onClose={() => setMembersOpen(false)} />}
    {showProfile && conversation && <DirectProfilePanel key={conversation.user.id} user={visibleProfiles[conversation.user.id] || conversation.user}
      friendship={friendshipWith(friends, conversation.user.id)} status={presence[conversation.user.id]}
      onAddFriend={() => friendshipWith(friends, conversation.user.id) === "incoming" ? friends.accept(conversation.user.id) : friends.add(conversation.user.id)} />}

    {settingsOpen && <Settings user={user} page={settingsPage} onPage={setSettingsPage} onClose={() => setSettingsOpen(false)} onLogout={() => void logout()}
      leaving={leaving} error={logoutError} inCall={inCall} callDevices={callDevices} onUserChange={onUserChange} realtime={realtime.client} />}
    {search}
    {newDm && <NewMessageDialog selfId={user.id} onClose={() => setNewDm(false)} onPick={async person => { await messagePerson(person); setNewDm(false); }} />}
    {discordOpen && server && <DiscordImportDialog server={server} realtime={realtime.client} onClose={() => setDiscordOpen(false)}
      onOpenChannel={id => { setDiscordOpen(false); goToChannel(server.id, id); }} />}
    {dialog && !loading && <ServerDialog mode={dialog} onClose={() => setDialog(null)} onServer={acceptServer} onChannel={next => {
      if (next.serverId === selected) {
        setChannels(current => current.some(c => c.id === next.id) ? current : [...current, next]); setChannelId(next.id);
      }
    }} />}
  </div></ProfileCardProvider>;
}

/** The search dialog, inside the profile card host so people results open their card. */
function SearchResultsHost({ onClose, onPick }: { onClose: () => void; onPick: (pick: SearchPick) => void }) {
  const openProfile = useProfileCard();
  // Focus returns where it was, which also anchors a person's profile card.
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : document.body);
  return <SearchDialog onClose={() => { onClose(); opener.focus(); }} onPick={pick => {
    if (pick.kind === "person") openProfile(pick.user, opener);
    else onPick(pick);
  }} />;
}
