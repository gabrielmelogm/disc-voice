import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity, Camera, Headphones, Mic, Monitor, Play, RefreshCw, ShieldCheck, Square, Volume2,
} from "lucide-react";
import { MAX_RECORDING_SECONDS, type AudioDevice } from "@disc-voice/shared";
import { useAudio } from "./hooks/useAudio";
import { useCamera } from "./hooks/useCamera";
import { useScreenShare } from "./hooks/useScreenShare";
import { NativeCameraPreview } from "./components/NativeCameraPreview";
import { ScreenShareTest } from "./components/ScreenShareTest";
import { Avatar, RadioCards, SoonTag, Switch } from "./components/ui";
import { audioProcessing, saveAudioProcessing, type AudioProcessing } from "./lib/voice";

const SEGMENTS = 30;

function DeviceSelect({ id, label, devices, value, onChange, disabled }: {
  id: string;
  label: string;
  devices: AudioDevice[];
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} disabled={disabled || !devices.length} onChange={(e) => onChange(e.target.value)}>
        {!devices.length && <option value="">Nenhum dispositivo disponível</option>}
        {devices.map((device) => (
          <option key={device.id} value={device.id}>
            {device.name}{device.isDefault ? " · Padrão do Windows" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

function CameraPreview({ stream, onError, mirrored }: {
  stream: MediaStream | null;
  onError: (message?: string) => void;
  mirrored: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let disposed = false;
    video.srcObject = stream;
    if (stream) void video.play().catch(() => { if (!disposed) onError(); });
    return () => {
      disposed = true;
      video.pause();
      video.srcObject = null;
    };
  }, [stream, onError]);
  return <video ref={ref} className={mirrored ? "mirrored" : ""} muted autoPlay playsInline aria-label="Prévia ao vivo da webcam" />;
}

export function DeviceSettings({ inCall = false, callDevices, userName = "Você" }: { inCall?: boolean; callDevices?: ReactNode; userName?: string } = {}) {
  const audio = useAudio();
  const camera = useCamera();
  const screen = useScreenShare();
  const [volume, setVolume] = useState(35);
  const [mirrored, setMirrored] = useState(true);
  const [processing, setProcessing] = useState(audioProcessing);
  const inputActive = audio.status.inputActive;
  const outputActive = audio.status.outputActive;
  const screenActive = screen.status === "live" || screen.status === "picking";
  const active = inputActive || outputActive || camera.live || camera.busy || screenActive;
  const audioLocked = audio.busy || audio.refreshing || inCall;
  const level = Math.min(100, Math.max(0, Math.round(audio.status.peak * 100)));
  const db = audio.status.peak > 0 ? Math.max(-60, Math.round(20 * Math.log10(audio.status.peak))) : -60;
  const lit = inputActive ? Math.round(level / 100 * SEGMENTS) : 0;

  const stopAll = () => {
    camera.stop();
    if (screenActive) screen.stop();
    void audio.act({ type: "stopAll" });
  };
  const toggle = (key: keyof AudioProcessing) => (checked: boolean) => {
    const next = { ...processing, [key]: checked };
    setProcessing(next);
    saveAudioProcessing(next);
  };

  return <div className="device-settings">
    {callDevices}
    {inCall && <div className="notice"><Headphones size={19} /><p>Chamada em andamento. Os testes locais de áudio ficam disponíveis ao sair da sala de voz.</p></div>}

    <section aria-labelledby="audio-test-title">
      <h2 id="audio-test-title" className="settings-section-title">Teste de áudio</h2>
      {!audio.available && <div className="notice"><Monitor size={19} /><div><strong>Abra o app no Windows para testar o áudio.</strong><p>Esta prévia mostra a interface. A seleção de entradas e saídas usa o motor nativo do aplicativo.</p></div></div>}
      {audio.error && <div className="error-banner" role="alert"><Activity size={18} /><div><strong>Não foi possível concluir o teste de áudio</strong><p>{audio.error}</p><small>Verifique a conexão e o acesso ao microfone para aplicativos da área de trabalho nas configurações de privacidade do sistema.</small></div></div>}
      <div className="field-grid">
        <DeviceSelect id="microphone" label="Dispositivo de entrada" devices={audio.devices.inputs} value={audio.inputId} onChange={audio.setInputId} disabled={audioLocked || inputActive} />
        <DeviceSelect id="output" label="Dispositivo de saída" devices={audio.devices.outputs} value={audio.outputId} onChange={audio.setOutputId} disabled={audioLocked || outputActive} />
      </div>

      <div className={`test-box ${inputActive ? "is-active" : ""}`}>
        <div className="test-row">
          <button className={`button ${inputActive ? "danger" : "secondary"}`} disabled={!audio.available || !audio.inputId || audioLocked || outputActive} onClick={() => void audio.act(inputActive ? { type: "stopMicrophone" } : { type: "startMicrophone", deviceId: audio.inputId })}>
            {inputActive ? <Square size={15} /> : <Mic size={16} />}{inputActive ? "Finalizar gravação" : "Testar microfone"}
          </button>
          <div className="segment-meter" role="meter" aria-label="Nível do microfone" aria-valuemin={0} aria-valuemax={100} aria-valuenow={level}>
            {Array.from({ length: SEGMENTS }, (_, index) => <span key={index} className={index < lit ? (index >= SEGMENTS * 0.85 ? "hot" : "on") : ""} />)}
          </div>
        </div>
        <p className="test-caption"><span>{inputActive ? "Fale normalmente. Estamos ouvindo." : audio.status.recordingReady ? "Gravação pronta para ouvir na saída selecionada." : "Grave até 10 segundos e depois ouça sua própria voz para conferir."}</span><span className="mono">{inputActive ? `${db} dBFS · ` : ""}{audio.status.recordedSeconds.toFixed(1)} / {MAX_RECORDING_SECONDS}s</span></p>
      </div>

      <div className={`test-box ${outputActive ? "is-active" : ""}`}>
        <div className="test-row">
          <button className={`button ${outputActive ? "danger" : "secondary"}`} disabled={!audio.available || !audio.outputId || audioLocked || inputActive} onClick={() => void audio.act(outputActive ? { type: "stopOutput" } : { type: "playTone", deviceId: audio.outputId, volume: volume / 100 })}>
            {outputActive ? <Square size={15} /> : <Volume2 size={16} />}{outputActive ? "Parar áudio" : "Tocar som"}
          </button>
          <button className="button secondary" disabled={!audio.available || !audio.outputId || !audio.status.recordingReady || inputActive || outputActive || audioLocked} onClick={() => void audio.act({ type: "playRecording", deviceId: audio.outputId, volume: volume / 100 })}><Play size={15} />Ouvir gravação</button>
          <label className="inline-range" htmlFor="volume"><span>Volume do teste</span><input id="volume" type="range" min="0" max="100" step="1" value={volume} disabled={outputActive} onChange={(e) => setVolume(Number(e.target.value))} /><span className="mono">{volume}%</span></label>
        </div>
        <p className="test-caption"><span>Tom de 440 Hz por 3 segundos na saída selecionada.</span></p>
      </div>
    </section>

    {/* Push-to-talk, sensitivity and call volumes are designed but not implemented yet. */}
    <section aria-labelledby="input-mode-title">
      <h2 id="input-mode-title" className="settings-section-title">Modo de entrada <SoonTag /></h2>
      <RadioCards name="input-mode" value="voice" disabled options={[{ value: "voice", label: "Detecção de voz" }, { value: "ptt", label: "Pressionar para falar" }]} />
      <div className="field-grid">
        <div className="field"><label htmlFor="sensitivity">Sensibilidade</label><input id="sensitivity" type="range" disabled defaultValue={40} /><small>Abaixo desse nível, o microfone fica em silêncio.</small></div>
        <div className="field"><label htmlFor="call-volume">Volume de saída da chamada</label><input id="call-volume" type="range" disabled defaultValue={80} /></div>
      </div>
    </section>

    <section aria-labelledby="video-title">
      <h2 id="video-title" className="settings-section-title">Vídeo</h2>
      <div className="video-settings">
        <div className={`video-stage ${camera.live ? "is-live" : ""}`}>
          {camera.native
            ? <NativeCameraPreview active={camera.live} onError={camera.previewFailed} mirrored={mirrored} />
            : <CameraPreview stream={camera.stream} onError={camera.previewFailed} mirrored={mirrored} />}
          {!camera.live && <div className="camera-placeholder"><Avatar name={userName} size="xl" /><p>{camera.busy ? "Aceite a solicitação de acesso à câmera." : "Sua câmera aparece aqui"}</p>{camera.busy && <span role="status">Aguardando a câmera…</span>}</div>}
          <span className="tile-name">{userName}</span>
          {camera.live && <span className="video-resolution">{camera.settings.width} × {camera.settings.height}{camera.settings.frameRate ? ` · ${Math.round(camera.settings.frameRate)} fps` : ""}</span>}
        </div>
        <div className="video-controls">
          <div className="field"><label htmlFor="camera">Câmera</label><select id="camera" value={camera.deviceId} disabled={camera.busy || camera.live} onChange={(e) => camera.setDeviceId(e.target.value)}>
            {(!camera.devices.length || !camera.devices.some((d) => d.deviceId === camera.deviceId)) && <option value="">Câmera padrão</option>}
            {camera.devices.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Webcam ${index + 1} · Permissão necessária`}</option>)}
          </select></div>
          <button className={`button full ${camera.live || camera.busy ? "danger" : "secondary"}`} onClick={() => camera.live || camera.busy ? camera.stop() : void camera.start()}>
            {camera.live || camera.busy ? <Square size={15} /> : <Camera size={17} />}{camera.busy ? "Cancelar teste" : camera.live ? "Desligar câmera" : "Testar câmera"}
          </button>
          <label className="checkbox-label"><input type="checkbox" checked={mirrored} onChange={(e) => setMirrored(e.target.checked)} />Espelhar prévia</label>
          {camera.error && <p className="inline-error" role="alert">{camera.error}</p>}
          <p className="field-help">A câmera só é ativada quando você inicia o teste.</p>
        </div>
      </div>
    </section>

    <ScreenShareTest screen={screen} />

    <section aria-labelledby="processing-title">
      <h2 id="processing-title" className="settings-section-title">Processamento de áudio</h2>
      <div className="switch-list">
        <Switch id="noise" label="Supressão de ruído" description="Tira teclado, ventilador e barulho de fundo" checked={processing.noiseSuppression} onChange={toggle("noiseSuppression")} />
        <Switch id="echo" label="Cancelamento de eco" description="Evita que sua voz volte pelos alto-falantes" checked={processing.echoCancellation} onChange={toggle("echoCancellation")} />
        <Switch id="gain" label="Ganho automático" description="Ajusta o volume do microfone sozinho" checked={processing.autoGainControl} onChange={toggle("autoGainControl")} />
      </div>
      <p className="field-help">{inCall ? "As mudanças valem a partir da próxima vez que você entrar em uma sala." : "Aplicado ao entrar em uma sala de voz."}</p>
    </section>

    <div className="settings-footer">
      <button className="button secondary" disabled={audio.refreshing || audio.busy} onClick={() => { void audio.refresh(); void camera.refresh(); }}>
        <RefreshCw size={15} className={audio.refreshing ? "spin" : ""} />{audio.refreshing ? "Buscando…" : "Atualizar dispositivos"}
      </button>
      <span role="status"><span className={`status-dot ${active ? "ok" : ""}`} />{active ? "Teste em andamento" : "Nenhum teste em andamento"}</span>
      <button className="link-button" disabled={!active || audio.busy} onClick={stopAll}><Square size={12} />Encerrar todos os testes</button>
    </div>
    <p className="privacy-note"><ShieldCheck size={13} />Os testes de áudio e vídeo acontecem só no seu dispositivo.</p>
  </div>;
}
