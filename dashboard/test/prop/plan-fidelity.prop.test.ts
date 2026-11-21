// Feature: dashboard-simulation, Property 18: The plan keeps the response's verdict
// **Validates: Requirements 12.5**

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import catalog from "../../src/simulation/data/voice-catalog.json";
import { decodeValue } from "../../src/simulation/codec";
import { DEFAULT_CONFIG } from "../../src/simulation/config";
import { buildJudgementEnvelope, planFromResponse, type PlanResponse } from "../../src/simulation/plans";
import { VERDICTS, type ScenarioId, type VerdictLabel } from "../../src/simulation/types";
import { arbSeed, arbTickGap, drive } from "../helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const SCENARIOS_WITH_SAMPLE: readonly ScenarioId[] = ["family_home", "stranger_night", "nobody_there"];

const unit = fc.double({ min: 0, max: 1, noNaN: true }).map((n) => (Object.is(n, -0) ? 0 : n));

const arbFace = fc.option(
  fc.record({ left: unit, top: unit, width: unit, height: unit }),
  { nil: null },
);

/** Confidence in 0..1, with the 0.80 accept boundary and its neighbours over-represented. */
const arbConfidence = fc.oneof(
  unit,
  fc.constantFrom(0, 0.79, 0.7999999, 0.8, 0.8000001, 0.81, 1),
);

const arbResponse: fc.Arbitrary<PlanResponse> = fc.record({
  verdict: fc.constantFrom(...VERDICTS),
  confidence: arbConfidence,
  face: arbFace,
  speech: fc.option(
    fc.record({
      lineId: fc.option(fc.constantFrom(...catalog.map((l) => l.id)), { nil: null }),
      ja: fc.string({ maxLength: 20 }),
      en: fc.string({ maxLength: 20 }),
    }),
    { nil: null },
  ),
});

/** What the engine shows after the verdict, following the accept rule of the design (0.80). */
function expectedLabel(r: PlanResponse): VerdictLabel {
  if (r.verdict === "family") return r.confidence >= DEFAULT_CONFIG.familyConfidenceMin ? "family" : "uncertain";
  if (r.verdict === "stranger") {
    return r.confidence >= DEFAULT_CONFIG.strangerConfidenceMin ? "stranger" : "uncertain";
  }
  return r.verdict;
}

describe("Feature: dashboard-simulation, Property 18: The plan keeps the response's verdict", () => {
  it("keeps verdict, confidence and face, and the judgement.result decodes with the engine's snapshotId", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SCENARIOS_WITH_SAMPLE),
        arbResponse,
        fc.uuid(),
        arbSeed,
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        (scenario, response, snapshotId, rng, now) => {
          const plan = planFromResponse(scenario, response);
          expect(plan.attempts.length).toBeGreaterThan(0);
          for (const attempt of plan.attempts) {
            expect(attempt.verdict).toBe(response.verdict);
            expect(attempt.confidence).toBe(response.confidence);
            expect(attempt.face).toEqual(response.face);
          }

          const [envelope, nextRng] = buildJudgementEnvelope(plan.attempts[0]!, snapshotId, rng, now);
          const decoded = decodeValue(JSON.parse(JSON.stringify(envelope)));
          expect(decoded.kind).toBe("valid");
          expect(envelope.id).toMatch(UUID);
          expect(nextRng).not.toBe(rng);
          expect(envelope.data).toEqual({
            snapshotId,
            verdict: response.verdict,
            confidence: response.confidence,
            face: response.face,
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it("runs through the engine to the matching verdict (0.80 accept rule)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SCENARIOS_WITH_SAMPLE),
        arbResponse,
        arbSeed,
        arbTickGap,
        (scenario, response, seed, gap) => {
          const result = drive(planFromResponse(scenario, response), seed, gap);
          expect(result.finished).toBe(true);

          const last = result.states[result.states.length - 1]!;
          expect(last.verdict).toBe(expectedLabel(response));

          const judged = result.messages.filter((m) => m.type === "reaction.performed");
          expect(judged.length).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});
