import { describe, expect, it } from "vitest";
import { COPY } from "../../src/content/copy";
import { renderScenarioHouse, timelineItemTexts } from "./scenarioHarness";

const JA = "おかえり。きょうも ぶじで よかった。";
const EN = "Welcome home. I'm glad you're safe today.";

describe("House: family_home scenario", () => {
  it("walks the states, shows the Family verdict and subtitle, and adds one simulated Timeline entry", async () => {
    const h = renderScenarioHouse();
    const s = COPY.house.states;

    expect(h.stateLabels).toEqual([s.sleeping]);
    expect(h.timelineList().textContent).toContain(COPY.timeline.empty);

    await h.start("family_home");
    expect(h.player.unlocked).toBe(true);
    h.runUntilRest();

    // State labels in order, ending asleep again.
    const order = [s.sleeping, s.waking, s.seeking, s.gazing, s.greeting, s.cooldown, s.sleeping];
    expect(h.stateLabels).toEqual(order);

    // Verdict label.
    const verdicts = h.frames.map((f) => f.verdict);
    expect(verdicts[0]).toBe(COPY.house.noVerdict);
    expect(verdicts).toContain(COPY.verdicts.family);

    // Japanese and English subtitle, shown while greeting.
    expect(h.subtitles).toEqual([{ ja: JA, en: EN }]);
    const greeting = h.frames.filter((f) => f.state === s.greeting);
    expect(greeting.length).toBeGreaterThan(0);
    expect(greeting.every((f) => f.subtitle?.ja === JA && f.subtitle?.en === EN)).toBe(true);

    // One audio request, no API involved.
    expect(h.player.requests).toHaveLength(1);

    // One new simulated Timeline entry, with verdict, line and no real notification.
    expect(h.encounters()).toHaveLength(1);
    expect(h.encounters()[0]!.mode).toBe("simulation");
    const items = timelineItemTexts(h.timelineList());
    expect(items).toHaveLength(1);
    expect(items[0]).toContain(COPY.verdicts.family);
    expect(items[0]).toContain(JA);
    expect(items[0]).toContain(EN);
    expect(items[0]).not.toContain(COPY.timeline.familyNotified);
  });
});
