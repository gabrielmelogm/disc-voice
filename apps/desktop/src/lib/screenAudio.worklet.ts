/**
 * Plays the computer's audio, arriving from Rust in 20 ms blocks, as a
 * steady stream: blocks are queued and read 128 frames at a time. It starts
 * once a small cushion is buffered, and drops what piles up past a limit, so
 * the delay never grows.
 */

// The AudioWorkletGlobalScope is not in the DOM typings.
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

const RATE = 48_000;
/** Start (or resume) once this much is queued... */
const PRIME = (RATE / 1000) * 40 * 2;
/** ...and drop down to it past this. Interleaved stereo samples. */
const MAX = (RATE / 1000) * 200 * 2;

class ScreenAudioProcessor extends AudioWorkletProcessor {
  private blocks: Float32Array[] = [];
  /** Read position in the first block. */
  private offset = 0;
  private queued = 0;
  private playing = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<Float32Array>) => {
      this.blocks.push(event.data);
      this.queued += event.data.length;
      while (this.queued > MAX && this.blocks.length > 1) {
        const dropped = this.blocks.shift()!;
        this.queued -= dropped.length - this.offset;
        this.offset = 0;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const [left, right = left] = outputs[0] ?? [];
    if (!left) return true;
    if (!this.playing && this.queued >= PRIME) this.playing = true;
    if (!this.playing) return true;
    for (let frame = 0; frame < left.length; frame++) {
      const block = this.blocks[0];
      if (!block) {
        // Ran dry: wait for a cushion again instead of crackling.
        this.playing = false;
        break;
      }
      left[frame] = block[this.offset];
      right[frame] = block[this.offset + 1];
      this.offset += 2;
      this.queued -= 2;
      if (this.offset >= block.length) {
        this.blocks.shift();
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("disc-screen-audio", ScreenAudioProcessor);
