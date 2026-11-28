import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Ban, Gamepad2, MessageCircle, UserCheck, UserPlus, UserRound, UserX } from "lucide-react";
import type { Activity, BannerColor, User } from "@disc-voice/shared";
import type { FriendsState } from "../hooks/useFriends";
import { activityDetail, activityLabel } from "../lib/activity";
import { message } from "../lib/api";
import { motionSrc, useReducedMotion } from "../lib/motion";
import { SEPARATOR, useContextMenu } from "./ContextMenu";
import { friendshipWith } from "./Friends";
import { BanDialog, canBanUser, RoleBadges, useCanBan, useServerRoles } from "./ServerRoles";
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

/** What the user menu offers besides the profile: friend requests and direct messages. */
interface UserActions {
  selfId?: string;
  friends?: Pick<FriendsState, "friends" | "incoming" | "outgoing" | "add" | "accept" | "remove">;
  onMessage?: (user: User) => void;
}
const UserActionsContext = createContext<UserActions>({});

/**
 * Hosts the profile card. `profiles` holds the latest known version of each
 * user, so a card opened from an old message still shows the current profile.
 */
export function ProfileCardProvider({ profiles, activities = {}, selfId, onMessage, friends, children }: {
  profiles: Record<string, User>;
  /** Current activity of each user, by id. */
  activities?: Record<string, Activity>;
  /** The signed-in user, who cannot message themselves. */
  selfId?: string;
  /** Opens a direct conversation with someone. */
  onMessage?: (user: User) => void;
  /** Friends and requests, for the user menu's friend request item. */
  friends?: UserActions["friends"];
  children: ReactNode;
}) {
  const [open, setOpen] = useState<{ user: User; anchor: HTMLElement } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const user = open && (profiles[open.user.id] || open.user);
  const canMessage = !!onMessage && !!user && user.id !== selfId && !user.discord;
  const show = useCallback<Open>((user, anchor) => setOpen({ user, anchor }), []);
  return <ActivityContext.Provider value={activities}><ProfileContext.Provider value={show}><UserActionsContext.Provider value={{ selfId, friends, onMessage }}>
    {children}
    {open && user && <ProfilePopover user={user} anchor={open.anchor} onClose={close}
      onMessage={canMessage ? () => { close(); onMessage(user); } : undefined} />}
  </UserActionsContext.Provider></ProfileContext.Provider></ActivityContext.Provider>;
}

/**
 * The right-click menu of a person: their profile, a friend request (or
 * undoing it), a direct message and, for who may, banning them from the open
 * server. Render `element` next to where `open` is called.
 */
export function useUserMenu() {
  const openProfile = useProfileCard();
  const { selfId, friends, onMessage } = useContext(UserActionsContext);
  const roles = useServerRoles();
  const menu = useContextMenu();
  const [banning, setBanning] = useState<User | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(""), 5000);
    return () => clearTimeout(timer);
  }, [error]);

  const open = useCallback((event: ReactMouseEvent, user: User) => {
    const anchor = event.currentTarget as HTMLElement;
    // Authors known only from imported Discord messages have just a profile.
    const person = user.id !== selfId && !user.discord;
    const friendship = friends && person ? friendshipWith(friends, user.id) : null;
    const run = (change: () => Promise<unknown>) => { setError(""); void change().catch(cause => setError(message(cause))); };
    menu.open(event, `Ações de ${user.name}`, [
      { label: "Exibir perfil", icon: UserRound, onSelect: () => openProfile(user, anchor) },
      friendship === "none" && { label: "Enviar pedido de amizade", icon: UserPlus, onSelect: () => run(() => friends!.add(user.id)) },
      friendship === "outgoing" && { label: "Desfazer pedido", icon: UserX, onSelect: () => run(() => friends!.remove(user.id)) },
      friendship === "incoming" && { label: "Aceitar pedido de amizade", icon: UserCheck, onSelect: () => run(() => friends!.accept(user.id)) },
      person && onMessage && { label: "Enviar mensagem direta", icon: MessageCircle, onSelect: () => onMessage(user) },
      SEPARATOR,
      canBanUser(roles, user.id) && { label: "Banir usuário", icon: Ban, danger: true, onSelect: () => setBanning(user) },
    ]);
  }, [selfId, friends, onMessage, roles, openProfile, menu.open]);

  const element = <>
    {menu.element}
    {banning && roles.serverId && <BanDialog serverId={roles.serverId} serverName={roles.serverName} user={banning} onClose={() => setBanning(null)} />}
    {error && <div className="floating-notice" role="alert">{error}</div>}
  </>;
  return { open, element };
}

function ProfilePopover({ user, anchor, onClose, onMessage }: { user: User; anchor: HTMLElement; onClose: () => void; onMessage?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const { serverId, serverName, badges } = useServerRoles();
  const badge = badges[user.id];
  const canBan = useCanBan(user.id);
  const [banning, setBanning] = useState(false);

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
      // The ban dialog opened from the card handles its own keys and clicks.
      if (banning) return;
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
    };
  }, [anchor, onClose, banning]);

  useEffect(() => () => { if (anchor.isConnected) anchor.focus(); }, [anchor]);

  // A modal dialog sits in the top layer and makes the rest of the page inert,
  // so a card opened from inside one has to live in it to show above it.
  return createPortal(<div ref={ref} className="profile-preview profile-card" role="dialog" aria-label={`Perfil de ${user.name}`} tabIndex={-1}
    style={position ? { left: position.left, top: position.top } : { visibility: "hidden" }}>
    <ProfileSummary user={user} />
    {badge && (badge.owner || badge.roles.length > 0) && <div className="detail-card"><h3 className="eyebrow">Cargos em {serverName}</h3><RoleBadges badge={badge} /></div>}
    {onMessage && <button type="button" className="button primary small full" onClick={onMessage}><MessageCircle size={16} />Enviar mensagem</button>}
    {canBan && serverId && <button type="button" className="button danger-soft small full" onClick={() => setBanning(true)}><Ban size={16} />Banir de {serverName}</button>}
    {banning && serverId && <BanDialog serverId={serverId} serverName={serverName} user={user} onClose={() => setBanning(false)} onBanned={onClose} />}
  </div>, anchor.closest("dialog[open]") ?? document.body);
}

/** A user's name that opens their profile card. */
export function ProfileButton({ user, className = "", children, title }: { user: User; className?: string; children?: ReactNode; title?: string }) {
  const open = useProfileCard();
  const menu = useUserMenu();
  return <>
    <button type="button" className={`profile-trigger ${className}`} title={title} aria-haspopup="dialog"
      onClick={event => open(user, event.currentTarget)} onContextMenu={event => menu.open(event, user)}>{children ?? user.name}</button>
    {menu.element}
  </>;
}
