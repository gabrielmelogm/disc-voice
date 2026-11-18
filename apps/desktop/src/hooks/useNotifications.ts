import { useEffect, useRef } from "react";
import type { Channel, RealtimeEvent, User, VoiceParticipant } from "@disc-voice/shared";
import type { Realtime } from "../lib/realtime";
import type { VoiceState } from "../lib/voice";
import { notificationPrefs, playNotificationSound, showDesktopNotification } from "../lib/notifications";

const PREVIEW_LENGTH = 100;

function preview(content: string) {
  const text = content.replace(/\s+/g, " ").trim();
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text;
}

function focused() {
  return typeof document.hasFocus === "function" ? document.hasFocus() : true;
}

/**
 * Plays the notification sound (and shows an OS notification in the background) when
 * someone else posts a message or joins the voice channel we are in.
 */
export function useNotifications({ realtime, user, voiceState, viewingChannelId, channels }: {
  realtime: Realtime;
  user: User;
  voiceState: Pick<VoiceState, "channel" | "peerId" | "deafened">;
  /** Text channel on screen, if any: its messages need no alert while the window has focus. */
  viewingChannelId: string | null;
  channels: Channel[];
}) {
  const latest = useRef({ user, voiceState, viewingChannelId, channels });
  latest.current = { user, voiceState, viewingChannelId, channels };
  // Peers already in our call; null until the first participant list for it arrives.
  const known = useRef<Set<string> | null>(null);
  const callId = voiceState.channel?.id ?? null;

  useEffect(() => { known.current = null; }, [callId]);

  useEffect(() => realtime.onEvent((event: RealtimeEvent) => {
    const { user, voiceState, viewingChannelId, channels } = latest.current;
    const prefs = notificationPrefs();

    if (event.type === "message.created") {
      const { message } = event;
      if (message.author.id === user.id) return;
      const background = !focused();
      if (!background && message.channelId === viewingChannelId) return;
      if (prefs.messageSounds) playNotificationSound();
      if (background && prefs.desktop) {
        const channel = channels.find(c => c.id === message.channelId);
        void showDesktopNotification(channel ? `${message.author.name} em #${channel.name}` : message.author.name, preview(message.content), message.author.name);
      }
      return;
    }

    const call = voiceState.channel;
    if (!call || !("channelId" in event) || event.channelId !== call.id) return;
    if (event.type === "voice.joined") {
      known.current = new Set(event.participants.map(p => p.peerId));
      return;
    }
    if (event.type !== "voice.participants") return;
    const previous = known.current;
    known.current = new Set(event.participants.map(p => p.peerId));
    if (!previous) return;
    const arrived = event.participants.filter((p: VoiceParticipant) =>
      !previous.has(p.peerId) && p.peerId !== voiceState.peerId && p.user.id !== user.id);
    if (!arrived.length || !prefs.voiceJoin) return;
    if (!voiceState.deafened) playNotificationSound();
    if (!focused() && prefs.desktop) {
      const names = arrived.map(p => p.user.name).join(", ");
      void showDesktopNotification(`${names} ${arrived.length > 1 ? "entraram" : "entrou"} em #${call.name}`, "Sala de voz", arrived[0].user.name);
    }
  }), [realtime]);
}
