import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE_CONFIG, type VoiceConfig } from "../../lambda/_shared/voice/config.js";
import {
  TOOL_SPECS,
  lookResultForModel,
  toolResultsFor,
  toolToCommand,
  type ToolContext,
  type ToolOutcome,
} from "../../lambda/_shared/voice/tools.js";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  let n = 0;
  return {
    nowMs: NOW,
    toolCalls: 0,
    looks: 0,
    gazeCommands: 0,
    lastGazeAtMs: null,
    dollReachable: true,
    deviceId: "warashi-01",
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    ...over,
  };
}

const cfg: VoiceConfig = { ...DEFAULT_VOICE_CONFIG };

function run(name: string, input: unknown, ctx = makeCtx(), c = cfg): ToolOutcome {
  return toolToCommand(name, typeof input === "string" ? input : JSON.stringify(input), ctx, c);
}

function gazeData(o: ToolOutcome): { panDeg: number; tiltDeg: number } {
  if (o.kind !== "command") throw new Error(`expected command, got ${JSON.stringify(o)}`);
  expect(o.envelopes).toHaveLength(1);
  expect(o.envelopes[0]?.type).toBe("gaze");
  return o.envelopes[0]?.data as { panDeg: number; tiltDeg: number };
}

function errorCode(o: ToolOutcome): string {
  if (o.kind !== "error") throw new Error(`expected error, got ${JSON.stringify(o)}`);
  expect(o.result.ok).toBe(false);
  return o.result.error;
}

describe("TOOL_SPECS", () => {
  it("lists the three tools with object input schemas", () => {
    expect(TOOL_SPECS.map((t) => t.toolSpec.name)).toEqual(["turn_head", "set_lantern", "look"]);
    for (const t of TOOL_SPECS) {
      expect((t.toolSpec.inputSchema.json as { type: string }).type).toBe("object");
    }
  });
});

