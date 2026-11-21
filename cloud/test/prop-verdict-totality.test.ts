// Feature: cloud-judgement, Property 1: Verdict totality
// Validates: Requirements 5.11, 5.12
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decideVerdict,
  type AdapterFailure,
  type FaceBox,
  type FaceQuality,
  type SearchOutcome,
  type Verdict,
  type VerdictConfig,
} from "../lambda/_shared/verdict.js";

const VERDICTS: readonly Verdict[] = ["family", "stranger", "no_face", "uncertain"];

/** Mostly in-range fractions, plus out-of-range and non-finite values an adapter might hand over. */
const fractionArb = fc.oneof(
  { weight: 6, arbitrary: fc.double({ min: 0, max: 1, noNaN: true }) },
  { weight: 2, arbitrary: fc.double({ min: -10, max: 10, noNaN: true, noDefaultInfinity: true }) },
  { weight: 1, arbitrary: fc.constantFrom(NaN, Infinity, -Infinity) },
);
const boxArb: fc.Arbitrary<FaceBox> = fc.record({
  left: fractionArb,
  top: fractionArb,
  width: fractionArb,
  height: fractionArb,
});
const score100Arb = fc.double({ min: 0, max: 100, noNaN: true });

const outcomeArb: fc.Arbitrary<SearchOutcome | AdapterFailure> = fc.oneof(
  fc.constant<SearchOutcome>({ kind: "no_face" }),
  fc.constantFrom<AdapterFailure["stage"]>("search", "detect", "store").map(
    (stage): AdapterFailure => ({ kind: "failure", stage }),
  ),
  fc.record({
    kind: fc.constant("face" as const),
    box: boxArb,
    faceConfidence: score100Arb,
    bestSimilarity: fc.option(score100Arb, { nil: null }),
  }),
);

const qualityArb: fc.Arbitrary<FaceQuality> = fc.option(
  fc.record({
    sharpness: fc.double({ min: 0, max: 255, noNaN: true }),
    brightness: fc.double({ min: 0, max: 255, noNaN: true }),
    yawDeg: fc.double({ min: -90, max: 90, noNaN: true }),
  }),
  { nil: null },
);

/** Valid config: searchFloor <= strangerMax <= familyMin <= 100 (R5.16). */
const configArb: fc.Arbitrary<VerdictConfig> = fc
  .tuple(score100Arb, score100Arb, score100Arb)
  .map((t) => t.sort((a, b) => a - b))
  .chain(([searchFloor, strangerMax, familyMin]) =>
    fc.record({
      searchFloor: fc.constant(searchFloor),
      strangerMax: fc.constant(strangerMax),
      familyMin: fc.constant(familyMin),
      faceConfidenceMin: score100Arb,
      minFaceWidth: fc.double({ min: 0, max: 1, noNaN: true }),
      minSharpness: fc.double({ min: 0, max: 255, noNaN: true }),
      minBrightness: fc.double({ min: 0, max: 255, noNaN: true }),
      maxYawDeg: fc.double({ min: 0, max: 90, noNaN: true }),
      acceptMin: fc.double({ min: 0, max: 1, noNaN: true }),
    }),
  );

const inUnit = (n: number): boolean => Number.isFinite(n) && n >= 0 && n <= 1;

describe("Feature: cloud-judgement, Property 1: Verdict totality", () => {
  it("Feature: cloud-judgement, Property 1: Verdict totality (verdict, confidence, face, box)", () => {
    fc.assert(
      fc.property(outcomeArb, qualityArb, configArb, (outcome, quality, config) => {
        const j = decideVerdict(outcome, quality, config);

        expect(VERDICTS).toContain(j.verdict);
        expect(typeof j.confidence).toBe("number");
        expect(inUnit(j.confidence)).toBe(true);

        // face is null exactly when the verdict is no_face... except failures, which are uncertain with no face
        if (j.verdict === "no_face") {
          expect(j.face).toBeNull();
        } else if (outcome.kind !== "failure") {
          expect(j.face).not.toBeNull();
        }
        if (j.face !== null) {
          for (const v of [j.face.left, j.face.top, j.face.width, j.face.height]) {
            expect(inUnit(v)).toBe(true);
          }
        }
      }),
      { numRuns: 500 },
    );
  });
});
