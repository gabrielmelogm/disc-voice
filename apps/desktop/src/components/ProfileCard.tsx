import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { BannerColor, User } from "@disc-voice/shared";
import { Avatar } from "./ui";

export const BANNER_COLORS: { id: BannerColor; name: string; value: string }[] = [
  { id: "brand", name: "Roxo", value: "var(--brand)" },
  { id: "green", name: "Verde", value: "#157a3f" },
  { id: "amber", name: "Âmbar", value: "#8a5a00" },
  { id: "red", name: "Vermelho", value: "#c11f2d" },
  { id: "graphite", name: "Grafite", value: "#4f4b5c" },
];

export function bannerColor(banner: BannerColor | undefined) {
  return (BANNER_COLORS.find(color => color.id === banner) || BANNER_COLORS[0]).value;
}

/** Banner, avatar, name, pronouns and "Sobre mim". */
export function ProfileSummary({ user, subtitle }: { user: User; subtitle?: string }) {
  return <>
    <div className="profile-banner" style={{ background: bannerColor(user.banner) }} />
    <Avatar name={user.name} src={user.avatar} size="xl" status="online" className="profile-avatar" />
    <strong>{user.name}</strong>
    {(subtitle ?? user.pronouns) && <span>{subtitle ?? user.pronouns}</span>}
    <div className="detail-card"><h3 className="eyebrow">Sobre mim</h3><p className="profile-bio">{user.bio || "Ainda não escreveu nada por aqui."}</p></div>
  </>;
}

type Open = (user: User, anchor: HTMLElement) => void;
const ProfileContext = createContext<Open>(() => {});

/** Opens a user's profile card next to the clicked element. */
export const useProfileCard = () => useContext(ProfileContext);

/**
 * Hosts the profile card. `profiles` holds the latest known version of each
 * user, so a card opened from an old message still shows the current profile.
 */
export function ProfileCardProvider({ profiles, children }: { profiles: Record<string, User>; children: ReactNode }) {
  const [open, setOpen] = useState<{ user: User; anchor: HTMLElement } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  return <ProfileContext.Provider value={(user, anchor) => setOpen({ user, anchor })}>
    {children}
    {open && <ProfilePopover user={profiles[open.user.id] || open.user} anchor={open.anchor} onClose={close} />}
  </ProfileContext.Provider>;
}

function ProfilePopover({ user, anchor, onClose }: { user: User; anchor: HTMLElement; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const card = ref.current!.getBoundingClientRect();
    const target = anchor.getBoundingClientRect();
    const margin = 12;
    // Beside the anchor when it fits, otherwise on its left; always on screen.
    let left = target.right + margin;
    if (left + card.width > window.innerWidth - margin) left = target.left - card.width - margin;
    left = Math.max(margin, Math.min(left, window.innerWidth - card.width - margin));
    const top = Math.max(margin, Math.min(target.top, window.innerHeight - card.height - margin));
    setPosition({ left, top });
  }, [anchor, user]);

  useEffect(() => {
    ref.current?.focus();
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
      if (anchor.isConnected) anchor.focus();
    };
  }, [anchor, onClose]);

  return <div ref={ref} className="profile-preview profile-card" role="dialog" aria-label={`Perfil de ${user.name}`} tabIndex={-1}
    style={position ? { left: position.left, top: position.top } : { visibility: "hidden" }}>
    <ProfileSummary user={user} />
  </div>;
}

/** A user's name that opens their profile card. */
export function ProfileButton({ user, className = "", children, title }: { user: User; className?: string; children?: ReactNode; title?: string }) {
  const open = useProfileCard();
  return <button type="button" className={`profile-trigger ${className}`} title={title} aria-haspopup="dialog"
    onClick={event => open(user, event.currentTarget)}>{children ?? user.name}</button>;
}
