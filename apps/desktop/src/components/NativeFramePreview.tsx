import { useEffect, useRef } from "react";
import { pumpFrames } from "../lib/frames";

const STATS_INTERVAL_MS = 1000;

/** What the preview actually receives, measured over the last second. */
export interface FrameStats {
  fps: number;
  width: number;
  height: number;
}

/** Draws JPEG frames pulled from a native engine (camera or screen). */
export function NativeFramePreview({ active, pull, label, mirrored = false, onError, onStats }: {
  active: boolean;
  pull: () => Promise<ArrayBuffer>;
  label: string;
  mirrored?: boolean;
  onError: (message?: string) => void;
  onStats?: (stats: FrameStats) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!active || !canvas) return;
    let frames = 0;
    let windowStart = performance.now();

    const stop = pumpFrames(canvas, pull, {
      onError,
      onFrame: () => { frames += 1; },
      onPull: () => {
        const now = performance.now();
        if (!onStats || now - windowStart < STATS_INTERVAL_MS) return;
        onStats({ fps: Math.round((frames * 1000) / (now - windowStart)), width: canvas.width, height: canvas.height });
        frames = 0;
        windowStart = now;
      },
    });

    return () => {
      stop();
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [active, pull, onError, onStats]);

  return <canvas ref={ref} className={mirrored ? "mirrored" : ""} aria-label={label} />;
}
