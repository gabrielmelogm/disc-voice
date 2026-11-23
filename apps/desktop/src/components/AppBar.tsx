import { useEffect, useRef, useState } from "react";
import {
  Check, ChevronUp, Headphones, Home, LoaderCircle, LogIn, MessageCircle, Mic, MicOff, MonitorOff, MonitorUp,
  MoreHorizontal, PhoneOff, Plus, Search, Settings2, Video, VideoOff, VolumeX,
} from "lucide-react";
import type { Server, User } from "@disc-voice/shared";
import { CAMERA_QUALITIES, type CameraQuality, type Voice, type VoiceState } from "../lib/voice";
import { Avatar } from "./ui";

export function ScreenButton({ voice, state }: { voice: Voice; state: VoiceState }) {
  if (!state.screenSupported) {
    return <button className="bar-button" disabled aria-label="Compartilhar tela (indisponível)" title="O compartilhamento de tela está disponível somente no aplicativo para Windows e Linux."><MonitorUp size={20} /></button>;
  }
  const active = state.screen !== "idle";
  const label = state.screen === "picking" ? "Cancelar escolha da tela" : active ? "Parar compartilhamento de tela" : "Compartilhar tela";
  return <button className={`bar-button ${state.screen === "live" ? "current" : ""}`} aria-label={label} aria-pressed={active} title={label}
    disabled={!active && state.status !== "connected"} onClick={() => (active ? voice.stopScreen() : void voice.startScreen())}>
    {active ? <MonitorOff size={20} /> : <MonitorUp size={20} />}
  </button>;
}

/**
 * Turns our webcam on or off in the call. The arrow opens the camera and
 * quality to use; they apply the next time it turns on (or at once, if on).
 */
export function CameraButton({ voice, state, menuOpen, onMenu, onPicked }: {
  voice: Voice; state: VoiceState; menuOpen: boolean; onMenu: () => void; onPicked: () => void;
}) {
  if (!state.cameraSupported) {
    return <button className="bar-button" disabled aria-label="Ligar câmera (indisponível)" title="A câmera não está disponível neste ambiente."><Video size={20} /></button>;
  }
  const on = state.camera !== "idle";
  const label = state.camera === "starting" ? "Cancelar câmera" : on ? "Desligar câmera" : "Ligar câmera";
  const pick = (action: () => void) => () => { onPicked(); action(); };
  const hasChosen = !state.cameraId || state.cameras.some(camera => camera.deviceId === state.cameraId);
  return <div className="split-button">
    <button className={`bar-button ${state.camera === "live" ? "current" : ""}`} aria-label={label} aria-pressed={on} title={label}
      disabled={!on && state.status !== "connected"} onClick={() => (on ? voice.stopCamera() : void voice.startCamera())}>
      {state.camera === "starting" ? <LoaderCircle size={20} className="spin" /> : on ? <VideoOff size={20} /> : <Video size={20} />}
    </button>
    <div className="menu-anchor">
      <button className="bar-button narrow" aria-haspopup="menu" aria-expanded={menuOpen} aria-label="Escolher câmera e qualidade" title="Câmera e qualidade"
        onClick={() => { if (!menuOpen) void voice.refreshCameras(); onMenu(); }}><ChevronUp size={16} /></button>
      {menuOpen && <div className="popover-menu" role="menu" aria-label="Câmera e qualidade">
        <span className="menu-label">Câmera</span>
        <button role="menuitemradio" aria-checked={!state.cameraId} onClick={pick(() => voice.setCamera(""))}><span>Câmera padrão</span>{!state.cameraId && <Check size={16} />}</button>
        {state.cameras.map(camera => <button key={camera.deviceId} role="menuitemradio" aria-checked={camera.deviceId === state.cameraId} onClick={pick(() => voice.setCamera(camera.deviceId))}>
          <span>{camera.label}</span>{camera.deviceId === state.cameraId && <Check size={16} />}
        </button>)}
        {!hasChosen && <p className="menu-empty">A câmera escolhida não está conectada.</p>}
        <hr />
        <span className="menu-label">Qualidade</span>
        {(Object.keys(CAMERA_QUALITIES) as CameraQuality[]).map(quality => <button key={quality} role="menuitemradio" aria-checked={quality === state.cameraQuality} onClick={pick(() => voice.setCameraQuality(quality))}>
          <span>{CAMERA_QUALITIES[quality].label}</span>{quality === state.cameraQuality && <Check size={16} />}
        </button>)}
      </div>}
    </div>
  </div>;
}

