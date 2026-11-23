import { useCallback, useEffect, useState } from "react";
import type { Friends } from "@disc-voice/shared";
import { api, message } from "../lib/api";
import type { Realtime } from "../lib/realtime";

const EMPTY: Friends = { friends: [], incoming: [], outgoing: [] };

/**
 * Friends, requests and friends' presence. Reloaded on each (re)connection and
 * whenever a request changes on either side; presence arrives live.
 */
export function useFriends(realtime: Realtime, revision: number) {
  const [data, setData] = useState<Friends>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!revision) return;
    const controller = new AbortController();
    void api.friends(controller.signal)
      .then(result => { if (!controller.signal.aborted) { setData(result); setError(""); } })
      .catch(cause => { if (!controller.signal.aborted) setError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision, reload]);

  useEffect(() => realtime.onEvent(event => {
    if (event.type === "friends.changed") setReload(n => n + 1);
    if (event.type === "presence.updated") {
      setData(current => current.friends.some(f => f.user.id === event.userId && f.status !== event.status)
        ? { ...current, friends: current.friends.map(f => f.user.id === event.userId ? { ...f, status: event.status } : f) }
        : current);
    }
    if (event.type === "user.updated") {
      const update = <T extends { user: { id: string } }>(list: T[]) => list.map(item => item.user.id === event.user.id ? { ...item, user: event.user } : item);
      setData(current => ({ friends: update(current.friends), incoming: update(current.incoming), outgoing: update(current.outgoing) }));
    }
  }), [realtime]);

  /** Runs a change, then reloads (the event reloads the other side). */
  const act = useCallback(async (change: () => Promise<unknown>) => {
    await change();
    setReload(n => n + 1);
  }, []);

  return {
    ...data,
    loading,
    error,
    retry: () => setReload(n => n + 1),
    add: (userId: string) => act(() => api.addFriend(userId)),
    accept: (userId: string) => act(() => api.acceptFriend(userId)),
    remove: (userId: string) => act(() => api.removeFriend(userId)),
  };
}

export type FriendsState = ReturnType<typeof useFriends>;
