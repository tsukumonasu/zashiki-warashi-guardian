import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_CONFIG,
  checkOrdering,
  envName,
  loadConfig,
  type CloudConfig,
} from "../lambda/_shared/config.js";

/** Settings checked for ranges: name, min, max, integer-only. Mirrors the documented ranges. */
const RANGES: [keyof CloudConfig, number, number, boolean][] = [
  ["searchFloor", 0, 100, false],
  ["familyMin", 0, 100, false],
  ["strangerMax", 0, 100, false],
  ["faceConfidenceMin", 0, 100, false],
  ["minFaceWidth", 0, 1, false],
  ["minSharpness", 0, 255, false],
  ["minBrightness", 0, 255, false],
  ["maxYawDeg", 0, 90, false],
  ["acceptMin", 0, 1, false],
  ["notifyWindowMs", 0, 86_400_000, true],
  ["snapshotExpiryDays", 1, 7, true],
  ["statusIntervalS", 1, 3600, true],
  ["reviewerSimulatePerHour", 1, 1_000_000, true],
  ["reviewerGeneratePerHour", 1, 1_000_000, true],
  ["familySimulatePerHour", 1, 1_000_000, true],
  ["familyGeneratePerHour", 1, 1_000_000, true],
  ["globalSimulatePerDay", 1, 1_000_000, true],
];

/** Boundary values that keep the ordering rule satisfied for the ordering-related settings. */
function validFor(setting: keyof CloudConfig, value: number): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (setting === "searchFloor") Object.assign(base, { strangerMax: 100, familyMin: 100 });
  if (setting === "strangerMax") Object.assign(base, { searchFloor: 0, familyMin: 100 });
  if (setting === "familyMin") Object.assign(base, { searchFloor: 0, strangerMax: 0 });
  base[setting] = value;
  return base;
}

function thrown(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error("expected loadConfig to throw");
}

describe("defaults (R27.1)", () => {
  it("returns the documented defaults with no overrides", () => {
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
    expect(loadConfig({}, {})).toEqual({ ...DEFAULT_CONFIG });
  });

  it("uses the documented rate limit and status defaults", () => {
    const c = loadConfig();
    expect(c.reviewerSimulatePerHour).toBe(20);
    expect(c.reviewerGeneratePerHour).toBe(3);
    expect(c.familySimulatePerHour).toBe(100);
    expect(c.globalSimulatePerDay).toBe(300);
    expect(c.statusIntervalS).toBe(60);
    expect(c.snapshotExpiryDays).toBe(3);
    expect(c.reviewerRealEncounters).toBe("redacted");
  });

  it("the default thresholds satisfy the ordering rule", () => {
    expect(() => checkOrdering(DEFAULT_CONFIG)).not.toThrow();
  });
});

describe("override sources and order (R27.2)", () => {
  it("maps setting names to WARASHI_ environment names", () => {
    expect(envName("searchFloor")).toBe("WARASHI_SEARCH_FLOOR");
    expect(envName("globalSimulatePerDay")).toBe("WARASHI_GLOBAL_SIMULATE_PER_DAY");
  });

  it("reads CDK context by setting name", () => {
    expect(loadConfig({}, { statusIntervalS: 30 }).statusIntervalS).toBe(30);
  });

  it("reads the environment, accepting numeric strings", () => {
    expect(loadConfig({ WARASHI_STATUS_INTERVAL_S: "45" }).statusIntervalS).toBe(45);
  });

  it("environment wins over context, and context wins over the default", () => {
    const c = loadConfig({ WARASHI_STATUS_INTERVAL_S: "10" }, { statusIntervalS: 30, snapshotExpiryDays: 5 });
    expect(c.statusIntervalS).toBe(10);
    expect(c.snapshotExpiryDays).toBe(5);
    expect(c.notifyWindowMs).toBe(DEFAULT_CONFIG.notifyWindowMs);
  });

  it("treats empty or undefined environment values as unset", () => {
    const c = loadConfig({ WARASHI_STATUS_INTERVAL_S: "  ", WARASHI_SNAPSHOT_EXPIRY_DAYS: undefined }, { statusIntervalS: 30 });
    expect(c.statusIntervalS).toBe(30);
    expect(c.snapshotExpiryDays).toBe(3);
  });

  it("does not read the environment under the plain setting name", () => {
    expect(loadConfig({ statusIntervalS: 5 }).statusIntervalS).toBe(60);
  });
});

