import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { ScreenInfo, ScreenRequest } from "@disc-voice/shared";
import { errorMessage } from "../lib/audio";
import { nativeScreen } from "../lib/nativeScreen";

/**
 * - `pending`: still asking the app whether native capture exists.
 * - `unavailable`: browser or a platform without a backend yet.
 * - `picking`: the system picker is open, waiting for the user.
 */
export type ScreenStatus = "pending" | "unavailable" | "idle" | "picking" | "live";

export interface ScreenShareController {
  status: ScreenStatus;
  info: ScreenInfo | null;
  error: string | null;
  start: (request: ScreenRequest) => Promise<void>;
  /** Stops sharing, or cancels the picker while it is open. */
  stop: () => void;
  previewFailed: (message?: string) => void;
}

const PREVIEW_FAILED = "Não foi possível exibir a tela. Tente compartilhar novamente.";

export function useScreenShare(): ScreenShareController {
  const [status, setStatus] = useState<ScreenStatus>(() => (isTauri() ? "pending" : "unavailable"));
  const [info, setInfo] = useState<ScreenInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = status !== "pending" && status !== "unavailable";
  const generation = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    if (status !== "pending") return;
    let disposed = false;
    void nativeScreen.supported().then((native) => {
      if (!disposed) setStatus(native ? "idle" : "unavailable");
    });
    return () => { disposed = true; };
  }, [status]);

  const stop = useCallback(() => {
    generation.current += 1;
    setInfo(null);
    setStatus((current) => (current === "picking" || current === "live" ? "idle" : current));
    // Also dismisses the picker if a start is still waiting on the user.
    void nativeScreen.stop().catch(() => {});
  }, []);

  const start = useCallback(async (request: ScreenRequest) => {
    const attempt = ++generation.current;
    setStatus("picking");
    setInfo(null);
    setError(null);
    try {
      const shared = await nativeScreen.start(request);
      if (!mounted.current || generation.current !== attempt) return;
      setInfo(shared);
      setStatus(shared ? "live" : "idle");
    } catch (cause) {
      if (!mounted.current || generation.current !== attempt) return;
      setError(errorMessage(cause));
      setStatus("idle");
    }
  }, []);

  const previewFailed = useCallback((message?: string) => {
    stop();
    setError(message ?? PREVIEW_FAILED);
  }, [stop]);

  useEffect(() => {
    if (!supported) return;
    mounted.current = true;
    window.addEventListener("pagehide", stop);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", stop);
      generation.current += 1;
      void nativeScreen.stop().catch(() => {});
    };
  }, [supported, stop]);

  return { status, info, error, start, stop, previewFailed };
}
