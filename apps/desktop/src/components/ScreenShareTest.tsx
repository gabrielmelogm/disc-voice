import { useCallback, useState } from "react";
import { MonitorUp, Square } from "lucide-react";
import type { ScreenSourceKind } from "@disc-voice/shared";
import type { ScreenShareController } from "../hooks/useScreenShare";
import { nativeScreen } from "../lib/nativeScreen";
import { NativeFramePreview, type FrameStats } from "./NativeFramePreview";

export const RESOLUTIONS = [
  { id: "720p", label: "720p · 1280 × 720", width: 1280, height: 720 },
  { id: "1080p", label: "1080p · 1920 × 1080", width: 1920, height: 1080 },
  { id: "1440p", label: "1440p · 2560 × 1440", width: 2560, height: 1440 },
] as const;

export const FRAME_RATES = [15, 30, 60] as const;

const SOURCE_NAMES: Record<ScreenSourceKind, string> = {
  monitor: "Tela inteira",
  window: "Janela",
  virtual: "Tela virtual",
  unknown: "Fonte do sistema",
};

/**
 * Local screen-share test: the system picker chooses what to share and the
 * frames the native engine produces are drawn here, nothing is sent.
 */
export function ScreenShareTest({ screen }: { screen: ScreenShareController }) {
  const [resolution, setResolution] = useState<(typeof RESOLUTIONS)[number]["id"]>("720p");
  const [frameRate, setFrameRate] = useState<number>(30);
  const [cursor, setCursor] = useState(true);
  const [stats, setStats] = useState<FrameStats | null>(null);
  const { status, info } = screen;
  const live = status === "live";
  const picking = status === "picking";
  const available = status !== "unavailable" && status !== "pending";
  const locked = !available || live || picking;

  const onStats = useCallback((next: FrameStats) => setStats(next), []);

  const start = () => {
    const size = RESOLUTIONS.find((option) => option.id === resolution) ?? RESOLUTIONS[0];
    setStats(null);
    void screen.start({ maxWidth: size.width, maxHeight: size.height, frameRate, cursor });
  };

  return (
    <section aria-labelledby="screen-title">
      <h2 id="screen-title" className="settings-section-title">Compartilhamento de tela {live && <span className="status-chip">Compartilhando</span>}</h2>
      <p className="field-help">Escolha uma tela ou janela e veja como ela seria transmitida. Nada sai do seu dispositivo neste teste.</p>
      {status === "unavailable" && <p className="inline-error">O compartilhamento de tela está disponível somente no aplicativo para Windows e Linux.</p>}
      <div className="video-settings">
        <div className={`video-stage screen-stage ${live ? "is-live" : ""}`}>
          <NativeFramePreview active={live} pull={nativeScreen.frame} label="Prévia do compartilhamento de tela" onError={screen.previewFailed} onStats={onStats} />
          {!live && <div className="camera-placeholder"><MonitorUp size={36} aria-hidden="true" /><p>{picking ? "Escolha uma tela ou janela na janela do sistema." : "Sua tela aparece aqui"}</p>{picking && <span role="status">Aguardando a escolha…</span>}</div>}
          {live && <span className="tile-name"><span className="live-dot" />AO VIVO</span>}
        </div>
        <div className="video-controls">
          <div className="field"><label htmlFor="screen-resolution">Resolução máxima</label>
            <select id="screen-resolution" value={resolution} disabled={locked} onChange={(e) => setResolution(e.target.value as typeof resolution)}>
              {RESOLUTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="screen-fps">Taxa de quadros</label>
            <select id="screen-fps" value={frameRate} disabled={locked} onChange={(e) => setFrameRate(Number(e.target.value))}>
              {FRAME_RATES.map((rate) => <option key={rate} value={rate}>{rate} fps</option>)}
            </select>
          </div>
          <label className="checkbox-label"><input type="checkbox" checked={cursor} disabled={locked} onChange={(e) => setCursor(e.target.checked)} />Mostrar o cursor do mouse</label>
          <button className={`button full ${live || picking ? "danger" : "secondary"}`} disabled={!available} onClick={() => (live || picking ? screen.stop() : start())}>
            {live || picking ? <Square size={15} /> : <MonitorUp size={16} />}{picking ? "Cancelar" : live ? "Parar compartilhamento" : "Compartilhar tela"}
          </button>
          {live && info && (
            <dl className="screen-details" aria-label="Detalhes do compartilhamento">
              <div><dt>Fonte</dt><dd>{SOURCE_NAMES[info.source]}{info.width ? ` · ${info.width} × ${info.height}` : ""}</dd></div>
              <div><dt>Prévia</dt><dd className="mono">{stats?.width ? `${stats.width} × ${stats.height}` : "—"}</dd></div>
              <div><dt>Quadros</dt><dd className="mono">{stats ? `${stats.fps} fps` : "—"} / até {info.frameRate}</dd></div>
            </dl>
          )}
          <p className="field-help">O sistema pergunta o que compartilhar. Uma tela parada envia menos quadros.</p>
          {screen.error && <p className="inline-error" role="alert">{screen.error}</p>}
        </div>
      </div>
    </section>
  );
}
