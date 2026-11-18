import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

/** A `voice.signal` payload, in the browser's JSON format. */
export interface SignalData {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

export type CallEvent =
  | { type: "signal"; peerId: string; data: SignalData }
  | { type: "peerState"; peerId: string; state: RTCPeerConnectionState }
  | { type: "speaking"; peerIds: string[] }
  | { type: "screen"; peerId: string; active: boolean }
  | { type: "screenEnded"; message: string }
  | { type: "error"; message: string };

export interface CallDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface CallConfig {
  iceServers: RTCIceServer[];
  /** PulseAudio names; empty for the system default. */
  inputId: string;
  outputId: string;
  muted: boolean;
  deafened: boolean;
}

/**
 * Calls run in Rust on Linux: WebKitGTK is built without WebRTC (there is no
 * RTCPeerConnection). The engine owns the peer connections, microphone,
 * speakers and screen encoding; the page relays its signaling and draws the
 * screens it receives (JPEG frames, like the native camera).
 */
export const nativeCall = {
  supported: async () => isTauri() && (await invoke<boolean>("call_native").catch(() => false)),
  /** Opens the microphone and speakers; resolves to the call's ID. */
  join(config: CallConfig, onEvent: (event: CallEvent) => void) {
    const channel = new Channel<CallEvent>();
    channel.onmessage = onEvent;
    return invoke<number>("call_join", { config, onEvent: channel });
  },
  /** Ends call `id`; a late leave never ends the call that replaced it. */
  leave: (id?: number) => invoke<void>("call_leave", { id: id ?? null }),
  /** Connects to exactly these peers. */
  peers: (selfId: string, peerIds: string[]) => invoke<void>("call_peers", { selfId, peerIds }),
  signal: (peerId: string, data: SignalData) => invoke<void>("call_signal", { peerId, data }),
  mute: (muted: boolean) => invoke<void>("call_mute", { muted }),
  deafen: (deafened: boolean) => invoke<void>("call_deafen", { deafened }),
  setInput: (inputId: string) => invoke<void>("call_set_input", { inputId }),
  setOutput: (outputId: string) => invoke<void>("call_set_output", { outputId }),
  devices: () => invoke<{ inputs: CallDevice[]; outputs: CallDevice[] }>("call_devices"),
  /** Sends what the screen engine captures (after its picker) to the call. */
  startScreen: (frameRate: number) => invoke<void>("call_screen_start", { frameRate }),
  stopScreen: () => invoke<void>("call_screen_stop"),
  /** Next JPEG of a peer's screen; empty when none arrived in time. */
  frame: (peerId: string) => invoke<ArrayBuffer>("call_screen_frame", { peerId }),
};

/** Native devices in the shape the call settings list (MediaDeviceInfo). */
export function deviceInfos(devices: { inputs: CallDevice[]; outputs: CallDevice[] }): MediaDeviceInfo[] {
  const info = (kind: MediaDeviceKind) => (device: CallDevice) =>
    ({ deviceId: device.id, groupId: "", kind, label: device.name, toJSON: () => ({}) }) as MediaDeviceInfo;
  return [...devices.inputs.map(info("audioinput")), ...devices.outputs.map(info("audiooutput"))];
}
