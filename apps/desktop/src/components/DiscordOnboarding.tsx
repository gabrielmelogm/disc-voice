import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { DiscordAccount, Server, User } from "@disc-voice/shared";
import { api, message } from "../lib/api";
import type { Realtime } from "../lib/realtime";
import { DiscordGuildPicker } from "./DiscordGuildPicker";
import { Avatar, DiscordMark, Switch } from "./ui";

/**
 * Right after signing in with Discord: asks what the integration may use
 * (photo, activity), then offers to import the user's Discord servers.
 */
export function DiscordOnboarding({ account, user, realtime, onServer, onOpen, onUserChange, onDone }: {
  account: DiscordAccount;
  user: User;
  realtime?: Realtime;
  onServer: (server: Server) => void;
  onOpen: (serverId: string) => void;
  onUserChange: (user: User) => void;
  onDone: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<"profile" | "servers">("profile");
  const [useAvatar, setUseAvatar] = useState(true);
  const [shareActivity, setShareActivity] = useState(true);
  // Discord doesn't share the "About me" with apps: the user pastes it here.
  const [bio, setBio] = useState(user.bio || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = account.displayName || account.username;
  const bioChanged = bio.trim() !== (user.bio || "").trim();

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  async function answer(choices: { useAvatar: boolean; shareActivity: boolean }, next: "servers" | "close") {
    setBusy(true);
    setError("");
    try {
      // The bio first: if it is refused, the user can fix it and try again.
      if (next === "servers" && bioChanged) onUserChange(await api.updateProfile({ bio }));
      await api.discordConsent(choices);
      if (next === "close") onDone();
      else setStep("servers");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  // Closing before answering counts as "no" to both, so it isn't asked again.
  const dismiss = () => {
    if (busy) return;
    if (step === "profile") void answer({ useAvatar: false, shareActivity: false }, "close");
    else onDone();
  };

  return <dialog ref={ref} className="action-dialog discord-dialog" aria-labelledby="onboarding-title" onCancel={event => { event.preventDefault(); dismiss(); }}>
    <div className="dialog-heading">
      <h2 id="onboarding-title">{step === "profile" ? "Integrar seu perfil do Discord" : "Importar servidores do Discord?"}</h2>
      <button type="button" className="icon-button" aria-label="Fechar" disabled={busy} onClick={dismiss}><X size={20} /></button>
    </div>

    {step === "profile" ? <div className="stack-form">
      <div className="connection-identity">
        <Avatar name={name} src={account.avatar} size="lg" />
        <div><strong>{name}</strong><span>@{account.username}</span></div>
        <DiscordMark size={22} />
      </div>
      <p className="lede">Você entrou com o Discord. Escolha o que o Disc Voice pode usar da sua conta; dá para mudar depois em Configurações › Conexões.</p>
      <div className="switch-list">
        <Switch id="onboarding-avatar" checked={useAvatar} disabled={busy} onChange={setUseAvatar}
          label="Usar minha foto do Discord" description="Sua foto de perfil do Discord vira a sua foto aqui." />
        <Switch id="onboarding-activity" checked={shareActivity} disabled={busy} onChange={setShareActivity}
          label="Mostrar minha atividade do Discord" description="Quem está nos seus servidores vê o jogo, a música ou o vídeo do seu status do Discord." />
      </div>
      <div className="field"><label htmlFor="onboarding-bio">Sobre mim</label>
        <textarea id="onboarding-bio" rows={3} maxLength={190} disabled={busy} value={bio} aria-describedby="onboarding-bio-help"
          placeholder="Cole aqui o “Sobre mim” do seu perfil do Discord" onChange={e => setBio(e.target.value)} />
        <small id="onboarding-bio-help">O Discord não compartilha a descrição do perfil com outros apps, então copie e cole se quiser a mesma. {[...bio].length}/190</small>
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <button className="button primary full large" disabled={busy} onClick={() => void answer({ useAvatar, shareActivity }, "servers")}>{busy ? "Salvando…" : "Continuar"}</button>
    </div> : <div className="stack-form">
      <p className="lede">Traga os servidores que você gerencia no Discord, com nome, ícone e canais de texto e voz. As mensagens antigas podem ser importadas depois, canal por canal.</p>
      <DiscordGuildPicker realtime={realtime} onServer={onServer} onOpen={id => { onOpen(id); onDone(); }} />
      <button className="button secondary full" onClick={onDone}>Agora não</button>
    </div>}
  </dialog>;
}
