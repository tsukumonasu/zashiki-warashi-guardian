import { describe, expect, it } from "vitest";
import { drive, planFor } from "./index";

describe("drive()", () => {
  it("runs family_home to rest and is deterministic", () => {
    const plan = planFor("family_home");
    const a = drive(plan, 7, 50);
    const b = drive(plan, 7, 50);
    expect(a.finished).toBe(true);
    expect(a.endedAtMs).toBeLessThanOrEqual(130_000);
    expect(a.states.length).toBeGreaterThan(1);
    const types = a.messages.map((m) => m.type);
    expect(types).toContain("presence.detected");
    expect(types).toContain("encounter.ended");
    expect(a.outputs.some((o) => o.kind === "audio.play")).toBe(true);
    expect(a.messages).toEqual(b.messages);
  });

  it("stops at maxMs when the run does not finish", () => {
    const r = drive(planFor("stranger_night"), 1, 100, { maxMs: 500 });
    expect(r.finished).toBe(false);
    expect(r.endedAtMs).toBeGreaterThanOrEqual(500);
  });
});
