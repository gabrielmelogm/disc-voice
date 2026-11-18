import { useEffect, useRef } from "react";
import { errorMessage } from "../lib/audio";

const IDLE_DELAY_MS = 50;
const STATS_INTERVAL_MS = 1000;

/** What the preview actually receives, measured over the last second. */
export interface FrameStats {
  fps: number;
  width: number;
  height: number;
}

/**
 * Draws JPEG frames pulled from a native engine (camera or screen). Pulling
 * one frame at a time keeps latency low: a slow page skips frames instead of
 * queueing them. An empty frame means none arrived in time.
 */
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
    const context = canvas?.getContext("2d");
    if (!active || !canvas || !context) return;
    let disposed = false;
    let frames = 0;
    let windowStart = performance.now();

    const report = () => {
      const now = performance.now();
      if (!onStats || now - windowStart < STATS_INTERVAL_MS) return;
      onStats({ fps: Math.round((frames * 1000) / (now - windowStart)), width: canvas.width, height: canvas.height });
      frames = 0;
      windowStart = now;
    };

    void (async () => {
      while (!disposed) {
        let frame: ArrayBuffer;
        try {
          frame = await pull();
        } catch (cause) {
          if (!disposed) onError(errorMessage(cause));
          return;
        }
        if (disposed) return;
        report();
        if (!frame.byteLength) {
          await new Promise((resolve) => setTimeout(resolve, IDLE_DELAY_MS));
          continue;
        }
        try {
          const image = await createImageBitmap(new Blob([frame], { type: "image/jpeg" }));
          if (disposed) {
            image.close();
            return;
          }
          if (canvas.width !== image.width || canvas.height !== image.height) {
            canvas.width = image.width;
            canvas.height = image.height;
          }
          context.drawImage(image, 0, 0);
          image.close();
          frames += 1;
        } catch {
          // A frame that fails to decode is skipped; the next one replaces it.
        }
      }
    })();

    return () => {
      disposed = true;
      context.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [active, pull, onError, onStats]);

  return <canvas ref={ref} className={mirrored ? "mirrored" : ""} aria-label={label} />;
}
