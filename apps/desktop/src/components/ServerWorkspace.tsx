import { useEffect, useState } from "react";
import { Hash, Headphones, Home, LogIn, LogOut, Plus, RefreshCw, Users } from "lucide-react";
import type { Channel, Server, User } from "@disc-voice/shared";
import { DeviceSettings } from "../DeviceSettings";
import { api, clearPendingInvite, message } from "../lib/api";
import { initials } from "../lib/display";
import { ServerDialog, type DialogMode } from "./ServerDialog";

export function ServerWorkspace({ user, inviteCode, onLogout }: {
  user: User; inviteCode: string; onLogout: () => Promise<void>;
}) {
  const [servers, setServers] = useState<Server[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [devices, setDevices] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogMode | null>(inviteCode ? { kind: "join", code: inviteCode } : null);
  const [loading, setLoading] = useState(true);
  const [channelLoading, setChannelLoading] = useState(false);
  const [error, setError] = useState("");
  const [channelError, setChannelError] = useState("");
  const [reload, setReload] = useState(0);
  const [channelReload, setChannelReload] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const server = servers.find(s => s.id === selected);
  const channel = channels.find(c => c.id === channelId);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api.servers(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setServers(result);
      setSelected(current => result.some(s => s.id === current) ? current : result[0]?.id || null);
    }).catch(cause => { if (!controller.signal.aborted) setError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    setChannels([]);
    setChannelId(null);
    setChannelError("");
    if (!selected) { setChannelLoading(false); return; }
    const controller = new AbortController();
    setChannelLoading(true);
    void api.channels(selected, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setChannels(result);
      setChannelId(current => result.some(c => c.id === current) ? current : result[0]?.id || null);
    }).catch(cause => { if (!controller.signal.aborted) setChannelError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setChannelLoading(false); });
    return () => controller.abort();
  }, [selected, channelReload]);

  function acceptServer(next: Server) {
    setServers(current => current.some(s => s.id === next.id) ? current : [...current, next]);
    setSelected(next.id);
    setDevices(false);
    setError("");
  }

  function closeDialog() {
    if (dialog?.kind === "join") clearPendingInvite();
    setDialog(null);
  }

  async function logout() {
    setLeaving(true);
    setError("");
    try { await onLogout(); }
    catch (cause) { setError(message(cause)); }
    finally { setLeaving(false); }
  }

  return <div className="app-shell community-shell">
    <header className="topbar">
      <button className="brand brand-button" onClick={() => { setDevices(false); }}><img className="brand-mark" src="/app-icon.png" alt="" width={18} height={18} />DiscVoice</button>
      <span className="topbar-caption">SEU ESPAÇO DE VOZ</span>
      <span className="environment"><span className="dot green" />Conectado</span>
    </header>
    <nav className="app-rail" aria-label="Servidores">
      <button className="rail-button" aria-label="Início" title="Início" onClick={() => { setDevices(false); setSelected(null); }}><Home size={20} /></button>
      <div className="rail-divider" />
      <div className="server-list">{servers.map(item => <button key={item.id} className={`rail-button server-avatar ${selected === item.id && !devices ? "active" : ""}`} aria-label={`Abrir servidor ${item.name}`} aria-pressed={selected === item.id && !devices} title={item.name} onClick={() => { setSelected(item.id); setDevices(false); }}>{initials(item.name)}</button>)}</div>
      <button className="rail-button add-server" aria-label="Criar servidor" title="Criar servidor" disabled={loading} onClick={() => setDialog({ kind: "create" })}><Plus size={22} /></button>
      <button className="rail-button" aria-label="Entrar em servidor" title="Entrar em servidor" disabled={loading} onClick={() => setDialog({ kind: "join" })}><LogIn size={20} /></button>
      <button className="rail-button rail-settings" aria-label="Configurações de voz e vídeo" aria-pressed={devices} title="Voz e vídeo" onClick={() => setDevices(true)}><Headphones size={20} /></button>
    </nav>
    <aside className="sidebar">
      <div className="sidebar-heading"><h2>{devices ? "Configurações" : server?.name || "Seu espaço"}</h2><p>{devices ? "Ajustes de dispositivos" : server ? "Sua comunidade no DiscVoice" : "Tudo começa com um convite"}</p></div>
      {devices ? <nav className="settings-nav" aria-label="Configurações"><span className="nav-item selected"><Headphones size={17} />Voz e vídeo</span></nav> : server ? <>
        <button className="button secondary invite-button" onClick={() => setDialog({ kind: "invite", server })}><Users size={15} />Convidar amigos</button>
        <div className="channel-heading"><span>CANAIS DE TEXTO</span><button className="icon-button" aria-label="Criar canal de texto" title="Criar canal de texto" disabled={channelLoading} onClick={() => setDialog({ kind: "channel", server })}><Plus size={17} /></button></div>
        <nav className="channel-list" aria-label="Canais de texto">
          {channelLoading && <p className="sidebar-status" role="status">Carregando canais…</p>}
          {!channelLoading && !channelError && channels.length === 0 && <p className="sidebar-status">Crie o primeiro canal.</p>}
          {channels.map(item => <button key={item.id} className={`nav-item ${channelId === item.id ? "selected" : ""}`} aria-pressed={channelId === item.id} onClick={() => setChannelId(item.id)}><Hash size={17} /><span>{item.name}</span></button>)}
        </nav>
        <button className="text-button refresh-channels" onClick={() => setChannelReload(n => n + 1)} disabled={channelLoading}><RefreshCw size={13} />Atualizar canais</button>
      </> : <div className="sidebar-status">Crie um servidor ou entre pelo link de um amigo.</div>}
      <div className="user-panel">
        <span className="user-avatar">{initials(user.email)}</span><div className="user-details"><strong title={user.email}>{user.email}</strong><span>Disponível</span></div>
        <button className="icon-button" aria-label="Sair da conta" title="Sair da conta" disabled={leaving} onClick={() => void logout()}><LogOut size={16} /></button>
      </div>
    </aside>
    <div className="workspace">
      {error && <div className="workspace-error"><div className="error-banner" role="alert">{error}</div><button className="button secondary" onClick={() => setReload(n => n + 1)} disabled={loading}>Tentar novamente</button></div>}
      {devices ? <DeviceSettings /> : <main className="community-main">
        {loading ? <div className="empty-state" role="status"><RefreshCw size={30} className="spin" /><h1>Carregando seus servidores…</h1></div> : server ? <>
          <div className="channel-topbar"><h1><Hash size={24} />{channel?.name || server.name}</h1><button className="button secondary" onClick={() => setDialog({ kind: "channel", server })} disabled={channelLoading}><Plus size={15} />Criar canal</button></div>
          {channelError ? <div className="empty-state"><p role="alert">{channelError}</p><button className="button secondary" onClick={() => setChannelReload(n => n + 1)}>Tentar novamente</button></div> : channelLoading ? <div className="empty-state" role="status">Carregando canais…</div> : <div className="empty-state">
            <span className="empty-icon"><Hash size={38} /></span>
            <h2>{channel ? `Bem-vindo a #${channel.name}` : `Bem-vindo a ${server.name}`}</h2>
            <p>{channel ? "Seu canal de texto está criado. Este é o espaço reservado para as conversas da comunidade." : "Organize sua comunidade criando o primeiro canal de texto."}</p>
            {!channel && <button className="button primary" onClick={() => setDialog({ kind: "channel", server })}><Plus size={16} />Criar primeiro canal</button>}
          </div>}
        </> : <div className="empty-state welcome-state">
          <span className="eyebrow">SEU PRÓXIMO ENCONTRO COMEÇA AQUI</span>
          <h1>Um lugar para chamar de seu.</h1>
          <p>Crie um servidor para seus amigos ou entre em uma comunidade com um convite.</p>
          <div className="welcome-actions"><button className="button primary" onClick={() => setDialog({ kind: "create" })}><Plus size={18} />Criar meu servidor</button><button className="button secondary" onClick={() => setDialog({ kind: "join" })}><LogIn size={18} />Tenho um convite</button></div>
        </div>}
      </main>}
    </div>
    {dialog && !loading && <ServerDialog mode={dialog} onClose={closeDialog} onServer={acceptServer} onChannel={next => {
      setChannels(current => [...current, next]); setChannelId(next.id);
    }} />}
  </div>;
}
