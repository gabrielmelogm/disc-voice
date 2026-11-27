import { useEffect, useState } from "react";
import type { ServerMember } from "@disc-voice/shared";
import { api, message } from "../lib/api";
import type { Realtime } from "../lib/realtime";

/** Adds a member, or replaces them when already listed. */
function upsert(list: ServerMember[], member: ServerMember) {
  return list.some(m => m.user.id === member.user.id)
    ? list.map(m => m.user.id === member.user.id ? member : m)
    : [...list, member];
}

/**
 * Everyone in a server with their role and presence. Loaded on each
 * (re)connection or server switch, then kept current by realtime events.
 */
export function useMembers(realtime: Realtime, revision: number, serverId: string | null) {
  const [members, setMembers] = useState<ServerMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => { setMembers([]); setError(""); }, [serverId]);

  useEffect(() => {
    if (!serverId || !revision) return;
    const controller = new AbortController();
    setLoading(true);
    void api.members(serverId, controller.signal)
      .then(result => { if (!controller.signal.aborted) { setMembers(result); setError(""); } })
      .catch(cause => { if (!controller.signal.aborted) setError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [serverId, revision, reload]);

  useEffect(() => realtime.onEvent(event => {
    if (event.type === "presence.updated") {
      setMembers(current => current.some(m => m.user.id === event.userId && m.status !== event.status)
        ? current.map(m => m.user.id === event.userId ? { ...m, status: event.status } : m)
        : current);
    }
    if ((event.type === "member.joined" || event.type === "member.updated") && event.serverId === serverId) {
      setMembers(current => upsert(current, event.member));
    }
    if (event.type === "member.left" && event.serverId === serverId) {
      setMembers(current => current.filter(m => m.user.id !== event.userId));
    }
    if (event.type === "user.updated") {
      setMembers(current => current.some(m => m.user.id === event.user.id)
        ? current.map(m => m.user.id === event.user.id ? { ...m, user: event.user } : m)
        : current);
    }
  }), [realtime, serverId]);

  return { members, loading, error, retry: () => setReload(n => n + 1) };
}

export type MembersState = ReturnType<typeof useMembers>;
