// Feature: cloud-judgement, Property 2: Threshold soundness
// Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.13
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decideVerdict,
  type FaceQuality,
  type SearchOutcome,
  type VerdictConfig,
} from "../lambda/_shared/verdict.js";

const finite = { noNaN: true, noDefaultInfinity: true } as const;

/** Thresholds with searchFloor <= strangerMax <= familyMin, as the config loader enforces. */
const configArb: fc.Arbitrary<VerdictConfig> = fc
  .tuple(
    fc.double({ min: 0, max: 100, ...finite }),
    fc.double({ min: 0, max: 100, ...finite }),
    fc.double({ min: 0, max: 100, ...finite }),
  )
  .chain(([a, b, c]) => {
    const [searchFloor, strangerMax, familyMin] = [a, b, c].sort((x, y) => x - y) as [number, number, number];
    return fc.record({
      searchFloor: fc.constant(searchFloor),
      familyMin: fc.constant(familyMin),
      strangerMax: fc.constant(strangerMax),
      faceConfidenceMin: fc.double({ min: 0, max: 100, ...finite }),
      minFaceWidth: fc.double({ min: 0, max: 1, ...finite }),
      minSharpness: fc.double({ min: 0, max: 100, ...finite }),
      minBrightness: fc.double({ min: 0, max: 255, ...finite }),
      maxYawDeg: fc.double({ min: 0, max: 90, ...finite }),
      acceptMin: fc.double({ min: 0, max: 1, ...finite }),
    });
  });

/** A similarity placed on, just beside, or near one of the two thresholds, or anywhere, or null. */
function similarityArb(c: VerdictConfig): fc.Arbitrary<number | null> {
  const around = (t: number) =>
    fc
      .constantFrom(-1, -0.01, -1e-9, 0, 1e-9, 0.01, 1)
      .map((d) => Math.min(100, Math.max(0, t + d)));
  return fc.oneof(
    { arbitrary: around(c.familyMin), weight: 4 },
    { arbitrary: around(c.strangerMax), weight: 4 },
    { arbitrary: fc.double({ min: 0, max: 100, ...finite }), weight: 2 },
    { arbitrary: fc.constant(null), weight: 1 },
  );
}

/** A value on, just beside, or anywhere near a limit. */
function nearArb(limit: number, lo: number, hi: number): fc.Arbitrary<number> {
  return fc.oneof(
    fc.constantFrom(-1, -0.01, 0, 0.01, 1).map((d) => Math.min(hi, Math.max(lo, limit + d))),
    fc.double({ min: lo, max: hi, ...finite }),
  );
}

const inputArb = configArb.chain((c) =>
  fc.record({
    c: fc.constant(c),
    sim: similarityArb(c),
    faceConfidence: nearArb(c.faceConfidenceMin, 0, 100),
    box: fc.record({
      left: fc.double({ min: 0, max: 1, ...finite }),
      top: fc.double({ min: 0, max: 1, ...finite }),
      width: nearArb(c.minFaceWidth, 0, 1),
      height: fc.double({ min: 0, max: 1, ...finite }),
    }),
    q: fc.option(
      fc.record({
        sharpness: nearArb(c.minSharpness, 0, 100),
        brightness: nearArb(c.minBrightness, 0, 255),
        yawDeg: nearArb(c.maxYawDeg, 0, 90).chain((y) => fc.boolean().map((neg) => (neg ? -y : y))),
      }),
      { nil: null },
    ),
  }),
);

describe("verdict thresholds", () => {
  it("Feature: cloud-judgement, Property 2: Threshold soundness", () => {
    fc.assert(
      fc.property(inputArb, ({ c, sim, faceConfidence, box, q }) => {
        const s: SearchOutcome = { kind: "face", box, faceConfidence, bestSimilarity: sim };
        const quality: FaceQuality = q;
        const j = decideVerdict(s, quality, c);

        if (j.verdict === "family") {
          expect(sim).not.toBeNull();
          expect(sim as number).toBeGreaterThanOrEqual(c.familyMin);
        }
        if (j.verdict === "stranger") {
          if (sim !== null) expect(sim).toBeLessThan(c.strangerMax);
          expect(faceConfidence).toBeGreaterThanOrEqual(c.faceConfidenceMin);
          expect(box.width).toBeGreaterThanOrEqual(c.minFaceWidth);
          expect(quality).not.toBeNull();
          const qq = quality as NonNullable<FaceQuality>;
          expect(qq.sharpness).toBeGreaterThanOrEqual(c.minSharpness);
          expect(qq.brightness).toBeGreaterThanOrEqual(c.minBrightness);
          expect(Math.abs(qq.yawDeg)).toBeLessThanOrEqual(c.maxYawDeg);
        }
        if (sim !== null && sim >= c.strangerMax && sim < c.familyMin) {
          expect(j.verdict).not.toBe("family");
          expect(j.verdict).not.toBe("stranger");
        }
      }),
      { numRuns: 500 },
    );
  });
});
