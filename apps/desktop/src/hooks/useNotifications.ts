import { useEffect, useRef } from "react";
import type { Channel, RealtimeEvent, User } from "@disc-voice/shared";
import type { Realtime } from "../lib/realtime";
import type { VoiceState } from "../lib/voice";
import { notificationPrefs, playNotificationSound, playVoiceConnectSound, showDesktopNotification } from "../lib/notifications";

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
 * someone else posts a message, or enters a voice room of any of our servers while we
 * are not in a call. In a call, someone connecting to ours plays a cue with no notification.
 */
export function useNotifications({ realtime, user, voiceState, viewingChannelId, channels }: {
  realtime: Realtime;
  user: User;
  voiceState: Pick<VoiceState, "channel" | "deafened">;
  /** Text channel on screen, if any: its messages need no alert while the window has focus. */
  viewingChannelId: string | null;
  channels: Channel[];
}) {
  const latest = useRef({ user, voiceState, viewingChannelId, channels });
  latest.current = { user, voiceState, viewingChannelId, channels };

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

    if (event.type === "voice.member.joined") {
      if (event.user.id === user.id || !prefs.voiceJoin) return;
      const call = voiceState.channel;
      if (call) {
        // In a call: only a cue for who connects to ours, no OS notification; other rooms would only interrupt.
        if (event.channelId === call.id && !voiceState.deafened) playVoiceConnectSound();
        return;
      }
      playNotificationSound();
      if (!focused() && prefs.desktop) {
        void showDesktopNotification(`${event.user.name} entrou em #${event.channelName}`, event.serverName, event.user.name);
      }
    }
  }), [realtime]);
}
