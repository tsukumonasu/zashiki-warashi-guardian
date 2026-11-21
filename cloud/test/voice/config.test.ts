import { describe, expect, it } from "vitest";
import { envName } from "../../lambda/_shared/config.js";
import { ConfigError, DEFAULT_VOICE_CONFIG, loadVoiceConfig } from "../../lambda/_shared/voice/config.js";

/** Settings rejected when out of range: name, min, max. All are integers. */
const REJECTED: [string, number, number][] = [
  ["lookTimeoutSeconds", 2, 15],
  ["maxLooksPerSession", 0, 10],
  ["maxToolCalls", 1, 100],
  ["maxGazeCommands", 0, 60],
  ["gazeMinIntervalMs", 200, 10_000],
  ["chunkMs", 60, 200],
  ["reorderWindow", 1, 8],
  ["grantWindowSeconds", 10, 300],
  ["maxConcurrent", 1, 10],
];

/** Settings clamped on read (R6.14). */
const CLAMPED: [string, number, number][] = [
  ["maxSeconds", 30, 420],
  ["silenceSeconds", 5, 60],
  ["noClientSeconds", 5, 60],
];

describe("loadVoiceConfig defaults", () => {
  it("returns the documented defaults with no source", () => {
    expect(loadVoiceConfig()).toEqual(DEFAULT_VOICE_CONFIG);
    expect(loadVoiceConfig({}, {})).toEqual(DEFAULT_VOICE_CONFIG);
  });

  it("keeps voice and reviewer voice off by default (R15.1)", () => {
    const c = loadVoiceConfig();
    expect(c.voiceEnabled).toBe(false);
    expect(c.reviewerVoiceEnabled).toBe(false);
    expect(c.perUserPerDay.reviewer).toBe(2);
    expect(c.blockedWords).toEqual([]);
  });

  it("ignores empty-string overrides", () => {
    expect(loadVoiceConfig({ [envName("maxSeconds")]: "  " }, { maxSeconds: "" }).maxSeconds).toBe(180);
  });
});

describe("override sources and order", () => {
  it("reads the context value when no env is set", () => {
    expect(loadVoiceConfig({}, { maxToolCalls: 7 }).maxToolCalls).toBe(7);
  });

  it("reads the environment variable as a string", () => {
    expect(loadVoiceConfig({ [envName("maxToolCalls")]: "8" }).maxToolCalls).toBe(8);
  });

  it("prefers environment over context over default", () => {
    const env = { [envName("maxToolCalls")]: "8" };
    expect(loadVoiceConfig(env, { maxToolCalls: 7 }).maxToolCalls).toBe(8);
    expect(loadVoiceConfig({}, { maxToolCalls: 7 }).maxToolCalls).toBe(7);
    expect(loadVoiceConfig({}, {}).maxToolCalls).toBe(20);
  });

  it("applies the order to booleans, strings, gaze limits and caps", () => {
    const c = loadVoiceConfig(
      { [envName("voiceEnabled")]: "true", [envName("voiceId")]: " matthew " },
      { voiceEnabled: false, voiceId: "x", voiceGazePanDeg: 45, perUserPerDayFamily: "5" },
    );
    expect(c.voiceEnabled).toBe(true);
    expect(c.voiceId).toBe("matthew");
    expect(c.voiceGazeLimits.panDeg).toBe(45);
    expect(c.voiceGazeLimits.tiltDeg).toBe(20);
    expect(c.perUserPerDay.family).toBe(5);
  });

  it("parses blockedWords from a comma list or an array and drops empty entries", () => {
    expect(loadVoiceConfig({ [envName("blockedWords")]: "a, b,,c " }).blockedWords).toEqual(["a", "b", "c"]);
    expect(loadVoiceConfig({}, { blockedWords: ["x", " ", "y"] }).blockedWords).toEqual(["x", "y"]);
    expect(() => loadVoiceConfig({}, { blockedWords: 3 })).toThrow(ConfigError);
    expect(() => loadVoiceConfig({}, { blockedWords: [1] })).toThrow(ConfigError);
  });

  it("accepts true and false in any case and rejects other booleans", () => {
    expect(loadVoiceConfig({ [envName("voiceEnabled")]: "TRUE" }).voiceEnabled).toBe(true);
    expect(() => loadVoiceConfig({ [envName("voiceEnabled")]: "yes" })).toThrow(ConfigError);
    expect(() => loadVoiceConfig({}, { reviewerVoiceEnabled: 1 })).toThrow(ConfigError);
  });

  it("rejects an empty or non-string model id once a value is given", () => {
    expect(() => loadVoiceConfig({}, { voiceModelId: 5 })).toThrow(ConfigError);
  });
});

