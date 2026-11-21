import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  decideVerdict,
  type AdapterFailure,
  type FaceQuality,
  type VerdictConfig,
} from "../lambda/_shared/verdict.js";

const num = fc.double({ min: -1000, max: 1000, noNaN: true });

/** Any threshold set, including nonsensical ones: failure safety must not depend on them. */
const configArb: fc.Arbitrary<VerdictConfig> = fc.record({
  searchFloor: num,
  familyMin: num,
  strangerMax: num,
  faceConfidenceMin: num,
  minFaceWidth: num,
  minSharpness: num,
  minBrightness: num,
  maxYawDeg: num,
  acceptMin: num,
});

const failureArb: fc.Arbitrary<AdapterFailure> = fc.record({
  kind: fc.constant("failure" as const),
  stage: fc.constantFrom("search" as const, "detect" as const, "store" as const),
});

const qualityArb: fc.Arbitrary<FaceQuality> = fc.option(
  fc.record({ sharpness: num, brightness: num, yawDeg: num }),
  { nil: null },
);

describe("verdict failure safety", () => {
  it("Feature: cloud-judgement, Property 4: Failure safety", () => {
    // **Validates: Requirements 5.9**
    fc.assert(
      fc.property(failureArb, qualityArb, configArb, (failure, quality, config) => {
        const j = decideVerdict(failure, quality, config);
        expect(j.verdict).toBe("uncertain");
        expect(j.verdict).not.toBe("family");
        expect(j.verdict).not.toBe("stranger");
        // A failure never produces a made-up score or a face box.
        expect(j.confidence).toBe(0);
        expect(j.face).toBeNull();
      }),
      { numRuns: 200 },
    );
  });
});
