import { useCallback, useEffect, useRef, useState } from "react";
import {
  INITIAL_AUDIO_STATUS,
  type AudioAction,
  type AudioDevices,
  type AudioStatus,
} from "@disc-voice/shared";
import { errorMessage, nativeAudio, selectDevice } from "../lib/audio";

export function useAudio() {
  const available = nativeAudio.available();
  const [devices, setDevices] = useState<AudioDevices>({ inputs: [], outputs: [] });
  const [inputId, setInputId] = useState("");
  const [outputId, setOutputId] = useState("");
  const [status, setStatus] = useState(INITIAL_AUDIO_STATUS);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const actionPending = useRef(false);
  const refreshPending = useRef(false);

  const acceptStatus = useCallback((next: AudioStatus) => {
    setStatus((current) => next.sequence >= current.sequence ? next : current);
  }, []);

  const refresh = useCallback(async () => {
    if (!available || refreshPending.current) return;
    refreshPending.current = true;
    setRefreshing(true);
    try {
      const next = await nativeAudio.devices();
      setDevices(next);
      setInputId((current) => selectDevice(next.inputs, current));
      setOutputId((current) => selectDevice(next.outputs, current));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      refreshPending.current = false;
      setRefreshing(false);
    }
  }, [available]);

  const act = useCallback(async (action: AudioAction) => {
    if (!available || actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setError(null);
    try {
      acceptStatus(await nativeAudio.action(action));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }, [available, acceptStatus]);

  useEffect(() => {
    if (!available) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    void refresh();
    const poll = async () => {
      try {
        const next = await nativeAudio.status();
        if (!disposed) acceptStatus(next);
      } catch (cause) {
        if (!disposed) setError(errorMessage(cause));
      } finally {
        if (!disposed) timer = setTimeout(poll, 100);
      }
    };
    void poll();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    // The native window also shuts down the worker. This covers React/HMR teardown.
    const stop = () => { void nativeAudio.action({ type: "stopAll" }).catch(() => {}); };
    window.addEventListener("pagehide", stop);
    return () => {
      disposed = true;
      clearTimeout(timer);
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
      window.removeEventListener("pagehide", stop);
      stop();
    };
  }, [available, refresh, acceptStatus]);

  return {
    available, devices, inputId, outputId, setInputId, setOutputId,
    status, error: error ?? status.error, busy, refreshing, refresh, act,
  };
}
