import { useEffect, useRef, useState } from "react";
import { Cloud, Download, FileText, RefreshCw, Trash2, X } from "lucide-react";
import type { CloudFile, FileGallery } from "@disc-voice/shared";
import { api, mediaUrl, message } from "../lib/api";
import { downloadFile, isImage } from "../lib/files";
import { fileSize, MediaViewer, type Media } from "./MessageContent";

type Filter = "all" | "images" | "other";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "images", label: "Imagens" },
  { value: "other", label: "Outros arquivos" },
];

function sentAt(value: string) {
  return new Date(value).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
}

/** The user's files in the cloud, in a drawer: see the space used, download and delete. */
export function FilesDrawer({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [gallery, setGallery] = useState<FileGallery | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Media | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal?.();
    return () => dialog?.close?.();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api.files(controller.signal)
      .then(setGallery)
      .catch(cause => { if (!controller.signal.aborted) setError(message(cause)); });
    return () => controller.abort();
  }, [reload]);

  async function remove(file: CloudFile) {
    setDeleting(file.id);
    setError("");
    try {
      await api.deleteFile(file.id);
      setGallery(current => current && { ...current, used: Math.max(0, current.used - file.size), files: current.files.filter(f => f.id !== file.id) });
      setConfirming(null);
    } catch (cause) { setError(message(cause)); }
    finally { setDeleting(null); }
  }

  const files = (gallery?.files || []).filter(file => filter === "all" || (filter === "images") === isImage(file.contentType));
  const used = gallery?.used || 0;
  const quota = gallery?.quota || 1;
  const percent = Math.min(100, (used / quota) * 100);
  return <dialog ref={ref} className="files-drawer" aria-labelledby="files-title"
    onCancel={event => { event.preventDefault(); if (!viewing) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header className="files-drawer-header">
      <span className="files-drawer-icon"><Cloud size={20} /></span>
      <div><h2 id="files-title">Seus arquivos</h2><p>Tudo o que você enviou nos chats. Apague o que não precisa mais para liberar espaço.</p></div>
      <button type="button" className="icon-button" aria-label="Fechar" title="Fechar (Esc)" onClick={onClose}><X size={20} /></button>
    </header>

    <section className="files-usage" aria-label="Espaço na nuvem">
      <div><strong>{fileSize(used)}</strong><span> de {fileSize(gallery?.quota || 1024 ** 3)} usados</span></div>
      <div className={`usage-bar ${percent >= 90 ? "full" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label="Espaço usado">
        <span style={{ width: `${percent}%` }} />
      </div>
      <small>Até {fileSize(gallery?.maxFileSize || 15 * 1024 ** 2)} por arquivo.</small>
    </section>

    <div className="files-filters" role="radiogroup" aria-label="Mostrar">
      {FILTERS.map(option => <button key={option.value} type="button" role="radio" aria-checked={filter === option.value}
        className={filter === option.value ? "selected" : ""} onClick={() => setFilter(option.value)}>{option.label}</button>)}
    </div>

    {error && <p className="chat-error files-error" role="alert">{error} <button className="link-button" onClick={() => setReload(n => n + 1)}>Tentar novamente</button></p>}
    {!gallery && !error && <p className="files-status" role="status"><RefreshCw size={16} className="spin" />Carregando seus arquivos…</p>}
    {gallery && !files.length && <div className="files-empty">
      <Cloud size={30} aria-hidden="true" />
      <p>{gallery.files.length ? "Nenhum arquivo neste filtro." : "Você ainda não enviou arquivos. Use o + ou arraste um arquivo para um chat."}</p>
    </div>}

    {files.length > 0 && <ul className="files-list" aria-label="Arquivos">
      {files.map(file => {
        const url = mediaUrl(file.url);
        const image = isImage(file.contentType);
        return <li key={file.id} className="cloud-file">
          {image
            ? <button type="button" className="cloud-thumb" aria-label={`Ver imagem ${file.name}`} onClick={() => setViewing({ url, name: file.name, kind: "image" })}>
              <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" />
            </button>
            : <span className="cloud-thumb"><FileText size={22} aria-hidden="true" /></span>}
          <span className="cloud-file-text"><strong title={file.name}>{file.name}</strong><small>{fileSize(file.size)} · {sentAt(file.createdAt)}</small></span>
          {confirming === file.id
            ? <span className="cloud-confirm">
              <span>Apagar para todos?</span>
              <button type="button" className="button danger small" disabled={deleting === file.id} onClick={() => void remove(file)}>{deleting === file.id ? "Apagando…" : "Apagar"}</button>
              <button type="button" className="button secondary small" disabled={deleting === file.id} onClick={() => setConfirming(null)}>Cancelar</button>
            </span>
            : <span className="cloud-actions">
              <button type="button" className="icon-button" aria-label={`Baixar ${file.name}`} title="Baixar" onClick={() => downloadFile(url)}><Download size={16} /></button>
              <button type="button" className="icon-button danger-icon" aria-label={`Apagar ${file.name}`} title="Apagar e liberar espaço" onClick={() => setConfirming(file.id)}><Trash2 size={16} /></button>
            </span>}
        </li>;
      })}
    </ul>}
    <p className="files-footnote">Ao apagar, o arquivo some das conversas em que foi enviado e o espaço volta para você.</p>
    {viewing && <MediaViewer media={viewing} onClose={() => setViewing(null)} />}
  </dialog>;
}
