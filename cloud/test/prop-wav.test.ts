// Feature: cloud-judgement, Property 17: WAV wrapper
// Validates: Requirements 7.10, 7.11, 22.6
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pcm16ToWav } from "../lambda/_shared/wav.js";

const rateArb = fc.constantFrom<16000 | 8000>(16000, 8000);

/** Raw PCM with an even length (whole 16-bit samples). */
const evenPcmArb = fc
  .uint8Array({ maxLength: 2000 })
  .map((bytes) => bytes.slice(0, bytes.length - (bytes.length % 2)));

/** Raw PCM with an odd length. */
const oddPcmArb = evenPcmArb.chain((even) =>
  fc.uint8Array({ minLength: 1, maxLength: 1 }).map((one) => {
    const out = new Uint8Array(even.length + 1);
    out.set(even);
    out.set(one, even.length);
    return out;
  }),
);

const text = (bytes: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...bytes.slice(start, end));

describe("Feature: cloud-judgement, Property 17: WAV wrapper", () => {
  it("wraps even-length PCM in a consistent 44-byte header followed by the original bytes", () => {
    fc.assert(
      fc.property(evenPcmArb, rateArb, (pcm, rate) => {
        const wav = pcm16ToWav(pcm, rate);
        const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

        expect(wav.length).toBe(44 + pcm.length);
        expect(text(wav, 0, 4)).toBe("RIFF");
        expect(view.getUint32(4, true)).toBe(36 + pcm.length);
        expect(text(wav, 8, 12)).toBe("WAVE");
        expect(text(wav, 12, 16)).toBe("fmt ");
        expect(view.getUint32(16, true)).toBe(16);
        expect(view.getUint16(20, true)).toBe(1);
        expect(view.getUint16(22, true)).toBe(1);
        expect(view.getUint32(24, true)).toBe(rate);
        expect(view.getUint32(28, true)).toBe(rate * 2);
        expect(view.getUint16(32, true)).toBe(2);
        expect(view.getUint16(34, true)).toBe(16);
        expect(text(wav, 36, 40)).toBe("data");
        expect(view.getUint32(40, true)).toBe(pcm.length);
        expect(Array.from(wav.slice(44))).toEqual(Array.from(pcm));
      }),
      { numRuns: 100 },
    );
  });

  it("rejects odd-length PCM and returns no bytes", () => {
    fc.assert(
      fc.property(oddPcmArb, rateArb, (pcm, rate) => {
        expect(() => pcm16ToWav(pcm, rate)).toThrow();
      }),
      { numRuns: 100 },
    );
  });
});