describe("ranges (R27.1, R14.9)", () => {
  for (const [setting, min, max, integer] of RANGES) {
    describe(setting, () => {
      it("accepts both boundaries", () => {
        expect(loadConfig({}, validFor(setting, min))[setting]).toBe(min);
        expect(loadConfig({}, validFor(setting, max))[setting]).toBe(max);
      });

      it("rejects values just outside, naming the setting and value", () => {
        for (const bad of [min - 1, max + 1]) {
          const e = thrown(() => loadConfig({}, validFor(setting, bad)));
          expect(e.setting).toBe(setting);
          expect(e.message).toContain(setting);
          expect(e.message).toContain(String(bad));
        }
      });

      it("rejects non-finite and non-numeric values", () => {
        for (const bad of [NaN, Infinity, -Infinity, "abc", true, {}]) {
          const e = thrown(() => loadConfig({}, { [setting]: bad }));
          expect(e.setting).toBe(setting);
        }
        const fromEnv = thrown(() => loadConfig({ [envName(setting)]: "Infinity" }));
        expect(fromEnv.setting).toBe(setting);
      });

      it("rejects a negative value", () => {
        const e = thrown(() => loadConfig({}, { [setting]: -5 }));
        expect(e.setting).toBe(setting);
        expect(e.message).toContain("-5");
      });

      if (integer) {
        it("rejects a fractional value", () => {
          const e = thrown(() => loadConfig({}, validFor(setting, min + 0.5)));
          expect(e.setting).toBe(setting);
          expect(e.message).toContain(String(min + 0.5));
        });
      }
    });
  }

  it("an invalid environment value is not rescued by a valid context value", () => {
    const e = thrown(() => loadConfig({ WARASHI_STATUS_INTERVAL_S: "0" }, { statusIntervalS: 30 }));
    expect(e.setting).toBe("statusIntervalS");
    expect(e.value).toBe("0");
  });
});

describe("ordering rule searchFloor <= strangerMax <= familyMin <= 100 (R5.16, R27.3)", () => {
  it("accepts equal values", () => {
    const c = loadConfig({}, { searchFloor: 80, strangerMax: 80, familyMin: 80 });
    expect([c.searchFloor, c.strangerMax, c.familyMin]).toEqual([80, 80, 80]);
  });

  it("accepts the full span 0 <= 0 <= 100", () => {
    expect(() => loadConfig({}, { searchFloor: 0, strangerMax: 0, familyMin: 100 })).not.toThrow();
  });

  it("rejects strangerMax above familyMin", () => {
    const e = thrown(() => loadConfig({}, { strangerMax: 95, familyMin: 90 }));
    expect(e.setting).toBe("strangerMax");
    expect(e.message).toContain("95");
  });

  it("rejects searchFloor above strangerMax", () => {
    const e = thrown(() => loadConfig({}, { searchFloor: 75, strangerMax: 70 }));
    expect(e.setting).toBe("searchFloor");
    expect(e.message).toContain("75");
  });

  it("applies the rule to values coming from the environment", () => {
    const e = thrown(() => loadConfig({ WARASHI_FAMILY_MIN: "60" }));
    expect(e.setting).toBe("strangerMax");
  });

  it("checkOrdering rejects a floor above the family minimum", () => {
    expect(() => checkOrdering({ searchFloor: 91, strangerMax: 70, familyMin: 90 })).toThrow(ConfigError);
  });
});

describe("reviewerRealEncounters", () => {
  it("accepts redacted and hidden from context and environment", () => {
    expect(loadConfig({}, { reviewerRealEncounters: "hidden" }).reviewerRealEncounters).toBe("hidden");
    expect(loadConfig({ WARASHI_REVIEWER_REAL_ENCOUNTERS: "redacted" }).reviewerRealEncounters).toBe("redacted");
  });

  it("environment wins over context", () => {
    const c = loadConfig({ WARASHI_REVIEWER_REAL_ENCOUNTERS: "hidden" }, { reviewerRealEncounters: "redacted" });
    expect(c.reviewerRealEncounters).toBe("hidden");
  });

  it("rejects any other value, naming the setting and value", () => {
    for (const bad of ["visible", "HIDDEN", 1, true]) {
      const e = thrown(() => loadConfig({}, { reviewerRealEncounters: bad }));
      expect(e.setting).toBe("reviewerRealEncounters");
      expect(e.message).toContain("reviewerRealEncounters");
      expect(e.message).toContain(String(bad));
    }
  });
});

describe("error message", () => {
  it("names the setting and the invalid value and sets the error name", () => {
    const e = thrown(() => loadConfig({ WARASHI_SNAPSHOT_EXPIRY_DAYS: "30" }));
    expect(e.name).toBe("ConfigError");
    expect(e.message).toContain("snapshotExpiryDays");
    expect(e.message).toContain('"30"');
  });

  it("truncates very long string values", () => {
    const e = thrown(() => loadConfig({}, { statusIntervalS: "x".repeat(500) }));
    expect(e.message.length).toBeLessThan(200);
  });
});
