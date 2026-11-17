export function cameraError(error: unknown): string {
  // DOMException is not an Error in every WebView/realm.
  const name = typeof error === "object" && error !== null && "name" in error
    ? String(error.name)
    : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Acesso à câmera negado. Permita a câmera no WebView2 e em Configurações do Windows → Privacidade e segurança → Câmera → Permitir que aplicativos da área de trabalho acessem a câmera.";
    case "NotFoundError":
      return "Nenhuma webcam foi encontrada. Conecte uma câmera e atualize os dispositivos.";
    case "NotReadableError":
      return "Não foi possível abrir a webcam. Verifique se outro aplicativo está usando a câmera.";
    case "OverconstrainedError":
      return "A câmera selecionada não está disponível. Atualize os dispositivos e selecione novamente.";
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

export function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * getUserMedia cannot be aborted. An epoch makes late permission responses
 * release their tracks instead of reactivating a stopped/unmounted camera.
 */
export class CameraSession {
  private epoch = 0;
  private stream: MediaStream | null = null;

  constructor(private media: Pick<MediaDevices, "getUserMedia">) {}

  async start(deviceId: string): Promise<MediaStream | null> {
    this.stop();
    const epoch = this.epoch;
    const stream = await this.media.getUserMedia({
      audio: false,
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    if (epoch !== this.epoch) {
      stopStream(stream);
      return null;
    }
    this.stream = stream;
    return stream;
  }

  stop() {
    this.epoch += 1;
    stopStream(this.stream);
    this.stream = null;
  }
}
