import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function query() {
  return typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
}

/** The system asks for less motion: animated images then start paused. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => !!query()?.matches);
  useEffect(() => {
    const media = query();
    if (!media) return;
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

/** The animated URL, or its still frame when motion is reduced and one exists. */
export function motionSrc(url: string, still: string | null | undefined, reduced: boolean) {
  return reduced && still ? still : url;
}
