import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { Realtime } from "../lib/realtime";
import { Voice } from "../lib/voice";

export function useVoice(realtime: Realtime) {
  const voice = useMemo(() => new Voice(realtime), [realtime]);
  const state = useSyncExternalStore(voice.subscribe, voice.getSnapshot);
  useEffect(() => { voice.start(); return () => voice.dispose(); }, [voice]);
  return { voice, state };
}