/** Floating app bar: server switcher, call controls and global shortcuts. */
export function AppBar({ user, servers, server, view, voice, voiceState, canJoinVoice, onSelectServer, onCreateServer, onJoinServer, onDms, onVoice, onSettings, onVoiceSettings, onSearch }: {
  user: User;
  servers: Server[];
  server: Server | undefined;
  view: "server" | "dms";
  voice: Voice;
  voiceState: VoiceState;
  canJoinVoice: boolean;
  onSelectServer: (server: Server) => void;
  onCreateServer: () => void;
  onJoinServer: () => void;
  onDms: () => void;
  onVoice: () => void;
  onSettings: () => void;
  onVoiceSettings: () => void;
  onSearch: () => void;
}) {
  const [menu, setMenu] = useState<"servers" | "call" | "camera" | null>(null);
  const ref = useRef<HTMLElement>(null);
  const inCall = !!voiceState.channel && voiceState.status !== "error";

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, [menu]);

  const pick = (action: () => void) => () => { setMenu(null); action(); };

  return <nav ref={ref} className="app-bar" aria-label="Barra do app">
    <div className="menu-anchor">
      <button className="server-switch" aria-haspopup="menu" aria-expanded={menu === "servers"} aria-label={`Trocar de servidor. Atual: ${server?.name || "nenhum"}`} title="Trocar de servidor" onClick={() => setMenu(menu === "servers" ? null : "servers")}>
        {server ? <Avatar name={server.name} size="sm" /> : <span className="avatar avatar-sm"><Home size={15} /></span>}
        {!inCall && <span className="server-switch-name">{server?.name || "Início"}</span>}
        <ChevronUp size={16} />
      </button>
      {menu === "servers" && <div className="popover-menu" role="menu" aria-label="Servidores">
        <span className="menu-label">Seus servidores</span>
        {servers.map(item => <button key={item.id} role="menuitem" aria-label={`Abrir servidor ${item.name}`} onClick={pick(() => onSelectServer(item))}>
          <Avatar name={item.name} size="sm" /><span>{item.name}</span>{item.id === server?.id && view === "server" && <Check size={16} />}
        </button>)}
        {!servers.length && <p className="menu-empty">Você ainda não está em nenhum servidor.</p>}
        <hr />
        <button role="menuitem" onClick={pick(onCreateServer)}><span className="menu-icon"><Plus size={16} /></span>Criar servidor</button>
        <button role="menuitem" onClick={pick(onJoinServer)}><span className="menu-icon"><LogIn size={16} /></span>Entrar com convite</button>
      </div>}
    </div>

    {inCall && <>
      <span className="bar-divider" />
      <div role="toolbar" aria-label="Controles da chamada" className="bar-group">
        <button className={`bar-button ${voiceState.muted || voiceState.deafened ? "off" : ""}`} aria-pressed={voiceState.muted} aria-label={voiceState.muted ? "Ativar microfone" : "Silenciar microfone"} title={voiceState.muted ? "Ativar microfone" : "Silenciar microfone"} onClick={voice.toggleMute}>{voiceState.muted || voiceState.deafened ? <MicOff size={20} /> : <Mic size={20} />}</button>
        <CameraButton voice={voice} state={voiceState} menuOpen={menu === "camera"} onMenu={() => setMenu(menu === "camera" ? null : "camera")} onPicked={() => setMenu(null)} />
        <ScreenButton voice={voice} state={voiceState} />
        <div className="menu-anchor">
          <button className="bar-button" aria-haspopup="menu" aria-expanded={menu === "call"} aria-label="Mais opções da chamada" title="Mais opções" onClick={() => setMenu(menu === "call" ? null : "call")}><MoreHorizontal size={20} /></button>
          {menu === "call" && <div className="popover-menu" role="menu" aria-label="Opções da chamada">
            <button role="menuitemcheckbox" aria-checked={voiceState.deafened} onClick={pick(voice.toggleDeafen)}><span className="menu-icon">{voiceState.deafened ? <VolumeX size={16} /> : <Headphones size={16} />}</span>{voiceState.deafened ? "Ativar áudio recebido" : "Desativar áudio recebido"}</button>
            <button role="menuitem" onClick={pick(onVoiceSettings)}><span className="menu-icon"><Settings2 size={16} /></span>Dispositivos de voz</button>
          </div>}
        </div>
        <button className="bar-button danger wide" aria-label="Sair da chamada" title="Sair da chamada" onClick={voice.hangUp}><PhoneOff size={20} /></button>
      </div>
    </>}

    <span className="bar-divider" />
    <button className="bar-button" aria-haspopup="dialog" aria-keyshortcuts="Control+K" aria-label="Buscar mensagens, pessoas e canais" title="Buscar (Ctrl+K)" onClick={onSearch}><Search size={20} /></button>
    <button className={`bar-button ${view === "dms" ? "current" : ""}`} aria-current={view === "dms" ? "page" : undefined} aria-label="Mensagens diretas" title="Mensagens diretas" onClick={onDms}><MessageCircle size={20} /></button>
    {!inCall && <button className="bar-button" disabled={!canJoinVoice} aria-label="Ir para a sala de voz" title="Sala de voz" onClick={onVoice}><Headphones size={20} /></button>}
    <span className="bar-divider" />
    <button className="bar-avatar" aria-label="Sua conta e configurações" title="Sua conta e configurações" onClick={onSettings}><Avatar name={user.name} src={user.avatar} status="online" /></button>
  </nav>;
}
