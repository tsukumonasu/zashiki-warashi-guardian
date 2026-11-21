// Feature: cloud-judgement, Property 3: Monotonicity
// Validates: Requirements 5.15
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decideVerdict,
  type FaceBox,
  type FaceQuality,
  type VerdictConfig,
} from "../lambda/_shared/verdict.js";

const pctArb = fc.double({ min: 0, max: 100, noNaN: true });
const fractionArb = fc.double({ min: 0, max: 1, noNaN: true });

/** Thresholds obey searchFloor <= strangerMax <= familyMin (R5.16). */
const configArb: fc.Arbitrary<VerdictConfig> = fc
  .tuple(fc.tuple(pctArb, pctArb, pctArb), pctArb, fractionArb, fc.double({ min: 0, max: 255, noNaN: true }), fc.double({ min: 0, max: 255, noNaN: true }), fc.double({ min: 0, max: 90, noNaN: true }), fractionArb)
  .map(([bands, faceConfidenceMin, minFaceWidth, minSharpness, minBrightness, maxYawDeg, acceptMin]) => {
    const [searchFloor, strangerMax, familyMin] = [...bands].sort((a, b) => a - b) as [number, number, number];
    return { searchFloor, strangerMax, familyMin, faceConfidenceMin, minFaceWidth, minSharpness, minBrightness, maxYawDeg, acceptMin };
  });

const boxArb: fc.Arbitrary<FaceBox> = fc.record({
  left: fractionArb,
  top: fractionArb,
  width: fractionArb,
  height: fractionArb,
});

const qualityArb: fc.Arbitrary<FaceQuality> = fc.option(
  fc.record({
    sharpness: fc.double({ min: 0, max: 255, noNaN: true }),
    brightness: fc.double({ min: 0, max: 255, noNaN: true }),
    yawDeg: fc.double({ min: -90, max: 90, noNaN: true }),
  }),
  { nil: null },
);

describe("Feature: cloud-judgement, Property 3: Monotonicity", () => {
  it("raising bestSimilarity never moves family to a non-family verdict", () => {
    fc.assert(
      fc.property(
        configArb,
        boxArb,
        pctArb,
        qualityArb,
        pctArb,
        pctArb,
        (config, box, faceConfidence, quality, a, b) => {
          const [low, high] = a <= b ? [a, b] : [b, a];
          const before = decideVerdict({ kind: "face", box, faceConfidence, bestSimilarity: low }, quality, config);
          const after = decideVerdict({ kind: "face", box, faceConfidence, bestSimilarity: high }, quality, config);
          if (before.verdict === "family") expect(after.verdict).toBe("family");
        },
      ),
      { numRuns: 500 },
    );
  });

  it("a null similarity that decides family cannot happen, and family at a value stays family above it", () => {
    const config: VerdictConfig = {
      searchFloor: 50, strangerMax: 70, familyMin: 90, faceConfidenceMin: 90,
      minFaceWidth: 0.08, minSharpness: 0, minBrightness: 0, maxYawDeg: 90, acceptMin: 0.8,
    };
    const box: FaceBox = { left: 0.4, top: 0.4, width: 0.2, height: 0.2 };
    const verdictAt = (sim: number | null) =>
      decideVerdict({ kind: "face", box, faceConfidence: 99, bestSimilarity: sim }, null, config).verdict;
    expect(verdictAt(90)).toBe("family");
    expect(verdictAt(100)).toBe("family");
    expect(verdictAt(null)).not.toBe("family");
  });
});
