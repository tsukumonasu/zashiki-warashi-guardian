// Feature: dashboard-simulation, Property 3: Engine determinism
// **Validates: Requirements 5.2**
import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { initialState, step } from "../../src/simulation/engine";
import type { Input } from "../../src/simulation/types";
import { arbInput } from "../helpers";

const RUNS = { numRuns: 150 };

/** An input and the time gap (ms) since the previous one. */
const arbTimed = fc.record({
  input: arbInput,
  gap: fc.integer({ min: 0, max: 5000 }),
});

describe("Property 3: Engine determinism", () => {
  it("step called twice with equal arguments returns equal state and outputs", () => {
    fc.assert(
      fc.property(
        fc.array(arbTimed, { maxLength: 25 }),
        arbInput,
        fc.integer({ min: 0, max: 60_000 }),
        (history, input: Input, finalGap) => {
          // Reach an arbitrary state through a sequence of inputs.
          let state = initialState();
          let now = 0;
          for (const h of history) {
            now += h.gap;
            state = step(state, h.input, now).state;
          }
          now += finalGap;

          // The second call gets a deep copy, so a mutation by the first call also shows up.
          const stateCopy = structuredClone(state);
          const inputCopy = structuredClone(input);

          const a = step(state, input, now);
          const b = step(stateCopy, inputCopy, now);

          expect(b.state).toEqual(a.state);
          expect(b.outputs).toEqual(a.outputs);

          // Calling again with the very same arguments gives the same result as well.
          const c = step(state, input, now);
          expect(c.state).toEqual(a.state);
          expect(c.outputs).toEqual(a.outputs);
        },
      ),
      RUNS,
    );
  });
});
