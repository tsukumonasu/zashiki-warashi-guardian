// Feature: dashboard-simulation, Property 7: Motion is slow
// **Validates: Requirements 6.3, 6.8**
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { initialState, step } from "../../src/simulation/engine";
import type { SimConfig, SimState } from "../../src/simulation/types";
import { arbInput, arbPlan, arbSeed, arbTickGap, drive } from "../helpers";

/** Float slack for the step bound; the engine adds and subtracts whole fractions of a degree. */
const EPS = 1e-9;

/** Config overrides: the defaults plus safe values and some unsafe ones that fall back. */
const arbConfig: fc.Arbitrary<Partial<SimConfig>> = fc.record(
  {
    glideStepDeg: fc.oneof(fc.double({ min: 0.1, max: 2, noNaN: true }), fc.constantFrom(5, 0, -1)),
    glideIntervalMs: fc.oneof(fc.integer({ min: 30, max: 500 }), fc.constantFrom(0, 10, 29)),
  },
  { requiredKeys: [] },
);

/** Steps: a time gap (0 allowed) and an input. `now` never decreases. */
const arbSteps = fc.array(
  fc.tuple(fc.oneof(fc.integer({ min: 0, max: 200 }), fc.integer({ min: 0, max: 5000 })), arbInput),
  { minLength: 1, maxLength: 150 },
);

describe("Property 7: Motion is slow", () => {
  it("full scenarios: every head step is one step and at least glideIntervalMs after the last", () => {
    fc.assert(
      fc.property(arbPlan, arbSeed, arbTickGap, (plan, seed, gap) => {
        const { states } = drive(plan, seed, gap);
        for (let i = 1; i < states.length; i++) {
          const a = states[i - 1]!;
          const b = states[i]!;
          const moved = b.pan !== a.pan || b.tilt !== a.tilt;
          expect(Math.abs(b.pan - a.pan)).toBeLessThanOrEqual(a.config.glideStepDeg + EPS);
          expect(Math.abs(b.tilt - a.tilt)).toBeLessThanOrEqual(a.config.glideStepDeg + EPS);
          if (moved) {
            expect(b.motion.lastStepAt - a.motion.lastStepAt).toBeGreaterThanOrEqual(
              a.config.glideIntervalMs,
            );
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("pan and tilt move at most one step, and not before glideIntervalMs has passed", () => {
    fc.assert(
      fc.property(arbConfig, arbSteps, (config, steps) => {
        let state: SimState = initialState(config);
        let now = 0;
        for (const [gap, input] of steps) {
          now += gap;
          const before = state;
          state = step(before, input, now).state;
          // A start of a fresh run rebuilds the state from `initialState`: not a head movement.
          if (input.kind === "user" && input.action.type === "start" && !before.running) continue;
          const dPan = Math.abs(state.pan - before.pan);
          const dTilt = Math.abs(state.tilt - before.tilt);
          const maxStep = before.config.glideStepDeg;
          expect(maxStep).toBeLessThanOrEqual(2);
          expect(dPan).toBeLessThanOrEqual(maxStep + EPS);
          expect(dTilt).toBeLessThanOrEqual(maxStep + EPS);
          if (now - before.motion.lastStepAt < before.config.glideIntervalMs) {
            expect(state.pan).toBe(before.pan);
            expect(state.tilt).toBe(before.tilt);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
