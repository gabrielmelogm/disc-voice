import type { Activity, ActivityKind } from "@disc-voice/shared";

const verbs: Record<ActivityKind, string> = {
  playing: "Jogando",
  streaming: "Transmitindo",
  listening: "Ouvindo",
  watching: "Assistindo",
  competing: "Competindo em",
};

/** "Jogando Minecraft". */
export function activityLabel(activity: Activity) {
  return `${verbs[activity.kind] ?? "Em"} ${activity.name}`;
}

/** Second line, e.g. the song and artist or the game mode. */
export function activityDetail(activity: Activity) {
  return [activity.details, activity.state].filter(Boolean).join(" · ");
}

/** Applies a realtime update to the activities map. */
export function withActivity(current: Record<string, Activity>, userId: string, activity: Activity | null) {
  if (!activity) {
    if (!(userId in current)) return current;
    const next = { ...current };
    delete next[userId];
    return next;
  }
  return { ...current, [userId]: activity };
}
