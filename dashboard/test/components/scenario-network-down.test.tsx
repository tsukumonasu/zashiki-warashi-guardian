import { describe, expect, it } from "vitest";
import { COPY } from "../../src/content/copy";
import { FakeApiClient } from "../helpers/FakeApiClient";
import { renderScenarioHouse, timelineItemTexts } from "./scenarioHarness";

/** The `uncertain` lines of the voice catalog; the doll draws one of them. */
const UNCERTAIN_LINES = [
  { ja: "……だれか、いるの？", en: "...Is someone there?" },
  { ja: "……いま、かげが うごいた？", en: "...Did a shadow just move?" },
  { ja: "……かぜの おと、かな。", en: "...Was that only the wind?" },
];

describe("House: network_down scenario", () => {
  it("goes waking to uncertain with the Offline verdict, no snapshot, no API call, and one simulated Timeline entry", async () => {
    const api = new FakeApiClient();
    const h = renderScenarioHouse({ api, role: "family" });
    const s = COPY.house.states;

    expect(h.stateLabels).toEqual([s.sleeping]);

    await h.start("network_down");
    expect(h.player.unlocked).toBe(true);
    h.runUntilRest();

    // No seeking (snapshot) step: waking leads straight to uncertain.
    expect(h.stateLabels).toEqual([s.sleeping, s.waking, s.uncertain, s.cooldown, s.sleeping]);
    expect(h.stateLabels).not.toContain(s.seeking);
    expect(h.stateLabels).not.toContain(s.gazing);

    // Verdict label "Offline".
    const verdicts = h.frames.map((f) => f.verdict);
    expect(verdicts[0]).toBe(COPY.house.noVerdict);
    expect(verdicts).toContain(COPY.verdicts.offline);
    expect(COPY.verdicts.offline).toBe("Offline");

    // Uncertain subtitle, shown while in the uncertain state.
    expect(h.subtitles).toHaveLength(1);
    const line = h.subtitles[0]!;
    expect(UNCERTAIN_LINES).toContainEqual(line);
    const uncertain = h.frames.filter((f) => f.state === s.uncertain);
    expect(uncertain.length).toBeGreaterThan(0);
    expect(uncertain.every((f) => f.subtitle?.ja === line.ja && f.subtitle?.en === line.en)).toBe(true);

    // No API call of any kind.
    expect(api.calls).toEqual([]);

    // One simulated Timeline entry, marked offline, with the line.
    expect(h.encounters()).toHaveLength(1);
    expect(h.encounters()[0]!.mode).toBe("simulation");
    const items = timelineItemTexts(h.timelineList());
    expect(items).toHaveLength(1);
    expect(items[0]).toContain(COPY.verdicts.offline);
    expect(items[0]).toContain(line.ja);
    expect(items[0]).toContain(line.en);
    expect(items[0]).not.toContain(COPY.timeline.familyNotified);
  });
});
