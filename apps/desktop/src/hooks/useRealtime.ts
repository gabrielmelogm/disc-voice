import { useEffect, useState, useSyncExternalStore } from "react";
import { Realtime } from "../lib/realtime";

export function useRealtime(serverId: string | null) {
  const [client] = useState(() => new Realtime());
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  useEffect(() => {
    client.start();
    const stop = () => client.stop();
    const resume = () => client.start();
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", resume);
    return () => {
      window.removeEventListener("pagehide", stop);
      window.removeEventListener("pageshow", resume);
      client.stop();
    };
  }, [client]);
  useEffect(() => client.watch(serverId), [client, serverId]);
  return { client, ...state };
}
