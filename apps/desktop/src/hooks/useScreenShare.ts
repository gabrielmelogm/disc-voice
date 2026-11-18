import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { ScreenInfo, ScreenRequest } from "@disc-voice/shared";
import { errorMessage } from "../lib/audio";
import { nativeScreen, type ScreenClaim } from "../lib/nativeScreen";

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
const TAKEN = "O compartilhamento de tela da chamada assumiu a captura.";

export function useScreenShare(): ScreenShareController {
  const [status, setStatus] = useState<ScreenStatus>(() => (isTauri() ? "pending" : "unavailable"));
  const [info, setInfo] = useState<ScreenInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = status !== "pending" && status !== "unavailable";
  const generation = useRef(0);
  const mounted = useRef(false);
  const claim = useRef<ScreenClaim | null>(null);

  useEffect(() => {
    if (status !== "pending") return;
    let disposed = false;
    void nativeScreen.supported().then((native) => {
      if (!disposed) setStatus(native ? "idle" : "unavailable");
    });
    return () => { disposed = true; };
  }, [status]);

  const reset = useCallback(() => {
    generation.current += 1;
    setInfo(null);
    setStatus((current) => (current === "picking" || current === "live" ? "idle" : current));
  }, []);

  /** Releases the engine only while this test holds it: never ends a call's sharing. */
  const release = useCallback(() => {
    const held = claim.current;
    claim.current = null;
    // Also dismisses the picker if a start is still waiting on the user.
    held?.release();
  }, []);

  const stop = useCallback(() => {
    reset();
    release();
  }, [reset, release]);

  const start = useCallback(async (request: ScreenRequest) => {
    // Restarting replaces our own capture: that is not being taken over.
    claim.current = null;
    const mine: ScreenClaim = nativeScreen.claim(() => {
      if (claim.current !== mine) return;
      claim.current = null;
      reset();
      if (mounted.current) setError(TAKEN);
    });
    claim.current = mine;
    const attempt = ++generation.current;
    setStatus("picking");
    setInfo(null);
    setError(null);
    try {
      const shared = await nativeScreen.start(request);
      if (!mounted.current || generation.current !== attempt) return;
      setInfo(shared);
      setStatus(shared ? "live" : "idle");
      if (!shared && claim.current === mine) claim.current = null;
    } catch (cause) {
      if (!mounted.current || generation.current !== attempt) return;
      setError(errorMessage(cause));
      setStatus("idle");
      if (claim.current === mine) claim.current = null;
    }
  }, [reset]);

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
      release();
    };
  }, [supported, stop, release]);

  return { status, info, error, start, stop, previewFailed };
}
