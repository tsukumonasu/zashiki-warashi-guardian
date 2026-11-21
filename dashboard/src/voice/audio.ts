/**
 * Pure audio helpers for the browser voice client. No Web Audio, no clock, so they are testable
 * in jsdom. `worklet.ts` stays a thin processor that calls these functions.
 *
 * Formats (docs/schema.md): the browser sends 16 kHz S16LE mono and receives 24 kHz S16LE mono.
 */

export const TARGET_RATE = 16_000;
/** Chunk length in milliseconds, both directions (`chunkMs` in the design). */
export const CHUNK_MS = 100;
/** Samples in one 100 ms chunk at 16 kHz. */
export const CHUNK_SAMPLES = (TARGET_RATE * CHUNK_MS) / 1000;

function clamp1(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x > 1 ? 1 : x < -1 ? -1 : x;
}

/**
 * Resamples mono float samples to 16 kHz. Output length is `ceil(n * 16000 / rate)`.
 * Downsampling averages the source window of each output sample (a cheap low-pass that limits
 * aliasing); upsampling interpolates linearly. Every output value is in [-1, 1]; a non-finite
 * sample counts as silence. An invalid `rate` gives an empty result.
 */
export function resampleTo16k(input: Float32Array, rate: number): Float32Array {
  const n = input.length;
  if (n === 0 || !Number.isFinite(rate) || rate <= 0) return new Float32Array(0);
  const m = Math.ceil((n * TARGET_RATE) / rate);
  const out = new Float32Array(m);
  const ratio = rate / TARGET_RATE;
  for (let i = 0; i < m; i++) {
    const start = i * ratio;
    if (ratio > 1) {
      const from = Math.min(Math.floor(start), n - 1);
      const to = Math.min(Math.max(Math.ceil(start + ratio), from + 1), n);
      let sum = 0;
      for (let k = from; k < to; k++) sum += clamp1(input[k] as number);
      out[i] = clamp1(sum / (to - from));
    } else {
      const k = Math.min(Math.floor(start), n - 1);
      const next = Math.min(k + 1, n - 1);
      const frac = start - k;
      const a = clamp1(input[k] as number);
      const b = clamp1(input[next] as number);
      out[i] = clamp1(a + (b - a) * frac);
    }
  }
  return out;
}

/** Float [-1, 1] to signed 16-bit PCM, with clipping. A non-finite sample becomes 0. */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const x = clamp1(input[i] as number);
    out[i] = x < 0 ? Math.round(x * 32768) : Math.round(x * 32767);
  }
  return out;
}

/** Signed 16-bit PCM to float in [-1, 1]. */
export function pcm16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = input[i] as number;
    out[i] = s < 0 ? s / 32768 : s / 32767;
  }
  return out;
}

/** Base64 of S16LE bytes, independent of the platform byte order. */
export function pcm16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] as number, true);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary);
}

/** Decodes Base64 S16LE bytes. Returns null for invalid Base64 or an odd byte count. */
export function base64ToPcm16(b64: string): Int16Array | null {
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    return null;
  }
  if (binary.length % 2 !== 0) return null;
  const out = new Int16Array(binary.length / 2);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

export interface Chunker {
  /** Adds samples and returns every complete chunk, in order. */
  push(samples: Int16Array): Int16Array[];
  /** Samples held that do not yet fill a chunk. */
  pending(): number;
}

/** Cuts a stream of samples into fixed-size chunks (default 100 ms at 16 kHz). */
export function makeChunker(chunkSamples: number = CHUNK_SAMPLES): Chunker {
  const size = Number.isFinite(chunkSamples) ? Math.max(1, Math.floor(chunkSamples)) : CHUNK_SAMPLES;
  let buf = new Int16Array(0);
  return {
    push(samples) {
      const joined = new Int16Array(buf.length + samples.length);
      joined.set(buf, 0);
      joined.set(samples, buf.length);
      const out: Int16Array[] = [];
      let offset = 0;
      while (joined.length - offset >= size) {
        out.push(joined.slice(offset, offset + size));
        offset += size;
      }
      buf = joined.slice(offset);
      return out;
    },
    pending: () => buf.length,
  };
}

export interface Reorder {
  /** Frames now deliverable, in increasing `seq`, with no duplicates. */
  push(seq: number, pcm: string): readonly { seq: number; pcm: string }[];
  /** Number of sequence numbers given up on. */
  missed(): number;
}

/**
 * Sequence reorder window, same behaviour as `cloud/lambda/_shared/voice/reorder.ts`. Holds at
 * most `window` frames while waiting for a missing `seq`; then it skips the gap and counts it.
 * Frames behind the delivery point are dropped.
 */
export function makeReorder(window: number): Reorder {
  const size = Number.isFinite(window) ? Math.max(1, Math.floor(window)) : 1;
  const held = new Map<number, string>();
  let next: number | null = null;
  let missed = 0;

  function drain(out: { seq: number; pcm: string }[]): void {
    while (next !== null && held.has(next)) {
      out.push({ seq: next, pcm: held.get(next) as string });
      held.delete(next);
      next += 1;
    }
  }

  return {
    push(seq, pcm) {
      if (!Number.isSafeInteger(seq) || seq < 0) return [];
      if (next === null) next = seq;
      if (seq < next || held.has(seq)) return [];
      held.set(seq, pcm);
      const out: { seq: number; pcm: string }[] = [];
      drain(out);
      while (held.size > size) {
        const lowest = Math.min(...held.keys());
        missed += lowest - (next as number);
        next = lowest;
        drain(out);
      }
      return out;
    },
    missed: () => missed,
  };
}
