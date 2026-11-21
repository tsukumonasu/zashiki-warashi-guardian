// Feature: dashboard-simulation, Property 4: Ignored inputs change nothing
// **Validates: Requirements 2.8, 5.4, 5.5**
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { initialState, step } from "../../src/simulation/engine";
import type { Input, Output, SimState } from "../../src/simulation/types";
import { arbEnvelopeOf, arbPlan, arbSeed, arbTickGap } from "../helpers";

const RUNS = { numRuns: 100 };

/** A state taken at `now`, at a random point of a scenario (or before any start). */
interface Snapshot {
  state: SimState;
  now: number;
}

/** Runs a scenario with plain ticks and keeps the state reached after `steps` ticks. */
const arbSnapshot: fc.Arbitrary<Snapshot> = fc
  .tuple(arbPlan, arbSeed, arbTickGap, fc.integer({ min: -1, max: 400 }))
  .map(([plan, seed, gap, steps]) => {
    let state = initialState();
    let now = 0;
    if (steps < 0) return { state, now };
    state = step(state, { kind: "user", action: { type: "start", plan, seed } }, now).state;
    for (let i = 0; i < steps; i++) {
      now += gap;
      state = step(state, { kind: "tick" }, now).state;
    }
    return { state, now };
  });

let counter = 0;
const fresh = (prefix: string): string => `${prefix}-${++counter}-unknown`;

/** Inputs that no state defines: unknown motion, play and snapshot ids, falling PIR edge. */
const arbUndefinedInput: fc.Arbitrary<Input> = fc.oneof(
  fc.constant(null).map((): Input => ({
    kind: "internal",
    event: { type: "servo.arrived", motionId: fresh("motion") },
  })),
  fc.constant(null).map((): Input => ({
    kind: "internal",
    event: { type: "audio.finished", playId: fresh("play") },
  })),
  fc.constant(null).map((): Input => ({
    kind: "internal",
    event: { type: "audio.failed", playId: fresh("play"), code: "interrupted" },
  })),
  fc.constant(null).map((): Input => ({
    kind: "internal",
    event: { type: "snapshot.ready", snapshotId: fresh("snap") },
  })),
);

/**
 * Stale failure feedback. By design (device-core-loop, "Stale feedback") the only effect is the
 * `error.reported` that carries the failure code; the state machine itself does not move.
 */
const arbStaleFailure: fc.Arbitrary<Input> = fc.oneof(
  fc.constant(null).map((): Input => ({
    kind: "internal",
    event: { type: "audio.failed", playId: fresh("play"), code: "audio_failed" },
  })),
  fc.constantFrom("camera_failed", "snapshot_too_large").map((code): Input => ({
    kind: "internal",
    event: { type: "snapshot.failed", snapshotId: fresh("snap"), code },
  })),
);

/** The state without the audit trail (log) and the id generator, which an error report advances. */
const core = (s: SimState): Omit<SimState, "log" | "rng"> => {
  const { log: _log, rng: _rng, ...rest } = s;
  void _log;
  void _rng;
  return rest;
};

const noStateChanged = (outputs: Output[]): boolean =>
  !outputs.some((o) => o.kind === "message" && o.envelope.type === "state.changed");

const arbUuid = fc.uuid();

describe("Feature: dashboard-simulation, Property 4: Ignored inputs change nothing", () => {
  it("inputs undefined for the current state leave the state equal and emit nothing", () => {
    fc.assert(
      fc.property(arbSnapshot, arbUndefinedInput, ({ state, now }, input) => {
        const result = step(state, input, now);
        expect(result.state).toEqual(state);
        expect(noStateChanged(result.outputs)).toBe(true);
        expect(result.outputs).toEqual([]);
      }),
      RUNS,
    );
  });

  it("stale failure feedback moves no state and emits only error.reported", () => {
    fc.assert(
      fc.property(arbSnapshot, arbStaleFailure, ({ state, now }, input) => {
        const result = step(state, input, now);
        expect(core(result.state)).toEqual(core(state));
        expect(noStateChanged(result.outputs)).toBe(true);
        for (const o of result.outputs) {
          expect(o.kind === "message" && o.envelope.type === "error.reported").toBe(true);
        }
      }),
      RUNS,
    );
  });

  it("a judgement.result for a stale snapshotId changes no machine state and emits no state.changed", () => {
    fc.assert(
      fc.property(arbSnapshot, arbEnvelopeOf("judgement.result"), ({ state, now }, env) => {
        const command = {
          ...env,
          deviceId: state.config.deviceId,
          encounterId: null,
          data: { ...(env.data as object), snapshotId: fresh("stale") },
        };
        const result = step(state, { kind: "command", value: command }, now);
        expect(noStateChanged(result.outputs)).toBe(true);
        // Only the duplicate window may record the new command id.
        expect(result.state).toEqual({
          ...state,
          seenCommandIds: result.state.seenCommandIds,
        });
        expect(result.state.seenCommandIds.slice(-1)).toEqual([command.id]);
      }),
      RUNS,
    );
  });

  it("a duplicate command id changes nothing and emits no output at all", () => {
    fc.assert(
      fc.property(arbSnapshot, arbUuid, arbEnvelopeOf("lantern"), ({ state, now }, id, env) => {
        const command = { ...env, id, deviceId: state.config.deviceId, encounterId: null };
        const first = step(state, { kind: "command", value: command }, now);
        const second = step(first.state, { kind: "command", value: command }, now);
        expect(second.state).toEqual(first.state);
        expect(second.outputs).toEqual([]);
      }),
      RUNS,
    );
  });

  it("a scenario start while running leaves the state equal and emits nothing", () => {
    fc.assert(
      fc.property(arbSnapshot, arbPlan, arbSeed, ({ state, now }, plan, seed) => {
        fc.pre(state.running);
        const result = step(state, { kind: "user", action: { type: "start", plan, seed } }, now);
        expect(result.state).toEqual(state);
        expect(result.outputs).toEqual([]);
      }),
      RUNS,
    );
  });
});
