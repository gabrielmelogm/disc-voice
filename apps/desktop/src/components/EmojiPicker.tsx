import { useEffect, useRef, useState } from "react";
import { Clock, Search, X } from "lucide-react";
import { EMOJI_CATEGORIES, recentEmoji, rememberEmoji, searchEmoji } from "../lib/emoji";

/**
 * Emoji to insert in the composer or react with: search in Portuguese,
 * categories and the ones used lately. Closes on Escape or a click outside.
 */
export function EmojiPicker({ onPick, onClose, label = "Escolher um emoji", className = "" }: {
  onPick: (emoji: string) => void;
  onClose: () => void;
  label?: string;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [recent] = useState(recentEmoji);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    input.current?.focus();
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [onClose]);

  function pick(emoji: string) {
    rememberEmoji(emoji);
    onPick(emoji);
  }

  const results = query.trim() ? searchEmoji(query) : null;
  const grid = (emojis: string[]) => <div className="emoji-grid">
    {emojis.map(emoji => <button key={emoji} type="button" className="emoji-cell" aria-label={emoji} title={emoji} onClick={() => pick(emoji)}>{emoji}</button>)}
  </div>;
  const sections = [
    ...(recent.length ? [{ id: "recent", label: "Usados recentemente", icon: <Clock size={16} aria-hidden="true" />, emojis: recent }] : []),
    ...EMOJI_CATEGORIES.map(category => ({ id: category.id, label: category.label, icon: category.icon, emojis: category.emojis.map(e => e.emoji) })),
  ];

  return <div ref={root} className={`emoji-picker ${className}`} role="dialog" aria-label={label}
    onKeyDown={event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }}>
    <header>
      <label className="gif-search">
        <Search size={16} aria-hidden="true" />
        <span className="sr-only">Buscar emoji</span>
        <input ref={input} type="search" placeholder="Buscar emoji" maxLength={40} value={query} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            // Inside the composer's form: Enter picks the first result instead of sending.
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (results?.[0]) pick(results[0].emoji);
          }} />
      </label>
      <button type="button" className="icon-button" aria-label="Fechar" title="Fechar (Esc)" onClick={onClose}><X size={18} /></button>
    </header>
    {!results && <nav className="emoji-tabs" aria-label="Categorias de emoji">
      {sections.map(section => <button key={section.id} type="button" className="emoji-tab" title={section.label} aria-label={section.label}
        onClick={() => list.current?.querySelector(`[data-section="${section.id}"]`)?.scrollIntoView?.({ block: "start" })}>{section.icon}</button>)}
    </nav>}
    <div ref={list} className="emoji-results">
      {results
        ? results.length ? grid(results.map(e => e.emoji)) : <p className="gif-status" role="status">Nenhum emoji encontrado.</p>
        : sections.map(section => <section key={section.id} data-section={section.id} aria-label={section.label}>
          <p className="gif-heading">{section.label}</p>
          {grid(section.emojis)}
        </section>)}
    </div>
  </div>;
}
