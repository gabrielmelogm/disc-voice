import { useEffect, useRef, useState } from "react";
import { MonitorUp, X } from "lucide-react";
import {
  SCREEN_FRAME_RATES, SCREEN_QUALITIES, type ScreenFrameRate, type ScreenOptions, type ScreenQuality,
} from "../lib/voice";
import { RadioCards, Switch } from "./ui";

const FRAME_RATE_HINTS: Record<ScreenFrameRate, string> = {
  30: "textos e slides",
  60: "vídeos e jogos",
};

/**
 * Asked every time the screen is shared: quality, frame rate and whether the
 * computer's audio goes with it. Starts from the last choices; confirming
 * opens the system picker.
 */
export function ScreenShareDialog({ initial, onShare, onClose }: {
  initial: ScreenOptions;
  onShare: (options: ScreenOptions) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [quality, setQuality] = useState<ScreenQuality>(initial.quality);
  const [frameRate, setFrameRate] = useState<ScreenFrameRate>(initial.frameRate);
  const [audio, setAudio] = useState(initial.audio);

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return <dialog ref={ref} className="action-dialog screen-share-dialog" aria-labelledby="screen-share-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="dialog-heading"><h2 id="screen-share-title">Compartilhar tela</h2>
      <button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}><X size={20} /></button></div>
    <p className="lede">Depois, o sistema pergunta qual tela ou janela mostrar.</p>
    <fieldset className="dialog-fieldset">
      <legend>Qualidade</legend>
      <RadioCards name="screen-quality" value={quality} onChange={setQuality}
        options={(Object.keys(SCREEN_QUALITIES) as ScreenQuality[]).map(value => ({
          value,
          label: <span className="choice-text"><strong>{value}</strong><small>{SCREEN_QUALITIES[value].label}</small></span>,
        }))} />
    </fieldset>
    <fieldset className="dialog-fieldset">
      <legend>Taxa de quadros</legend>
      <RadioCards name="screen-frame-rate" value={String(frameRate)} onChange={value => setFrameRate(Number(value) as ScreenFrameRate)}
        options={SCREEN_FRAME_RATES.map(rate => ({
          value: String(rate),
          label: <span className="choice-text"><strong>{rate} fps</strong><small>{FRAME_RATE_HINTS[rate]}</small></span>,
        }))} />
      <p className="field-help">Qualidade e quadros maiores usam mais internet.</p>
    </fieldset>
    <Switch id="screen-share-audio" checked={audio} onChange={setAudio} label="Compartilhar o áudio do computador"
      description="O áudio da chamada fica de fora, sem eco." />
    <div className="dialog-actions">
      <button type="button" className="button secondary" onClick={onClose}>Cancelar</button>
      <button type="button" className="button primary" autoFocus onClick={() => onShare({ quality, frameRate, audio })}><MonitorUp size={16} />Escolher tela</button>
    </div>
  </dialog>;
}
