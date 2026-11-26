import workletUrl from "./screenAudio.worklet.ts?worker&url";

export interface ScreenAudio {
  track: MediaStreamTrack;
  stop: () => void;
}

export interface SystemAudioSource {
  /** Starts the capture; each call of `onAudio` is interleaved stereo at 48 kHz. */
  start: (onAudio: (samples: Float32Array) => void) => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Turns the computer's audio, captured in Rust without this app's own sound
 * (so the call is never sent back), into a WebRTC audio track. The track
 * comes from Web Audio, not getUserMedia: no echo cancellation or noise
 * suppression touches the music.
 */
export async function screenAudio(source: SystemAudioSource): Promise<ScreenAudio> {
  if (typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") {
    throw new Error("Este ambiente não consegue enviar o áudio do computador pela chamada.");
  }
  const context = new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" });
  let started = false;
  const close = () => {
    void context.close().catch(() => {});
    if (started) void source.stop().catch(() => {});
  };
  try {
    await context.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(context, "disc-screen-audio", { numberOfInputs: 0, outputChannelCount: [2] });
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 2;
    node.connect(destination);
    const track = destination.stream.getAudioTracks()[0];
    if (!track) throw new Error("Este ambiente não consegue enviar o áudio do computador pela chamada.");
    // Favors fidelity: it is music or a movie, not a voice.
    track.contentHint = "music";
    await source.start(samples => node.port.postMessage(samples, [samples.buffer]));
    started = true;
    void context.resume().catch(() => {});
    return {
      track,
      stop: () => {
        node.port.onmessage = null;
        node.disconnect();
        track.stop();
        close();
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}

/**
 * Lets Opus carry stereo (the screen's music) in a remote description:
 * browsers only send stereo to a peer that says it receives it. Voice stays
 * mono inside it.
 */
export function opusStereo(sdp: string): string {
  const opus = new Set([...sdp.matchAll(/^a=rtpmap:(\d+) opus\/48000\/2\r?$/gim)].map(match => match[1]));
  if (!opus.size) return sdp;
  return sdp.replace(/^a=fmtp:(\d+) ([^\r\n]*)/gm, (line, payload: string, parameters: string) => {
    if (!opus.has(payload)) return line;
    const extra = ["stereo=1", "sprop-stereo=1"].filter(parameter => !parameters.split(";").includes(parameter));
    return extra.length ? `${line};${extra.join(";")}` : line;
  });
}
