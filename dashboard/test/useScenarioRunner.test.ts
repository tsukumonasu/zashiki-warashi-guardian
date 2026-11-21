import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useScenarioRunner, TICK_MS, type Timer } from "../src/hooks/useScenarioRunner";
import { createManualClock } from "../src/lib/clock";
import { buildFamilyHomePlan } from "../src/simulation/plans";
import { FakePlayer } from "./helpers/fakePlayer";

/** A timer that fires only when the test says so. */
function fakeTimer(): Timer & { fire(): void; active(): boolean } {
  let fn: (() => void) | null = null;
  return {
    setInterval: (f) => {
      fn = f;
      return 1;
    },
    clearInterval: () => {
      fn = null;
    },
    fire: () => fn?.(),
    active: () => fn !== null,
  };
}

const plan = buildFamilyHomePlan({
  verdict: "family",
  confidence: 0.97,
  face: { left: 0.4, top: 0.3, width: 0.2, height: 0.3 },
  speech: { lineId: "greeting_family", ja: "", en: "" },
});

describe("useScenarioRunner", () => {
  it("runs family_home to rest and adds one simulated Timeline entry", () => {
    const clock = createManualClock(1_000_000);
    const player = new FakePlayer();
    const timer = fakeTimer();
    const { result } = renderHook(() => useScenarioRunner({ clock, player, timer }));

    act(() => result.current.start(plan, { seed: 7 }));
    expect(player.unlocked).toBe(true);
    expect(result.current.running).toBe(true);

    const seen = new Set<string>();
    for (let i = 0; i < 4000 && result.current.running; i++) {
      act(() => {
        clock.advance(TICK_MS);
        player.advance(TICK_MS);
        timer.fire();
      });
      seen.add(result.current.state.deviceState);
    }

    expect(result.current.running).toBe(false);
    expect(result.current.state.deviceState).toBe("sleeping");
    expect(timer.active()).toBe(false);
    expect(seen.has("greeting")).toBe(true);
    expect(player.requests.length).toBe(1);

    expect(result.current.encounters).toHaveLength(1);
    const e = result.current.encounters[0]!;
    expect(e.mode).toBe("simulation");
    expect(e.verdict).toBe("family");
    expect(e.reaction?.kind).toBe("family");
    expect(e.line?.ja).not.toBe("");
  });
});
