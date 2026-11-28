import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, LoaderCircle, RefreshCw, X } from "lucide-react";
import { installUpdate, useUpdateState, type UpdateState } from "../lib/updater";

function progress(state: UpdateState) {
  if (!state.total) return null;
  return Math.min(100, Math.round((state.downloaded / state.total) * 100));
}

/**
 * Discreet button in the app bar when a newer version exists. It never
 * forces anything: the update starts only when the user asks for it.
 */
export function UpdateButton({ inCall, onLeaveCall }: { inCall: boolean; onLeaveCall: () => void }) {
  const state = useUpdateState();
  const [open, setOpen] = useState(false);
  if (state.status === "idle" || !state.version) return null;

  const percent = progress(state);
  const busy = state.status === "downloading" || state.status === "installing";
  const label = state.status === "downloading" ? `Baixando a versão ${state.version}${percent === null ? "" : ` (${percent}%)`}`
    : state.status === "installing" ? `Instalando a versão ${state.version}`
    : `Nova versão disponível: ${state.version}`;
  return <>
    <button className="bar-button update-button" aria-haspopup="dialog" aria-label={label} title={label} onClick={() => setOpen(true)}>
      {busy ? <LoaderCircle size={20} className="spin" /> : <ArrowDownToLine size={20} />}
      {!busy && <span className="update-dot" aria-hidden="true" />}
    </button>
    {open && <UpdateDialog state={state} inCall={inCall} onLeaveCall={onLeaveCall} onClose={() => setOpen(false)} />}
  </>;
}

/** Release notes and "Atualizar agora"; the download only starts here. */
export function UpdateDialog({ state, inCall, onLeaveCall, onClose }: {
  state: UpdateState; inCall: boolean; onLeaveCall: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const percent = progress(state);
  const busy = state.status === "downloading" || state.status === "installing";

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal?.();
    return () => dialog?.close?.();
  }, []);

  // Leaving the call happens only after the download, right before restarting.
  // The Flatpak only opens the download: the call goes on.
  const update = () => void installUpdate(() => { if (inCall) onLeaveCall(); });
  const leavesCall = inCall && !state.manual;

  return <dialog ref={ref} className="action-dialog update-dialog" aria-labelledby="update-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="dialog-heading"><h2 id="update-title">Nova versão: {state.version}</h2>
      <button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}><X size={20} /></button></div>
    {state.notes ? <div className="update-notes" aria-label="Novidades">{state.notes}</div> : <p className="lede">Correções e melhorias.</p>}

    {busy && <div className="update-progress">
      <progress max={100} value={state.status === "installing" ? 100 : percent ?? undefined} aria-label="Progresso do download" />
      <span>{state.status === "installing" ? "Instalando…" : percent === null ? "Baixando…" : `Baixando… ${percent}%`}</span>
    </div>}
    {state.status === "error" && <p className="inline-error" role="alert">{state.error || "Não foi possível atualizar."}</p>}
    {leavesCall && !busy && <p className="field-help" role="status">Você está em uma chamada. Ela continua durante o download e é encerrada só na hora de reiniciar.</p>}
    {!busy && <p className="field-help">{state.manual
      ? "O navegador baixa a nova versão (.flatpak). Abra o arquivo para atualizar o app: você continua conectado."
      : "O app reinicia sozinho na nova versão, e você continua conectado."}</p>}

    <div className="dialog-actions">
      <button type="button" className="button secondary" onClick={onClose}>{busy ? "Fechar" : "Depois"}</button>
      <button type="button" className="button primary" autoFocus disabled={busy} onClick={update}>
        {busy ? <LoaderCircle size={16} className="spin" /> : state.manual ? <ArrowDownToLine size={16} /> : <RefreshCw size={16} />}
        {state.status === "error" ? "Tentar de novo" : state.manual ? "Baixar a nova versão" : leavesCall ? "Atualizar e sair da chamada" : "Atualizar agora"}
      </button>
    </div>
  </dialog>;
}
