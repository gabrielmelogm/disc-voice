import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Copy, LinkIcon, MessageSquareText, Plus, Search, Volume2, X } from "lucide-react";
import type { Channel, Invite, Server } from "@disc-voice/shared";
import { api, message, parseInvite } from "../lib/api";
import { Avatar, SoonTag, Switch } from "./ui";

export type DialogMode =
  | { kind: "create" }
  | { kind: "join"; code?: string }
  | { kind: "invite"; server: Server }
  | { kind: "channel"; server: Server; channelType?: Channel["type"] };

export function ServerDialog({ mode, onClose, onServer, onChannel }: {
  mode: DialogMode;
  onClose: () => void;
  onServer: (server: Server) => void;
  onChannel: (channel: Channel) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(mode.kind === "join" ? mode.code || "" : "");
  const [invite, setInvite] = useState<Invite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [channelType, setChannelType] = useState<Channel["type"]>(mode.kind === "channel" ? mode.channelType || "text" : "text");

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    if (!(mode.kind === "join" && mode.code)) return;
    let disposed = false;
    setBusy(true);
    void Promise.resolve().then(() => api.previewInvite(parseInvite(mode.code || ""))).then(result => {
      if (!disposed) setInvite(result);
    }).catch(cause => {
      if (!disposed) setError(message(cause));
    }).finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, [mode]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (mode.kind === "create") {
        const result = await api.createServer(value.trim());
        setInvite(result);
        onServer(result.server);
      } else if (mode.kind === "channel") {
        onChannel(await api.createChannel(mode.server.id, value.trim(), channelType));
        onClose();
      } else if (mode.kind === "invite") {
        setInvite(await api.invite(mode.server.id));
      } else if (mode.kind === "join") {
        const code = parseInvite(value);
        if (!invite || invite.code.toLowerCase() !== code.toLowerCase()) {
          setInvite(await api.previewInvite(code));
        } else {
          onServer(await api.join(code));
          onClose();
        }
      }
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(invite!.url);
      setCopied(true);
      setError("");
    } catch {
      setError("Não foi possível copiar automaticamente. Selecione e copie o link abaixo.");
    }
  }

  const sharing = !!invite && (mode.kind === "create" || mode.kind === "invite");
  const title = {
    create: sharing ? "Convide seus amigos" : "Crie seu servidor",
    join: "Entrar em um servidor",
    invite: `Convidar pessoas para ${mode.kind === "invite" ? mode.server.name : ""}`,
    channel: "Criar canal",
  }[mode.kind];

  return <dialog ref={ref} className="action-dialog" aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog-heading"><h2 id="dialog-title">{title}</h2><button type="button" className="icon-button" aria-label="Fechar" disabled={busy} onClick={onClose}><X size={20} /></button></div>

    {mode.kind === "invite" && <>
      {/* Inviting friends directly needs the friends feature; layout only for now. */}
      <div className="search-field"><Search size={16} /><label className="sr-only" htmlFor="friend-search">Buscar amigos</label><input id="friend-search" className="search-input" disabled placeholder="Buscar amigos" /></div>
      <p className="dialog-empty">Convidar amigos direto pelo nome chega em breve.</p>
      <hr />
      {!invite && <form onSubmit={submit} className="stack-form">
        <h3 className="eyebrow">Ou crie um link de convite</h3>
        <div className="field-grid">
          <div className="field"><label htmlFor="invite-expiry">Expira em</label><select id="invite-expiry" disabled defaultValue="never"><option value="1h">1 hora</option><option value="1d">1 dia</option><option value="7d">7 dias</option><option value="never">Nunca</option></select></div>
          <div className="field"><label htmlFor="invite-uses">Limite de usos</label><select id="invite-uses" disabled defaultValue="0"><option value="0">Sem limite</option><option value="1">1 uso</option><option value="10">10 usos</option><option value="50">50 usos</option></select></div>
        </div>
        <Switch id="invite-temporary" disabled checked={false} label="Membro temporário" description="Sai do servidor ao desconectar" />
        <p className="field-help"><SoonTag /> Expiração, limite de usos e membro temporário ainda não estão disponíveis.</p>
        <button className="button primary full large" disabled={busy}><LinkIcon size={16} />{busy ? "Criando…" : "Criar link de convite"}</button>
      </form>}
    </>}

    {sharing ? <div className="stack-form">
      {mode.kind === "create" && <p>Compartilhe este link para entrar em <strong>{invite.server.name}</strong>.</p>}
      <div className="field"><label htmlFor="invite-link">{mode.kind === "invite" ? "Seu link de convite" : "Link de convite"}</label>
        <div className="inline-form"><input id="invite-link" readOnly value={invite.url} onFocus={e => e.target.select()} /><button className="button primary" onClick={() => void copy()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "Link copiado!" : "Copiar link"}</button></div>
        <small>O link não expira e não tem limite de usos. Quem receber pode abrir no navegador ou colar em “Entrar com convite”.</small>
      </div>
      <button className="button secondary full" onClick={onClose}>Concluir</button>
    </div> : mode.kind === "invite" ? null : <form onSubmit={submit} className="stack-form">
      <p className="lede">{mode.kind === "create" ? "Um lugar para sua comunidade. Você só precisa de um nome." : mode.kind === "channel" ? `Um novo assunto para ${mode.server.name}.` : "Cole o link que você recebeu de um amigo."}</p>
      {mode.kind === "channel" && <fieldset className="channel-type"><legend className="field-label">Tipo de canal</legend>
        <label className={channelType === "text" ? "checked" : ""}><input type="radio" name="channel-type" value="text" checked={channelType === "text"} disabled={busy} onChange={() => setChannelType("text")} /><MessageSquareText size={18} />Texto</label>
        <label className={channelType === "voice" ? "checked" : ""}><input type="radio" name="channel-type" value="voice" checked={channelType === "voice"} disabled={busy} onChange={() => setChannelType("voice")} /><Volume2 size={18} />Voz</label>
      </fieldset>}
      <div className="field">
        <label htmlFor="dialog-value">{mode.kind === "join" ? "Link ou código do convite" : mode.kind === "channel" ? "Nome do canal" : "Nome do servidor"}</label>
        <input autoFocus id="dialog-value" required disabled={busy} maxLength={mode.kind === "join" ? 2048 : mode.kind === "channel" ? 64 : 100}
          placeholder={mode.kind === "channel" ? "geral" : mode.kind === "create" ? "Meu servidor" : "https://…/?invite=…"}
          value={value} onChange={e => { setValue(e.target.value); if (mode.kind === "join") setInvite(null); }} />
        {mode.kind === "channel" && <small>Letras, números, hífens e sublinhados. O nome será salvo em minúsculas.</small>}
      </div>
      {mode.kind === "join" && invite && <div className="invite-preview"><Avatar name={invite.server.name} size="lg" square /><div><small>Você foi convidado para</small><strong>{invite.server.name}</strong></div></div>}
      <button className="button primary full large" disabled={busy || !value.trim()}>{mode.kind === "join" ? null : <Plus size={16} />}{busy ? "Aguarde…" : mode.kind === "create" ? "Criar servidor" : mode.kind === "channel" ? "Criar canal" : invite ? "Aceitar convite" : "Ver convite"}</button>
    </form>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </dialog>;
}