describe("rejected ranges", () => {
  it.each(REJECTED)("%s: boundaries accepted, outside and invalid values rejected", (name, min, max) => {
    const get = (v: unknown) => (loadVoiceConfig({}, { [name]: v }) as unknown as Record<string, number>)[name];
    expect(get(min)).toBe(min);
    expect(get(max)).toBe(max);
    expect(get(String(Math.floor((min + max) / 2)))).toBe(Math.floor((min + max) / 2));
    for (const bad of [min - 1, max + 1, -1, Number.NaN, Infinity, -Infinity, "abc", min + 0.5, true]) {
      expect(() => loadVoiceConfig({}, { [name]: bad }), `${name}=${String(bad)}`).toThrow(ConfigError);
    }
  });

  it("names the setting in the error", () => {
    try {
      loadVoiceConfig({ [envName("chunkMs")]: "1000" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain("chunkMs");
    }
  });

  it("rejects negative caps and accepts zero", () => {
    expect(loadVoiceConfig({}, { deviceStartsPerDay: 0 }).deviceStartsPerDay).toBe(0);
    expect(loadVoiceConfig({}, { globalPerDay: 0 }).globalPerDay).toBe(0);
    expect(loadVoiceConfig({}, { perUserPerDayFamily: 0 }).perUserPerDay.family).toBe(0);
    for (const name of ["deviceStartsPerDay", "globalPerDay", "perUserPerDayFamily", "perUserPerDayReviewer"]) {
      expect(() => loadVoiceConfig({}, { [name]: -1 })).toThrow(ConfigError);
      expect(() => loadVoiceConfig({}, { [name]: Number.NaN })).toThrow(ConfigError);
      expect(() => loadVoiceConfig({}, { [name]: 1.5 })).toThrow(ConfigError);
    }
  });

  it("limits the reviewer cap to 0..2 (R15.2)", () => {
    expect(loadVoiceConfig({}, { perUserPerDayReviewer: 2 }).perUserPerDay.reviewer).toBe(2);
    expect(() => loadVoiceConfig({}, { perUserPerDayReviewer: 3 })).toThrow(ConfigError);
  });

  it("accepts recheckSeconds 0 or 10..120 only", () => {
    for (const ok of [0, 10, 120, 45]) expect(loadVoiceConfig({}, { recheckSeconds: ok }).recheckSeconds).toBe(ok);
    for (const bad of [1, 9, 121, -1, Number.NaN, Infinity, 10.5]) {
      expect(() => loadVoiceConfig({}, { recheckSeconds: bad }), String(bad)).toThrow(ConfigError);
    }
  });
});

describe("clamped settings (R6.14)", () => {
  it.each(CLAMPED)("%s: clamps to its range", (name, min, max) => {
    const get = (v: unknown) => (loadVoiceConfig({}, { [name]: v }) as unknown as Record<string, number>)[name];
    expect(get(min)).toBe(min);
    expect(get(max)).toBe(max);
    expect(get(min + 1)).toBe(min + 1);
    expect(get(min - 1)).toBe(min);
    expect(get(max + 1)).toBe(max);
    expect(get(-10)).toBe(min);
    expect(get(1e9)).toBe(max);
    expect(get(String(max + 100))).toBe(max);
  });

  it.each(CLAMPED)("%s: non-finite values are rejected, not clamped", (name) => {
    for (const bad of [Number.NaN, Infinity, -Infinity, "abc"]) {
      expect(() => loadVoiceConfig({}, { [name]: bad })).toThrow(ConfigError);
    }
  });

  it("clamps an environment value too", () => {
    expect(loadVoiceConfig({ [envName("maxSeconds")]: "9999" }).maxSeconds).toBe(420);
  });
});

describe("gaze limits (R7.5)", () => {
  it("accepts 0 and the hardware ceilings 60 and 30", () => {
    const c = loadVoiceConfig({}, { voiceGazePanDeg: 60, voiceGazeTiltDeg: 30 });
    expect(c.voiceGazeLimits).toEqual({ panDeg: 60, tiltDeg: 30 });
    expect(loadVoiceConfig({}, { voiceGazePanDeg: 0, voiceGazeTiltDeg: 0 }).voiceGazeLimits).toEqual({
      panDeg: 0,
      tiltDeg: 0,
    });
  });

  it("rejects pan above 60 and tilt above 30", () => {
    expect(() => loadVoiceConfig({}, { voiceGazePanDeg: 60.5 })).toThrow(ConfigError);
    expect(() => loadVoiceConfig({}, { voiceGazePanDeg: 61 })).toThrow(ConfigError);
    expect(() => loadVoiceConfig({}, { voiceGazeTiltDeg: 30.5 })).toThrow(ConfigError);
    expect(() => loadVoiceConfig({}, { voiceGazeTiltDeg: 31 })).toThrow(ConfigError);
    expect(() => loadVoiceConfig({ [envName("voiceGazePanDeg")]: "90" })).toThrow(ConfigError);
  });

  it("rejects negative and non-finite limits", () => {
    for (const name of ["voiceGazePanDeg", "voiceGazeTiltDeg"]) {
      for (const bad of [-1, Number.NaN, Infinity, -Infinity]) {
        expect(() => loadVoiceConfig({}, { [name]: bad })).toThrow(ConfigError);
      }
    }
  });
});
