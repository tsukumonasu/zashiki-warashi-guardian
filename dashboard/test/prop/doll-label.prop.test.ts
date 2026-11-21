// Feature: dashboard-simulation, Property 26: The doll's text alternative follows its state
// **Validates: Requirements 17.6**

import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { dollLabel, AHEAD_TOLERANCE_DEG, DARK_BELOW, BRIGHT_FROM } from "../../src/simulation/doll-label";
import type { DeviceState } from "../../src/simulation/types";

const RUNS = { numRuns: 200 };

const DEVICE_STATES: DeviceState[] = [
  "sleeping",
  "waking",
  "seeking",
  "gazing",
  "greeting",
  "warning",
  "uncertain",
  "cooldown",
];

const DIRECTIONS = ["left", "ahead", "right"] as const;
const LEVELS = ["dark", "dim", "bright"] as const;

const arbState = fc.record({
  deviceState: fc.constantFrom(...DEVICE_STATES),
  pan: fc.oneof(
    fc.double({ min: -60, max: 60, noNaN: true }),
    fc.double({ min: -3, max: 3, noNaN: true }),
    fc.constantFrom(-AHEAD_TOLERANCE_DEG, AHEAD_TOLERANCE_DEG, 0),
  ),
  lantern: fc.oneof(
    fc.double({ min: 0, max: 1, noNaN: true }),
    fc.constantFrom(0, DARK_BELOW, BRIGHT_FROM, 1),
  ),
});

function expectedDirection(pan: number): (typeof DIRECTIONS)[number] {
  if (Math.abs(pan) <= 2) return "ahead";
  return pan < 0 ? "left" : "right";
}

function expectedLevel(lantern: number): (typeof LEVELS)[number] {
  if (lantern < 0.05) return "dark";
  return lantern < 0.5 ? "dim" : "bright";
}

describe("Property 26: The doll's text alternative follows its state", () => {
  it("names the state, the head direction and the lantern level", () => {
    fc.assert(
      fc.property(arbState, (s) => {
        const label = dollLabel(s);
        const words = label.split(/[^a-z]+/i);
        expect(label.length).toBeGreaterThan(0);
        expect(label).toContain(s.deviceState);
        const direction = expectedDirection(s.pan);
        const level = expectedLevel(s.lantern);
        expect(words).toContain(direction);
        expect(words).toContain(level);
        // No other direction or level word appears.
        for (const d of DIRECTIONS) if (d !== direction) expect(words).not.toContain(d);
        for (const l of LEVELS) if (l !== level) expect(words).not.toContain(l);
      }),
      RUNS,
    );
  });

  it("treats exactly ±2° as ahead", () => {
    expect(dollLabel({ deviceState: "gazing", pan: 2, lantern: 1 })).toContain("ahead");
    expect(dollLabel({ deviceState: "gazing", pan: -2, lantern: 1 })).toContain("ahead");
    expect(dollLabel({ deviceState: "gazing", pan: 2.01, lantern: 1 })).toContain("right");
  });
});
