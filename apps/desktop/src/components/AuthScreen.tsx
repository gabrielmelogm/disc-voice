import { useEffect, useRef, useState } from "react";
import { LoaderCircle, MicOff } from "lucide-react";
import type { AuthSession } from "@disc-voice/shared";
import { message } from "../lib/api";
import { signInWithGoogle } from "../lib/google";
import { Avatar, BrandMark, GoogleMark } from "./ui";

export function AuthScreen({ onAuthenticated, hasInvite, notice }: {
  onAuthenticated: (session: AuthSession) => void;
  hasInvite: boolean;
  notice: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);

  useEffect(() => () => pending.current?.abort(), []);

  async function signIn() {
    if (busy) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    try {
      onAuthenticated(await signInWithGoogle(controller.signal));
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  function cancel() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
  }

  return <main className="auth-page">
    <section className="auth-panel">
      <BrandMark />
      <div className="auth-form">
        <h1>Boas-vindas ao Disc Voice</h1>
        <p className="lede">Entre com sua conta Google para voltar às suas comunidades, chamadas e conversas.</p>
        {hasInvite && <div className="notice">Você tem um convite. Entre para continuar.</div>}
        {notice && <p className="notice" role="status">{notice}</p>}

        <button type="button" className="button primary full large google-button" disabled={busy} onClick={() => void signIn()}>
          {busy ? <LoaderCircle size={17} className="spin" /> : <GoogleMark />}
          {busy ? "Continue no navegador…" : "Continuar com Google"}
        </button>
        {busy && <button type="button" className="link-button" onClick={cancel}>Cancelar</button>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        <p className="auth-switch">Primeira vez por aqui? Sua conta é criada no primeiro acesso.</p>
      </div>
    </section>

    <section className="auth-showcase" aria-hidden="true">
      <div className="showcase">
        <div className="showcase-call">
          <div className="showcase-tile is-speaking"><Avatar name="Ana Souza" size="xl" /><span className="tile-name">Ana Souza</span></div>
          <div className="showcase-tile"><Avatar name="Diego Rocha" size="xl" /><span className="tile-name"><MicOff size={13} />Diego Rocha</span></div>
        </div>
        <div className="showcase-message">
          <Avatar name="Carla Mendes" />
          <div><p><strong>Carla Mendes</strong><time>Hoje às 10:04</time></p><p>Bora começar a call em 5 min?</p></div>
        </div>
        <h2>Voz, vídeo e chat no mesmo lugar</h2>
        <p>Crie canais para o seu time ou comunidade e entre numa chamada com um clique.</p>
      </div>
    </section>
  </main>;
}
