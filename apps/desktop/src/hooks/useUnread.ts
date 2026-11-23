import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReadState } from "@disc-voice/shared";
import { api } from "../lib/api";
import type { Realtime } from "../lib/realtime";

type Reads = Record<string, ReadState>;

const newer = (a: string, b: string) => BigInt(a) > BigInt(b);

/**
 * Unread messages per text channel and conversation. The read markers live
 * in the API, so they follow the user across devices and restarts; this keeps
 * a live copy, reloaded on each (re)connection and server switch.
 */
export function useUnread(realtime: Realtime, revision: number, { userId, serverId }: { userId: string; serverId: string | null }) {
  const [reads, setReads] = useState<Reads>({});
  const [reload, setReload] = useState(0);
  // Newest message seen per channel, to tell whether a read on another device covers it.
  const latest = useRef(new Map<string, string>());
  const current = useRef(reads);
  current.current = reads;

  useEffect(() => {
    if (!revision) return;
    const controller = new AbortController();
    void api.reads(controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        setReads(Object.fromEntries(result.map(read => [read.channelId, read])));
      })
      // Badges are a nicety: keep what we have when this fails.
      .catch(() => {});
    return () => controller.abort();
  }, [revision, serverId, reload]);

  useEffect(() => realtime.onEvent(event => {
    if (event.type === "message.created") {
      const { message } = event;
      const seen = latest.current.get(message.channelId);
      if (!seen || newer(message.id, seen)) latest.current.set(message.channelId, message.id);
      if (message.author.id === userId) return;
      const read = current.current[message.channelId];
      // A channel we do not know yet (a new conversation): ask the API.
      if (!read) { setReload(n => n + 1); return; }
      if (!newer(message.id, read.lastReadId)) return;
      setReads(all => ({ ...all, [message.channelId]: { ...all[message.channelId], unread: Math.min(all[message.channelId].unread + 1, 100) } }));
    }
    if (event.type === "read.updated") {
      setReads(all => {
        const read = all[event.channelId];
        if (!read || !newer(event.lastReadId, read.lastReadId)) return all;
        const seen = latest.current.get(event.channelId);
        const caughtUp = !seen || !newer(seen, event.lastReadId);
        return { ...all, [event.channelId]: { ...read, lastReadId: event.lastReadId, unread: caughtUp ? 0 : read.unread } };
      });
    }
    if (event.type === "dm.created") {
      const { channel } = event.conversation;
      setReads(all => all[channel.id] ? all : { ...all, [channel.id]: { channelId: channel.id, serverId: null, lastReadId: "0", unread: 0 } });
    }
    if (event.type === "channel.created" && event.channel.type === "text") {
      const { channel } = event;
      setReads(all => all[channel.id] ? all : { ...all, [channel.id]: { channelId: channel.id, serverId: channel.serverId, lastReadId: "0", unread: 0 } });
    }
  }), [realtime, userId]);

  /** The user saw everything up to this message. */
  const markRead = useCallback((channelId: string, messageId: string) => {
    const read = current.current[channelId];
    if (read && !newer(messageId, read.lastReadId)) return;
    setReads(all => ({
      ...all,
      [channelId]: { channelId, serverId: all[channelId]?.serverId ?? null, lastReadId: messageId, unread: 0 },
    }));
    // A failed marker is retried by the next read; the badge stays cleared here.
    void api.markRead(channelId, messageId).catch(() => {});
  }, []);

  const counts = useMemo(() => Object.fromEntries(Object.values(reads).map(read => [read.channelId, read.unread])), [reads]);
  const dmUnread = useMemo(() => Object.values(reads).reduce((sum, read) => read.serverId === null ? sum + read.unread : sum, 0), [reads]);

  return { counts, dmUnread, markRead };
}
