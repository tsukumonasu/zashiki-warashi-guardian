// Feature: dashboard-simulation, Property 14: Scenarios never reveal a family label
// **Validates: Requirements 9.1, 9.2, 9.3**

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import family from "../../src/simulation/data/sample-responses/family.json";
import noFace from "../../src/simulation/data/sample-responses/no_face.json";
import stranger from "../../src/simulation/data/sample-responses/stranger.json";
import { containsLabel } from "../../src/simulation/privacy";
import {
  buildFamilyHomePlan,
  buildNetworkDownPlan,
  buildNobodyTherePlan,
  buildStrangerNightPlan,
  type PlanResponse,
} from "../../src/simulation/plans";
import { buildSimEncounter } from "../../src/simulation/timeline";
import type { ScenarioId, ScenarioPlan, SchemaMessage } from "../../src/simulation/types";
import { arbLabels, arbSeed, arbTickGap, drive } from "../helpers";

const SCENARIOS_NON_FAMILY = ["stranger_night", "nobody_there", "network_down"] as const;

/** Every string value reachable in `value`, keys included. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectStrings(v, out);
    }
  }
  return out;
}

function responseFor(scenario: ScenarioId): PlanResponse | null {
  switch (scenario) {
    case "family_home":
      return family as unknown as PlanResponse;
    case "stranger_night":
      return stranger as unknown as PlanResponse;
    case "nobody_there":
      return noFace as unknown as PlanResponse;
    case "network_down":
      return null;
  }
}

/** The response with every label planted in its speech text, in two letter cases. */
function poisoned(response: PlanResponse | null, labels: readonly string[]): PlanResponse | null {
  if (response === null || response.speech === null) return response;
  const planted = labels.flatMap((l) => [l, l.toUpperCase()]).join(" ");
  return {
    ...response,
    speech: {
      ...response.speech,
      ja: `${planted} ${response.speech.ja}`.slice(0, 200),
      en: `${planted} ${response.speech.en}`.slice(0, 200),
    },
  };
}

function plan(scenario: ScenarioId, response: PlanResponse | null, labels: readonly string[]): ScenarioPlan {
  if (response === null) return buildNetworkDownPlan();
  switch (scenario) {
    case "family_home":
      return buildFamilyHomePlan(response, labels);
    case "stranger_night":
      return buildStrangerNightPlan(response, labels);
    default:
      return buildNobodyTherePlan(response, labels);
  }
}

/** Timeline entry of a run; the spoken line is kept apart from the events. */
function timelineOf(messages: SchemaMessage[]) {
  return buildSimEncounter(messages, { mode: "simulation", ja: "", en: "" });
}

/** The first string that holds a label, or undefined. Unique strings only, to stay fast. */
function leak(strings: string[], labels: readonly string[]): string | undefined {
  return [...new Set(strings)].find((s) => containsLabel(s, labels));
}

const notSpeak = (m: SchemaMessage): boolean => m.type !== "speak";

describe("Feature: dashboard-simulation, Property 14: Scenarios never reveal a family label", () => {
  it("non-family verdict scenarios and network_down never contain a label", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SCENARIOS_NON_FAMILY),
        arbLabels,
        arbSeed,
        arbTickGap,
        (scenario, rawLabels, seed, gap) => {
          // Baseline run without labels: its text is the catalog text and fixed structure.
          const base = drive(plan(scenario, responseFor(scenario), []), seed, gap);
          const baseText = collectStrings([base.outputs, base.states]);
          // Labels that are part of the bundled text itself cannot be told apart; drop them
          // and check below that the baseline text is unchanged by planting labels.
          const baseUnique = [...new Set(baseText)];
          const labels = rawLabels.filter((l) => !baseUnique.some((s) => containsLabel(s, [l])));

          const run = drive(plan(scenario, poisoned(responseFor(scenario), rawLabels), rawLabels), seed, gap);
          expect([...new Set(collectStrings([run.outputs, run.states]))]).toEqual([...new Set(baseText)]);

          const timeline = timelineOf(run.messages);
          expect(leak(collectStrings([run.outputs, run.states, timeline]), labels)).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("family_home keeps labels out of everything except the text of a speak", () => {
    fc.assert(
      fc.property(arbLabels, arbSeed, arbTickGap, (rawLabels, seed, gap) => {
        const response = responseFor("family_home");
        const base = drive(plan("family_home", response, []), seed, gap);
        const baseText = collectStrings([
          base.messages.filter(notSpeak),
          base.states.map((s) => ({ ...s, subtitle: null })),
        ]);
        const labels = rawLabels.filter((l) => !baseText.some((s) => containsLabel(s, [l])));

        const run = drive(plan("family_home", poisoned(response, rawLabels), rawLabels), seed, gap);
        const events = run.messages.filter(notSpeak);
        const timeline = timelineOf(run.messages);
        const timelineText = collectStrings({
          ...timeline,
          events: timeline.events.filter(notSpeak),
          line: null,
        });

        expect(leak(collectStrings([events, timelineText]), labels)).toBeUndefined();
        // judgement.result and status.report are checked explicitly, as the requirement names them.
        for (const m of run.messages) {
          if (m.type === "judgement.result" || m.type === "status.report") {
            expect(leak(collectStrings(m), labels)).toBeUndefined();
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
