// Feature: cloud-judgement, Property 5: Device-accept consistency
// Validates: Requirements 5.14
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../lambda/_shared/config.js";
import {
  decideVerdict,
  type AdapterFailure,
  type FaceQuality,
  type SearchOutcome,
  type VerdictConfig,
} from "../lambda/_shared/verdict.js";

const NUM_RUNS = 500;

const fraction = fc.double({ min: 0, max: 1, noNaN: true });
const percent = fc.double({ min: 0, max: 100, noNaN: true });
const wide = fc.double({ min: -1000, max: 1000, noNaN: true });

const configArb: fc.Arbitrary<VerdictConfig> = fc.record({
  searchFloor: percent,
  familyMin: percent,
  strangerMax: percent,
  faceConfidenceMin: percent,
  minFaceWidth: fraction,
  minSharpness: fc.double({ min: 0, max: 255, noNaN: true }),
  minBrightness: fc.double({ min: 0, max: 255, noNaN: true }),
  maxYawDeg: fc.double({ min: 0, max: 90, noNaN: true }),
  acceptMin: fraction,
});

const boxArb = fc.record({ left: wide, top: wide, width: wide, height: wide });

const outcomeArb: fc.Arbitrary<SearchOutcome | AdapterFailure> = fc.oneof(
  fc.constant<SearchOutcome>({ kind: "no_face" }),
  fc.constant<AdapterFailure>({ kind: "failure", stage: "search" }),
  fc.record({
    kind: fc.constant("face" as const),
    box: boxArb,
    faceConfidence: fc.double({ min: 0, max: 120, noNaN: true }),
    bestSimilarity: fc.option(fc.double({ min: 0, max: 120, noNaN: true }), { nil: null }),
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

describe("verdict device-accept consistency", () => {
  it("Feature: cloud-judgement, Property 5: Device-accept consistency", () => {
    fc.assert(
      fc.property(outcomeArb, qualityArb, configArb, (outcome, quality, config) => {
        const j = decideVerdict(outcome, quality, config);
        if (j.verdict === "family" || j.verdict === "stranger") {
          expect(j.confidence).toBeGreaterThanOrEqual(config.acceptMin);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: cloud-judgement, Property 5: Device-accept consistency (default config mirrors the device's 0.80)", () => {
    // device/warashi_agent/config.py: JudgementConfig.family_confidence_min = 0.80
    expect(DEFAULT_CONFIG.acceptMin).toBe(0.8);
    fc.assert(
      fc.property(outcomeArb, qualityArb, (outcome, quality) => {
        const j = decideVerdict(outcome, quality, DEFAULT_CONFIG);
        if (j.verdict === "family" || j.verdict === "stranger") {
          expect(j.confidence).toBeGreaterThanOrEqual(0.8);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
