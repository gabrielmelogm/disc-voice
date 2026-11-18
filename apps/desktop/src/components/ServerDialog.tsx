import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Copy, Hash, Plus, X } from "lucide-react";
import type { Channel, Invite, Server } from "@disc-voice/shared";
import { api, message, parseInvite } from "../lib/api";
import { initials } from "../lib/display";

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
    if (mode.kind !== "invite" && !(mode.kind === "join" && mode.code)) return;
    let disposed = false;
    setBusy(true);
    const load = mode.kind === "invite"
      ? () => api.invite(mode.server.id)
      : () => api.previewInvite(parseInvite(mode.code || ""));
    void Promise.resolve().then(load).then(result => {
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
  const title = sharing ? "Convide seus amigos" : {
    create: "Crie seu servidor",
    join: "Entre em um servidor",
    invite: "Convide seus amigos",
    channel: "Criar canal",
  }[mode.kind];

  return <dialog ref={ref} className="action-dialog" aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="card-heading"><h2 id="dialog-title">{title}</h2><button type="button" className="icon-button" aria-label="Fechar" disabled={busy} onClick={onClose}><X size={20} /></button></div>
    {sharing ? <div className="stack-form">
      <p>Compartilhe este link para entrar em <strong>{invite.server.name}</strong>.</p>
      <div className="field"><label htmlFor="invite-link">Link de convite</label><input id="invite-link" readOnly value={invite.url} onFocus={e => e.target.select()} /></div>
      <button className="button primary full" onClick={() => void copy()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "Link copiado!" : "Copiar link"}</button>
      <p className="card-footnote">Quem receber pode abrir no navegador ou colar em “Entrar em servidor” no aplicativo.</p>
      <button className="button secondary full" onClick={onClose}>Concluir</button>
    </div> : mode.kind === "invite" ? <p role="status">{busy ? "Buscando convite…" : "Não foi possível carregar o convite. Feche e tente novamente."}</p> : <form onSubmit={submit} className="stack-form">
      <p>{mode.kind === "create" ? "Um lugar para sua comunidade. Você só precisa de um nome." : mode.kind === "channel" ? `Um novo assunto para ${mode.server.name}.` : "Cole o link que você recebeu de um amigo."}</p>
      {mode.kind === "channel" && <fieldset className="channel-type"><legend>Tipo de canal</legend>
        <label><input type="radio" name="channel-type" value="text" checked={channelType === "text"} disabled={busy} onChange={() => setChannelType("text")} /> Texto</label>
        <label><input type="radio" name="channel-type" value="voice" checked={channelType === "voice"} disabled={busy} onChange={() => setChannelType("voice")} /> Voz</label>
      </fieldset>}
      <div className="field">
        <label htmlFor="dialog-value">{mode.kind === "join" ? "Link ou código do convite" : mode.kind === "channel" ? "Nome do canal" : "Nome do servidor"}</label>
        <input autoFocus id="dialog-value" required disabled={busy} maxLength={mode.kind === "join" ? 2048 : mode.kind === "channel" ? 64 : 100}
          placeholder={mode.kind === "channel" ? "geral" : mode.kind === "create" ? "Meu servidor" : "https://…/?invite=…"}
          value={value} onChange={e => { setValue(e.target.value); if (mode.kind === "join") setInvite(null); }} />
        {mode.kind === "channel" && <small>Letras, números, hífens e sublinhados. O nome será salvo em minúsculas.</small>}
      </div>
      {mode.kind === "join" && invite && <div className="invite-preview"><span className="server-avatar">{initials(invite.server.name)}</span><div><small>Você foi convidado para</small><strong>{invite.server.name}</strong></div></div>}
      <button className="button primary full" disabled={busy || !value.trim()}>{mode.kind === "channel" ? <Hash size={16} /> : <Plus size={16} />}{busy ? "Aguarde…" : mode.kind === "create" ? "Criar servidor" : mode.kind === "channel" ? "Criar canal" : invite ? "Aceitar convite" : "Ver convite"}</button>
    </form>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </dialog>;
}
