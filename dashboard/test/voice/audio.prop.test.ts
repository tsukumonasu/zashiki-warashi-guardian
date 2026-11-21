// Feature: voice-conversation, Property 7: Audio gain (resampler half)
// **Validates: Requirements 12.3, 12.4, 12.5, 13.3**

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  base64ToPcm16,
  floatToPcm16,
  makeChunker,
  makeReorder,
  pcm16ToBase64,
  pcm16ToFloat,
  resampleTo16k,
} from "../../src/voice/audio";

const NUM_RUNS = 200;

const sampleArb = fc.oneof(
  fc.float({ min: -1, max: 1, noNaN: true }),
  fc.float({ min: -100, max: 100, noNaN: true }),
  fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, 1, -1),
);
const samplesArb = (max: number) =>
  fc.array(sampleArb, { maxLength: max }).map((a) => Float32Array.from(a));
const int16Arb = fc.array(fc.integer({ min: -32768, max: 32767 }), { maxLength: 400 }).map((a) => Int16Array.from(a));

describe("Feature: voice-conversation, Property 7: Audio gain (resampler half)", () => {
  it("resampleTo16k returns ceil(n*16000/rate) samples (within one), all in [-1, 1]", () => {
    fc.assert(
      fc.property(
        samplesArb(600),
        fc.oneof(fc.integer({ min: 4000, max: 192_000 }), fc.constantFrom(8000, 16_000, 24_000, 44_100, 48_000)),
        (input, rate) => {
          const out = resampleTo16k(input, rate);
          const expected = Math.ceil((input.length * 16_000) / rate);
          expect(Math.abs(out.length - expected)).toBeLessThanOrEqual(1);
          for (const v of out) {
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(-1);
            expect(v).toBeLessThanOrEqual(1);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("an invalid rate or empty input gives an empty result", () => {
    fc.assert(
      fc.property(samplesArb(50), fc.constantFrom(0, -1, Number.NaN, Infinity), (input, rate) => {
        expect(resampleTo16k(input, rate).length).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
    expect(resampleTo16k(new Float32Array(0), 48_000).length).toBe(0);
  });

  it("at 16 kHz the resampler keeps clamped samples unchanged", () => {
    fc.assert(
      fc.property(fc.array(fc.float({ min: -1, max: 1, noNaN: true }), { maxLength: 200 }), (a) => {
        const input = Float32Array.from(a);
        // `+ 0` folds -0 into 0: the resampler may return +0 for a -0 input.
        expect(Array.from(resampleTo16k(input, 16_000), (v) => v + 0)).toEqual(Array.from(input, (v) => v + 0));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("floatToPcm16 stays in the 16-bit range and pcm16ToFloat inverts it exactly", () => {
    fc.assert(
      fc.property(int16Arb, (pcm) => {
        expect(Array.from(floatToPcm16(pcm16ToFloat(pcm)))).toEqual(Array.from(pcm));
      }),
      { numRuns: NUM_RUNS },
    );
    fc.assert(
      fc.property(samplesArb(200), (input) => {
        const pcm = floatToPcm16(input);
        expect(pcm.length).toBe(input.length);
        input.forEach((x, i) => {
          const s = pcm[i] as number;
          if (!Number.isFinite(x)) expect(s).toBe(0);
          else if (x > 0) expect(s).toBeGreaterThanOrEqual(0);
          else if (x < 0) expect(s).toBeLessThanOrEqual(0);
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("pcm16 Base64 round trips, and odd byte counts or bad Base64 give null", () => {
    fc.assert(
      fc.property(int16Arb, (pcm) => {
        expect(Array.from(base64ToPcm16(pcm16ToBase64(pcm)) as Int16Array)).toEqual(Array.from(pcm));
      }),
      { numRuns: NUM_RUNS },
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (k) => {
        const odd = btoa("a".repeat(2 * k + 1));
        expect(base64ToPcm16(odd)).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
    expect(base64ToPcm16("!!not base64!!")).toBeNull();
  });

  it("the chunker emits exact-size chunks, keeps a short remainder and loses nothing", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 64 }),
        fc.array(int16Arb, { maxLength: 8 }),
        (size, pieces) => {
          const c = makeChunker(size);
          const chunks: Int16Array[] = [];
          for (const p of pieces) chunks.push(...c.push(p));
          for (const ch of chunks) expect(ch.length).toBe(size);
          expect(c.pending()).toBeLessThan(size);
          const total = pieces.reduce((n, p) => n + p.length, 0);
          expect(chunks.length * size + c.pending()).toBe(total);
          const flat = pieces.flatMap((p) => Array.from(p));
          expect(chunks.flatMap((ch) => Array.from(ch))).toEqual(flat.slice(0, chunks.length * size));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("the reorder window delivers increasing unique seq and counts every gap", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 1, maxLength: 80 }),
        (window, seqs) => {
          const r = makeReorder(window);
          const delivered: number[] = [];
          for (const s of seqs) {
            for (const f of r.push(s, `p${s}`)) {
              expect(f.pcm).toBe(`p${f.seq}`);
              delivered.push(f.seq);
            }
          }
          for (let i = 1; i < delivered.length; i++) {
            expect(delivered[i] as number).toBeGreaterThan(delivered[i - 1] as number);
          }
          if (delivered.length > 0) {
            const first = seqs[0] as number;
            const last = delivered[delivered.length - 1] as number;
            expect(delivered.length + r.missed()).toBe(last - first + 1);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
