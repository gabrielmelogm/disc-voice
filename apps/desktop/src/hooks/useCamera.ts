import { useCallback, useEffect, useRef, useState } from "react";
import { CameraSession, cameraError } from "../lib/camera";
import { selectDevice } from "../lib/audio";

export function useCamera() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<MediaTrackSettings>({});
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

  const previewFailed = useCallback(() => {
    stop();
    setError("Não foi possível exibir o vídeo. Tente iniciar a webcam novamente.");
  }, [stop]);

  useEffect(() => {
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
  }, [refresh, stop]);

  return { devices, deviceId, setDeviceId, stream, busy, error, settings, refresh, start, stop, previewFailed };
}
