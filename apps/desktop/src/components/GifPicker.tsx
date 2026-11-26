import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Pause, Play, Search, X } from "lucide-react";
import type { Gif, GifChoice } from "@disc-voice/shared";
import { api, ApiError, message } from "../lib/api";
import { motionSrc, useReducedMotion } from "../lib/motion";

/** Waits for a pause in typing before searching. */
const SEARCH_DELAY = 350;

export function gifChoice(gif: Gif): GifChoice {
  return { slug: gif.slug, title: gif.title, url: gif.url, still: gif.still, width: gif.width, height: gif.height };
}

/** Errors from the API in the picker's words. */
function gifError(error: unknown) {
  if (error instanceof ApiError && error.status === 429) return "Muitas buscas de GIF em pouco tempo. Espere um minuto e tente de novo.";
  if (error instanceof ApiError && error.status === 503) return "Os GIFs não estão disponíveis neste servidor.";
  return message(error);
}

/**
 * An animated image that respects reduced motion: it then shows its still frame
 * with a button to play it.
 */
export function GifImage({ url, still, alt, className = "", onError, onOpen, openLabel }: {
  url: string; still?: string | null; alt: string; className?: string; onError?: () => void;
  /** Makes the image a button (e.g. to enlarge it); the play toggle stays separate. */
  onOpen?: () => void; openLabel?: string;
}) {
  const reduced = useReducedMotion();
  const [playing, setPlaying] = useState(false);
  const paused = reduced && !!still && !playing;
  const image = <img src={motionSrc(url, still, paused)} alt={onOpen ? "" : alt} loading="lazy" referrerPolicy="no-referrer" draggable={false} onError={onError} />;
  return <span className={`gif-image ${className}`}>
    {onOpen ? <button type="button" className="gif-open" aria-label={openLabel || alt} onClick={onOpen}>{image}</button> : image}
    {reduced && still && <button type="button" className="gif-play" aria-pressed={playing} aria-label={playing ? `Pausar ${alt}` : `Reproduzir ${alt}`}
      title={playing ? "Pausar" : "Reproduzir"} onClick={event => { event.stopPropagation(); setPlaying(!playing); }}>
      {playing ? <Pause size={14} /> : <Play size={14} />}
    </button>}
  </span>;
}

/** Klipy's attribution, shown wherever its GIFs are picked. */
export function KlipyAttribution() {
  return <span className="klipy-attribution">GIFs por <strong>KLIPY</strong></span>;
}

/**
 * Search and trending GIFs from Klipy, with a preview before using one.
 * `confirmLabel` names the action ("Enviar", "Usar como avatar"...).
 */
export function GifPicker({ onPick, onClose, confirmLabel = "Enviar", className = "", label = "Escolher um GIF" }: {
  onPick: (gif: GifChoice) => void;
  onClose: () => void;
  confirmLabel?: string;
  className?: string;
  label?: string;
}) {
  const reduced = useReducedMotion();
  const [query, setQuery] = useState("");
  // Together, so a new search always starts at the first page.
  const [{ search, page }, setRequest] = useState({ search: "", page: 1 });
  const [results, setResults] = useState<Gif[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<Gif | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const next = query.trim().split(/\s+/).filter(Boolean).join(" ");
    const timer = window.setTimeout(() => setRequest(current => current.search === next ? current : { search: next, page: 1 }), next ? SEARCH_DELAY : 0);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api.gifs(search, page, controller.signal)
      .then(result => {
        setResults(current => page === 1 ? result.results : [...current, ...result.results.filter(gif => !current.some(c => c.id === gif.id))]);
        setHasNext(result.hasNext);
      })
      .catch(cause => { if (!controller.signal.aborted) setError(gifError(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [search, page, retry]);

  useEffect(() => {
    input.current?.focus();
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [onClose]);

  useEffect(() => { if (selected) confirm.current?.focus(); else input.current?.focus(); }, [selected]);

  const empty = !loading && !error && !results.length;
  return <div ref={root} className={`gif-picker ${className}`} role="dialog" aria-label={label}
    onKeyDown={event => {
      if (event.key !== "Escape") return;
      // Only the picker closes, not a dialog around it.
      event.preventDefault();
      event.stopPropagation();
      if (selected) setSelected(null); else onClose();
    }}>
    {selected ? <div className="gif-preview">
      <header>
        <button type="button" className="icon-button" aria-label="Voltar para os resultados" title="Voltar" onClick={() => setSelected(null)}><ArrowLeft size={18} /></button>
        <strong title={selected.title}>{selected.title || "GIF"}</strong>
        <button type="button" className="icon-button" aria-label="Fechar" title="Fechar" onClick={onClose}><X size={18} /></button>
      </header>
      <GifImage url={selected.url} still={selected.still} alt={selected.title || "GIF selecionado"} className="gif-preview-image" />
      <div className="button-row">
        <button ref={confirm} type="button" className="button primary small" onClick={() => onPick(gifChoice(selected))}>{confirmLabel}</button>
        <button type="button" className="button secondary small" onClick={() => setSelected(null)}>Escolher outro</button>
      </div>
    </div> : <>
      <header>
        <label className="gif-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Buscar GIFs no Klipy</span>
          <input ref={input} type="search" placeholder="Buscar GIFs no Klipy" maxLength={100} value={query} onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              // The picker sits inside forms (composer, profile): Enter searches now instead of submitting them.
              if (event.key !== "Enter") return;
              event.preventDefault();
              const next = query.trim().split(/\s+/).filter(Boolean).join(" ");
              setRequest(current => current.search === next ? current : { search: next, page: 1 });
            }} />
        </label>
        <button type="button" className="icon-button" aria-label="Fechar" title="Fechar (Esc)" onClick={onClose}><X size={18} /></button>
      </header>
      <p className="gif-heading">{search ? `Resultados para “${search}”` : "Em alta"}</p>
      <div className="gif-results" aria-busy={loading}>
        {error && <div className="gif-status" role="alert"><p>{error}</p><button type="button" className="link-button" onClick={() => setRetry(n => n + 1)}>Tentar novamente</button></div>}
        {empty && <p className="gif-status" role="status">Nenhum GIF encontrado. Tente outras palavras.</p>}
        {!!results.length && <ul className="gif-grid">
          {results.map(gif => <li key={gif.id}>
            <button type="button" className="gif-tile" title={gif.title || undefined} aria-label={gif.title ? `GIF: ${gif.title}` : "GIF sem título"} onClick={() => setSelected(gif)}>
              <img src={motionSrc(gif.thumbnail, gif.still, reduced)} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} />
            </button>
          </li>)}
        </ul>}
        {loading && <p className="gif-status" role="status">Carregando GIFs…</p>}
        {hasNext && !loading && !error && <button type="button" className="button secondary small gif-more" onClick={() => setRequest(current => ({ ...current, page: current.page + 1 }))}>Carregar mais</button>}
      </div>
    </>}
    <footer><KlipyAttribution /></footer>
  </div>;
}
