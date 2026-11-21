// Feature: dashboard-simulation, Property 9: The state is always renderable
// **Validates: Requirements 7.1, 7.5, 8.7**
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { initialState, step } from "../../src/simulation/engine";
import type { SimState } from "../../src/simulation/types";
import { arbInput, arbPlan, arbSeed, arbTickGap, drive } from "../helpers";

const DEVICE_STATES = [
  "sleeping",
  "waking",
  "seeking",
  "gazing",
  "greeting",
  "warning",
  "uncertain",
  "cooldown",
];
const EYE_STATES = ["closed", "half", "open", "stare"];

/** Time gaps in ms (0 allowed); `now` never decreases. Long gaps let cooldowns finish. */
const arbSteps = fc.array(
  fc.tuple(fc.oneof(fc.integer({ min: 0, max: 200 }), fc.integer({ min: 0, max: 20_000 })), arbInput),
  { minLength: 1, maxLength: 150 },
);

function expectRenderable(s: SimState): void {
  expect(DEVICE_STATES).toContain(s.deviceState);
  expect(Number.isFinite(s.pan)).toBe(true);
  expect(Number.isFinite(s.tilt)).toBe(true);
  expect(Number.isFinite(s.lantern)).toBe(true);
  expect(s.lantern).toBeGreaterThanOrEqual(0);
  expect(s.lantern).toBeLessThanOrEqual(1);
  expect(EYE_STATES).toContain(s.eye);
  if (s.subtitle !== null) {
    expect(typeof s.subtitle.ja).toBe("string");
    expect(typeof s.subtitle.en).toBe("string");
    expect(s.subtitle.ja.length).toBeGreaterThan(0);
    expect(s.subtitle.en.length).toBeGreaterThan(0);
  }
  if (s.deviceState === "sleeping") {
    expect(s.lantern).toBe(0);
    expect(s.eye).toBe("closed");
    expect(s.subtitle).toBeNull();
  }
}

describe("Property 9: The state is always renderable", () => {
  it("every state after every input is renderable, and a sleeping doll is dark with closed eyes", () => {
    fc.assert(
      fc.property(arbSteps, (steps) => {
        let state = initialState();
        expectRenderable(state);
        let now = 0;
        for (const [gap, input] of steps) {
          now += gap;
          state = step(state, input, now).state;
          expectRenderable(state);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("full scenarios stay renderable, including the settled sleeping state at the end", () => {
    fc.assert(
      fc.property(arbPlan, arbSeed, arbTickGap, (plan, seed, gap) => {
        const { states } = drive(plan, seed, gap);
        for (const s of states) expectRenderable(s);
        expect(states[states.length - 1]!.deviceState).toBe("sleeping");
      }),
      { numRuns: 100 },
    );
  });
});
