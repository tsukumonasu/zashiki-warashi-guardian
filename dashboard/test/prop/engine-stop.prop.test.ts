// Feature: dashboard-simulation, Property 13: Stopping always ends the encounter cleanly
// **Validates: Requirements 2.6, 6.6**

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { step } from "../../src/simulation/engine";
import type { SchemaMessage } from "../../src/simulation/types";
import { arbPlan, arbSeed, arbTickGap, drive } from "../helpers";

interface Change {
  from: string;
  to: string;
  reason: string;
}

const changes = (messages: readonly SchemaMessage[]): Change[] =>
  messages.filter((m) => m.type === "state.changed").map((m) => (m as unknown as { data: Change }).data);

/** Epoch ms at which the unstopped run first enters `cooldown`. */
function cooldownStartMs(plan: Parameters<typeof drive>[0], seed: number, gap: number): number {
  const base = drive(plan, seed, gap);
  const msg = base.messages.find(
    (m) => m.type === "state.changed" && (m as unknown as { data: Change }).data.to === "cooldown",
  );
  expect(msg).toBeDefined();
  return Date.parse(msg!.ts);
}

describe("Feature: dashboard-simulation, Property 13: Stopping always ends the encounter cleanly", () => {
  it("a stop at any moment before cooldown ends the encounter with reason manual and rests cleanly", () => {
    fc.assert(
      fc.property(arbPlan, arbSeed, arbTickGap, fc.double({ min: 0, max: 1, noNaN: true }), (plan, seed, gap, frac) => {
        const cooldownAt = cooldownStartMs(plan, seed, gap);
        const startMs = Date.parse(drive(plan, seed, gap).messages[0]!.ts);
        // The stop is delivered at the first tick at or after `atMs`; keep it strictly before cooldown.
        const atMs = Math.floor(frac * Math.max(0, cooldownAt - startMs - 2 * gap));
        const result = drive(plan, seed, gap, {
          script: [{ atMs, input: { kind: "user", action: { type: "stop" } } }],
        });

        // Ends in rest.
        expect(result.finished).toBe(true);
        const last = result.states[result.states.length - 1]!;
        expect(last.deviceState).toBe("sleeping");
        expect(last.running).toBe(false);
        expect(last.mode).toBe("guard");
        expect(last.pan).toBe(0);
        expect(last.tilt).toBe(0);
        expect(last.lantern).toBe(0);
        expect(last.subtitle).toBeNull();

        // The stop moved the doll to cooldown with reason manual.
        const cs = changes(result.messages);
        const manual = cs.filter((c) => c.reason === "manual");
        expect(manual).toHaveLength(1);
        expect(manual[0]!.to).toBe("cooldown");
        expect(cs[cs.length - 1]).toMatchObject({ to: "sleeping", reason: "cooldown_done" });

        // One encounter.ended, reason manual, and it is the last message.
        const ended = result.messages.filter((m) => m.type === "encounter.ended");
        expect(ended).toHaveLength(1);
        expect((ended[0] as unknown as { data: { reason: string } }).data.reason).toBe("manual");
        // Only the closing status.report (state is now sleeping) may follow it.
        const after = result.messages.slice(result.messages.indexOf(ended[0]!) + 1);
        expect(after.every((m) => m.type === "status.report")).toBe(true);
        expect(after.length).toBeLessThanOrEqual(1);

        // The audio was stopped.
        expect(result.outputs.some((o) => o.kind === "audio.stop")).toBe(true);

        // Nothing more happens after rest.
        let state = last;
        for (let k = 1; k <= 5; k++) {
          const next = step(state, { kind: "tick" }, result.endedAtMs + k * 60_000);
          expect(next.outputs).toEqual([]);
          state = next.state;
        }
      }),
      { numRuns: 150 },
    );
  });
});
