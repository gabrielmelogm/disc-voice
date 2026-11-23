import { useCallback, useEffect, useState } from "react";
import type { DirectConversation } from "@disc-voice/shared";
import { api, message } from "../lib/api";
import type { Realtime } from "../lib/realtime";

const newest = (a: DirectConversation, b: DirectConversation) => {
  if (a.lastMessageId === b.lastMessageId) return 0;
  // Empty conversations were just started: they go first.
  if (!a.lastMessageId) return -1;
  if (!b.lastMessageId) return 1;
  return BigInt(b.lastMessageId) > BigInt(a.lastMessageId) ? 1 : -1;
};

/** The user's direct conversations, most recent first, kept live. */
export function useDirectMessages(realtime: Realtime, revision: number) {
  const [conversations, setConversations] = useState<DirectConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!revision) return;
    const controller = new AbortController();
    setError("");
    void api.dms(controller.signal)
      .then(result => { if (!controller.signal.aborted) setConversations(result); })
      .catch(cause => { if (!controller.signal.aborted) setError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision, reload]);

  const add = useCallback((conversation: DirectConversation) => {
    setConversations(current => current.some(c => c.channel.id === conversation.channel.id)
      ? current : [conversation, ...current]);
  }, []);

  useEffect(() => realtime.onEvent(event => {
    if (event.type === "dm.created") add(event.conversation);
    if (event.type === "message.created") {
      const { message } = event;
      setConversations(current => {
        if (!current.some(c => c.channel.id === message.channelId)) return current;
        return current.map(c => c.channel.id === message.channelId ? { ...c, lastMessageId: message.id } : c).sort(newest);
      });
    }
    // Keep the other person's name and photo current.
    if (event.type === "user.updated") {
      setConversations(current => current.some(c => c.user.id === event.user.id)
        ? current.map(c => c.user.id === event.user.id ? { ...c, user: event.user } : c) : current);
    }
  }), [realtime, add]);

  /** Opens (or starts) the conversation with someone. */
  const open = useCallback(async (userId: string) => {
    const conversation = await api.openDm(userId);
    add(conversation);
    return conversation;
  }, [add]);

  return { conversations, loading, error, open, retry: () => setReload(n => n + 1) };
}
