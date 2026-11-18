import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { CameraSession, cameraError } from "../lib/camera";
import { errorMessage, selectDevice } from "../lib/audio";
import { nativeCamera } from "../lib/nativeCamera";

export interface CameraOption {
  deviceId: string;
  label: string;
}

export interface CameraSettings {
  deviceId?: string;
  width?: number;
  height?: number;
  frameRate?: number;
}

export interface CameraController {
  /** Frames come from the native engine and are drawn on a canvas. */
  native: boolean;
  devices: CameraOption[];
  deviceId: string;
  setDeviceId: (deviceId: string) => void;
  /** getUserMedia stream (browser mode only). */
  stream: MediaStream | null;
  /** The camera is capturing, in either mode. */
  live: boolean;
  busy: boolean;
  error: string | null;
  settings: CameraSettings;
  refresh: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => void;
  previewFailed: (message?: string) => void;
}

type Mode = "pending" | "browser" | "native";

const PREVIEW_FAILED = "Não foi possível exibir o vídeo. Tente iniciar a webcam novamente.";

function useCameraMode(): Mode {
  const [mode, setMode] = useState<Mode>(() => (isTauri() ? "pending" : "browser"));
  useEffect(() => {
    if (mode !== "pending") return;
    let disposed = false;
    void nativeCamera.supported().then((native) => {
      if (!disposed) setMode(native ? "native" : "browser");
    });
    return () => { disposed = true; };
  }, [mode]);
  return mode;
}

export function useCamera(): CameraController {
  const mode = useCameraMode();
  const browser = useBrowserCamera(mode === "browser");
  const native = useNativeCamera(mode === "native");
  return mode === "native" ? native : browser;
}

function useBrowserCamera(enabled: boolean): CameraController {
  const [devices, setDevices] = useState<CameraOption[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<CameraSettings>({});
  const session = useRef<CameraSession | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    try {
      if (!navigator.mediaDevices) throw new Error("A câmera precisa do WebView2 atualizado e de um contexto seguro.");
      const found = (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === "videoinput");
      if (!mounted.current) return;
      setDevices(found);
      setDeviceId((current) => selectDevice(found.map((d) => ({ id: d.deviceId })), current));
    } catch (cause) {
      if (mounted.current) setError(cameraError(cause));
    }
  }, []);

  const stop = useCallback(() => {
    generation.current += 1;
    pending.current = false;
    session.current?.stop();
    setStream(null);
    setSettings({});
    setBusy(false);
  }, []);

  const start = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      if (!session.current) throw new Error("A câmera não está disponível neste ambiente.");
      const next = await session.current.start(deviceId);
      if (!mounted.current || generation.current !== request || !next) return;
      const track = next.getVideoTracks()[0];
      if (!track) throw new Error("A webcam não forneceu uma faixa de vídeo.");
      track.addEventListener("ended", () => {
        if (!mounted.current || generation.current !== request) return;
        stop();
        setError("A webcam foi desconectada ou o acesso à câmera foi interrompido.");
        void refresh();
      }, { once: true });
      setSettings(track.getSettings());
      setDeviceId(track.getSettings().deviceId ?? deviceId);
      setStream(next);
      await refresh();
    } catch (cause) {
      if (mounted.current && generation.current === request) {
        session.current?.stop();
        setStream(null);
        setError(cameraError(cause));
      }
    } finally {
      if (mounted.current && generation.current === request) {
        pending.current = false;
        setBusy(false);
      }
    }
  }, [deviceId, refresh, stop]);

  const previewFailed = useCallback((message?: string) => {
    stop();
    setError(message ?? PREVIEW_FAILED);
  }, [stop]);

  useEffect(() => {
    if (!enabled) return;
    mounted.current = true;
    const media = navigator.mediaDevices;
    session.current = media ? new CameraSession(media) : null;
    void refresh();
    media?.addEventListener("devicechange", refresh);
    window.addEventListener("pagehide", stop);
    return () => {
      mounted.current = false;
      generation.current += 1;
      pending.current = false;
      session.current?.stop();
      media?.removeEventListener("devicechange", refresh);
      window.removeEventListener("pagehide", stop);
    };
  }, [enabled, refresh, stop]);

  return {
    native: false, devices, deviceId, setDeviceId, stream, live: !!stream,
    busy, error, settings, refresh, start, stop, previewFailed,
  };
}

function useNativeCamera(enabled: boolean): CameraController {
  const [devices, setDevices] = useState<CameraOption[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<CameraSettings>({});
  const generation = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const found = await nativeCamera.devices();
      if (!mounted.current) return;
      setDevices(found.map((device) => ({ deviceId: device.id, label: device.name })));
      setDeviceId((current) => selectDevice(found, current));
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    }
  }, []);

  const stop = useCallback(() => {
    generation.current += 1;
    pending.current = false;
    setLive(false);
    setSettings({});
    setBusy(false);
    void nativeCamera.stop().catch(() => {});
  }, []);

  const start = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const info = await nativeCamera.start(deviceId);
      if (!mounted.current || generation.current !== request) {
        // Cancelled while the camera was opening: release it again.
        void nativeCamera.stop().catch(() => {});
        return;
      }
      setSettings({ deviceId: info.deviceId, width: info.width, height: info.height, frameRate: info.frameRate });
      setDeviceId(info.deviceId);
      setLive(true);
    } catch (cause) {
      if (mounted.current && generation.current === request) setError(errorMessage(cause));
    } finally {
      if (mounted.current && generation.current === request) {
        pending.current = false;
        setBusy(false);
      }
    }
  }, [deviceId]);

  const previewFailed = useCallback((message?: string) => {
    stop();
    setError(message ?? PREVIEW_FAILED);
  }, [stop]);

  useEffect(() => {
    if (!enabled) return;
    mounted.current = true;
    void refresh();
    window.addEventListener("pagehide", stop);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", stop);
      stop();
    };
  }, [enabled, refresh, stop]);

  return {
    native: true, devices, deviceId, setDeviceId, stream: null, live,
    busy, error, settings, refresh, start, stop, previewFailed,
  };
}
