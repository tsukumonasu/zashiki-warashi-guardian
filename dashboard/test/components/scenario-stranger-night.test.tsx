import { describe, expect, it } from "vitest";
import { COPY } from "../../src/content/copy";
import { renderScenarioHouse, timelineItemTexts } from "./scenarioHarness";

const JA = "……だあれ？ このいえの ひとじゃ ないね。";
const EN = "...Who are you? You don't belong to this house.";

describe("House: stranger_night scenario", () => {
  it("walks the states, stares silently, then warns, and adds a simulated entry marked as notified", async () => {
    const h = renderScenarioHouse();
    const s = COPY.house.states;

    await h.start("stranger_night");
    h.runUntilRest();

    // State labels in order, ending asleep again.
    const order = [s.sleeping, s.waking, s.seeking, s.gazing, s.warning, s.cooldown, s.sleeping];
    expect(h.stateLabels).toEqual(order);

    // Verdict label.
    expect(h.frames[0]!.verdict).toBe(COPY.house.noVerdict);
    expect(h.frames.map((f) => f.verdict)).toContain(COPY.verdicts.stranger);

    // No subtitle during the silent stare: it only appears once the line is spoken.
    const warning = h.frames.filter((f) => f.state === s.warning);
    expect(warning.length).toBeGreaterThan(0);
    expect(warning[0]!.subtitle).toBeNull();
    expect(h.frames.filter((f) => f.state === s.gazing).every((f) => f.subtitle === null)).toBe(true);
    expect(h.subtitles).toEqual([{ ja: JA, en: EN }]);

    // One simulated Timeline entry with the simulated notification note.
    expect(h.encounters()).toHaveLength(1);
    expect(h.encounters()[0]!.mode).toBe("simulation");
    const items = timelineItemTexts(h.timelineList());
    expect(items).toHaveLength(1);
    expect(items[0]).toContain(COPY.verdicts.stranger);
    expect(items[0]).toContain(COPY.timeline.familyNotified);
    expect(items[0]).toContain(COPY.timeline.familyNotifiedNote);
  });
});
