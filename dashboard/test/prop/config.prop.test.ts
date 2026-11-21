// Feature: dashboard-simulation, Property 8: Unsafe configuration falls back to the defaults
// **Validates: Requirements 6.2**

import fc from "fast-check";
import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONFIG,
  HARD_PAN_LIMIT,
  HARD_TILT_LIMIT,
  MAX_GLIDE_STEP_DEG,
  MIN_GLIDE_INTERVAL_MS,
  validateConfig,
} from "../../src/simulation/config";
import type { SimConfig } from "../../src/simulation/types";

const RUNS = { numRuns: 200 };

/** Arbitrary finite numbers, biased toward the limits so both sides of each rule are hit. */
const arbNum = fc.oneof(
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.double({ min: -100, max: 100, noNaN: true }),
  fc.constantFrom(
    0,
    -0,
    2,
    2.0001,
    30,
    30.0001,
    60,
    60.0001,
    HARD_PAN_LIMIT,
    HARD_TILT_LIMIT,
    MAX_GLIDE_STEP_DEG,
    MIN_GLIDE_INTERVAL_MS,
    29.999,
    5,
  ),
);

const arbPartial: fc.Arbitrary<Partial<SimConfig>> = fc.record(
  {
    panLimit: arbNum,
    tiltLimit: arbNum,
    glideStepDeg: arbNum,
    glideIntervalMs: arbNum,
    cooldownS: arbNum,
    glideTimeoutS: arbNum,
    lanternFadeOutMs: arbNum,
  },
  { requiredKeys: [] },
);

describe("Property 8: Unsafe configuration falls back to the defaults", () => {
  it("never exceeds the hard limits and replaces each rejected field with its default", () => {
    fc.assert(
      fc.property(arbPartial, (partial) => {
        const cfg = validateConfig(partial);

        expect(cfg.panLimit).toBeLessThanOrEqual(HARD_PAN_LIMIT);
        expect(cfg.tiltLimit).toBeLessThanOrEqual(HARD_TILT_LIMIT);
        expect(cfg.glideStepDeg).toBeLessThanOrEqual(MAX_GLIDE_STEP_DEG);
        expect(cfg.glideIntervalMs).toBeGreaterThanOrEqual(MIN_GLIDE_INTERVAL_MS);
        expect(cfg.cooldownS).toBeGreaterThanOrEqual(
          cfg.glideTimeoutS + cfg.lanternFadeOutMs / 1000,
        );

        const checks: Array<[keyof SimConfig, boolean]> = [
          ["panLimit", partial.panLimit === undefined || (partial.panLimit >= 0 && partial.panLimit <= HARD_PAN_LIMIT)],
          ["tiltLimit", partial.tiltLimit === undefined || (partial.tiltLimit >= 0 && partial.tiltLimit <= HARD_TILT_LIMIT)],
          ["glideStepDeg", partial.glideStepDeg === undefined || (partial.glideStepDeg > 0 && partial.glideStepDeg <= MAX_GLIDE_STEP_DEG)],
          ["glideIntervalMs", partial.glideIntervalMs === undefined || partial.glideIntervalMs >= MIN_GLIDE_INTERVAL_MS],
        ];
        for (const [key, safe] of checks) {
          if (!safe) expect(cfg[key]).toBe(DEFAULT_CONFIG[key]);
        }
      }),
      RUNS,
    );
  });

  it("returns the defaults for an empty configuration", () => {
    expect(validateConfig({})).toEqual(DEFAULT_CONFIG);
  });
});
