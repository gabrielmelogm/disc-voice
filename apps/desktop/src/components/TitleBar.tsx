import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";

/**
 * Window title bar drawn by the app where the native one is turned off
 * (Windows), so the frame follows the app theme instead of the system's.
 */
export function TitleBar() {
  const [custom, setCustom] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    const window = getCurrentWindow();
    let active = true;
    let unlisten: (() => void) | undefined;
    const sync = () => window.isMaximized().then(value => { if (active) setMaximized(value); }).catch(() => {});
    void window.isDecorated().then(decorated => {
      if (!active || decorated) return;
      setCustom(true);
      void sync();
      void window.onResized(() => void sync()).then(stop => {
        if (active) unlisten = stop; else stop();
      });
    }).catch(() => {});
    return () => { active = false; unlisten?.(); };
  }, []);

  if (!custom) return null;
  const window = getCurrentWindow();
  return <header className="window-titlebar" data-tauri-drag-region>
    <span className="window-title" data-tauri-drag-region>
      <img src="/app-icon.png" alt="" width={16} height={16} data-tauri-drag-region />
      Disc Voice
    </span>
    <div className="window-controls">
      <button className="window-control" aria-label="Minimizar" title="Minimizar" onClick={() => void window.minimize()}><Minus size={16} /></button>
      <button className="window-control" aria-label={maximized ? "Restaurar" : "Maximizar"} title={maximized ? "Restaurar" : "Maximizar"}
        onClick={() => void window.toggleMaximize()}>{maximized ? <Copy size={13} /> : <Square size={13} />}</button>
      <button className="window-control close" aria-label="Fechar" title="Fechar" onClick={() => void window.close()}><X size={17} /></button>
    </div>
  </header>;
}
