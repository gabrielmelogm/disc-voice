import { useState, type FormEvent } from "react";
import { LoaderCircle, MicOff } from "lucide-react";
import type { AuthSession } from "@disc-voice/shared";
import { api, message } from "../lib/api";
import { Avatar, BrandMark, GoogleMark, SoonTag } from "./ui";

export function AuthScreen({ onAuthenticated, hasInvite, notice }: {
  onAuthenticated: (session: AuthSession) => void;
  hasInvite: boolean;
  notice: string;
}) {
  const [register, setRegister] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const session = await (register ? api.register(name, email, password) : api.login(email, password));
      onAuthenticated(session);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-page">
    <section className="auth-panel">
      <BrandMark />
      <div className="auth-form">
        <h1>{register ? "Crie sua conta" : "Boas-vindas ao Disc Voice"}</h1>
        <p className="lede">{register ? "Comece com seu nome, e-mail e uma senha." : "Entre para voltar às suas comunidades, chamadas e conversas."}</p>
        {hasInvite && <div className="notice">Você tem um convite. Entre ou cadastre-se para continuar.</div>}
        {notice && <p className="notice" role="status">{notice}</p>}

        {/* Google Sign-In is tracked in issue #7. */}
        <button type="button" className="button secondary full google-button" disabled title="Login com Google em breve"><GoogleMark />Continuar com Google<SoonTag /></button>
        <div className="divider"><span>ou use seu e-mail</span></div>

        <form onSubmit={submit} className="stack-form">
          {register && <div className="field"><label htmlFor="name">Nome</label><input id="name" autoComplete="name" required maxLength={32} value={name} disabled={busy} onChange={e => setName(e.target.value)} /><small>É o nome que aparece nas mensagens e chamadas.</small></div>}
          <div className="field"><label htmlFor="email">E-mail</label><input id="email" type="email" autoComplete="email" placeholder="voce@exemplo.com" required maxLength={254} value={email} disabled={busy} onChange={e => setEmail(e.target.value)} /></div>
          <div className="field"><label htmlFor="password">Senha</label><input id="password" type="password" autoComplete={register ? "new-password" : "current-password"} required minLength={8} maxLength={128} value={password} disabled={busy} onChange={e => setPassword(e.target.value)} aria-describedby={register ? "password-help" : undefined} />{register && <small id="password-help">Use pelo menos 8 caracteres.</small>}</div>
          {error && <p className="inline-error" role="alert">{error}</p>}
          <button className="button primary full large" disabled={busy}>{busy && <LoaderCircle size={17} className="spin" />}{busy ? "Aguarde…" : register ? "Criar conta" : "Entrar"}</button>
        </form>
        <p className="auth-switch">{register ? "Já tem uma conta?" : "Primeira vez por aqui?"} <button className="link-button" disabled={busy} onClick={() => { setRegister(!register); setError(""); }}>{register ? "Fazer login" : "Cadastre-se"}</button></p>
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
