// Feature: dashboard-simulation, Property 10: Every emitted message is a valid, well-formed envelope
// **Validates: Requirements 4.9, 4.10**

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ALL_TYPES, decodeValue } from "../../src/simulation/codec";
import { initialState, step } from "../../src/simulation/engine";
import type { SchemaMessage } from "../../src/simulation/types";
import { arbInput, arbPlan, arbSeed, arbTickGap, drive } from "../helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Checks every envelope rule over an ordered stream of emitted messages. */
function checkStream(messages: readonly SchemaMessage[]): void {
  let inEncounter = false;
  for (const m of messages) {
    const decoded = decodeValue(m);
    expect(decoded.kind, `${m.type} must decode valid`).toBe("valid");
    expect(ALL_TYPES).toContain(m.type); // no device-internal event on the wire
    expect(m.v).toBe(1);
    expect(m.id).toMatch(UUID);
    expect(m.ts).toMatch(TS);
    expect(Number.isNaN(Date.parse(m.ts))).toBe(false);
    expect(new Date(m.ts).toISOString()).toBe(m.ts);
    expect(m.deviceId).toBe("warashi-sim");

    if (m.type === "presence.detected") inEncounter = true;
    if (m.type === "status.report") {
      expect(m.encounterId).toBeNull();
    } else if (inEncounter) {
      expect(m.encounterId, `${m.type} inside an encounter`).toMatch(UUID);
    } else {
      expect(m.encounterId, `${m.type} outside an encounter`).toBeNull();
    }
    if (m.type === "encounter.ended") inEncounter = false;
  }
}

describe("Feature: dashboard-simulation, Property 10: Every emitted message is a valid, well-formed envelope", () => {
  it("complete scenario runs emit only well-formed envelopes", () => {
    fc.assert(
      fc.property(arbPlan, arbSeed, arbTickGap, (plan, seed, gap) => {
        const { messages } = drive(plan, seed, gap);
        expect(messages.length).toBeGreaterThan(0);
        checkStream(messages);
      }),
      { numRuns: 100 },
    );
  });

  it("random input sequences emit only well-formed envelopes", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(arbInput, fc.integer({ min: 0, max: 2000 })), { maxLength: 40 }), (steps) => {
        let state = initialState();
        let now = 0;
        const messages: SchemaMessage[] = [];
        for (const [input, gap] of steps) {
          now += gap;
          const result = step(state, input, now);
          state = result.state;
          for (const o of result.outputs) if (o.kind === "message") messages.push(o.envelope);
        }
        checkStream(messages);
      }),
      { numRuns: 200 },
    );
  });
});
