import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check, ChevronUp, Cloud, HeadphoneOff, Headphones, Home, LayoutGrid, LoaderCircle, LogIn, MessageCircle, Mic, MicOff, MonitorOff, MonitorUp,
  PhoneOff, Plus, Search, Settings2, Video, VideoOff,
} from "lucide-react";
import type { ChosenStatus, Server, User } from "@disc-voice/shared";
import { CHOSEN_STATUSES, STATUS_LABELS } from "../lib/presence";
import { CAMERA_QUALITIES, screenLabel, type CameraQuality, type Voice, type VoiceState } from "../lib/voice";
import { CallChip } from "./CallNav";
import { ScreenShareDialog } from "./ScreenShareDialog";
import { UpdateButton } from "./UpdateDialog";
import { Avatar, Badge, unreadLabel } from "./ui";

/**
 * Shares the screen in the call. Each time, a dialog asks for the quality,
 * the frame rate and whether the computer's audio goes with it.
 */
export function ScreenButton({ voice, state }: { voice: Voice; state: VoiceState }) {
  const [asking, setAsking] = useState(false);
  if (!state.screenSupported) {
    return <button className="bar-button" disabled aria-label="Compartilhar tela (indisponível)" title="O compartilhamento de tela está disponível somente no aplicativo para Windows e Linux."><MonitorUp size={20} /></button>;
  }
  const active = state.screen !== "idle";
  const sharing = state.screenShare ? ` (${screenLabel(state.screenShare)}${state.screenAudio ? ", com áudio" : ""})` : "";
  const label = state.screen === "picking" ? "Cancelar escolha da tela" : active ? `Parar compartilhamento de tela${sharing}` : "Compartilhar tela";
  return <>
    <button className={`bar-button ${state.screen === "live" ? "current" : ""}`} aria-label={label} aria-pressed={active} title={label}
      disabled={!active && state.status !== "connected"} onClick={() => (active ? voice.stopScreen() : setAsking(true))}>
      {active ? <MonitorOff size={20} /> : <MonitorUp size={20} />}
    </button>
    {asking && <ScreenShareDialog initial={{ quality: state.screenQuality, frameRate: state.screenFrameRate, audio: state.shareAudio }}
      onClose={() => setAsking(false)}
      onShare={options => { setAsking(false); void voice.startScreen(options); }} />}
  </>;
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
      <button className={`bar-button narrow ${state.camera === "live" ? "current" : ""}`} aria-haspopup="menu" aria-expanded={menuOpen} aria-label="Escolher câmera e qualidade" title="Câmera e qualidade"
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

/**
 * Mutes or unmutes the microphone. The arrow opens the input and output
 * devices, which switch in the middle of the call without leaving it.
 */
export function MicButton({ voice, state, menuOpen, onMenu, onPicked, onVoiceSettings }: {
  voice: Voice; state: VoiceState; menuOpen: boolean; onMenu: () => void; onPicked: () => void; onVoiceSettings: () => void;
}) {
  const silent = state.muted || state.deafened;
  const label = state.muted ? "Ativar microfone" : "Silenciar microfone";
  const pick = (action: () => void) => () => { onPicked(); action(); };
  const inputs = state.devices.filter(device => device.kind === "audioinput" && device.deviceId);
  const outputs = state.devices.filter(device => device.kind === "audiooutput" && device.deviceId);
  // The native call engine opens any output itself.
  const sinkSupported = state.native || (typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype);
  const inputMissing = !!state.inputId && !inputs.some(device => device.deviceId === state.inputId);
  const outputMissing = !!state.outputId && !outputs.some(device => device.deviceId === state.outputId);
  const inputLocked = state.deviceBusy || state.status === "connecting";
  const option = (device: MediaDeviceInfo, index: number, current: string, fallback: string, choose: (id: string) => Promise<void>, disabled: boolean) =>
    <button key={device.deviceId} role="menuitemradio" aria-checked={device.deviceId === current} disabled={disabled} onClick={pick(() => void choose(device.deviceId))}>
      <span>{device.label || `${fallback} ${index + 1}`}</span>{device.deviceId === current && <Check size={16} />}
    </button>;
  return <div className="split-button">
    <button className={`bar-button ${silent ? "off" : ""}`} aria-pressed={state.muted} aria-label={label} title={label} onClick={voice.toggleMute}>
      {silent ? <MicOff size={20} /> : <Mic size={20} />}
    </button>
    <div className="menu-anchor">
      <button className={`bar-button narrow ${silent ? "off" : ""}`} aria-haspopup="menu" aria-expanded={menuOpen} aria-label="Escolher microfone e saída de áudio" title="Microfone e saída de áudio"
        onClick={() => { if (!menuOpen) void voice.refreshDevices(); onMenu(); }}><ChevronUp size={16} /></button>
      {menuOpen && <div className="popover-menu" role="menu" aria-label="Microfone e saída de áudio">
        <span className="menu-label">Entrada</span>
        <button role="menuitemradio" aria-checked={!state.inputId} disabled={inputLocked} onClick={pick(() => void voice.setInput(""))}><span>Padrão do sistema</span>{!state.inputId && <Check size={16} />}</button>
        {inputs.map((device, index) => option(device, index, state.inputId, "Microfone", voice.setInput, inputLocked))}
        {inputMissing && <p className="menu-empty">O microfone escolhido não está conectado.</p>}
        <hr />
        <span className="menu-label">Saída</span>
        {sinkSupported ? <>
          <button role="menuitemradio" aria-checked={!state.outputId} disabled={state.deviceBusy} onClick={pick(() => void voice.setOutput(""))}><span>Padrão do sistema</span>{!state.outputId && <Check size={16} />}</button>
          {outputs.map((device, index) => option(device, index, state.outputId, "Saída", voice.setOutput, state.deviceBusy))}
          {outputMissing && <p className="menu-empty">A saída escolhida não está conectada.</p>}
        </> : <p className="menu-empty">Este ambiente usa a saída padrão do sistema.</p>}
        <hr />
        <button role="menuitem" onClick={pick(onVoiceSettings)}><span className="menu-icon"><Settings2 size={16} /></span>Dispositivos de voz</button>
      </div>}
    </div>
  </div>;
}

/** Turns off (and back on) the audio we hear from the call. */
export function DeafenButton({ voice, state }: { voice: Voice; state: VoiceState }) {
  const label = state.deafened ? "Ativar áudio recebido" : "Desativar áudio recebido";
  return <button className={`bar-button ${state.deafened ? "off" : ""}`} aria-pressed={state.deafened} aria-label={label} title={label} onClick={voice.toggleDeafen}>
    {state.deafened ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
  </button>;
}

/** Small green headphones on a server's icon: the call is there. */
function CallMark({ children, on }: { children: ReactNode; on: boolean }) {
  return <span className="call-mark-host">{children}{on && <span className="call-mark" aria-hidden="true"><Headphones size={10} /></span>}</span>;
}

/**
 * Floating app bar: server switcher, call controls and global shortcuts.
 * In a call it shows the full controls on the call screen (`call`) and
 * shrinks them into a green chip anywhere else (`away`).
 */
export function AppBar({ user, status = "online", chosenStatus = status, onStatus = () => {}, servers, server, view, voice, voiceState, viewingCall = false, onOpenCall, canJoinVoice, dmUnread = 0, onSelectServer, onCreateServer, onJoinServer, onManageServers, onDms, onVoice, onSettings, onVoiceSettings, onSearch, onFiles }: {
  user: User;
  /** The status others see (an idle "online" shows as idle). */
  status?: ChosenStatus;
  /** The status the user picked. */
  chosenStatus?: ChosenStatus;
  onStatus?: (status: ChosenStatus) => void;
  /** Unread messages across all direct conversations. */
  dmUnread?: number;
  servers: Server[];
  server: Server | undefined;
  view: "server" | "dms";
  voice: Voice;
  voiceState: VoiceState;
  /** The call's room is the screen open now. */
  viewingCall?: boolean;
  /** Back to the call's room, from anywhere. */
  onOpenCall?: () => void;
  canJoinVoice: boolean;
  onSelectServer: (server: Server) => void;
  onCreateServer: () => void;
  onJoinServer: () => void;
  /** Opens the grid with every server ("Gerenciar servidores"). */
  onManageServers?: () => void;
  onDms: () => void;
  onVoice: () => void;
  onSettings: () => void;
  onVoiceSettings: () => void;
  onSearch: () => void;
  /** Opens the drawer with the user's files in the cloud. */
  onFiles?: () => void;
}) {
  const [menu, setMenu] = useState<"servers" | "mic" | "camera" | "account" | null>(null);
  const ref = useRef<HTMLElement>(null);
  const inCall = !!voiceState.channel && voiceState.status !== "error";
  const mode = !inCall ? "app" : viewingCall ? "call" : "away";
  const callServerId = inCall ? voiceState.channel?.serverId : undefined;
  const callServerName = servers.find(s => s.id === callServerId)?.name;

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
      <button className="server-switch" aria-haspopup="menu" aria-expanded={menu === "servers"} aria-label={`Trocar de servidor. Atual: ${server?.name || "nenhum"}${callServerName ? `. Em chamada em ${callServerName}` : ""}`} title="Trocar de servidor" onClick={() => setMenu(menu === "servers" ? null : "servers")}>
        {server ? <CallMark on={!!server && server.id === callServerId}><Avatar name={server.name} src={server.icon} size="sm" /></CallMark> :<span className="avatar avatar-sm"><Home size={15} /></span>}
        {mode !== "call" && <span className="server-switch-name">{server?.name || "Início"}</span>}
        <ChevronUp size={16} />
      </button>
      {menu === "servers" && <div className="popover-menu" role="menu" aria-label="Servidores">
        <span className="menu-label">Seus servidores</span>
        {servers.map(item => {
          const here = item.id === callServerId;
          return <button key={item.id} role="menuitem" aria-label={`Abrir servidor ${item.name}${here ? ", em chamada" : ""}`} onClick={pick(() => onSelectServer(item))}>
            <CallMark on={here}><Avatar name={item.name} src={item.icon} size="sm" /></CallMark>
            {here ? <span className="menu-text"><span>{item.name}</span><small className="call-sub">{voiceState.channel?.name} · você está lá</small></span> : <span>{item.name}</span>}
            {here && <span className="call-tag"><span className="call-tag-dot" />Em chamada</span>}
            {item.id === server?.id && view === "server" && <Check size={16} />}
          </button>;
        })}
        {!servers.length && <p className="menu-empty">Você ainda não está em nenhum servidor.</p>}
        <hr />
        {onManageServers && <button role="menuitem" onClick={pick(onManageServers)}><span className="menu-icon"><LayoutGrid size={16} /></span>Gerenciar servidores</button>}
        <button role="menuitem" onClick={pick(onCreateServer)}><span className="menu-icon"><Plus size={16} /></span>Criar servidor</button>
        <button role="menuitem" onClick={pick(onJoinServer)}><span className="menu-icon"><LogIn size={16} /></span>Entrar com convite</button>
      </div>}
    </div>

    {mode === "away" && <>
      <span className="bar-divider" />
      <CallChip voice={voice} state={voiceState} serverName={callServerName} onOpen={onOpenCall ?? onVoice} />
    </>}

    {mode === "call" && <>
      <span className="bar-divider" />
      <div role="toolbar" aria-label="Controles da chamada" className="bar-group">
        <MicButton voice={voice} state={voiceState} menuOpen={menu === "mic"} onMenu={() => setMenu(menu === "mic" ? null : "mic")} onPicked={() => setMenu(null)} onVoiceSettings={onVoiceSettings} />
        <DeafenButton voice={voice} state={voiceState} />
        <CameraButton voice={voice} state={voiceState} menuOpen={menu === "camera"} onMenu={() => setMenu(menu === "camera" ? null : "camera")} onPicked={() => setMenu(null)} />
        <ScreenButton voice={voice} state={voiceState} />
        <button className="bar-button danger wide" aria-label="Sair da chamada" title="Sair da chamada" onClick={voice.hangUp}><PhoneOff size={20} /></button>
      </div>
    </>}

    <span className="bar-divider" />
    <button className="bar-button" aria-haspopup="dialog" aria-keyshortcuts="Control+K" aria-label="Buscar mensagens, pessoas e canais" title="Buscar (Ctrl+K)" onClick={onSearch}><Search size={20} /></button>
    {onFiles && <button className="bar-button" aria-haspopup="dialog" aria-label="Seus arquivos na nuvem" title="Seus arquivos" onClick={onFiles}><Cloud size={20} /></button>}
    <button className={`bar-button ${view === "dms" ? "current" : ""}`} aria-current={view === "dms" ? "page" : undefined}
      aria-label={dmUnread > 0 ? `Mensagens diretas, ${unreadLabel(dmUnread)}` : "Mensagens diretas"} title="Mensagens diretas" onClick={onDms}>
      <MessageCircle size={20} />{dmUnread > 0 && <span className="bar-badge"><Badge count={dmUnread} /></span>}
    </button>
    {!inCall && <button className="bar-button" disabled={!canJoinVoice} aria-label="Ir para a sala de voz" title="Sala de voz" onClick={onVoice}><Headphones size={20} /></button>}
    <UpdateButton inCall={inCall} onLeaveCall={voice.hangUp} />
    <span className="bar-divider" />
    <div className="menu-anchor">
      <button className="bar-avatar" aria-haspopup="menu" aria-expanded={menu === "account"} aria-label="Sua conta e configurações" title={`Sua conta · ${STATUS_LABELS[status]}`}
        onClick={() => setMenu(menu === "account" ? null : "account")}><Avatar name={user.name} src={user.avatar} still={user.avatarStill} status={status} /></button>
      {menu === "account" && <div className="popover-menu align-end" role="menu" aria-label="Sua conta">
        <span className="menu-label">Status</span>
        {CHOSEN_STATUSES.map(option => <button key={option.value} role="menuitemradio" aria-checked={option.value === chosenStatus} onClick={pick(() => onStatus(option.value))}>
          <span className="menu-icon"><span className={`presence-dot presence-${option.value}`} /></span>
          <span className="menu-text"><span>{option.label}</span><small>{option.hint}</small></span>
          {option.value === chosenStatus && <Check size={16} />}
        </button>)}
        <hr />
        <button role="menuitem" onClick={pick(onSettings)}><span className="menu-icon"><Settings2 size={16} /></span>Configurações</button>
      </div>}
    </div>
  </nav>;
}
