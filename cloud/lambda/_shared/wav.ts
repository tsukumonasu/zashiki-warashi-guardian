/**
 * WAV wrapper for raw PCM from Polly (`OutputFormat: pcm`), which has no header.
 * The device plays only 16-bit PCM WAV through `aplay`, so the cloud adds the header.
 * Pure: no AWS imports, no I/O.
 */

const HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

/**
 * Wrap raw 16-bit mono little-endian PCM in a 44-byte RIFF/WAVE header.
 *
 * Throws (and returns no bytes) when the PCM length is odd, because a 16-bit
 * sample cannot be half a byte, or when the sample rate is not 8,000 or 16,000
 * (the rates Polly allows for `pcm`).
 */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: 16000 | 8000): Uint8Array {
  if (sampleRate !== 8000 && sampleRate !== 16000) {
    throw new RangeError("sampleRate must be 8000 or 16000");
  }
  if (pcm.length % BYTES_PER_SAMPLE !== 0) {
    throw new RangeError("PCM length must be even (16-bit samples)");
  }

  const out = new Uint8Array(HEADER_BYTES + pcm.length);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      out[offset + i] = text.charCodeAt(i);
    }
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // format 1 = PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, HEADER_BYTES);
  return out;
}
