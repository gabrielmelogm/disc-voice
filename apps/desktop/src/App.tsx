import { useEffect, useRef, useState } from "react";
import {
  Activity, ArrowUpRight, AudioLines, Camera, Check, CircleHelp,
  Headphones, Mic, Monitor, Play, RefreshCw, ShieldCheck, SlidersHorizontal,
  Square, Volume2, X,
} from "lucide-react";
import { MAX_RECORDING_SECONDS, type AudioDevice } from "@disc-voice/shared";
import { useAudio } from "./hooks/useAudio";
import { useCamera } from "./hooks/useCamera";

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
  onError: () => void;
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

export function App() {
  const audio = useAudio();
  const camera = useCamera();
  const [volume, setVolume] = useState(35);
  const [mirrored, setMirrored] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const inputActive = audio.status.inputActive;
  const outputActive = audio.status.outputActive;
  const active = inputActive || outputActive || !!camera.stream || camera.busy;
  const audioLocked = audio.busy || audio.refreshing;
  const level = Math.min(100, Math.max(0, Math.round(audio.status.peak * 100)));
  const db = audio.status.peak > 0 ? Math.max(-60, Math.round(20 * Math.log10(audio.status.peak))) : -60;
  const count = audio.devices.inputs.length + audio.devices.outputs.length + camera.devices.length;

  const stopAll = () => {
    camera.stop();
    void audio.act({ type: "stopAll" });
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a href="#devices" className="brand" aria-label="Disc Voice, início">
          <span className="brand-mark"><AudioLines size={25} /></span>
          <span>disc<span className="brand-light">voice</span><small>DEVICE STUDIO</small></span>
        </a>
        <div className="workspace-label">SEU ESPAÇO</div>
        <a className="nav-item selected" href="#devices"><SlidersHorizontal size={18} /> Dispositivos <span className="nav-dot" /></a>
        <button className="nav-item" onClick={() => setHelpOpen(true)}><CircleHelp size={18} /> Guia de testes <ArrowUpRight size={14} /></button>
        <div className="sidebar-bottom">
          <div className="local-card"><ShieldCheck size={19} /><strong>Fica no seu dispositivo.</strong><p>Seus testes são locais. Nenhum áudio ou vídeo é enviado.</p></div>
          <div className="platform"><Monitor size={15} /><span>Windows desktop</span><span>v0.1</span></div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> <strong>Dispositivos</strong></div>
          <div className="environment"><span className={`dot ${audio.available ? "green" : ""}`} />{audio.available ? "Modo local" : "Prévia no navegador"}</div>
        </header>

        <main id="devices">
          <div className="page-heading">
            <div><div className="eyebrow">CHECK, CHECK. UM, DOIS.</div><h1>Seu setup, em sintonia<span>.</span></h1><p>Confira seu áudio e vídeo antes da próxima conversa.</p></div>
            <button className="button secondary refresh-button" disabled={audio.refreshing || audio.busy} onClick={() => { void audio.refresh(); void camera.refresh(); }}>
              <RefreshCw size={16} className={audio.refreshing ? "spin" : ""} />{audio.refreshing ? "Buscando…" : "Atualizar dispositivos"}
            </button>
          </div>

          {!audio.available && <div className="notice"><Monitor size={19} /><div><strong>Abra o app no Windows para testar o áudio.</strong><p>Esta prévia mostra a interface. A seleção de entradas e saídas usa o motor nativo do aplicativo.</p></div></div>}
          {audio.error && <div className="error-banner" role="alert"><Activity size={18} /><div><strong>Não foi possível concluir o teste de áudio</strong><p>{audio.error}</p><small>Verifique a conexão e o acesso ao microfone para aplicativos da área de trabalho nas configurações de privacidade do Windows.</small></div></div>}

          <div className="section-bar"><div><span className="section-indicator" /><h2>Painel de dispositivos</h2><span className="count">{count}</span></div><span className="section-note">Selecione. Teste. Conecte-se.</span></div>

          <div className="device-grid">
            <div className="audio-column">
              <section className={`card ${inputActive ? "card-active" : ""}`} aria-labelledby="microphone-title">
                <div className="card-heading"><div className="device-icon purple"><Mic size={21} /></div><div><h3 id="microphone-title">Microfone</h3><p>Faça sua voz chegar com clareza.</p></div><span className={`badge ${inputActive ? "live" : ""}`}>{inputActive ? "Gravando" : "Entrada"}</span></div>
                <DeviceSelect id="microphone" label="Dispositivo de entrada" devices={audio.devices.inputs} value={audio.inputId} onChange={audio.setInputId} disabled={audioLocked || inputActive} />
                <div className="meter-caption"><span>Nível de entrada</span><span className="mono">{inputActive ? `${db} dBFS` : "— dBFS"}</span></div>
                <div className="meter" role="meter" aria-label="Nível do microfone" aria-valuemin={0} aria-valuemax={100} aria-valuenow={level}>
                  {Array.from({ length: 40 }, (_, index) => <span key={index} className={inputActive && index < level / 2.5 ? `lit ${index > 34 ? "hot" : ""}` : ""} />)}
                </div>
                <div className="meter-legend"><span>Silêncio</span><span>Ideal</span><span>Alto</span></div>
                <div className="recording-info"><span className={`dot ${inputActive ? "red" : ""}`} /><span>{inputActive ? "Fale algo. Estamos ouvindo." : audio.status.recordingReady ? "Gravação pronta para ouvir na saída abaixo." : "Grave um trecho para testar sua voz."}</span><span className="mono">{audio.status.recordedSeconds.toFixed(1)} / {MAX_RECORDING_SECONDS}s</span></div>
                <button className={`button full ${inputActive ? "stop-button" : "primary"}`} disabled={!audio.available || !audio.inputId || audioLocked || outputActive} onClick={() => void audio.act(inputActive ? { type: "stopMicrophone" } : { type: "startMicrophone", deviceId: audio.inputId })}>
                  {inputActive ? <Square size={15} /> : <Mic size={16} />}{inputActive ? "Finalizar gravação" : "Testar microfone"}
                </button>
                <p className="card-footnote">A gravação termina automaticamente após 10 segundos.</p>
              </section>

              <section className={`card ${outputActive ? "card-active" : ""}`} aria-labelledby="output-title">
                <div className="card-heading"><div className="device-icon blue"><Headphones size={21} /></div><div><h3 id="output-title">Saída de áudio</h3><p>Ouça cada detalhe, no lugar certo.</p></div><span className={`badge ${outputActive ? "live" : ""}`}>{outputActive ? "Reproduzindo" : "Saída"}</span></div>
                <DeviceSelect id="output" label="Dispositivo de saída" devices={audio.devices.outputs} value={audio.outputId} onChange={audio.setOutputId} disabled={audioLocked || outputActive} />
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

            <section className={`card camera-card ${camera.stream ? "card-active" : ""}`} aria-labelledby="camera-title">
              <div className="card-heading"><div className="device-icon peach"><Camera size={21} /></div><div><h3 id="camera-title">Webcam</h3><p>Encontre seu melhor enquadramento.</p></div><span className={`badge ${camera.stream ? "live" : ""}`}>{camera.stream ? "Ao vivo" : "Vídeo"}</span></div>
              <div className="field"><label htmlFor="camera">Dispositivo de vídeo</label><select id="camera" value={camera.deviceId} disabled={camera.busy || !!camera.stream} onChange={(e) => camera.setDeviceId(e.target.value)}>
                {(!camera.devices.length || !camera.devices.some((d) => d.deviceId === camera.deviceId)) && <option value="">Câmera padrão</option>}
                {camera.devices.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Webcam ${index + 1} · Permissão necessária`}</option>)}
              </select></div>
              <div className={`video-stage ${camera.stream ? "is-live" : ""}`}>
                <CameraPreview stream={camera.stream} onError={camera.previewFailed} mirrored={mirrored} />
                {!camera.stream && <div className="camera-placeholder"><div className="camera-orbit"><Camera size={31} strokeWidth={1.4} /></div><strong>{camera.busy ? "Aguardando a câmera…" : "Sua câmera, quando você quiser."}</strong><p>{camera.busy ? "Aceite a solicitação de acesso à webcam." : "Inicie o teste para ver a prévia ao vivo."}</p><span className="private-label"><ShieldCheck size={13} /> Prévia local e privada</span></div>}
                {camera.stream && <><span className="live-label"><span className="dot red" />AO VIVO</span><span className="video-resolution">{camera.settings.width} × {camera.settings.height}</span></>}
                <span className="viewfinder top-left" /><span className="viewfinder top-right" /><span className="viewfinder bottom-left" /><span className="viewfinder bottom-right" />
              </div>
              {camera.error && <p className="inline-error" role="alert">{camera.error}</p>}
              <div className="camera-options"><label className="checkbox-label"><input type="checkbox" checked={mirrored} onChange={(e) => setMirrored(e.target.checked)} />Espelhar prévia</label><span>{camera.stream && camera.settings.frameRate ? `${Math.round(camera.settings.frameRate)} fps` : "HD preferencial"}</span></div>
              <button className={`button full ${camera.stream || camera.busy ? "stop-button" : "primary"}`} onClick={() => camera.stream || camera.busy ? camera.stop() : void camera.start()}>
                {camera.stream || camera.busy ? <Square size={15} /> : <Camera size={17} />}{camera.busy ? "Cancelar teste" : camera.stream ? "Desligar webcam" : "Testar webcam"}
              </button>
              <p className="card-footnote">A câmera só é ativada quando você inicia o teste.</p>
              <div className="camera-tip"><span className="tip-icon">↗</span><div><strong>Uma boa conversa começa com um bom setup.</strong><p>Posicione a câmera na altura dos olhos e procure uma fonte de luz à sua frente.</p></div></div>
            </section>
          </div>

          <div className="bottom-strip"><div><span className={`dot ${active ? "green" : ""}`} /><span>{active ? "Teste em andamento" : "Tudo no seu tempo. Inicie um teste acima."}</span></div><button className="text-button" disabled={!active || audio.busy} onClick={stopAll}><Square size={12} />Encerrar todos os testes</button></div>
          <footer><span>Feito para você se conectar melhor.</span><span><ShieldCheck size={13} />100% local <span className="footer-dot">·</span> Áudio via WASAPI</span></footer>
        </main>
      </div>

      {helpOpen && <div className="modal-backdrop" onClick={() => setHelpOpen(false)}><section className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") setHelpOpen(false); }}>
        <div className="card-heading"><div className="device-icon purple"><CircleHelp size={22} /></div><h2 id="help-title">Um check rápido no seu setup</h2><button autoFocus className="icon-button" aria-label="Fechar guia" onClick={() => setHelpOpen(false)}><X size={20} /></button></div>
        <ol className="guide-list"><li><Mic size={20} /><div><strong>Teste sua voz</strong><p>Selecione o microfone, inicie o teste e fale por até 10 segundos. A barra mostra o nível capturado.</p></div></li><li><Headphones size={20} /><div><strong>Confira o que você ouve</strong><p>Escolha a saída, ajuste o volume e toque o som. Depois, ouça a gravação do microfone.</p></div></li><li><Camera size={20} /><div><strong>Veja seu enquadramento</strong><p>Inicie a webcam e permita o acesso quando solicitado. Após a permissão, os nomes das câmeras ficam disponíveis.</p></div></li></ol>
        <div className="notice"><ShieldCheck size={20} /><p>Se o acesso estiver bloqueado, confira Câmera e Microfone em Configurações do Windows → Privacidade e segurança. Ative o acesso para aplicativos da área de trabalho.</p></div>
        <button className="button primary full" onClick={() => setHelpOpen(false)}><Check size={17} />Vamos testar</button>
      </section></div>}
    </div>
  );
}
