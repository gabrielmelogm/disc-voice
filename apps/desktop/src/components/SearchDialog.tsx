import { useEffect, useRef, useState, type ReactNode } from "react";
import { LoaderCircle, MessageSquareText, Search, Volume2 } from "lucide-react";
import type { ChannelHit, MessageHit, SearchResults, User } from "@disc-voice/shared";
import { api, message } from "../lib/api";
import { messageTime } from "../lib/display";
import { Avatar } from "./ui";

export type SearchPick =
  | { kind: "channel"; channel: ChannelHit }
  | { kind: "person"; user: User }
  | { kind: "message"; message: MessageHit };

const DEBOUNCE_MS = 200;

/** Marks the searched words inside a result. */
export function highlight(text: string, query: string): ReactNode {
  const words = query.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return text;
  const pattern = new RegExp(`(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu");
  return text.split(pattern).map((part, i) => i % 2 ? <mark key={i}>{part}</mark> : part);
}

/** Global search (Ctrl+K): channels, people and messages from the user's servers. */
export function SearchDialog({ onClose, onPick }: { onClose: () => void; onPick: (pick: SearchPick) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const searched = useRef("");

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    const q = query.trim();
    setError("");
    if (!q) { setResults(null); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      void api.search(q, undefined, controller.signal).then(page => {
        searched.current = q;
        setResults(page);
        setActive(0);
      }).catch(cause => { if (!controller.signal.aborted) setError(message(cause)); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  async function loadMore() {
    if (!results?.nextCursor || more) return;
    setMore(true);
    try {
      const page = await api.search(searched.current, results.nextCursor);
      setResults(current => current && { ...current, messages: [...current.messages, ...page.messages], nextCursor: page.nextCursor });
    } catch (cause) { setError(message(cause)); }
    finally { setMore(false); }
  }

  const picks: SearchPick[] = results ? [
    ...results.channels.map(channel => ({ kind: "channel" as const, channel })),
    ...results.people.map(user => ({ kind: "person" as const, user })),
    ...results.messages.map(item => ({ kind: "message" as const, message: item })),
  ] : [];
  const choose = (pick: SearchPick) => { onPick(pick); onClose(); };
  const optionId = (index: number) => `search-result-${index}`;
  const option = (index: number, content: ReactNode, label: string) => {
    const pick = picks[index];
    return <button key={optionId(index)} id={optionId(index)} role="option" aria-selected={index === active} aria-label={label} tabIndex={-1}
      onMouseMove={() => setActive(index)} onClick={() => choose(pick)}>{content}</button>;
  };
  let index = 0;
  const q = searched.current;

  return <dialog ref={ref} className="search-dialog" aria-label="Buscar" onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}
    onClick={event => { if (event.target === ref.current) onClose(); }}>
    <div className="search-field">
      <Search size={18} />
      <input className="search-input" autoFocus role="combobox" aria-label="Buscar mensagens, pessoas e canais" placeholder="Buscar mensagens, pessoas e canais"
        aria-expanded={picks.length > 0} aria-controls="search-results" aria-activedescendant={picks.length ? optionId(active) : undefined}
        value={query} maxLength={100} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!picks.length) return;
            const next = (active + (event.key === "ArrowDown" ? 1 : -1) + picks.length) % picks.length;
            setActive(next);
            document.getElementById(optionId(next))?.scrollIntoView?.({ block: "nearest" });
          } else if (event.key === "Enter" && picks[active]) {
            event.preventDefault();
            choose(picks[active]);
          }
        }} />
      <kbd>Esc</kbd>
    </div>
    <div id="search-results" className="search-results" role="listbox" aria-label="Resultados" aria-busy={loading}>
      {error && <p className="inline-error search-status" role="alert">{error}</p>}
      {!query.trim() && <p className="search-status">Digite para buscar canais e salas, pessoas dos seus servidores e mensagens.</p>}
      {query.trim() && loading && !results && <p className="search-status" role="status"><LoaderCircle size={18} className="spin" /> Buscando…</p>}
      {results && !picks.length && !loading && <p className="search-status" role="status">Nada encontrado para “{q}”.</p>}

      {!!results?.channels.length && <div role="group" aria-label="Canais e salas"><h3 className="eyebrow">Canais e salas</h3>
        {results.channels.map(channel => option(index++, <>
          <span className="search-icon">{channel.type === "voice" ? <Volume2 size={16} /> : <MessageSquareText size={16} />}</span>
          <div><strong>{highlight(channel.name, q)}</strong><small>{channel.type === "voice" ? "Sala de voz" : "Canal de texto"} · {channel.serverName}</small></div>
        </>, `${channel.type === "voice" ? "Sala" : "Canal"} ${channel.name} em ${channel.serverName}`))}
      </div>}

      {!!results?.people.length && <div role="group" aria-label="Pessoas"><h3 className="eyebrow">Pessoas</h3>
        {results.people.map(user => option(index++, <>
          <Avatar name={user.name} size="sm" />
          <div><strong>{highlight(user.name, q)}</strong>{user.pronouns && <small>{user.pronouns}</small>}</div>
        </>, `Perfil de ${user.name}`))}
      </div>}

      {!!results?.messages.length && <div role="group" aria-label="Mensagens"><h3 className="eyebrow">Mensagens</h3>
        {results.messages.map(item => option(index++, <>
          <Avatar name={item.author.name} size="sm" />
          <div>
            <small><strong>{item.author.name}</strong> em #{item.channelName} · {item.serverName} · {messageTime(item.createdAt)}</small>
            <span className="result-snippet">{highlight(item.content, q)}</span>
          </div>
        </>, `Mensagem de ${item.author.name} em ${item.channelName}: ${item.content}`))}
      </div>}
      {results?.nextCursor && <button className="button secondary small search-more" disabled={more} onClick={() => void loadMore()}>{more ? "Carregando…" : "Mais mensagens"}</button>}
    </div>
  </dialog>;
}
