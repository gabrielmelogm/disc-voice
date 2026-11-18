import { useEffect, useState } from "react";
import { LinkIcon, LoaderCircle } from "lucide-react";
import type { Invite, Server, User } from "@disc-voice/shared";
import { api, message, parseInvite } from "../lib/api";
import { Avatar, BrandMark } from "./ui";

/** Full-page invitation shown after login when the app was opened from an invite link. */
export function InvitePage({ code, user, onJoined, onDismiss, onSwitchAccount }: {
  code: string;
  user: User;
  onJoined: (server: Server) => void;
  onDismiss: () => void;
  onSwitchAccount: () => void;
}) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [invalid, setInvalid] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(() => api.previewInvite(parseInvite(code)))
      .then(result => { if (!disposed) setInvite(result); })
      .catch(cause => { if (!disposed) setInvalid(message(cause)); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [code]);

  async function accept() {
    if (!invite || joining) return;
    setJoining(true);
    setError("");
    try { onJoined(await api.join(invite.code)); }
    catch (cause) { setError(message(cause)); setJoining(false); }
  }

  return <main className="invite-page">
    <BrandMark />
    <section className="invite-card" aria-labelledby="invite-title">
      {loading ? <p role="status" className="invite-loading"><LoaderCircle size={20} className="spin" />Buscando convite…</p> : invite ? <>
        <p className="invite-from">Você recebeu um convite para entrar em</p>
        <Avatar name={invite.server.name} size="xl" square />
        <h1 id="invite-title">{invite.server.name}</h1>
        <button className="button primary full large" disabled={joining} onClick={() => void accept()}>{joining && <LoaderCircle size={17} className="spin" />}{joining ? "Entrando…" : "Aceitar convite"}</button>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <p className="invite-account"><Avatar name={user.name} size="xs" />Entrando como {user.name} <button className="link-button" disabled={joining} onClick={onSwitchAccount}>Trocar conta</button></p>
        <button className="link-button subtle" disabled={joining} onClick={onDismiss}>Agora não</button>
      </> : <>
        <span className="invite-broken"><LinkIcon size={28} /></span>
        <h1 id="invite-title">Esse convite não vale mais</h1>
        <p className="lede">{invalid || "O link expirou ou é inválido."} Peça um novo para quem te convidou.</p>
        <button className="button primary full large" onClick={onDismiss}>Ir para o Disc Voice</button>
      </>}
    </section>
  </main>;
}
