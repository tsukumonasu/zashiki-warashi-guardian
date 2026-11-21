import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { DEFAULT_VOICE_CONFIG, type VoiceConfig } from "../../lambda/_shared/voice/config.js";
import {
  lookResultForModel,
  toolResultsFor,
  toolToCommand,
  type ToolContext,
} from "../../lambda/_shared/voice/tools.js";

// Feature: voice-conversation, Property 3: Tool commands stay within limits
// **Validates: Requirements 7.2, 7.5, 7.6, 7.7, 7.9, 7.10, 7.12, 7.14**

const NUM_RUNS = 200;
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

const toolName = fc.oneof(
  fc.constantFrom("turn_head", "set_lantern", "look"),
  fc.string({ maxLength: 12 }),
  fc.constantFrom("__proto__", "constructor", ""),
);

const weirdNumber = fc.oneof(
  fc.double({ noNaN: false }),
  fc.constantFrom(1e308, -1e308, 1e21, -1e21, 0, -0, 61, -61, 31, -31),
  fc.integer(),
);

const jsonValue: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small", maxDepth: 3 },
    fc.constant(null),
    fc.boolean(),
    weirdNumber.filter((n) => Number.isFinite(n)),
    fc.string({ maxLength: 8 }),
    fc.array(tie("value"), { maxLength: 3 }),
    fc.dictionary(fc.string({ maxLength: 6 }), tie("value"), { maxKeys: 3 }),
  ),
})).value;

const toolArgs = fc.oneof(
  fc.record(
    {
      direction: fc.oneof(fc.constantFrom("left", "right", "up", "down", "center", "x"), jsonValue),
      pan_deg: fc.oneof(weirdNumber.filter(Number.isFinite), jsonValue),
      tilt_deg: fc.oneof(weirdNumber.filter(Number.isFinite), jsonValue),
      level: fc.oneof(weirdNumber.filter(Number.isFinite), jsonValue),
      fade_ms: fc.oneof(weirdNumber.filter(Number.isFinite), jsonValue),
    },
    { requiredKeys: [] },
  ),
  jsonValue,
);

const inputString = fc.oneof(
  toolArgs.map((v) => JSON.stringify(v) ?? "null"),
  fc.string({ maxLength: 30 }),
  fc.constantFrom("", "   ", "{", "[1,", '{"level":1e999}', '{"pan_deg":1e999}'),
);

const configArb: fc.Arbitrary<VoiceConfig> = fc.record({
  pan: fc.oneof(fc.double({ min: 0, max: 60, noNaN: true }), fc.constantFrom(NaN, Infinity, -5, 1000)),
  tilt: fc.oneof(fc.double({ min: 0, max: 30, noNaN: true }), fc.constantFrom(NaN, Infinity, -5, 1000)),
  maxGaze: fc.integer({ min: 0, max: 8 }),
  interval: fc.integer({ min: 200, max: 3000 }),
  maxCalls: fc.integer({ min: 1, max: 12 }),
  maxLooks: fc.integer({ min: 0, max: 4 }),
}).map((c) => ({
  ...DEFAULT_VOICE_CONFIG,
  voiceGazeLimits: { panDeg: c.pan, tiltDeg: c.tilt },
  maxGazeCommands: c.maxGaze,
  gazeMinIntervalMs: c.interval,
  maxToolCalls: c.maxCalls,
  maxLooksPerSession: c.maxLooks,
}));

