import { describe, expect, it } from "vitest";
import { COPY } from "../../src/content/copy";
import { renderScenarioHouse, timelineItemTexts } from "./scenarioHarness";

const JA = "……だれか、いるの？";
const EN = "...Is someone there?";

describe("House: nobody_there scenario", () => {
  it("walks the states through uncertain, shows the No face verdict and the uncertain line, and adds one simulated Timeline entry", async () => {
    const h = renderScenarioHouse();
    const s = COPY.house.states;

    expect(h.stateLabels).toEqual([s.sleeping]);

    await h.start("nobody_there");
    expect(h.player.unlocked).toBe(true);
    h.runUntilRest();

    // State labels in order: the doll scans, finds no face, is unsure, then settles.
    const order = [s.sleeping, s.waking, s.seeking, s.uncertain, s.cooldown, s.sleeping];
    expect(h.stateLabels).toEqual(order);

    // Verdict label.
    const verdicts = h.frames.map((f) => f.verdict);
    expect(verdicts[0]).toBe(COPY.house.noVerdict);
    expect(verdicts).toContain(COPY.verdicts.no_face);
    expect(verdicts).not.toContain(COPY.verdicts.family);
    expect(verdicts).not.toContain(COPY.verdicts.stranger);

    // The uncertain line, in Japanese and English, shown while unsure.
    expect(h.subtitles).toEqual([{ ja: JA, en: EN }]);
    const unsure = h.frames.filter((f) => f.state === s.uncertain);
    expect(unsure.length).toBeGreaterThan(0);
    expect(unsure.every((f) => f.subtitle?.ja === JA && f.subtitle?.en === EN)).toBe(true);

    // One simulated Timeline entry, with the verdict and the line, and no notification.
    expect(h.encounters()).toHaveLength(1);
    expect(h.encounters()[0]!.mode).toBe("simulation");
    const items = timelineItemTexts(h.timelineList());
    expect(items).toHaveLength(1);
    expect(items[0]).toContain(COPY.verdicts.no_face);
    expect(items[0]).toContain(JA);
    expect(items[0]).toContain(EN);
    expect(items[0]).not.toContain(COPY.timeline.familyNotified);
  });
});
