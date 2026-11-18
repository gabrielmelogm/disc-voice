import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity, Camera, Check, CircleHelp, Headphones, Mic, Monitor, MonitorUp,
  Play, RefreshCw, ShieldCheck, Square, Volume2, X,
} from "lucide-react";
import { MAX_RECORDING_SECONDS, type AudioDevice } from "@disc-voice/shared";
import { useAudio } from "./hooks/useAudio";
import { useCamera } from "./hooks/useCamera";
import { useScreenShare } from "./hooks/useScreenShare";
import { NativeCameraPreview } from "./components/NativeCameraPreview";
import { ScreenShareTest } from "./components/ScreenShareTest";

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

export function DeviceSettings({ inCall = false, callDevices }: { inCall?: boolean; callDevices?: ReactNode } = {}) {
  const audio = useAudio();
  const camera = useCamera();
  const screen = useScreenShare();
  const [volume, setVolume] = useState(35);
  const [mirrored, setMirrored] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const inputActive = audio.status.inputActive;
  const outputActive = audio.status.outputActive;
  const screenActive = screen.status === "live" || screen.status === "picking";
  const active = inputActive || outputActive || camera.live || camera.busy || screenActive;
  const audioLocked = audio.busy || audio.refreshing || inCall;
  const level = Math.min(100, Math.max(0, Math.round(audio.status.peak * 100)));
  const db = audio.status.peak > 0 ? Math.max(-60, Math.round(20 * Math.log10(audio.status.peak))) : -60;

  const stopAll = () => {
    camera.stop();
    if (screenActive) screen.stop();
    void audio.act({ type: "stopAll" });
  };

  return (
    <>
        <main id="devices">
          <div className="page-heading">
            <div><h1>Voz e vídeo</h1><p>Escolha quais dispositivos o DiscVoice deve usar nos seus testes.</p></div>
            <button className="text-button" onClick={() => setHelpOpen(true)}><CircleHelp size={16} />Guia de testes</button>
          </div>

          {callDevices}
          {inCall && <div className="notice"><Headphones size={19} /><p>Chamada em andamento. Os testes locais de áudio ficam disponíveis ao sair do canal de voz.</p></div>}
          {!audio.available && <div className="notice"><Monitor size={19} /><div><strong>Abra o app no Windows para testar o áudio.</strong><p>Esta prévia mostra a interface. A seleção de entradas e saídas usa o motor nativo do aplicativo.</p></div></div>}
          {audio.error && <div className="error-banner" role="alert"><Activity size={18} /><div><strong>Não foi possível concluir o teste de áudio</strong><p>{audio.error}</p><small>Verifique a conexão e o acesso ao microfone para aplicativos da área de trabalho nas configurações de privacidade do Windows.</small></div></div>}

          <div className="device-grid">
            <div className="audio-column">
              <div className="device-fields">
                <DeviceSelect id="microphone" label="Dispositivo de entrada" devices={audio.devices.inputs} value={audio.inputId} onChange={audio.setInputId} disabled={audioLocked || inputActive} />
                <DeviceSelect id="output" label="Dispositivo de saída" devices={audio.devices.outputs} value={audio.outputId} onChange={audio.setOutputId} disabled={audioLocked || outputActive} />
                <div className="field"><label htmlFor="camera">Câmera</label><select id="camera" value={camera.deviceId} disabled={camera.busy || camera.live} onChange={(e) => camera.setDeviceId(e.target.value)}>
                  {(!camera.devices.length || !camera.devices.some((d) => d.deviceId === camera.deviceId)) && <option value="">Câmera padrão</option>}
                  {camera.devices.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Webcam ${index + 1} · Permissão necessária`}</option>)}
                </select></div>
              </div>
              <section className={`card ${inputActive ? "card-active" : ""}`} aria-labelledby="microphone-title">
                <div className="card-heading"><div><h2 id="microphone-title">Testar microfone</h2><p>Fale para conferir o nível de entrada.</p></div>{inputActive && <span className="badge live">Gravando</span>}</div>
                <div className="meter-caption"><span>Nível de entrada</span><span className="mono">{inputActive ? `${db} dBFS` : "— dBFS"}</span></div>
                <div className="meter" role="meter" aria-label="Nível do microfone" aria-valuemin={0} aria-valuemax={100} aria-valuenow={level}>
                  <span className={level > 85 ? "hot" : ""} style={{ width: `${inputActive ? level : 0}%` }} />
                </div>
                <div className="recording-info"><span className={`dot ${inputActive ? "red" : ""}`} /><span>{inputActive ? "Fale algo. Estamos ouvindo." : audio.status.recordingReady ? "Gravação pronta para ouvir na saída abaixo." : "Grave um trecho para testar sua voz."}</span><span className="mono">{audio.status.recordedSeconds.toFixed(1)} / {MAX_RECORDING_SECONDS}s</span></div>
                <button className={`button ${inputActive ? "stop-button" : "primary"}`} disabled={!audio.available || !audio.inputId || audioLocked || outputActive} onClick={() => void audio.act(inputActive ? { type: "stopMicrophone" } : { type: "startMicrophone", deviceId: audio.inputId })}>
                  {inputActive ? <Square size={15} /> : <Mic size={16} />}{inputActive ? "Finalizar gravação" : "Testar microfone"}
                </button>
                <p className="card-footnote">A gravação termina automaticamente após 10 segundos.</p>
              </section>

              <section className={`card ${outputActive ? "card-active" : ""}`} aria-labelledby="output-title">
                <div className="card-heading"><div><h2 id="output-title">Testar saída de áudio</h2><p>Confira o som no dispositivo selecionado.</p></div>{outputActive && <span className="badge live">Reproduzindo</span>}</div>
                <div className="volume-row"><Volume2 size={17} /><label htmlFor="volume">Volume do teste</label><span className="mono">{volume}%</span></div>
                <input id="volume" type="range" min="0" max="100" step="1" value={volume} disabled={outputActive} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Volume do teste" />
                <div className="button-row">
                  <button className={`button ${outputActive ? "stop-button" : "secondary"}`} disabled={!audio.available || !audio.outputId || audioLocked || inputActive} onClick={() => void audio.act(outputActive ? { type: "stopOutput" } : { type: "playTone", deviceId: audio.outputId, volume: volume / 100 })}>
                    {outputActive ? <Square size={15} /> : <Volume2 size={16} />}{outputActive ? "Parar áudio" : "Tocar som"}
                  </button>
                  <button className="button secondary" disabled={!audio.available || !audio.outputId || !audio.status.recordingReady || inputActive || outputActive || audioLocked} onClick={() => void audio.act({ type: "playRecording", deviceId: audio.outputId, volume: volume / 100 })}><Play size={15} />Ouvir gravação</button>
                </div>
                <p className="card-footnote">Tom de 440 Hz por 3 segundos na saída selecionada.</p>
              </section>
            </div>

            <section className={`card camera-card ${camera.live ? "card-active" : ""}`} aria-labelledby="camera-title">
              <div className="card-heading"><h2 id="camera-title">Pré-visualização da câmera</h2>{camera.live && <span className="badge live">Ao vivo</span>}</div>
              <div className={`video-stage ${camera.live ? "is-live" : ""}`}>
                {camera.native
                  ? <NativeCameraPreview active={camera.live} onError={camera.previewFailed} mirrored={mirrored} />
                  : <CameraPreview stream={camera.stream} onError={camera.previewFailed} mirrored={mirrored} />}
                {!camera.live && <div className="camera-placeholder"><div className="camera-avatar" aria-hidden="true">V</div><p>{camera.busy ? "Aceite a solicitação de acesso à webcam." : "Sua câmera aparece aqui"}</p>{camera.busy && <span role="status">Aguardando a câmera…</span>}</div>}
                {camera.live && <><span className="live-label"><span className="dot red" />AO VIVO</span><span className="video-resolution">{camera.settings.width} × {camera.settings.height}</span></>}
              </div>
              {camera.error && <p className="inline-error" role="alert">{camera.error}</p>}
              <div className="camera-options"><label className="checkbox-label"><input type="checkbox" checked={mirrored} onChange={(e) => setMirrored(e.target.checked)} />Espelhar prévia</label><span>{camera.live && camera.settings.frameRate ? `${Math.round(camera.settings.frameRate)} fps` : "HD preferencial"}</span></div>
              <button className={`button ${camera.live || camera.busy ? "stop-button" : "primary"}`} onClick={() => camera.live || camera.busy ? camera.stop() : void camera.start()}>
                {camera.live || camera.busy ? <Square size={15} /> : <Camera size={17} />}{camera.busy ? "Cancelar teste" : camera.live ? "Desligar webcam" : "Testar webcam"}
              </button>
              <p className="card-footnote">A câmera só é ativada quando você inicia o teste.</p>
            </section>
          </div>

          <ScreenShareTest screen={screen} />

          <div className="page-actions">
            <button className="button secondary" disabled={audio.refreshing || audio.busy} onClick={() => { void audio.refresh(); void camera.refresh(); }}>
              <RefreshCw size={15} className={audio.refreshing ? "spin" : ""} />{audio.refreshing ? "Buscando…" : "Atualizar dispositivos"}
            </button>
            <span>As seleções são aplicadas ao iniciar cada teste.</span>
          </div>
          <div className="bottom-strip"><div role="status"><span className={`dot ${active ? "green" : ""}`} /><span>{active ? "Teste em andamento" : "Tudo pronto para testar"}</span></div><button className="text-button" disabled={!active || audio.busy} onClick={stopAll}><Square size={12} />Encerrar todos os testes</button></div>
          <footer><ShieldCheck size={13} /><span>Áudio e vídeo locais, só no seu dispositivo.</span></footer>
        </main>

      {helpOpen && <div className="modal-backdrop" onClick={() => setHelpOpen(false)}><section className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") setHelpOpen(false); }}>
        <div className="card-heading"><div className="device-icon purple"><CircleHelp size={22} /></div><h2 id="help-title">Um check rápido no seu setup</h2><button autoFocus className="icon-button" aria-label="Fechar guia" onClick={() => setHelpOpen(false)}><X size={20} /></button></div>
        <ol className="guide-list"><li><Mic size={20} /><div><strong>Teste sua voz</strong><p>Selecione o microfone, inicie o teste e fale por até 10 segundos. A barra mostra o nível capturado.</p></div></li><li><Headphones size={20} /><div><strong>Confira o que você ouve</strong><p>Escolha a saída, ajuste o volume e toque o som. Depois, ouça a gravação do microfone.</p></div></li><li><Camera size={20} /><div><strong>Veja seu enquadramento</strong><p>Inicie a webcam e permita o acesso quando solicitado. Após a permissão, os nomes das câmeras ficam disponíveis.</p></div></li><li><MonitorUp size={20} /><div><strong>Confira o que você compartilha</strong><p>Escolha a resolução e a taxa de quadros, clique em Compartilhar tela e selecione uma tela ou janela na janela do sistema.</p></div></li></ol>
        <div className="notice"><ShieldCheck size={20} /><p>Se o acesso estiver bloqueado, confira Câmera e Microfone em Configurações do Windows → Privacidade e segurança. Ative o acesso para aplicativos da área de trabalho.</p></div>
        <button className="button primary full" onClick={() => setHelpOpen(false)}><Check size={17} />Vamos testar</button>
      </section></div>}
    </>
  );
}
