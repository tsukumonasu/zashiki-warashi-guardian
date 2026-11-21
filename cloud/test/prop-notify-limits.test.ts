// Feature: cloud-judgement, Property 6: Notification limits
// Validates: Requirements 9.2, 9.3, 9.4, 9.5
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { shouldNotify } from "../lambda/_shared/notify.js";
import type { Verdict } from "../lambda/_shared/verdict.js";

const verdictArb: fc.Arbitrary<Verdict> = fc.constantFrom<Verdict>(
  "family",
  "stranger",
  "no_face",
  "uncertain",
);

/** One snapshot: time step since the previous one (non-decreasing times), encounter, verdict. */
const stepArb = fc.record({
  dtMs: fc.integer({ min: 0, max: 10_000 }),
  encounter: fc.integer({ min: 0, max: 3 }),
  verdict: verdictArb,
});

describe("Feature: cloud-judgement, Property 6: Notification limits", () => {
  it("fires only for strangers, once per encounter, and at least windowMs apart", () => {
    fc.assert(
      fc.property(
        fc.array(stepArb, { maxLength: 60 }),
        fc.integer({ min: 0, max: 20_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (steps, windowMs, startMs) => {
          const notifiedEncounters = new Set<number>();
          let lastNotifiedAtMs: number | null = null;
          let nowMs = startMs;
          const firedAt: number[] = [];
          for (const step of steps) {
            nowMs += step.dtMs;
            const decision = shouldNotify({
              verdict: step.verdict,
              encounterAlreadyNotified: notifiedEncounters.has(step.encounter),
              lastNotifiedAtMs,
              nowMs,
              windowMs,
            });
            if (!decision.notify) continue;
            expect(step.verdict).toBe("stranger");
            expect(notifiedEncounters.has(step.encounter)).toBe(false);
            if (lastNotifiedAtMs !== null) {
              expect(nowMs - lastNotifiedAtMs).toBeGreaterThanOrEqual(windowMs);
            }
            notifiedEncounters.add(step.encounter);
            lastNotifiedAtMs = nowMs;
            firedAt.push(nowMs);
          }
          // At most one firing per encounter, and consecutive firings respect the window.
          expect(firedAt.length).toBeLessThanOrEqual(notifiedEncounters.size);
          for (let k = 1; k < firedAt.length; k += 1) {
            expect(firedAt[k]! - firedAt[k - 1]!).toBeGreaterThanOrEqual(windowMs);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("never fires when the clock is earlier than the last notification", () => {
    fc.assert(
      fc.property(
        verdictArb,
        fc.boolean(),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        (verdict, already, lastMs, skewMs, windowMs) => {
          const decision = shouldNotify({
            verdict,
            encounterAlreadyNotified: already,
            lastNotifiedAtMs: lastMs,
            nowMs: lastMs - skewMs,
            windowMs,
          });
          expect(decision.notify).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
