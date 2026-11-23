import { useEffect, useRef, useState } from "react";
import type { User } from "@disc-voice/shared";
import type { Realtime } from "../lib/realtime";

/** Without a new announcement for this long, the person stopped typing. */
export const TYPING_EXPIRY = 6_000;
/** How often the composer tells others the user is still typing. */
export const TYPING_INTERVAL = 3_000;

/** "Elisa Prado está digitando…", or "" when nobody is. */
export function typingLabel(users: Pick<User, "name">[]) {
  if (!users.length) return "";
  if (users.length === 1) return `${users[0].name} está digitando…`;
  if (users.length === 2) return `${users[0].name} e ${users[1].name} estão digitando…`;
  return "Várias pessoas estão digitando…";
}

/** Who else is typing in a channel, oldest first. */
export function useTyping(realtime: Realtime, channelId: string, selfId?: string) {
  const [typing, setTyping] = useState<User[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const active = timers.current;
    const stop = (userId: string) => {
      clearTimeout(active.get(userId));
      active.delete(userId);
      setTyping(current => current.some(u => u.id === userId) ? current.filter(u => u.id !== userId) : current);
    };
    const off = realtime.onEvent(event => {
      if (event.type === "typing" && event.channelId === channelId && event.user.id !== selfId) {
        clearTimeout(active.get(event.user.id));
        active.set(event.user.id, setTimeout(() => stop(event.user.id), TYPING_EXPIRY));
        setTyping(current => current.some(u => u.id === event.user.id)
          ? current.map(u => u.id === event.user.id ? event.user : u)
          : [...current, event.user]);
      }
      // Their message arrived: they are done typing it.
      if (event.type === "message.created" && event.message.channelId === channelId) stop(event.message.author.id);
    });
    return () => {
      off();
      active.forEach(timer => clearTimeout(timer));
      active.clear();
      setTyping([]);
    };
  }, [realtime, channelId, selfId]);

  return typing;
}
