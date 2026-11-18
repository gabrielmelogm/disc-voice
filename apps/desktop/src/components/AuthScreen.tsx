import { useState, type FormEvent } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
import type { AuthSession } from "@disc-voice/shared";
import { api, message } from "../lib/api";

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
    <section className="auth-intro">
      <img src="/app-icon.png" alt="" width={92} height={92} />
      <span className="eyebrow">DISCVOICE</span>
      <h1>Seu espaço.<br />Sua comunidade.</h1>
      <p>Crie um servidor, convide seus amigos e tenha um lugar para se encontrar.</p>
      <div className="auth-decoration" aria-hidden="true"><span># geral</span><span># boas-vindas</span><span># seus-assuntos</span></div>
    </section>
    <section className="auth-card">
      <h2>{register ? "Crie sua conta" : "Bom ter você de volta!"}</h2>
      <p>{register ? "Comece com seu nome, e-mail e uma senha." : "Entre para acessar seus servidores."}</p>
      {hasInvite && <div className="notice">Você tem um convite. Entre ou cadastre-se para continuar.</div>}
      {notice && <p className="notice" role="status">{notice}</p>}
      <form onSubmit={submit} className="stack-form">
        {register && <div className="field"><label htmlFor="name">Nome</label><input id="name" autoComplete="name" required maxLength={32} value={name} disabled={busy} onChange={e => setName(e.target.value)} /></div>}
        <div className="field"><label htmlFor="email">E-mail</label><input id="email" type="email" autoComplete="email" required maxLength={254} value={email} disabled={busy} onChange={e => setEmail(e.target.value)} /></div>
        <div className="field"><label htmlFor="password">Senha</label><input id="password" type="password" autoComplete={register ? "new-password" : "current-password"} required minLength={8} maxLength={128} value={password} disabled={busy} onChange={e => setPassword(e.target.value)} aria-describedby={register ? "password-help" : undefined} />{register && <small id="password-help">Use pelo menos 8 caracteres.</small>}</div>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <button className="button primary full" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : <ArrowRight size={17} />}{busy ? "Aguarde…" : register ? "Criar conta" : "Entrar"}</button>
      </form>
      <p className="auth-switch">{register ? "Já tem uma conta?" : "Primeira vez por aqui?"} <button className="text-button" disabled={busy} onClick={() => { setRegister(!register); setError(""); }}>{register ? "Fazer login" : "Cadastre-se"}</button></p>
    </section>
  </main>;
}