describe("turn_head", () => {
  it.each([
    ["left", -20, 0],
    ["right", 20, 0],
    ["up", 0, 12],
    ["down", 0, -8],
    ["center", 0, 0],
  ])("direction %s maps to the table", (direction, pan, tilt) => {
    const o = run("turn_head", { direction });
    expect(gazeData(o)).toEqual({ panDeg: pan, tiltDeg: tilt });
    expect((o as { result: object }).result).toEqual({ ok: true, pan, tilt });
  });

  it("builds the envelope for the target doll with a null encounter", () => {
    const o = run("turn_head", { direction: "left" });
    if (o.kind !== "command") throw new Error("expected command");
    const env = o.envelopes[0]!;
    expect(env.deviceId).toBe("warashi-01");
    expect(env.encounterId).toBeNull();
    expect(env.ts).toBe(new Date(NOW).toISOString());
  });

  it("uses exact angles and defaults a missing axis to 0", () => {
    expect(gazeData(run("turn_head", { pan_deg: 10, tilt_deg: -5 }))).toEqual({ panDeg: 10, tiltDeg: -5 });
    expect(gazeData(run("turn_head", { pan_deg: 10 }))).toEqual({ panDeg: 10, tiltDeg: 0 });
    expect(gazeData(run("turn_head", { tilt_deg: 7 }))).toEqual({ panDeg: 0, tiltDeg: 7 });
  });

  it("clamps huge and negative angles to the configured limits", () => {
    expect(gazeData(run("turn_head", { pan_deg: 1e9, tilt_deg: 1e9 }))).toEqual({ panDeg: 30, tiltDeg: 20 });
    expect(gazeData(run("turn_head", { pan_deg: -1e9, tilt_deg: -1e9 }))).toEqual({ panDeg: -30, tiltDeg: -20 });
  });

  it("never widens the range beyond the hardware ceilings, even with a bad config", () => {
    const wide = { ...cfg, voiceGazeLimits: { panDeg: 500, tiltDeg: 500 } };
    expect(gazeData(run("turn_head", { pan_deg: 999, tilt_deg: 999 }, makeCtx(), wide))).toEqual({
      panDeg: 60,
      tiltDeg: 30,
    });
    const nan = { ...cfg, voiceGazeLimits: { panDeg: Number.NaN, tiltDeg: -5 } };
    expect(gazeData(run("turn_head", { pan_deg: 50, tilt_deg: 50 }, makeCtx(), nan))).toEqual({
      panDeg: 0,
      tiltDeg: 0,
    });
  });

  it("does not produce -0", () => {
    const d = gazeData(run("turn_head", { pan_deg: -0, tilt_deg: -0 }));
    expect(Object.is(d.panDeg, 0)).toBe(true);
    expect(Object.is(d.tiltDeg, 0)).toBe(true);
  });

  it("lets a valid direction win over angles", () => {
    expect(gazeData(run("turn_head", { direction: "right", pan_deg: -10 }))).toEqual({ panDeg: 20, tiltDeg: 0 });
  });

  it("falls back to angles for an unknown direction, and fails when there are none", () => {
    expect(gazeData(run("turn_head", { direction: "sideways", pan_deg: 5 }))).toEqual({ panDeg: 5, tiltDeg: 0 });
    expect(errorCode(run("turn_head", { direction: "sideways" }))).toBe("bad_arguments");
    // Prototype keys are not directions.
    expect(errorCode(run("turn_head", { direction: "toString" }))).toBe("bad_arguments");
    expect(errorCode(run("turn_head", { direction: "__proto__" }))).toBe("bad_arguments");
  });

  it.each([
    ["missing arguments", {}],
    ["null angle", { pan_deg: null }],
    ["string in a number field", { pan_deg: "10" }],
    ["nested value", { pan_deg: { value: 10 } }],
    ["array value", { tilt_deg: [1] }],
    ["boolean value", { pan_deg: true }],
    ["null direction", { direction: null }],
    ["numeric direction", { direction: 3 }],
  ])("rejects %s with bad_arguments", (_label, input) => {
    expect(errorCode(run("turn_head", input))).toBe("bad_arguments");
  });

  it("ignores a non-finite angle but still accepts the other axis", () => {
    // JSON cannot carry NaN or Infinity; 1e999 parses to Infinity.
    expect(errorCode(run("turn_head", '{"pan_deg":1e999}'))).toBe("bad_arguments");
    expect(gazeData(run("turn_head", '{"pan_deg":1e999,"tilt_deg":4}'))).toEqual({ panDeg: 0, tiltDeg: 4 });
  });

  it.each([["null"], ["[]"], ["5"], ['"left"'], ["true"]])("rejects non-object JSON %s", (json) => {
    expect(errorCode(run("turn_head", json))).toBe("bad_arguments");
  });

  it("stops at maxGazeCommands with too_many_moves", () => {
    const ctx = makeCtx({ gazeCommands: cfg.maxGazeCommands });
    expect(errorCode(run("turn_head", { direction: "left" }, ctx))).toBe("too_many_moves");
    const ok = makeCtx({ gazeCommands: cfg.maxGazeCommands - 1 });
    expect(run("turn_head", { direction: "left" }, ok).kind).toBe("command");
  });

  it("enforces the minimum interval with too_fast", () => {
    const min = cfg.gazeMinIntervalMs;
    expect(errorCode(run("turn_head", { direction: "left" }, makeCtx({ lastGazeAtMs: NOW - (min - 1) })))).toBe(
      "too_fast",
    );
    expect(run("turn_head", { direction: "left" }, makeCtx({ lastGazeAtMs: NOW - min })).kind).toBe("command");
    expect(run("turn_head", { direction: "left" }, makeCtx({ lastGazeAtMs: null })).kind).toBe("command");
  });
});

