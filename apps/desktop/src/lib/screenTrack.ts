import { pumpFrames } from "./frames";

/**
 * Screens send frames only when their content changes, and so does a canvas
 * capture. A peer that joins (or loses packets) while the screen is still
 * would wait for the next change, so the last frame is repainted this often.
 */
const REFRESH_MS = 1000;

export interface ScreenTrack {
  stream: MediaStream;
  track: MediaStreamTrack;
  stop: () => void;
}

/**
 * Turns the native engine's JPEG frames into a WebRTC video track: frames
 * are drawn on an offscreen canvas captured as a media stream.
 */
export function screenTrack(pull: () => Promise<ArrayBuffer>, frameRate: number, onError: (message: string) => void): ScreenTrack {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const context = canvas.getContext("2d");
  if (!context || typeof canvas.captureStream !== "function") {
    throw new Error("Este ambiente não consegue enviar a tela pela chamada.");
  }
  const stream = canvas.captureStream(frameRate);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error("Este ambiente não consegue enviar a tela pela chamada.");
  // Favors sharp text over motion when the bandwidth is short.
  track.contentHint = "detail";

  let lastFrame = performance.now();
  const stopPump = pumpFrames(canvas, pull, { onError, onFrame: () => { lastFrame = performance.now(); } });
  const refresh = setInterval(() => {
    if (performance.now() - lastFrame < REFRESH_MS) return;
    // Repainting the canvas onto itself emits the same image as a new frame.
    context.drawImage(canvas, 0, 0);
    lastFrame = performance.now();
  }, REFRESH_MS);

  return {
    stream,
    track,
    stop: () => {
      stopPump();
      clearInterval(refresh);
      track.stop();
    },
  };
}
