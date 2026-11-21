// Feature: dashboard-simulation, Property 12: A stranger line never comes before the silent stare
// **Validates: Requirements 3.2**

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { initialState, step } from "../../src/simulation/engine";
import type { Input, Output, SimState } from "../../src/simulation/types";
import { arbLabels, arbSeed, arbTickGap, DEFAULT_AUDIO_MS, MAX_SIM_MS, planFor } from "../helpers";

interface StepRecord {
  now: number;
  before: SimState;
  after: SimState;
  outputs: Output[];
}

/** Runs the stranger scenario like `drive`, but keeps the simulated time of every step. */
function runStranger(labels: readonly string[], seed: number, gap: number): { steps: StepRecord[]; stareMs: number } {
  const plan = planFor("stranger_night", labels);
  let state = initialState();
  const stareMs = state.config.stareS * 1000;
  const steps: StepRecord[] = [];
  const audioDue: { at: number; playId: string }[] = [];
  let now = 0;

  const run = (input: Input): void => {
    const before = state;
    const result = step(state, input, now);
    state = result.state;
    for (const o of result.outputs) {
      if (o.kind === "audio.play") audioDue.push({ at: now + (o.durationHintMs ?? DEFAULT_AUDIO_MS), playId: o.playId });
    }
    steps.push({ now, before, after: state, outputs: result.outputs });
  };

  run({ kind: "user", action: { type: "start", plan, seed } });
  while (!(state.deviceState === "sleeping" && !state.running) && now < MAX_SIM_MS) {
    now += gap;
    for (let i = 0; i < audioDue.length; ) {
      if (audioDue[i]!.at <= now) {
        const [due] = audioDue.splice(i, 1);
        run({ kind: "internal", event: { type: "audio.finished", playId: due!.playId } });
      } else i++;
    }
    run({ kind: "tick" });
  }
  return { steps, stareMs };
}

const reactions = (s: StepRecord): { kind: string }[] =>
  s.outputs.flatMap((o) =>
    o.kind === "message" && o.envelope.type === "reaction.performed" ? [o.envelope.data as { kind: string }] : [],
  );
const plays = (s: StepRecord): Output[] => s.outputs.filter((o) => o.kind === "audio.play");

describe("Feature: dashboard-simulation, Property 12: A stranger line never comes before the silent stare", () => {
  it("no line, reaction or subtitle during the stare; the line and reaction come together after it", () => {
    fc.assert(
      fc.property(arbLabels, arbSeed, arbTickGap, (labels, seed, gap) => {
        const { steps, stareMs } = runStranger(labels, seed, gap);

        let warningSince: number | null = null;
        let firstPlay: StepRecord | null = null;
        for (const s of steps) {
          if (s.after.deviceState === "warning" && s.before.deviceState !== "warning") warningSince = s.now;
          if (s.after.deviceState !== "warning" && s.before.deviceState === "warning") {
            // leaving warning without a stranger line would be an offline/error path; not checked here
          }
          const inStare = warningSince !== null && s.after.deviceState === "warning" && s.now - warningSince < stareMs;
          if (inStare) {
            expect(plays(s)).toHaveLength(0);
            expect(reactions(s)).toHaveLength(0);
            expect(s.after.subtitle).toBeNull();
          }
          if (plays(s).length > 0 && firstPlay === null) {
            firstPlay = s;
            // The stranger line starts only after warning was reached and the stare has passed.
            expect(warningSince).not.toBeNull();
            expect(s.now - warningSince!).toBeGreaterThanOrEqual(stareMs);
            expect(reactions(s).map((r) => r.kind)).toEqual(["stranger"]);
          }
        }
        // The stranger scenario reaches warning and speaks once.
        expect(warningSince).not.toBeNull();
        expect(firstPlay).not.toBeNull();
        // No reaction.performed of kind stranger exists outside the step with the first play.
        for (const s of steps) {
          if (s !== firstPlay) expect(reactions(s).filter((r) => r.kind === "stranger")).toHaveLength(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});