describe("set_lantern", () => {
  function lanternData(o: ToolOutcome): { level: number; fadeMs: number } {
    if (o.kind !== "command") throw new Error(`expected command, got ${JSON.stringify(o)}`);
    expect(o.envelopes[0]?.type).toBe("lantern");
    expect(o.result).toEqual({ ok: true });
    return o.envelopes[0]?.data as { level: number; fadeMs: number };
  }

  it("accepts a valid level and defaults fadeMs to 1200", () => {
    expect(lanternData(run("set_lantern", { level: 0.5 }))).toEqual({ level: 0.5, fadeMs: 1200 });
  });

  it("uses a given fade and rounds it", () => {
    expect(lanternData(run("set_lantern", { level: 1, fade_ms: 250.6 }))).toEqual({ level: 1, fadeMs: 251 });
  });

  it("clamps huge and negative values", () => {
    expect(lanternData(run("set_lantern", { level: 1e9, fade_ms: 1e9 }))).toEqual({ level: 1, fadeMs: 10_000 });
    expect(lanternData(run("set_lantern", { level: -3, fade_ms: -50 }))).toEqual({ level: 0, fadeMs: 0 });
  });

  it("does not produce -0", () => {
    const d = lanternData(run("set_lantern", { level: -0, fade_ms: -0 }));
    expect(Object.is(d.level, 0)).toBe(true);
    expect(Object.is(d.fadeMs, 0)).toBe(true);
  });

  it("uses the default fade when fade_ms is not a finite number", () => {
    expect(lanternData(run("set_lantern", { level: 0.2, fade_ms: "100" })).fadeMs).toBe(1200);
    expect(lanternData(run("set_lantern", { level: 0.2, fade_ms: null })).fadeMs).toBe(1200);
  });

  it.each([
    ["missing level", {}],
    ["null level", { level: null }],
    ["string level", { level: "0.5" }],
    ["nested level", { level: { v: 1 } }],
    ["array level", { level: [1] }],
  ])("rejects %s with bad_arguments", (_label, input) => {
    expect(errorCode(run("set_lantern", input))).toBe("bad_arguments");
  });

  it("rejects non-object JSON and an infinite level", () => {
    expect(errorCode(run("set_lantern", "null"))).toBe("bad_arguments");
    expect(errorCode(run("set_lantern", "[1]"))).toBe("bad_arguments");
    expect(errorCode(run("set_lantern", '{"level":1e999}'))).toBe("bad_arguments");
  });

  it("is not limited by the head-move counters", () => {
    const ctx = makeCtx({ gazeCommands: 999, lastGazeAtMs: NOW });
    expect(run("set_lantern", { level: 1 }, ctx).kind).toBe("command");
  });
});

describe("look", () => {
  it("returns a snapshot.request whose requestId is the envelope data", () => {
    const o = run("look", {});
    if (o.kind !== "look") throw new Error(`expected look, got ${JSON.stringify(o)}`);
    expect(o.envelope.type).toBe("snapshot.request");
    expect(o.envelope.data).toEqual({ requestId: o.requestId });
    expect(o.envelope.encounterId).toBeNull();
    expect(o.requestId).toMatch(/^[A-Za-z0-9-]{1,64}$/);
  });

  it("accepts an empty input string and extra fields", () => {
    expect(run("look", "").kind).toBe("look");
    expect(run("look", "   ").kind).toBe("look");
    expect(run("look", { anything: { nested: [1] } }).kind).toBe("look");
  });

  it("stops at maxLooksPerSession with too_many_looks", () => {
    expect(errorCode(run("look", {}, makeCtx({ looks: cfg.maxLooksPerSession })))).toBe("too_many_looks");
    expect(run("look", {}, makeCtx({ looks: cfg.maxLooksPerSession - 1 })).kind).toBe("look");
  });

  it("is refused when no look is allowed at all", () => {
    expect(errorCode(run("look", {}, makeCtx(), { ...cfg, maxLooksPerSession: 0 }))).toBe("too_many_looks");
  });
});

