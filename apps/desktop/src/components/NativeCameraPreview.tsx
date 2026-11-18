import { useEffect, useRef } from "react";
import { errorMessage } from "../lib/audio";
import { nativeCamera } from "../lib/nativeCamera";

const IDLE_DELAY_MS = 50;

/**
 * Draws frames pulled from the native camera. Pulling one frame at a time
 * keeps latency low: a slow page skips frames instead of queueing them.
 */
export function NativeCameraPreview({ active, mirrored, onError }: {
  active: boolean;
  mirrored: boolean;
  onError: (message?: string) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!active || !canvas || !context) return;
    let disposed = false;

    void (async () => {
      while (!disposed) {
        let frame: ArrayBuffer;
        try {
          frame = await nativeCamera.frame();
        } catch (cause) {
          if (!disposed) onError(errorMessage(cause));
          return;
        }
        if (disposed) return;
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
        } catch {
          // A frame that fails to decode is skipped; the next one replaces it.
        }
      }
    })();

    return () => {
      disposed = true;
      context.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [active, onError]);

  return <canvas ref={ref} className={mirrored ? "mirrored" : ""} aria-label="Prévia ao vivo da webcam" />;
}
