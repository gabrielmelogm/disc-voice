import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Download, Headphones, LogIn, Plus, Search, X } from "lucide-react";
import type { Server } from "@disc-voice/shared";
import { api } from "../lib/api";
import { normalize } from "./Members";
import { Avatar, Badge, unreadLabel } from "./ui";

/** Avatar colors, in turn down the list ("EN" purple, "CL" green, "DB" yellow, "JS" red…). */
const TONES = ["brand", "green", "yellow", "red"] as const;

const number = (count: number) => count.toLocaleString("pt-BR");

/** "1 servidor", "8 servidores". */
export function serverCount(count: number) {
  return count === 1 ? "1 servidor" : `${number(count)} servidores`;
}

/** "1 membro", "1.204 membros". */
export function memberCount(count: number) {
  return count === 1 ? "1 membro" : `${number(count)} membros`;
}

/**
 * Every server the user is in, as a grid: open one, see who is around, and
 * create, join or import another. The drawer on the left searches by name.
 */
export function ServersDialog({ servers, currentId, callServerId, unread = {}, onClose, onOpen, onCreate, onJoin, onImport }: {
  servers: Server[];
  /** The server on screen, marked "Você está aqui". */
  currentId?: string;
  /** The server of the user's call, whose icon carries the headphones badge. */
  callServerId?: string;
  /** Unread messages per server id. */
  unread?: Record<string, number>;
  onClose: () => void;
  onOpen: (server: Server) => void;
  onCreate: () => void;
  onJoin: () => void;
  onImport: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [drawer, setDrawer] = useState(true);
  const [query, setQuery] = useState("");
  // Fresh member and online counts; the list in the app may be older.
  const [counts, setCounts] = useState<Record<string, Pick<Server, "memberCount" | "onlineCount">>>({});
  // Importing needs the Discord integration, which the API may have turned off.
  const [discord, setDiscord] = useState(true);

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal?.();
    // Opening the dialog focuses its first button; the search goes first.
    input.current?.focus();
    return () => dialog?.close?.();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api.servers(controller.signal)
      .then(list => setCounts(Object.fromEntries(list.map(s => [s.id, { memberCount: s.memberCount, onlineCount: s.onlineCount }]))))
      // The counts are a nicety: the grid works without them.
      .catch(() => {});
    api.discord(controller.signal).then(status => setDiscord(status.enabled !== false)).catch(() => {});
    return () => controller.abort();
  }, []);

  const tones = useMemo(() => Object.fromEntries(servers.map((s, index) => [s.id, TONES[index % TONES.length]])), [servers]);
  const q = normalize(query);
  const shown = q ? servers.filter(s => normalize(s.name).includes(q)) : servers;

  function openDrawer() {
    setDrawer(true);
    // The field mounts with the drawer; focus it right after.
    requestAnimationFrame(() => input.current?.focus());
  }

  function closeDrawer() {
    setQuery("");
    setDrawer(false);
    toggle.current?.focus();
  }

  function clearSearch() {
    setQuery("");
    input.current?.focus();
  }

  /** Esc clears the search; with the field empty, it closes the drawer. */
  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape") return;
    // Keep the dialog open: this Esc belongs to the field.
    event.preventDefault();
    event.stopPropagation();
    if (query) setQuery("");
    else closeDrawer();
  }

  const pick = (action: () => void) => () => { onClose(); action(); };
  const subtitle = !q ? serverCount(servers.length)
    : shown.length ? `${shown.length} de ${serverCount(servers.length)}` : "Nenhum resultado";

  return <dialog ref={ref} className="servers-dialog" aria-labelledby="servers-title" aria-describedby="servers-count"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className={`servers-shell ${drawer ? "with-drawer" : ""}`}>
      {drawer && <aside className="servers-drawer" aria-label="Buscar servidores">
        <div className="servers-drawer-heading">
          <h3 className="eyebrow">Buscar servidores</h3>
          <button type="button" className="icon-button small" aria-label="Fechar busca" onClick={closeDrawer}><X size={16} /></button>
        </div>
        <div className="search-field servers-search">
          <Search size={16} />
          <label className="sr-only" htmlFor="servers-search">Buscar servidores pelo nome</label>
          <input ref={input} id="servers-search" className="search-input" autoFocus placeholder="Buscar" autoComplete="off" aria-describedby="servers-search-hint"
            value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onSearchKey} />
          {query && <button type="button" className="icon-button small search-clear" aria-label="Limpar busca" onClick={clearSearch}><X size={14} /></button>}
        </div>
        <p id="servers-search-hint" className="servers-hint">Esc limpa a busca; com o campo vazio, fecha.</p>
        <h3 className="eyebrow servers-drawer-section">Adicionar</h3>
        <button type="button" className="settings-link" onClick={pick(onCreate)}><Plus size={16} />Criar servidor</button>
        <button type="button" className="settings-link" onClick={pick(onJoin)}><LogIn size={16} />Entrar com convite</button>
        {discord && <button type="button" className="settings-link" onClick={pick(onImport)}><Download size={16} />Importar do Discord</button>}
      </aside>}

      <section className="servers-main">
        <header className="servers-heading">
          <div>
            <h2 id="servers-title">Seus servidores</h2>
            <p id="servers-count" aria-live="polite">{subtitle}</p>
          </div>
          <button ref={toggle} type="button" className={`icon-button servers-toggle ${drawer ? "active" : ""}`} aria-pressed={drawer}
            aria-label={drawer ? "Fechar busca de servidores" : "Buscar servidores"} title="Buscar servidores"
            onClick={() => (drawer ? closeDrawer() : openDrawer())}><Search size={18} /></button>
          <button type="button" className="icon-button servers-close" aria-label="Fechar" onClick={onClose}><X size={18} /></button>
        </header>

        {q && !shown.length ? <div className="servers-empty">
          <span className="servers-empty-icon"><Search size={20} /></span>
          <h3>Nenhum servidor com “{query.trim()}”</h3>
          <p>Confira se o nome está certo. Se o servidor ainda não é seu, entre com um convite.</p>
          <div className="button-row">
            <button type="button" className="button secondary small" onClick={clearSearch}>Limpar busca</button>
            <button type="button" className="button primary small" onClick={pick(onJoin)}>Entrar com convite</button>
          </div>
        </div> : <ul className="servers-grid" aria-label="Seus servidores">
          {shown.map(server => {
            const here = server.id === currentId;
            const calling = server.id === callServerId;
            const members = counts[server.id]?.memberCount ?? server.memberCount;
            const online = counts[server.id]?.onlineCount ?? server.onlineCount;
            const unreadCount = unread[server.id] || 0;
            const details = [here && "você está aqui", calling && "em chamada", unreadCount > 0 && unreadLabel(unreadCount)].filter(Boolean).join(", ");
            return <li key={server.id}>
              <button type="button" className={`server-card ${here ? "current" : ""}`} aria-current={here ? "true" : undefined}
                aria-label={`Abrir ${server.name}${details ? `, ${details}` : ""}`} onClick={pick(() => onOpen(server))}>
                <span className="server-card-top">
                  <span className={`server-card-avatar tone-${tones[server.id]}`}>
                    <Avatar name={server.name} src={server.icon} size="sm" />
                    {calling && <span className="server-card-call" aria-hidden="true"><Headphones size={10} strokeWidth={3} /></span>}
                  </span>
                  {here ? <span className="here-tag">Você está aqui</span> : <Badge count={unreadCount} />}
                </span>
                <strong className="server-card-name">{server.name}</strong>
                {members !== undefined && <small className="server-card-meta">
                  <span>{memberCount(members)}</span>
                  {online !== undefined && <><span aria-hidden="true">·</span><span className="status-dot ok" /><span>{`${number(online)} online`}</span></>}
                </small>}
              </button>
            </li>;
          })}
          {!q && <li>
            <button type="button" className="server-card add-card" onClick={pick(onCreate)}>
              <span className="add-card-icon"><Plus size={18} /></span>
              Criar ou entrar em um servidor
            </button>
          </li>}
        </ul>}
      </section>
    </div>
  </dialog>;
}
