import { describe, expect, it } from "vitest";
import { capabilities, type Role } from "../src/lib/roles";
import { parseHash, hrefFor, watchRoute, navigate } from "../src/lib/router";
import { createManualClock, systemClock } from "../src/lib/clock";

describe("capabilities", () => {
  it("locks everything for a visitor", () => {
    expect(capabilities("visitor")).toEqual({
      liveCloud: false,
      deviceStatus: false,
      realTimeline: false,
      controls: false,
      faces: false,
      snapshot: "none",
    });
  });

  it("gives a reviewer read-only access with illustrations", () => {
    expect(capabilities("reviewer")).toEqual({
      liveCloud: true,
      deviceStatus: true,
      realTimeline: true,
      controls: false,
      faces: false,
      snapshot: "illustration",
    });
  });

  it("gives the family everything with snapshot urls", () => {
    expect(capabilities("family")).toEqual({
      liveCloud: true,
      deviceStatus: true,
      realTimeline: true,
      controls: true,
      faces: true,
      snapshot: "url",
    });
  });

  it("returns copies that cannot corrupt the tables", () => {
    const roles: Role[] = ["visitor", "reviewer", "family"];
    for (const r of roles) {
      capabilities(r).controls = !capabilities(r).controls;
      expect(capabilities(r)).toEqual(capabilities(r));
    }
    expect(capabilities("reviewer").controls).toBe(false);
  });
});

describe("router", () => {
  it("parses the four routes and falls back to /", () => {
    expect(parseHash("")).toBe("/");
    expect(parseHash("#/")).toBe("/");
    expect(parseHash("#/house")).toBe("/house");
    expect(parseHash("#/timeline")).toBe("/timeline");
    expect(parseHash("#/family")).toBe("/family");
    expect(parseHash("#/house/")).toBe("/house");
    expect(parseHash("#/house?x=1")).toBe("/house");
    expect(parseHash("#/nope")).toBe("/");
    expect(hrefFor("/timeline")).toBe("#/timeline");
  });

  it("notifies on hash changes and stops after unsubscribe", () => {
    const seen: string[] = [];
    const off = watchRoute((r) => seen.push(r));
    navigate("/family");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    off();
    navigate("/house");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(seen[0]).toBeDefined();
    expect(seen).toContain("/family");
    expect(seen).not.toContain("/house");
    window.location.hash = "";
  });
});

describe("clock", () => {
  it("manual clock moves only when told", () => {
    const c = createManualClock(100);
    expect(c.now()).toBe(100);
    c.advance(50);
    expect(c.now()).toBe(150);
    c.set(7);
    expect(c.now()).toBe(7);
  });

  it("system clock reports real time", () => {
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(1000);
  });
});