function ctxFor(over: Partial<ToolContext>): ToolContext {
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

const call = fc.record({
  name: toolName,
  input: inputString,
  dtMs: fc.integer({ min: 0, max: 2500 }),
  reachable: fc.boolean(),
  dropResult: fc.boolean(), // simulates a call whose result never got recorded
});

describe("Property 3: tool commands stay within limits", () => {
  it("never throws and keeps every command inside the limits over a whole session", () => {
    fc.assert(
      fc.property(configArb, fc.array(call, { maxLength: 40 }), (cfg, calls) => {
        let toolCalls = 0;
        let looks = 0;
        let gazeCommands = 0;
        let lastGazeAtMs: number | null = null;
        let now = NOW;
        const gazeTimes: number[] = [];
        const ids: string[] = [];
        const results = new Map<string, object>();

        calls.forEach((c, i) => {
          now += c.dtMs;
          const ctx = ctxFor({
            nowMs: now,
            toolCalls,
            looks,
            gazeCommands,
            lastGazeAtMs,
            dollReachable: c.reachable,
          });
          const out = toolToCommand(c.name, c.input, ctx, cfg); // must not throw
          const id = `tu-${i}`;
          ids.push(id);

          if (out.kind === "error") {
            expect(out.result.ok).toBe(false);
            if (!c.dropResult) results.set(id, out.result);
            return;
          }
          toolCalls += 1;
          if (out.kind === "look") {
            looks += 1;
            expect(out.envelope.type).toBe("snapshot.request");
            if (!c.dropResult) results.set(id, lookResultForModel("timeout"));
            return;
          }
          if (!c.dropResult) results.set(id, out.result);
          for (const env of out.envelopes) {
            const d = env.data as Record<string, number>;
            if (env.type === "gaze") {
              gazeCommands += 1;
              lastGazeAtMs = now;
              gazeTimes.push(now);
              const panMax = Math.min(60, Number.isFinite(cfg.voiceGazeLimits.panDeg) ? Math.max(0, cfg.voiceGazeLimits.panDeg) : 0);
              const tiltMax = Math.min(30, Number.isFinite(cfg.voiceGazeLimits.tiltDeg) ? Math.max(0, cfg.voiceGazeLimits.tiltDeg) : 0);
              expect(Number.isFinite(d.panDeg)).toBe(true);
              expect(Number.isFinite(d.tiltDeg)).toBe(true);
              expect(Math.abs(d.panDeg as number)).toBeLessThanOrEqual(panMax);
              expect(Math.abs(d.tiltDeg as number)).toBeLessThanOrEqual(tiltMax);
              expect(Math.abs(d.panDeg as number)).toBeLessThanOrEqual(60);
              expect(Math.abs(d.tiltDeg as number)).toBeLessThanOrEqual(30);
            } else if (env.type === "lantern") {
              expect(d.level).toBeGreaterThanOrEqual(0);
              expect(d.level).toBeLessThanOrEqual(1);
              expect(Number.isInteger(d.fadeMs)).toBe(true);
              expect(d.fadeMs).toBeGreaterThanOrEqual(0);
              expect(d.fadeMs).toBeLessThanOrEqual(10_000);
            } else {
              throw new Error(`unexpected envelope type ${env.type}`);
            }
          }
        });

        expect(gazeCommands).toBeLessThanOrEqual(cfg.maxGazeCommands);
        expect(toolCalls).toBeLessThanOrEqual(cfg.maxToolCalls);
        expect(looks).toBeLessThanOrEqual(cfg.maxLooksPerSession);
        for (let i = 1; i < gazeTimes.length; i++) {
          expect((gazeTimes[i] as number) - (gazeTimes[i - 1] as number)).toBeGreaterThanOrEqual(
            cfg.gazeMinIntervalMs,
          );
        }

        // Exactly one toolResult per toolUse id, including errors and dropped results.
        const entries = toolResultsFor(ids, results);
        expect(entries.map((e) => e.toolUseId)).toEqual(ids);
        for (const e of entries) expect(typeof e.result).toBe("object");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("is total for any single tool name and input string, including while the doll is unreachable", () => {
    fc.assert(
      fc.property(toolName, inputString, fc.boolean(), (name, input, reachable) => {
        const out = toolToCommand(name, input, ctxFor({ dollReachable: reachable }), DEFAULT_VOICE_CONFIG);
        expect(["command", "look", "error"]).toContain(out.kind);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("gives exactly one result per distinct toolUse id, even with repeated ids", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("a", "b", "c", "d", "e"), { maxLength: 15 }),
        fc.array(fc.constantFrom("a", "b", "c", "d", "e"), { maxLength: 5 }),
        (ids, recorded) => {
          const results = new Map<string, object>(recorded.map((r) => [r, { ok: true }]));
          const entries = toolResultsFor(ids, results);
          expect(entries.map((e) => e.toolUseId)).toEqual([...new Set(ids)]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
