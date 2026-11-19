import { useState, type ReactNode } from "react";
import { initials } from "../lib/display";

export type Presence = "online" | "idle" | "dnd" | "offline";

export function Avatar({ name, src, size = "md", status, speaking = false, square = false, className = "" }: {
  name: string;
  /** Profile photo; the initials show while it is missing or fails to load. */
  src?: string | null;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  status?: Presence;
  speaking?: boolean;
  square?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const photo = src && failed !== src ? src : null;
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
  options: { value: T; label: string }[];
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

export function BrandMark() {
  return <span className="brand-lockup"><img src="/app-icon.png" alt="" width={36} height={36} /><span>Disc Voice</span></span>;
}
