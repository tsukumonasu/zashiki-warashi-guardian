/**
 * AudioWorklet processor for microphone capture. Thin on purpose: it only collects the 128-sample
 * blocks of the browser, and `audio.ts` does the work (resample to 16 kHz, convert to S16, cut
 * into 100 ms chunks). Each finished chunk is posted to the main thread as an `ArrayBuffer`.
 *
 * Loaded through `browserAudio.ts` with Vite's `?worker&url` import, which bundles this file and
 * `audio.ts` into one classic script.
 */
import { CHUNK_MS, floatToPcm16, makeChunker, resampleTo16k } from "./audio";

// The AudioWorklet global scope is not in the DOM lib types.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

export const CAPTURE_PROCESSOR = "warashi-capture";

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly chunker = makeChunker();
  private readonly windowSamples = Math.max(1, Math.round((sampleRate * CHUNK_MS) / 1000));
  private block = new Float32Array(this.windowSamples);
  private filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (channel === undefined) return true;
    let offset = 0;
    while (offset < channel.length) {
      const n = Math.min(channel.length - offset, this.windowSamples - this.filled);
      this.block.set(channel.subarray(offset, offset + n), this.filled);
      this.filled += n;
      offset += n;
      if (this.filled === this.windowSamples) {
        const pcm = floatToPcm16(resampleTo16k(this.block, sampleRate));
        for (const chunk of this.chunker.push(pcm)) {
          // Copy the bytes out: the chunk may be a view on a larger buffer.
          this.port.postMessage(chunk.slice().buffer);
        }
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor(CAPTURE_PROCESSOR, CaptureProcessor);
