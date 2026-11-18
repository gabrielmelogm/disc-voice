import { useEffect, useRef, useState } from "react";
import { LogIn, MessageSquareText, Plus, RefreshCw, WifiOff } from "lucide-react";
import type { Channel, Server, User, VoiceParticipant } from "@disc-voice/shared";
import { api, message } from "../lib/api";
import { useNotifications } from "../hooks/useNotifications";
import { useRealtime } from "../hooks/useRealtime";
import { useVoice } from "../hooks/useVoice";
import { AppBar } from "./AppBar";
import { ChannelDetails, ChannelHeader } from "./ChannelDetails";
import { ChannelSidebar } from "./ChannelSidebar";
import { DirectMessages, DirectMessagesSidebar } from "./DirectMessages";
import { ServerDialog, type DialogMode } from "./ServerDialog";
import { Settings, type SettingsPage } from "./Settings";
import { TextChannel } from "./TextChannel";
import { CallStatus, VoiceChannel, VoiceDevices } from "./VoiceChannel";

type View = "server" | "dms" | "settings";

export function ServerWorkspace({ user, joinedServer, onLogout }: {
  user: User; joinedServer: Server | null; onLogout: () => Promise<void>;
}) {
  const [servers, setServers] = useState<Server[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>("server");
  const [lastView, setLastView] = useState<Exclude<View, "settings">>("server");
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
  // Channel to open once another server's channel list arrives (e.g. returning to a call).
  const pendingChannel = useRef<string | null>(null);
  const realtime = useRealtime(selected);
  const { voice, state: voiceState } = useVoice(realtime.client);
  const [participants, setParticipants] = useState<Record<string, VoiceParticipant[]>>({});
  const server = servers.find(s => s.id === selected);
  const channel = channels.find(c => c.id === channelId);
  const inCall = !!voiceState.channel && voiceState.status !== "error";
  const voiceChannels = channels.filter(c => c.type === "voice");
  useNotifications({
    realtime: realtime.client,
    user,
    voiceState,
    viewingChannelId: view === "server" && channel?.type === "text" ? channel.id : null,
    channels,
  });

  useEffect(() => realtime.client.onEvent(event => {
    if (event.type === "channel.created" && event.channel.serverId === selected) {
      setChannels(current => current.some(c => c.id === event.channel.id) ? current : [...current, event.channel]);
    }
    if (event.type === "server.snapshot" && event.serverId === selected) {
      setParticipants(event.channels);
    }
    if (event.type === "voice.participants" && event.serverId === selected) {
      setParticipants(current => ({ ...current, [event.channelId]: event.participants }));
    }
  }), [realtime.client, selected]);

  useEffect(() => { if (realtime.status !== "connected") setParticipants({}); }, [realtime.status]);
  useEffect(() => { setParticipants({}); setChannels([]); setChannelId(null); }, [selected]);

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

  function show(next: Exclude<View, "settings">) {
    setView(next);
    setLastView(next);
  }

  function openSettings(page: SettingsPage) {
    setSettingsPage(page);
    setView("settings");
  }

  function acceptServer(next: Server) {
    setServers(current => current.some(s => s.id === next.id) ? current : [...current, next]);
    setSelected(next.id);
    show("server");
    setError("");
  }

  function selectServer(next: Server) {
    setSelected(next.id);
    show("server");
  }

  function openChannel(next: Channel) {
    if (next.serverId === selected) setChannelId(next.id);
    show("server");
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
  if (view === "settings") {
    return <div className="app-shell">
      <Settings user={user} page={settingsPage} onPage={setSettingsPage} onClose={() => setView(lastView)} onLogout={() => void logout()}
        leaving={leaving} error={logoutError} inCall={inCall} callDevices={callDevices} />
    </div>;
  }

  const viewingCall = view === "server" && channel?.type === "voice";
  const showDetails = view === "server" && channel?.type === "text";

  return <div className={`app-shell workspace-shell ${showDetails ? "with-details" : ""}`}>
    {view === "dms" ? <DirectMessagesSidebar /> : server ? <ChannelSidebar server={server} channels={channels} channelId={channelId}
      participants={participants} voiceState={voiceState} loading={channelLoading} error={channelError}
      onSelect={openChannel} onJoin={joinVoice} onCreate={type => setDialog({ kind: "channel", server, channelType: type })}
      onInvite={() => setDialog({ kind: "invite", server })} onReload={() => setChannelReload(n => n + 1)} /> : <aside className="sidebar">
      <div className="sidebar-title"><h2>Seu espaço</h2></div>
      <p className="sidebar-status">{loading ? "Carregando…" : "Crie um servidor ou entre pelo link de um amigo."}</p>
    </aside>}

    <div className={`stage ${viewingCall ? "dark-stage" : ""}`}>
      {realtime.status !== "connected" && !loading && <p className="connection-banner" role="status"><WifiOff size={15} />{realtime.status === "reconnecting" ? "Reconectando ao servidor…" : "Conectando ao servidor…"}</p>}
      {error && <div className="workspace-error"><p className="error-banner" role="alert">{error}</p><button className="button secondary" onClick={() => setReload(n => n + 1)} disabled={loading}>Tentar novamente</button></div>}

      {view === "dms" ? <DirectMessages /> : loading ? <div className="empty-state" role="status"><RefreshCw size={30} className="spin" /><h1>Carregando seus servidores…</h1></div> : server ? (
        channelError && !channel ? <div className="empty-state"><p role="alert">{channelError}</p><button className="button secondary" onClick={() => setChannelReload(n => n + 1)}>Tentar novamente</button></div>
        : channelLoading && !channel ? <div className="empty-state" role="status">Carregando canais…</div>
        : channel?.type === "text" ? <main className="channel-main"><ChannelHeader channel={channel} /><TextChannel key={channel.id} channel={channel} realtime={realtime.client} revision={realtime.revision} self={user} /></main>
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
        <AppBar user={user} servers={servers} server={server} view={view === "dms" ? "dms" : "server"} voice={voice} voiceState={voiceState}
          canJoinVoice={voiceChannels.length > 0} onSelectServer={selectServer}
          onCreateServer={() => setDialog({ kind: "create" })} onJoinServer={() => setDialog({ kind: "join" })}
          onDms={() => show(view === "dms" ? "server" : "dms")} onVoice={goToVoice}
          onSettings={() => openSettings("overview")} onVoiceSettings={() => openSettings("voice")} />
      </div>
    </div>

    {showDetails && <ChannelDetails user={user} voiceChannels={voiceChannels} participants={participants} voiceState={voiceState} onJoin={joinVoice} />}

    {dialog && !loading && <ServerDialog mode={dialog} onClose={() => setDialog(null)} onServer={acceptServer} onChannel={next => {
      if (next.serverId === selected) {
        setChannels(current => current.some(c => c.id === next.id) ? current : [...current, next]); setChannelId(next.id);
      }
    }} />}
  </div>;
}
