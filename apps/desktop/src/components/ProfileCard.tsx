import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Gamepad2, MessageCircle } from "lucide-react";
import type { Activity, BannerColor, User } from "@disc-voice/shared";
import { activityDetail, activityLabel } from "../lib/activity";
import { motionSrc, useReducedMotion } from "../lib/motion";
import { Avatar } from "./ui";

const ActivityContext = createContext<Record<string, Activity>>({});

/** What a user is doing right now, if they share it. */
export const useActivity = (userId: string): Activity | undefined => useContext(ActivityContext)[userId];

export function ActivityLine({ activity }: { activity: Activity }) {
  const detail = activityDetail(activity);
  const [broken, setBroken] = useState<string | null>(null);
  const image = activity.image && activity.image !== broken ? activity.image : null;
  return <div className={`activity-line ${image ? "with-art" : ""}`} title={activity.source === "discord" ? "Atividade sincronizada com o Discord" : undefined}>
    {image
      ? <img className="activity-art" src={image} alt={activity.imageText || activity.name} title={activity.imageText || undefined} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(image)} />
      : <Gamepad2 size={16} aria-hidden="true" />}
    <div><strong>{activityLabel(activity)}</strong>{detail && <small>{detail}</small>}</div>
  </div>;
}

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

/** The banner color, with the user's GIF over it (a still frame under reduced motion). */
export function ProfileBanner({ user }: { user: Pick<User, "banner" | "bannerGif" | "bannerStill"> }) {
  const reduced = useReducedMotion();
  const [failed, setFailed] = useState<string | null>(null);
  const gif = user.bannerGif ? motionSrc(user.bannerGif, user.bannerStill, reduced) : null;
  return <div className="profile-banner" style={{ background: bannerColor(user.banner) }}>
    {gif && gif !== failed && <img className="profile-banner-gif" src={gif} alt="" referrerPolicy="no-referrer" draggable={false} onError={() => setFailed(gif)} />}
  </div>;
}

/** Banner, avatar, name, pronouns and "Sobre mim". */
export function ProfileSummary({ user, subtitle }: { user: User; subtitle?: string }) {
  const activity = useActivity(user.id);
  // Authors known only from imported Discord messages have no Disc Voice profile.
  if (user.discord) {
    return <>
      <div className="profile-banner" style={{ background: bannerColor("graphite") }} />
      <Avatar name={user.name} src={user.avatar} still={user.avatarStill} size="xl" className="profile-avatar" />
      <strong>{user.name}</strong>
      <span>@{user.discord} · Discord</span>
      <div className="detail-card"><p className="muted">Pessoa das mensagens importadas do Discord. Quando ela vincular a conta do Discord ao Disc Voice, as mensagens passam a mostrar o perfil dela.</p></div>
    </>;
  }
  return <>
    <ProfileBanner user={user} />
    <Avatar name={user.name} src={user.avatar} still={user.avatarStill} size="xl" status="online" className="profile-avatar" />
    <strong>{user.name}</strong>
    {(subtitle ?? user.pronouns) && <span>{subtitle ?? user.pronouns}</span>}
    {activity && <div className="detail-card"><h3 className="eyebrow">Agora</h3><ActivityLine activity={activity} /></div>}
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
export function ProfileCardProvider({ profiles, activities = {}, selfId, onMessage, children }: {
  profiles: Record<string, User>;
  /** Current activity of each user, by id. */
  activities?: Record<string, Activity>;
  /** The signed-in user, who cannot message themselves. */
  selfId?: string;
  /** Opens a direct conversation with someone. */
  onMessage?: (user: User) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<{ user: User; anchor: HTMLElement } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const user = open && (profiles[open.user.id] || open.user);
  const canMessage = !!onMessage && !!user && user.id !== selfId && !user.discord;
  return <ActivityContext.Provider value={activities}><ProfileContext.Provider value={(user, anchor) => setOpen({ user, anchor })}>
    {children}
    {open && user && <ProfilePopover user={user} anchor={open.anchor} onClose={close}
      onMessage={canMessage ? () => { close(); onMessage(user); } : undefined} />}
  </ProfileContext.Provider></ActivityContext.Provider>;
}

function ProfilePopover({ user, anchor, onClose, onMessage }: { user: User; anchor: HTMLElement; onClose: () => void; onMessage?: () => void }) {
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
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) {
        // Escape closes only the card, not the dialog it was opened from.
        if (event instanceof KeyboardEvent) event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
      if (anchor.isConnected) anchor.focus();
    };
  }, [anchor, onClose]);

  // A modal dialog sits in the top layer and makes the rest of the page inert,
  // so a card opened from inside one has to live in it to show above it.
  return createPortal(<div ref={ref} className="profile-preview profile-card" role="dialog" aria-label={`Perfil de ${user.name}`} tabIndex={-1}
    style={position ? { left: position.left, top: position.top } : { visibility: "hidden" }}>
    <ProfileSummary user={user} />
    {onMessage && <button type="button" className="button primary small full" onClick={onMessage}><MessageCircle size={16} />Enviar mensagem</button>}
  </div>, anchor.closest("dialog[open]") ?? document.body);
}

/** A user's name that opens their profile card. */
export function ProfileButton({ user, className = "", children, title }: { user: User; className?: string; children?: ReactNode; title?: string }) {
  const open = useProfileCard();
  return <button type="button" className={`profile-trigger ${className}`} title={title} aria-haspopup="dialog"
    onClick={event => open(user, event.currentTarget)}>{children ?? user.name}</button>;
}
