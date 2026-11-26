import { Maximize2, Mic, MicOff, PhoneOff } from "lucide-react";
import { exitPip } from "../lib/pip";
import type { ScreenFeed, Voice, VoiceState } from "../lib/voice";
import { NativeFramePreview } from "./NativeFramePreview";
import { StreamVideo } from "./VoiceChannel";

const ignoreFrameError = () => {};

/**
 * The floating window of picture-in-picture: someone's shared screen over
 * the whole (small, always on top) window, with the call's basic controls.
 * Dragging anywhere on the picture moves the window.
 */
export function PipView({ voice, state, screen }: {
  voice: Voice; state: VoiceState; screen: { peerId: string; feed: ScreenFeed };
}) {
  const name = state.participants.find(p => p.peerId === screen.peerId)?.user.name ?? "alguém";
  const label = `Tela de ${name}`;
  const muted = state.muted || state.deafened;
  return <section className="pip-view" aria-label="Picture-in-picture da chamada">
    <div className="pip-screen" data-tauri-drag-region>
      {"pull" in screen.feed
        ? <NativeFramePreview active pull={screen.feed.pull} label={label} onError={ignoreFrameError} />
        : <StreamVideo stream={screen.feed} label={label} />}
    </div>
    <p className="pip-label" data-tauri-drag-region>{label}</p>
    <div className="pip-controls" role="toolbar" aria-label="Controles da chamada">
      <button className={`bar-button ${muted ? "off" : ""}`} aria-pressed={state.muted}
        aria-label={state.muted ? "Ativar microfone" : "Silenciar microfone"} title={state.muted ? "Ativar microfone" : "Silenciar microfone"}
        onClick={voice.toggleMute}>{muted ? <MicOff size={18} /> : <Mic size={18} />}</button>
      <button className="bar-button danger" aria-label="Sair da chamada" title="Sair da chamada" onClick={voice.hangUp}><PhoneOff size={18} /></button>
      <button className="bar-button" aria-label="Voltar ao app" title="Voltar ao app" onClick={exitPip}><Maximize2 size={18} /></button>
    </div>
  </section>;
}
