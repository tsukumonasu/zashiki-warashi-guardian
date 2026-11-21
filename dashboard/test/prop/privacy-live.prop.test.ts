// Feature: dashboard-simulation, Property 15: Live results cannot smuggle text for non-family verdicts
// **Validates: Requirements 9.4**

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import catalog from "../../src/simulation/data/voice-catalog.json";
import { planFromResponse, type PlanResponse } from "../../src/simulation/plans";
import { containsLabel } from "../../src/simulation/privacy";
import { buildSimEncounter } from "../../src/simulation/timeline";
import type { ScenarioId, Verdict } from "../../src/simulation/types";
import { arbScenario, arbSeed, arbTickGap, drive } from "../helpers";

const LINES = catalog as { id: string; ja: string; en: string }[];

/** Labels carry a "§" marker, so they cannot occur in catalog text or message structure by chance. */
const arbLabel = fc.string({ unit: "grapheme", minLength: 1, maxLength: 8 }).map((s) => `§${s}`);
const arbLabelSet = fc.array(arbLabel, { minLength: 1, maxLength: 3 });

const arbVerdict: fc.Arbitrary<Exclude<Verdict, "family">> = fc.constantFrom("stranger", "no_face", "uncertain");

/** Hostile text: labels (also in other letter case) mixed with filler. */
function arbHostileText(labels: readonly string[]): fc.Arbitrary<string> {
  const piece = fc.oneof(
    fc.constantFrom(...labels),
    fc.constantFrom(...labels).map((l) => l.toUpperCase()),
    fc.string({ maxLength: 10 }),
  );
  return fc.array(piece, { minLength: 1, maxLength: 5 }).map((p) => p.join(" ") + ` ${labels[0]}`);
}

const arbCase = arbLabelSet.chain((labels) =>
  fc.record({
    labels: fc.constant(labels),
    scenario: arbScenario.filter((s): s is Exclude<ScenarioId, "network_down"> => s !== "network_down"),
    verdict: arbVerdict,
    lineId: fc.option(fc.constantFrom(...LINES.map((l) => l.id)), { nil: null }),
    ja: arbHostileText(labels),
    en: arbHostileText(labels),
    seed: arbSeed,
    gap: arbTickGap,
  }),
);

describe("Feature: dashboard-simulation, Property 15: Live results cannot smuggle text for non-family verdicts", () => {
  it("plan, display and timeline never contain a label and show catalog text", () => {
    fc.assert(
      fc.property(arbCase, ({ labels, scenario, verdict, lineId, ja, en, seed, gap }) => {
        const response: PlanResponse = {
          verdict,
          confidence: 0.9,
          face: verdict === "no_face" ? null : { left: 0.4, top: 0.3, width: 0.2, height: 0.3 },
          speech: { lineId, ja, en },
        };
        const plan = planFromResponse(scenario, response, labels);
        expect(plan.display).toBeNull();
        expect(containsLabel(JSON.stringify(plan), labels)).toBe(false);

        const run = drive(plan, seed, gap);
        for (const s of run.states) {
          if (s.subtitle) {
            expect(containsLabel(s.subtitle.ja, labels)).toBe(false);
            expect(containsLabel(s.subtitle.en, labels)).toBe(false);
          }
        }
        expect(containsLabel(JSON.stringify(run.messages), labels)).toBe(false);

        // The shown text is the catalog text of the line the doll actually said.
        const reaction = run.messages.find((m) => m.type === "reaction.performed");
        const shown = [...run.states].reverse().find((s) => s.subtitle !== null)?.subtitle ?? null;
        if (reaction?.type === "reaction.performed" && reaction.data.lineId !== null) {
          const line = LINES.find((l) => l.id === reaction.data.lineId);
          expect(line).toBeDefined();
          expect(shown).toEqual({ ja: line!.ja, en: line!.en });
        }

        // Timeline record built from the run, with the text that was displayed.
        const encounter = buildSimEncounter(run.messages, {
          mode: "live",
          ja: shown?.ja ?? "",
          en: shown?.en ?? "",
        });
        expect(containsLabel(JSON.stringify(encounter), labels)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
