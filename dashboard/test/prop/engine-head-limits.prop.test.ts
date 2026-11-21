// Feature: dashboard-simulation, Property 6: Head angles stay inside the limits
// **Validates: Requirements 6.1, 6.4, 6.7**
import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { initialState, step } from "../../src/simulation/engine";
import type { Input, SimState } from "../../src/simulation/types";
import { arbEnvelopeOf, arbFiniteAngle, arbInput, planFor } from "../helpers";

const RUNS = { numRuns: 150 };

const arbTimed = fc.record({
  input: arbInput,
  gap: fc.integer({ min: 0, max: 5000 }),
});

const arbNonFinite = fc.constantFrom(NaN, Infinity, -Infinity);

/** A gaze with at least one non-finite angle (the other may be any finite or non-finite value). */
const arbBadGaze = fc
  .tuple(
    arbEnvelopeOf("gaze"),
    fc.oneof(
      fc.tuple(arbNonFinite, fc.oneof(arbFiniteAngle, arbNonFinite)),
      fc.tuple(arbFiniteAngle, arbNonFinite),
    ),
  )
  .map(([m, [panDeg, tiltDeg]]) => ({
    ...m,
    deviceId: "warashi-sim",
    encounterId: null,
    data: { panDeg, tiltDeg },
  }));

/** A well-formed gaze with any finite angles, extremes included. */
const arbGoodGaze = fc
  .tuple(arbEnvelopeOf("gaze"), arbFiniteAngle, arbFiniteAngle)
  .map(([m, panDeg, tiltDeg]) => ({
    ...m,
    deviceId: "warashi-sim",
    encounterId: null,
    data: { panDeg, tiltDeg },
  }));

function expectInsideLimits(s: SimState): void {
  const { panLimit, tiltLimit } = s.config;
  for (const v of [s.pan, s.panTarget]) {
    expect(Number.isFinite(v)).toBe(true);
    expect(Math.abs(v)).toBeLessThanOrEqual(panLimit);
  }
  for (const v of [s.tilt, s.tiltTarget]) {
    expect(Number.isFinite(v)).toBe(true);
    expect(Math.abs(v)).toBeLessThanOrEqual(tiltLimit);
  }
}

/** Runs the timed inputs, checking the limits after every one. Returns the final state and time. */
function runChecked(history: ReadonlyArray<{ input: Input; gap: number }>): {
  state: SimState;
  now: number;
} {
  let state = initialState();
  let now = 0;
  expectInsideLimits(state);
  for (const h of history) {
    now += h.gap;
    state = step(state, h.input, now).state;
    expectInsideLimits(state);
  }
  return { state, now };
}

describe("Property 6: Head angles stay inside the limits", () => {
  it("pan, tilt and both targets stay finite and inside the limits after every input", () => {
    fc.assert(
      fc.property(
        fc.array(arbTimed, { maxLength: 40 }),
        fc.array(fc.tuple(arbGoodGaze, fc.integer({ min: 0, max: 3000 })), { maxLength: 8 }),
        (history, gazes) => {
          const { state, now } = runChecked(history);
          let s = state;
          let t = now;
          for (const [gaze, gap] of gazes) {
            t += gap;
            s = step(s, { kind: "command", value: gaze }, t).state;
            expectInsideLimits(s);
            // Let the head glide so the pan and tilt themselves are exercised, too.
            for (let i = 0; i < 5; i++) {
              t += 100;
              s = step(s, { kind: "tick" }, t).state;
              expectInsideLimits(s);
            }
          }
        },
      ),
      RUNS,
    );
  });

  it("a gaze with a non-finite angle leaves the head unchanged and reports malformed_message", () => {
    fc.assert(
      fc.property(fc.array(arbTimed, { maxLength: 30 }), arbBadGaze, (history, bad) => {
        const { state, now } = runChecked(history);
        const result = step(state, { kind: "command", value: bad }, now);
        expectInsideLimits(result.state);

        // The inbound check runs first, so the first output is the one report for this gaze.
        const first = result.outputs[0];
        expect(first?.kind).toBe("message");
        if (first?.kind !== "message") return;
        expect(first.envelope.type).toBe("error.reported");
        expect(first.envelope.data).toMatchObject({ code: "malformed_message", refId: bad.id });

        // The same step also glides the head and runs world inputs that are due at `now`; those
        // may move the head or report errors of their own. A different malformed command at the
        // same time is the control: if the bad gaze changed the head or the targets, or reported
        // more than once, the two results would differ.
        const control = step(state, { kind: "command", value: { ...bad, data: "broken" } }, now);
        expect(result.state).toEqual(control.state);
        expect(result.outputs).toEqual(control.outputs);
      }),
      RUNS,
    );
  });

  it("a gaze with 1e300 degrees clamps to the limits", () => {
    const s0 = initialState();
    const gaze = {
      v: 1,
      id: "00000000-0000-4000-8000-000000000001",
      ts: "2026-11-20T12:34:56.789Z",
      deviceId: "warashi-sim",
      encounterId: null,
      type: "gaze",
      data: { panDeg: 1e300, tiltDeg: -1e300 },
    };
    // Wake the doll first: a gaze is rejected while it sleeps.
    const awake = step(
      s0,
      { kind: "user", action: { type: "start", plan: planFor("family_home"), seed: 1 } },
      0,
    ).state;
    let s = step(awake, { kind: "command", value: gaze }, 10).state;
    expectInsideLimits(s);
    expect(s.panTarget).toBe(s.config.panLimit);
    expect(s.tiltTarget).toBe(-s.config.tiltLimit);
    for (let t = 100; t <= 5000; t += 100) {
      s = step(s, { kind: "tick" }, t).state;
      expectInsideLimits(s);
    }
  });
});
