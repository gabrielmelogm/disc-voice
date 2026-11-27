import { useState, type ReactNode } from "react";
import { mediaUrl } from "../lib/api";
import { initials } from "../lib/display";
import { motionSrc, useReducedMotion } from "../lib/motion";

export type Presence = "online" | "idle" | "dnd" | "offline";

export function Avatar({ name, src, still, size = "md", status, speaking = false, square = false, className = "" }: {
  name: string;
  /** Profile photo; the initials show while it is missing or fails to load. */
  src?: string | null;
  /** Still frame of a GIF photo, shown instead when the user prefers reduced motion. */
  still?: string | null;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  status?: Presence;
  speaking?: boolean;
  square?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const reduced = useReducedMotion();
  // Images kept by the API (e.g. server icons) come as `/api/files/...`.
  const shown = src ? mediaUrl(motionSrc(src, still, reduced)) : null;
  const photo = shown && failed !== shown ? shown : null;
  return <span className={`avatar avatar-${size} ${square ? "avatar-square" : ""} ${speaking ? "is-speaking" : ""} ${className}`} aria-hidden="true">
    {photo
      // Google photos refuse requests that carry a Referer from other sites.
      ? <img className="avatar-photo" src={photo} alt="" referrerPolicy="no-referrer" draggable={false} onError={() => setFailed(photo)} />
      : initials(name)}
    {status && <span className={`presence presence-${status}`} />}
  </span>;
}

export function Badge({ count, label }: { count: number; label?: string }) {
  if (count <= 0) return null;
  return <span className="count-badge" aria-label={label}>{count > 99 ? "99+" : count}</span>;
}

/** Spoken form of an unread count, matching the badge's "99+" cap. */
export function unreadLabel(count: number) {
  return count === 1 ? "1 mensagem não lida" : `${count > 99 ? "Mais de 99" : count} mensagens não lidas`;
}

export function LiveTag() {
  return <span className="live-tag"><span className="live-dot" />AO VIVO</span>;
}

/** Marks controls whose feature is designed but not implemented yet. */
export function SoonTag() {
  return <span className="soon-tag">Em breve</span>;
}

export function Switch({ id, checked, onChange, disabled, label, description }: {
  id: string;
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  label: ReactNode;
  description?: ReactNode;
}) {
  return <div className="switch-row">
    <label htmlFor={id}><strong>{label}</strong>{description && <small>{description}</small>}</label>
    <input id={id} type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} onChange={event => onChange?.(event.target.checked)} />
  </div>;
}

export function RadioCards<T extends string>({ name, value, options, onChange, disabled }: {
  name: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange?: (value: T) => void;
  disabled?: boolean;
}) {
  return <div className="radio-cards" role="radiogroup">
    {options.map(option => <label key={option.value} className={value === option.value ? "checked" : ""}>
      <input type="radio" name={name} value={option.value} checked={value === option.value} disabled={disabled} onChange={() => onChange?.(option.value)} />
      {option.label}
    </label>)}
  </div>;
}

export function GoogleMark({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>;
}

export function DiscordMark({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <path d="M20.32 4.37A19.8 19.8 0 0 0 15.4 2.84a.07.07 0 0 0-.08.04c-.21.38-.45.87-.61 1.25a18.3 18.3 0 0 0-5.49 0c-.17-.39-.41-.87-.62-1.25a.08.08 0 0 0-.08-.04 19.7 19.7 0 0 0-4.88 1.52.07.07 0 0 0-.03.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.06 19.9 19.9 0 0 0 5.99 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.23-2a.08.08 0 0 0-.04-.11 13.1 13.1 0 0 1-1.87-.89.08.08 0 0 1-.01-.13l.37-.29a.07.07 0 0 1 .08-.01c3.93 1.8 8.18 1.8 12.07 0a.07.07 0 0 1 .08.01l.37.29a.08.08 0 0 1-.01.13c-.6.35-1.22.65-1.87.89a.08.08 0 0 0-.04.11c.36.7.77 1.37 1.23 2a.08.08 0 0 0 .08.03 19.8 19.8 0 0 0 6-3.03.08.08 0 0 0 .03-.06c.5-5.18-.84-9.67-3.55-13.66a.06.06 0 0 0-.03-.03zM8.02 15.33c-1.18 0-2.16-1.09-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.33-.96 2.42-2.16 2.42zm7.97 0c-1.18 0-2.15-1.09-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.33-.95 2.42-2.16 2.42z" />
  </svg>;
}

export function BrandMark() {
  return <span className="brand-lockup"><img src="/app-icon.png" alt="" width={36} height={36} /><span>Disc Voice</span></span>;
}
