// Feature: dashboard-simulation, Property 20: Manual commands stay inside the documented ranges
// **Validates: Requirements 14.3, 14.4**

import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { buildCommand, type Control } from "../../src/simulation/controls";
import { decodeValue } from "../../src/simulation/codec";

const RUNS = { numRuns: 200 };

/** Any double, with the nasty ones listed explicitly. */
const arbNumber = fc.oneof(
  fc.double({ noNaN: false }),
  fc.constantFrom(NaN, Infinity, -Infinity, 1e308, -1e308, Number.MAX_VALUE, -0, 0, 1, -1),
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
);

const arbControl: fc.Arbitrary<Control> = fc.oneof(
  fc.string().map((lineId): Control => ({ kind: "speak", lineId })),
  fc.constantFrom<"left" | "right">("left", "right").map((side): Control => ({ kind: "look", side })),
  fc
    .record({ level: arbNumber, fadeS: arbNumber })
    .map(({ level, fadeS }): Control => ({ kind: "lantern", level, fadeS })),
  fc.constantFrom<"guard" | "sleep">("guard", "sleep").map((mode): Control => ({ kind: "mode", mode })),
);

/** Wrap a command in an envelope so the codec can check it. */
function envelope(type: string, data: unknown): unknown {
  return {
    v: 1,
    id: "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10",
    ts: "2026-11-20T12:34:56.789Z",
    deviceId: "warashi-01",
    encounterId: null,
    type,
    data,
  };
}

describe("Property 20: manual commands stay inside the documented ranges", () => {
  it("every command is within range and decodes valid", () => {
    fc.assert(
      fc.property(arbControl, (control) => {
        const cmd = buildCommand(control);
        switch (cmd.type) {
          case "lantern": {
            const { level, fadeMs } = cmd.data;
            expect(Number.isFinite(level)).toBe(true);
            expect(level).toBeGreaterThanOrEqual(0);
            expect(level).toBeLessThanOrEqual(1);
            expect(Number.isInteger(fadeMs)).toBe(true);
            expect(fadeMs).toBeGreaterThanOrEqual(0);
            expect(fadeMs).toBeLessThanOrEqual(10_000);
            break;
          }
          case "gaze": {
            const { panDeg, tiltDeg } = cmd.data;
            expect(Math.abs(panDeg)).toBeLessThanOrEqual(20);
            expect(Math.abs(tiltDeg)).toBeLessThanOrEqual(20);
            // Hard limits of the HTTP API.
            expect(Math.abs(panDeg)).toBeLessThanOrEqual(60);
            expect(Math.abs(tiltDeg)).toBeLessThanOrEqual(30);
            expect(tiltDeg).toBe(0);
            break;
          }
          case "speak": {
            expect(control.kind).toBe("speak");
            expect(Object.keys(cmd.data)).toEqual(["lineId"]);
            expect("audioUrl" in cmd.data).toBe(false);
            break;
          }
          case "mode.set":
            expect(["guard", "sleep"]).toContain(cmd.data.mode);
            break;
        }

        // The codec validates the wire shape. `speak` also needs ja/en on the wire,
        // and a lineId that is a string is all the codec requires of it.
        const data =
          cmd.type === "speak" ? { lineId: cmd.data.lineId, audioUrl: null, ja: "あ", en: "a" } : cmd.data;
        expect(decodeValue(envelope(cmd.type, data)).kind).toBe("valid");
      }),
      RUNS,
    );
  });

  it("non-finite and huge lantern inputs are clamped, not propagated", () => {
    fc.assert(
      fc.property(arbNumber, arbNumber, (level, fadeS) => {
        const cmd = buildCommand({ kind: "lantern", level, fadeS });
        expect(cmd.type).toBe("lantern");
        if (cmd.type !== "lantern") return;
        if (!Number.isFinite(level)) expect(cmd.data.level).toBe(0);
        if (!Number.isFinite(fadeS)) expect(cmd.data.fadeMs).toBe(0);
        if (Number.isFinite(fadeS) && fadeS >= 10) expect(cmd.data.fadeMs).toBe(10_000);
      }),
      RUNS,
    );
  });

  it("look left and right give pan -20 and +20 with tilt 0", () => {
    expect(buildCommand({ kind: "look", side: "left" })).toEqual({
      type: "gaze",
      data: { panDeg: -20, tiltDeg: 0 },
    });
    expect(buildCommand({ kind: "look", side: "right" })).toEqual({
      type: "gaze",
      data: { panDeg: 20, tiltDeg: 0 },
    });
  });
});
