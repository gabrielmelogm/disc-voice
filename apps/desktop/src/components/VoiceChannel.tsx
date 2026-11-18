import { Headphones, Mic, MicOff, PhoneOff, Volume2, VolumeX } from "lucide-react";
import type { Channel, VoiceParticipant } from "@disc-voice/shared";
import type { Voice, VoiceState } from "../lib/voice";

const labels: Record<VoiceState["status"], string> = {
  idle: "Desconectado", connecting: "Conectando áudio…", connected: "Voz conectada",
  reconnecting: "Reconectando…", error: "Falha na conexão",
};

export function VoiceControls({ voice, state }: { voice: Voice; state: VoiceState }) {
  return <div className="voice-controls">
    <button className="icon-button" aria-label={state.muted ? "Ativar microfone" : "Silenciar microfone"} aria-pressed={state.muted} title={state.muted ? "Ativar microfone" : "Silenciar microfone"} onClick={voice.toggleMute}>{state.muted || state.deafened ? <MicOff size={19} /> : <Mic size={19} />}</button>
    <button className="icon-button" aria-label={state.deafened ? "Ativar áudio recebido" : "Desativar áudio recebido"} aria-pressed={state.deafened} title="Áudio recebido" onClick={voice.toggleDeafen}>{state.deafened ? <VolumeX size={19} /> : <Headphones size={19} />}</button>
    <button className="icon-button disconnect" aria-label="Sair do canal de voz" title="Sair do canal de voz" onClick={voice.leave}><PhoneOff size={19} /></button>
  </div>;
}

export function VoicePanel({ voice, state }: { voice: Voice; state: VoiceState }) {
  if (!state.channel) return state.error ? <p className="voice-notice" role="status">{state.error}</p> : null;
  return <section className="voice-panel" aria-label="Chamada atual">
    <strong role="status">{labels[state.status]}</strong>
    <span>{state.channel.name}</span>
    <VoiceControls voice={voice} state={state} />
    {state.error && <p role="alert">{state.error}</p>}
    {state.status === "error" && <button className="text-button" onClick={() => void voice.join(state.channel!)}>Tentar novamente</button>}
    {state.playbackBlocked && <button className="button secondary" onClick={() => void voice.resumePlayback()}>Ativar reprodução de áudio</button>}
  </section>;
}

export function VoiceChannel({ channel, voice, state, participants, online }: {
  channel: Channel; voice: Voice; state: VoiceState; participants: VoiceParticipant[]; online: boolean;
}) {
  const active = state.channel?.id === channel.id && state.status !== "error";
  return <section className="voice-room">
    <Volume2 size={40} />
    <h2>{channel.name}</h2>
    <p>{active ? labels[state.status] : "Entre no canal para conversar com sua comunidade."}</p>
    <ul className="voice-members" aria-label="Participantes do canal de voz">
      {participants.map(participant => <li key={participant.peerId} className={state.speaking.includes(participant.peerId) ? "speaking" : ""}>
        {participant.muted ? <MicOff size={18} /> : <Mic size={18} />}
        <span title={participant.user.email}>{participant.user.name}</span>
        {participant.deafened && <VolumeX size={16} aria-label="Áudio desativado" />}
        {state.speaking.includes(participant.peerId) && <small>Falando</small>}
      </li>)}
    </ul>
    {!participants.length && <p>Ninguém neste canal ainda.</p>}
    {active ? <VoiceControls voice={voice} state={state} /> :
      <button className="button primary" disabled={!online} onClick={() => void voice.join(channel)}><Headphones size={18} />Entrar no canal de voz</button>}
  </section>;
}

export function VoiceDevices({ voice, state }: { voice: Voice; state: VoiceState }) {
  const sinkSupported = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
  return <section className="card call-devices" aria-label="Dispositivos das chamadas">
    <h2>Dispositivos das chamadas</h2>
    <p>Seleções usadas no chat de voz via WebRTC. Autorize o microfone ao entrar em um canal para ver os nomes dos dispositivos.</p>
    <div className="device-fields">
      <div className="field"><label htmlFor="call-input">Microfone da chamada</label>
        <select id="call-input" value={state.inputId} disabled={state.deviceBusy || state.status === "connecting"} onChange={event => void voice.setInput(event.target.value)}>
          <option value="">Padrão do sistema</option>
          {state.inputId && !state.devices.some(d => d.deviceId === state.inputId) && <option value={state.inputId}>Dispositivo selecionado indisponível</option>}
          {state.devices.filter(d => d.kind === "audioinput" && d.deviceId).map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microfone ${i + 1}`}</option>)}
        </select>
      </div>
      <div className="field"><label htmlFor="call-output">Saída da chamada</label>
        <select id="call-output" value={state.outputId} disabled={!sinkSupported || state.deviceBusy} onChange={event => void voice.setOutput(event.target.value)}>
          <option value="">Padrão do sistema</option>
          {state.devices.filter(d => d.kind === "audiooutput" && d.deviceId).map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Saída ${i + 1}`}</option>)}
        </select>
        {!sinkSupported && <small>Este ambiente utiliza a saída padrão do sistema.</small>}
      </div>
    </div>
    <button className="text-button" onClick={() => void voice.refreshDevices()}>Atualizar dispositivos da chamada</button>
    {state.error && !state.channel && <p role="alert">{state.error}</p>}
  </section>;
}
