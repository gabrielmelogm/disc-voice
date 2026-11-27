import { useEffect, useRef } from "react";
import type { Channel, ChosenStatus, RealtimeEvent, User } from "@disc-voice/shared";
import { mentionText } from "../lib/mentions";
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

/** Title of a message's OS notification: the author, plus where it was posted unless it is a direct message. */
function messageTitle(event: Extract<RealtimeEvent, { type: "message.created" }>, channels: Channel[]) {
  const { message } = event;
  const known = channels.find(c => c.id === message.channelId);
  if (event.channelType === "voice") return `${message.author.name} no chat de ${event.channelName ?? known?.name ?? "sala"}`;
  const channel = event.channelName ?? (known?.type === "text" ? known.name : undefined);
  if (!channel) return message.author.name;
  return event.serverName ? `${message.author.name} em #${channel} (${event.serverName})` : `${message.author.name} em #${channel}`;
}

/**
 * Plays the notification sound (and shows an OS notification in the background) when
 * someone else sends us a direct message or posts in a text channel of any of our servers
 * (or in the room chat of the call we are in), or enters a voice room of them while we are not in a call. In a call, someone connecting
 * to ours plays a cue with no notification. "Do not disturb" silences all but that cue.
 */
export function useNotifications({ realtime, user, status, voiceState, viewingChannelId, channels }: {
  realtime: Realtime;
  user: User;
  status: ChosenStatus;
  voiceState: Pick<VoiceState, "channel" | "deafened">;
  /** Text channel or conversation on screen, if any: its messages need no alert while the window has focus. */
  viewingChannelId: string | null;
  /** Channels of the server on screen: name messages that arrive without one. */
  channels: Channel[];
}) {
  const latest = useRef({ user, status, voiceState, viewingChannelId, channels });
  latest.current = { user, status, voiceState, viewingChannelId, channels };

  useEffect(() => realtime.onEvent((event: RealtimeEvent) => {
    const { user, status, voiceState, viewingChannelId, channels } = latest.current;
    const prefs = notificationPrefs();
    const quiet = status === "dnd";

    if (event.type === "message.created") {
      const { message } = event;
      if (quiet || message.author.id === user.id) return;
      // A voice room's chat only concerns who is in that call.
      if (event.channelType === "voice" && voiceState.channel?.id !== message.channelId) return;
      const background = !focused();
      if (!background && message.channelId === viewingChannelId) return;
      if (prefs.messageSounds) playNotificationSound();
      if (background && prefs.desktop) {
        void showDesktopNotification(messageTitle(event, channels), preview(mentionText(message.content, message.mentions)), message.author.name);
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
      if (quiet) return;
      playNotificationSound();
      if (!focused() && prefs.desktop) {
        void showDesktopNotification(`${event.user.name} entrou em #${event.channelName}`, event.serverName, event.user.name);
      }
    }
  }), [realtime]);
}
