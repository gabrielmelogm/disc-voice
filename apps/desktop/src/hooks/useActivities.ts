import { useEffect, useState } from "react";
import type { Activity } from "@disc-voice/shared";
import { api } from "../lib/api";
import { withActivity } from "../lib/activity";
import type { Realtime } from "../lib/realtime";

/**
 * What the people the user can see are doing, by user id. Loaded on each
 * (re)connection or server switch, then kept current by realtime events.
 */
export function useActivities(realtime: Realtime, revision: number) {
  const [activities, setActivities] = useState<Record<string, Activity>>({});

  useEffect(() => realtime.onEvent(event => {
    if (event.type === "activity.updated") setActivities(current => withActivity(current, event.userId, event.activity));
  }), [realtime]);

  useEffect(() => {
    if (!revision) return;
    const controller = new AbortController();
    void api.activities(controller.signal)
      .then(result => { if (!controller.signal.aborted) setActivities(result); })
      // Activities are a nicety: keep what we have when this fails.
      .catch(() => {});
    return () => controller.abort();
  }, [revision]);

  return activities;
}
