import { useEffect, useState } from "react";
import type { Role } from "@disc-voice/shared";
import { api } from "../lib/api";
import type { Realtime } from "../lib/realtime";

/**
 * The roles of a server, highest first (@everyone last). Loaded on each
 * (re)connection or server switch, then kept current by realtime events.
 */
export function useRoles(realtime: Realtime, revision: number, serverId: string | null) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [reload, setReload] = useState(0);

  useEffect(() => { setRoles([]); }, [serverId]);

  useEffect(() => {
    if (!serverId || !revision) return;
    const controller = new AbortController();
    // Without roles the app falls back to plain members: nothing is offered
    // that the API would refuse.
    void api.roles(serverId, controller.signal)
      .then(result => { if (!controller.signal.aborted) setRoles(result); })
      .catch(() => {});
    return () => controller.abort();
  }, [serverId, revision, reload]);

  useEffect(() => realtime.onEvent(event => {
    if (event.type === "roles.updated" && event.serverId === serverId) setRoles(event.roles);
  }), [realtime, serverId]);

  return { roles, setRoles, reload: () => setReload(n => n + 1) };
}