describe("shared checks", () => {
  it("reports unknown_tool for other names, including prototype keys", () => {
    for (const name of ["", "fly", "TURN_HEAD", "toString", "__proto__"]) {
      expect(errorCode(run(name, {}))).toBe("unknown_tool");
    }
  });

  it("reports bad_arguments for invalid JSON before anything else", () => {
    expect(errorCode(run("turn_head", "{not json"))).toBe("bad_arguments");
    expect(errorCode(run("fly", "{not json"))).toBe("bad_arguments");
    expect(errorCode(run("look", "{", makeCtx({ toolCalls: 999 })))).toBe("bad_arguments");
  });

  it("reports too_many_calls before the tool name and the doll check", () => {
    const ctx = makeCtx({ toolCalls: cfg.maxToolCalls, dollReachable: false });
    expect(errorCode(run("turn_head", {}, ctx))).toBe("too_many_calls");
    expect(errorCode(run("fly", {}, ctx))).toBe("too_many_calls");
    expect(run("set_lantern", { level: 1 }, makeCtx({ toolCalls: cfg.maxToolCalls - 1 })).kind).toBe("command");
  });

  it("reports doll_unavailable for every tool when the doll is unreachable", () => {
    const ctx = makeCtx({ dollReachable: false });
    expect(errorCode(run("turn_head", { direction: "left" }, ctx))).toBe("doll_unavailable");
    expect(errorCode(run("set_lantern", { level: 1 }, ctx))).toBe("doll_unavailable");
    expect(errorCode(run("look", {}, ctx))).toBe("doll_unavailable");
  });

  it("checks the doll before per-tool limits", () => {
    const ctx = makeCtx({ dollReachable: false, gazeCommands: 999, looks: 999 });
    expect(errorCode(run("turn_head", {}, ctx))).toBe("doll_unavailable");
    expect(errorCode(run("look", {}, ctx))).toBe("doll_unavailable");
  });

  it("never throws, even for a bad clock or a throwing id source", () => {
    expect(errorCode(run("turn_head", { direction: "left" }, makeCtx({ nowMs: Number.NaN })))).toBe("internal");
    const boom = makeCtx({
      newId: () => {
        throw new Error("no ids");
      },
    });
    expect(errorCode(run("look", {}, boom))).toBe("internal");
    expect(toolToCommand("turn_head", undefined as unknown as string, makeCtx(), cfg).kind).toBe("error");
  });

  it("keeps names, ids, confidences and face boxes out of results for the model", () => {
    const outcomes = [
      run("turn_head", { direction: "left" }),
      run("set_lantern", { level: 0.3 }),
      run("turn_head", { pan_deg: 5, name: "Hana", id: "x", confidence: 0.9, face: { left: 0 } }, makeCtx(), cfg),
    ];
    for (const o of outcomes) {
      if (o.kind !== "command") throw new Error("expected command");
      const keys = Object.keys(o.result);
      for (const k of keys) expect(["ok", "pan", "tilt"]).toContain(k);
      expect(JSON.stringify(o.result)).not.toMatch(/name|confidence|face|id|Hana/i);
    }
    for (const o of [run("fly", {}), run("turn_head", "{")]) {
      if (o.kind !== "error") throw new Error("expected error");
      expect(Object.keys(o.result).sort()).toEqual(["error", "ok"]);
    }
  });
});

describe("lookResultForModel", () => {
  it.each([
    ["family", "family"],
    ["stranger", "stranger"],
    ["no_face", "nobody"],
    ["uncertain", "unsure"],
    ["timeout", "unsure"],
  ] as const)("maps %s to %s and nothing else", (verdict, who) => {
    expect(lookResultForModel(verdict)).toEqual({ who });
  });
});

describe("toolResultsFor", () => {
  it("returns one entry per distinct id in first-seen order", () => {
    const results = new Map<string, object>([
      ["a", { ok: true }],
      ["b", { who: "family" }],
    ]);
    expect(toolResultsFor(["b", "a", "b", "a"], results)).toEqual([
      { toolUseId: "b", result: { who: "family" } },
      { toolUseId: "a", result: { ok: true } },
    ]);
  });

  it("fills a missing result with the fallback error", () => {
    expect(toolResultsFor(["x"], new Map())).toEqual([
      { toolUseId: "x", result: { ok: false, error: "not_available" } },
    ]);
    expect(toolResultsFor(["x"], new Map(), "session_ending")).toEqual([
      { toolUseId: "x", result: { ok: false, error: "session_ending" } },
    ]);
  });

  it("returns an empty list for no ids", () => {
    expect(toolResultsFor([], new Map([["a", {}]]))).toEqual([]);
  });
});
