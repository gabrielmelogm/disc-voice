import { nativeCamera } from "../lib/nativeCamera";
import { NativeFramePreview } from "./NativeFramePreview";

/** Live preview of the native camera (Linux). */
export function NativeCameraPreview({ active, mirrored, onError }: {
  active: boolean;
  mirrored: boolean;
  onError: (message?: string) => void;
}) {
  return (
    <NativeFramePreview
      active={active}
      pull={nativeCamera.frame}
      label="Prévia ao vivo da webcam"
      mirrored={mirrored}
      onError={onError}
    />
  );
}
