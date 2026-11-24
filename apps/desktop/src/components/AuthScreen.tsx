import { useEffect, useRef, useState } from "react";
import { LoaderCircle, MicOff } from "lucide-react";
import type { AuthSession } from "@disc-voice/shared";
import { api, message } from "../lib/api";
import { signInWithDiscord } from "../lib/discordLogin";
import { signInWithGoogle } from "../lib/google";
import { Avatar, BrandMark, DiscordMark, GoogleMark } from "./ui";

type Provider = "discord" | "google";

export function AuthScreen({ onAuthenticated, hasInvite, notice }: {
  onAuthenticated: (session: AuthSession) => void;
  hasInvite: boolean;
  notice: string;
}) {
  const [busy, setBusy] = useState<Provider | null>(null);
  const [error, setError] = useState("");
  // Offered unless the server says the integration is not configured.
  const [discord, setDiscord] = useState(true);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    let active = true;
    api.discordAuthConfig().then(config => { if (active) setDiscord(config.enabled); }).catch(() => {});
    return () => { active = false; };
  }, []);

  async function signIn(provider: Provider) {
    if (busy) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(provider);
    setError("");
    try {
      const start = provider === "discord" ? signInWithDiscord : signInWithGoogle;
      onAuthenticated(await start(controller.signal));
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(null);
      }
    }
  }

  function cancel() {
    pending.current?.abort();
    pending.current = null;
    setBusy(null);
  }

  const waiting = <><LoaderCircle size={17} className="spin" />Continue no navegador…</>;

  return <main className="auth-page">
    <section className="auth-panel">
      <BrandMark />
      <div className="auth-form">
        <h1>Boas-vindas ao Disc Voice</h1>
        <p className="lede">{discord
          ? "Entre com o Discord para trazer sua foto, sua atividade e seus servidores, ou use sua conta Google."
          : "Entre com sua conta Google para voltar às suas comunidades, chamadas e conversas."}</p>
        {hasInvite && <div className="notice">Você tem um convite. Entre para continuar.</div>}
        {notice && <p className="notice" role="status">{notice}</p>}

        {discord && <button type="button" className="button primary full large discord-button" disabled={!!busy} onClick={() => void signIn("discord")}>
          {busy === "discord" ? waiting : <><DiscordMark />Continuar com Discord</>}
        </button>}
        <button type="button" className={`button ${discord ? "secondary" : "primary"} full large google-button`} disabled={!!busy} onClick={() => void signIn("google")}>
          {busy === "google" ? waiting : <><GoogleMark />Continuar com Google</>}
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
