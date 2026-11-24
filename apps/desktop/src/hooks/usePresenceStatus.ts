import { useCallback, useEffect, useState } from "react";
import type { ChosenStatus } from "@disc-voice/shared";
import type { Realtime } from "../lib/realtime";

const KEY = "discvoice.status";
/** Without keyboard or pointer use for this long, "online" shows as idle. */
export const IDLE_AFTER_MS = 10 * 60_000;
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "focus"] as const;

function stored(): ChosenStatus {
  try {
    const value = localStorage.getItem(KEY);
    return value === "idle" || value === "dnd" ? value : "online";
  } catch { return "online"; }
}

/**
 * The status the user chose for themselves, kept on this device and sent on
 * every (re)connection, since the API keeps it only in memory. While "online",
 * a long time without input shows the user as idle.
 */
export function usePresenceStatus(realtime: Realtime, revision: number) {
  const [chosen, setChosen] = useState<ChosenStatus>(stored);
  const [away, setAway] = useState(false);
  const status: ChosenStatus = chosen === "online" && away ? "idle" : chosen;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const active = () => {
      clearTimeout(timer);
      setAway(false);
      timer = setTimeout(() => setAway(true), IDLE_AFTER_MS);
    };
    active();
    ACTIVITY_EVENTS.forEach(name => window.addEventListener(name, active, { passive: true }));
    return () => {
      clearTimeout(timer);
      ACTIVITY_EVENTS.forEach(name => window.removeEventListener(name, active));
    };
  }, []);

  useEffect(() => {
    if (!revision) return;
    // Offline right now: the next connection sends it.
    try { realtime.send({ type: "presence.set", status }); } catch { /* reconnecting */ }
  }, [realtime, revision, status]);

  const choose = useCallback((next: ChosenStatus) => {
    setChosen(next);
    try { localStorage.setItem(KEY, next); } catch { /* storage unavailable */ }
  }, []);

  return { status, chosen, choose };
}
