// Feature: dashboard-simulation, Property 19: The privacy indicator never claims "off" without evidence
// **Validates: Requirements 13.5, 13.6, 13.7, 13.8**

import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { indicatorView, INDICATOR_TEXT, type StatusFetch } from "../../src/simulation/indicator";
import type { StatusReportData } from "../../src/simulation/types";

const RUNS = { numRuns: 200 };

const arbStatus: fc.Arbitrary<StatusReportData> = fc.record({
  state: fc.constantFrom("sleeping", "waking", "seeking", "gazing", "greeting", "warning", "uncertain", "cooldown"),
  mode: fc.constantFrom("guard", "sleep"),
  panDeg: fc.double({ noNaN: true, noDefaultInfinity: true }),
  tiltDeg: fc.double({ noNaN: true, noDefaultInfinity: true }),
  lantern: fc.double({ min: 0, max: 1, noNaN: true }),
  cameraActive: fc.boolean(),
  micActive: fc.boolean(),
  motionEnabled: fc.boolean(),
  uptimeSec: fc.nat(),
  agentVersion: fc.string(),
}) as fc.Arbitrary<StatusReportData>;

const arbFetch: fc.Arbitrary<StatusFetch> = fc.oneof(
  fc.constant<StatusFetch>({ kind: "none" }),
  fc.constant<StatusFetch>({ kind: "failed" }),
  fc.record({
    kind: fc.constant("ok" as const),
    online: fc.boolean(),
    status: fc.option(arbStatus, { nil: null }),
  }),
);

describe("Property 19: privacy indicator never claims off without evidence", () => {
  it("maps every StatusFetch to the documented view", () => {
    fc.assert(
      fc.property(arbFetch, (f) => {
        const v = indicatorView(f);
        if (f.kind === "none") {
          expect(v).toEqual({ kind: "simulation", text: INDICATOR_TEXT.simulation });
        } else if (f.kind === "failed" || !f.online) {
          expect(v).toEqual({ kind: "unknown", text: INDICATOR_TEXT.unknown });
        } else if (f.status === null) {
          expect(v.kind).toBe("simulation");
        } else {
          const { cameraActive, micActive } = f.status;
          if (!cameraActive && !micActive) {
            expect(v).toEqual({ kind: "off", text: INDICATOR_TEXT.off });
          } else {
            expect(v.kind).toBe("active");
            if (v.kind === "active") {
              expect(v.parts.includes("Camera on")).toBe(cameraActive);
              expect(v.parts.includes("Microphone on")).toBe(micActive);
              expect(v.parts.length).toBe(Number(cameraActive) + Number(micActive));
            }
          }
        }
      }),
      RUNS,
    );
  });

  it("claims off only for an online doll whose report has both flags false", () => {
    fc.assert(
      fc.property(arbFetch, (f) => {
        if (indicatorView(f).kind === "off") {
          expect(f.kind).toBe("ok");
          if (f.kind === "ok") {
            expect(f.online).toBe(true);
            expect(f.status?.cameraActive).toBe(false);
            expect(f.status?.micActive).toBe(false);
          }
        }
      }),
      RUNS,
    );
  });
});
