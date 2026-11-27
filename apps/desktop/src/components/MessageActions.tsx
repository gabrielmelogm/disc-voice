import { type ReactNode, useEffect, useRef } from "react";
import { AtSign, Pencil, SmilePlus, Trash2 } from "lucide-react";
import type { ChatMessage, Reaction, User } from "@disc-voice/shared";
import { QUICK_REACTIONS } from "../lib/emoji";
import { EVERYONE_NAME, mentionText } from "../lib/mentions";
import { Avatar } from "./ui";

/** Reactions after the user adds (or removes) theirs, before the API answers. */
export function applyReaction(reactions: Reaction[] = [], emoji: string, userId: string, add: boolean): Reaction[] {
  const existing = reactions.find(r => r.emoji === emoji);
  if (add) {
    if (existing?.users.includes(userId)) return reactions;
    return existing
      ? reactions.map(r => r === existing ? { ...r, count: r.count + 1, users: [...r.users, userId] } : r)
      : [...reactions, { emoji, count: 1, users: [userId] }];
  }
  if (!existing?.users.includes(userId)) return reactions;
  return reactions.flatMap(r => r !== existing ? [r]
    : r.count > 1 ? [{ ...r, count: r.count - 1, users: r.users.filter(id => id !== userId) }] : []);
}

/** "Ana, Bruno e mais 2 reagiram com 🔥". */
export function reactionLabel(reaction: Reaction, names: Record<string, string>, selfId?: string) {
  const people = reaction.users.map(id => id === selfId ? "Você" : names[id] || "Alguém");
  const shown = people.slice(0, 3);
  const rest = people.length - shown.length;
  const list = rest > 0 ? `${shown.join(", ")} e mais ${rest}` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} e ${shown.at(-1)}` : shown[0];
  return `${list} ${people.length > 1 ? "reagiram" : "reagiu"} com ${reaction.emoji}`;
}

/** The emoji on a message: a count each, highlighted where the user reacted. */
export function Reactions({ reactions, names, selfId, onToggle, onAdd }: {
  reactions: Reaction[];
  names: Record<string, string>;
  selfId?: string;
  onToggle: (emoji: string, add: boolean) => void;
  onAdd: () => void;
}) {
  return <div className="reactions" role="group" aria-label="Reações">
    {reactions.map(reaction => {
      const mine = !!selfId && reaction.users.includes(selfId);
      const label = reactionLabel(reaction, names, selfId);
      return <button key={reaction.emoji} type="button" className={`reaction ${mine ? "mine" : ""}`} aria-pressed={mine} disabled={!selfId}
        title={label} aria-label={`${label}. ${mine ? "Remover sua reação" : "Reagir também"}`} onClick={() => onToggle(reaction.emoji, !mine)}>
        <span className="reaction-emoji" aria-hidden="true">{reaction.emoji}</span><span className="reaction-count">{reaction.count}</span>
      </button>;
    })}
    {selfId && <button type="button" className="reaction add-reaction" aria-label="Adicionar reação" title="Adicionar reação" onClick={onAdd}><SmilePlus size={16} /></button>}
  </div>;
}

/** Shown over a message on hover or focus: quick reactions, and editing or deleting one's own. */
export function MessageToolbar({ own, onReact, onPicker, onEdit, onDelete }: {
  own: boolean;
  onReact: (emoji: string) => void;
  onPicker: () => void;
  onEdit: () => void;
  onDelete: (immediately: boolean) => void;
}) {
  return <div className="message-toolbar" role="toolbar" aria-label="Ações da mensagem">
    {QUICK_REACTIONS.map(emoji => <button key={emoji} type="button" className="icon-button" aria-label={`Reagir com ${emoji}`} title={`Reagir com ${emoji}`}
      onClick={() => onReact(emoji)}>{emoji}</button>)}
    <button type="button" className="icon-button" aria-label="Adicionar reação" title="Adicionar reação" onClick={onPicker}><SmilePlus size={17} /></button>
    {own && <>
      <button type="button" className="icon-button" aria-label="Editar mensagem" title="Editar" onClick={onEdit}><Pencil size={16} /></button>
      <button type="button" className="icon-button danger" aria-label="Excluir mensagem" title="Excluir (Shift+clique exclui sem perguntar)"
        onClick={event => onDelete(event.shiftKey)}><Trash2 size={16} /></button>
    </>}
  </div>;
}

/** Asks before deleting a message for everyone. */
export function DeleteMessageDialog({ message, busy, error, onConfirm, onClose }: {
  message: ChatMessage;
  busy: boolean;
  error: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const text = mentionText(message.content, message.mentions).replace(/\s+/g, " ").trim();
  return <dialog ref={ref} className="action-dialog" aria-labelledby="delete-message-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="dialog-heading"><h2 id="delete-message-title">Excluir mensagem</h2></div>
    <p className="lede">A mensagem some para todo mundo, com as reações. Não dá para desfazer.</p>
    <blockquote className="delete-preview">
      <Avatar name={message.author.name} src={message.author.avatar} still={message.author.avatarStill} size="sm" />
      <span>{text || (message.attachments?.length ? "Anexo" : "Mensagem sem texto")}</span>
    </blockquote>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button type="button" className="button secondary" onClick={onClose}>Cancelar</button>
      <button type="button" className="button danger" autoFocus disabled={busy} onClick={onConfirm}><Trash2 size={16} />{busy ? "Excluindo…" : "Excluir"}</button>
    </div>
  </dialog>;
}

/** People matching the `@` being typed; the composer handles the keys. */
export function MentionSuggestions({ people, everyone = false, active, empty, onPick, onHover }: {
  people: User[];
  /** Offers `@everyone` first. */
  everyone?: boolean;
  /** Index among the options, `@everyone` included. */
  active: number;
  /** Shown when nobody matches. */
  empty?: string;
  onPick: (name: string) => void;
  onHover: (index: number) => void;
}) {
  const shift = everyone ? 1 : 0;
  const option = (id: string, index: number, name: string, content: ReactNode, label = name) =>
    <div key={id} id={`mention-${id}`} role="option" aria-selected={index === active} aria-label={label}
      className={`mention-option ${index === active ? "active" : ""}`}
      // Keeps the focus in the composer.
      onPointerDown={event => event.preventDefault()}
      onPointerEnter={() => onHover(index)} onClick={() => onPick(name)}>
      {content}
    </div>;
  return <div className="mention-suggestions" role="listbox" id="mention-suggestions" aria-label="Mencionar alguém">
    <p className="gif-heading">Mencionar</p>
    {everyone && option(EVERYONE_NAME, 0, EVERYONE_NAME, <>
      <span className="mention-everyone-icon" aria-hidden="true"><AtSign size={14} /></span>
      <strong>@{EVERYONE_NAME}</strong><span className="mention-hint">Todos do servidor</span>
    </>, `@${EVERYONE_NAME}, todos do servidor`)}
    {people.map((person, index) => option(person.id, index + shift, person.name, <>
      <Avatar name={person.name} src={person.avatar} still={person.avatarStill} size="xs" />
      <strong>{person.name}</strong>
    </>))}
    {!everyone && !people.length && empty && <p className="mention-empty">{empty}</p>}
  </div>;
}
