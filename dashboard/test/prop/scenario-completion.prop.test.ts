// Feature: dashboard-simulation, Property 11: A scenario completes in order and returns to rest
// **Validates: Requirements 2.3, 2.4, 3.1, 3.3, 3.4, 3.7, 6.5**

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ScenarioId, VerdictLabel } from "../../src/simulation/types";
import { arbLabels, arbScenario, arbSeed, arbTickGap, drive, planFor } from "../helpers";

/** State changes (`to` values) each scenario must emit, in order (Requirements 3.1, 3.3, 3.4). */
const EXPECTED_STATES: Record<ScenarioId, string[]> = {
  family_home: ["waking", "seeking", "gazing", "greeting", "cooldown", "sleeping"],
  stranger_night: ["waking", "seeking", "gazing", "warning", "cooldown", "sleeping"],
  nobody_there: ["waking", "seeking", "uncertain", "cooldown", "sleeping"],
  network_down: ["waking", "uncertain", "cooldown", "sleeping"],
};

const EXPECTED_LABEL: Record<ScenarioId, VerdictLabel> = {
  family_home: "family",
  stranger_night: "stranger",
  nobody_there: "no_face",
  network_down: "offline",
};

/** True when `needle` appears in `haystack` as a (not necessarily contiguous) subsequence. */
function isSubsequence(needle: readonly string[], haystack: readonly string[]): boolean {
  let i = 0;
  for (const item of haystack) if (item === needle[i]) i++;
  return i === needle.length;
}

describe("Feature: dashboard-simulation, Property 11: A scenario completes in order and returns to rest", () => {
  it("completes in order within 120 s and returns to rest", () => {
    fc.assert(
      fc.property(arbScenario, arbLabels, arbSeed, arbTickGap, (scenario, labels, seed, gap) => {
        const result = drive(planFor(scenario, labels), seed, gap);

        // Completes within 120 simulated seconds (Requirement 2.4).
        expect(result.finished).toBe(true);
        expect(result.endedAtMs).toBeLessThanOrEqual(120_000 + gap);

        // Ordered event types (Requirement 2.3).
        const types = result.messages
          .map((m) => m.type)
          .filter((t) => t !== "status.report");
        const wakingAt = result.messages.findIndex(
          (m) => m.type === "state.changed" && (m.data as { to: string }).to === "waking",
        );
        expect(wakingAt).toBeGreaterThan(-1);
        const expectedTypes = ["presence.detected", "state.changed"];
        if (scenario !== "network_down") expectedTypes.push("snapshot.captured");
        expectedTypes.push("reaction.performed", "encounter.ended");
        expect(isSubsequence(expectedTypes, types), types.join(",")).toBe(true);
        if (scenario === "network_down") {
          expect(types).not.toContain("snapshot.captured");
          expect(types).not.toContain("judgement.result");
        }

        // Ordered state changes per scenario (Requirements 3.1, 3.3, 3.4).
        const changes = result.messages
          .filter((m) => m.type === "state.changed")
          .map((m) => (m.data as { to: string }).to);
        expect(changes).toEqual(EXPECTED_STATES[scenario]);

        // Back at rest (Requirement 6.5), with the verdict label still visible (Requirement 3.7).
        const last = result.states[result.states.length - 1]!;
        expect(last.deviceState).toBe("sleeping");
        expect(last.running).toBe(false);
        expect(last.pan).toBe(0);
        expect(last.tilt).toBe(0);
        expect(last.lantern).toBe(0);
        expect(last.subtitle).toBeNull();
        expect(last.verdict).toBe(EXPECTED_LABEL[scenario]);
      }),
      { numRuns: 100 },
    );
  });
});
