import { errorMessage } from "./audio";

/** How long to wait before pulling again when no frame arrived. */
const IDLE_DELAY_MS = 50;

export interface FramePump {
  /** A pull failed: the capture ended. No more pulls follow. */
  onError: (message: string) => void;
  /** Called after every pull, with or without a frame. */
  onPull?: () => void;
  /** Called after a frame was drawn. */
  onFrame?: () => void;
}

/**
 * Draws JPEG frames pulled from a native engine (camera or screen) on
 * `canvas`, resizing it to each frame. Pulling one frame at a time keeps
 * latency low: a slow page skips frames instead of queueing them. An empty
 * frame means none arrived in time. Returns a function that stops pulling.
 */
export function pumpFrames(canvas: HTMLCanvasElement, pull: () => Promise<ArrayBuffer>, handlers: FramePump): () => void {
  const context = canvas.getContext("2d");
  let disposed = false;
  // No 2D context (e.g. tests without canvas support): nothing to draw on.
  if (!context) return () => {};

  void (async () => {
    while (!disposed) {
      let frame: ArrayBuffer;
      try {
        frame = await pull();
      } catch (cause) {
        if (!disposed) handlers.onError(errorMessage(cause));
        return;
      }
      if (disposed) return;
      handlers.onPull?.();
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
        handlers.onFrame?.();
      } catch {
        // A frame that fails to decode is skipped; the next one replaces it.
      }
    }
  })();

  return () => { disposed = true; };
}
