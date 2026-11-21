import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_VOICE_CONFIG } from "../../lambda/_shared/voice/config.js";
import { encodeOut, type EndReason, type TextFrame } from "../../lambda/_shared/voice/frames.js";
import { logVoice } from "../../lambda/_shared/voice/log.js";
import type { SessionRecord } from "../../lambda/_shared/voice/ports.js";
import { buildSystemPrompt } from "../../lambda/_shared/voice/prompt.js";
import { initialSession, stepSession, type SessionEvent } from "../../lambda/_shared/voice/session.js";
import {
  lookResultForModel,
  toolResultsFor,
  toolToCommand,
  type ToolContext,
} from "../../lambda/_shared/voice/tools.js";
import { setLogSink } from "../../lambda/_shared/safelog.js";
import { FakeVoiceStore } from "./voice-store-fake.js";

// Feature: voice-conversation, Property 8: No family data and no stored speech
// **Validates: Requirements 9.1, 14.1, 14.2, 14.4, 14.5**

const NUM_RUNS = 200;
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

/**
 * A family label with a sentinel character that no fixed text of the voice code contains, so a
 * short random label cannot match an ordinary word such as "family" by accident. The functions
 * under test take no registry at all; the example test below uses realistic names without it.
 */
const label = fc
  .string({ minLength: 0, maxLength: 10 })
  .map((core) => `${core.trim()}\u2605`);
const registry = fc.array(label, { minLength: 0, maxLength: 100 });

const hex = "0123456789abcdef".split("");
const hash64 = fc.array(fc.constantFrom(...hex), { minLength: 64, maxLength: 64 }).map((c) => c.join(""));
const tokenSecret = fc
  .array(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-".split("")), {
    minLength: 43,
    maxLength: 43,
  })
  .map((c) => c.join(""));

const endReasonArb = fc.constantFrom<EndReason>(
  "silence",
  "limit",
  "stranger",
  "user",
  "manual",
  "language",
  "unsafe_output",
  "error",
  "no_client",
  "offline",
);

function contains(haystack: string, labels: readonly string[]): string | undefined {
  const lower = haystack.toLowerCase();
  return labels.find((l) => lower.includes(l.toLowerCase()));
}

function toolCtx(over: Partial<ToolContext> = {}): ToolContext {
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

/** Every tool result the model can receive for the given labels placed inside the tool input. */
function allToolResults(labels: readonly string[]): string[] {
  const out: string[] = [];
  const inputs = [
    ...labels.map((l) => JSON.stringify({ direction: l })),
    ...labels.map((l) => JSON.stringify({ pan_deg: 5, note: l, name: l })),
    ...labels.map((l) => JSON.stringify({ level: 0.5, label: l })),
    "{}",
    "{",
  ];
  for (const name of ["turn_head", "set_lantern", "look", "unknown", ...labels]) {
    for (const input of inputs) {
      for (const reachable of [true, false]) {
        const o = toolToCommand(name, input, toolCtx({ dollReachable: reachable }), DEFAULT_VOICE_CONFIG);
        out.push(JSON.stringify(o.kind === "command" || o.kind === "error" ? o.result : o));
      }
    }
  }
  for (const v of ["family", "stranger", "no_face", "uncertain", "timeout"] as const) {
    out.push(JSON.stringify(lookResultForModel(v)));
  }
  out.push(JSON.stringify(toolResultsFor(["t1", "t2", "t1"], new Map([["t1", { ok: true }]]))));
  return out;
}

const sessionEvent: fc.Arbitrary<SessionEvent> = fc.oneof(
  fc.constant<SessionEvent>({ t: "tick" }),
  fc.constant<SessionEvent>({ t: "hello" }),
  fc.constant<SessionEvent>({ t: "streamOpened" }),
  fc.constant<SessionEvent>({ t: "activity" }),
  endReasonArb.map((reason): SessionEvent => ({ t: "endRequest", reason })),
  fc.boolean().map((ok): SessionEvent => ({ t: "streamClosed", ok })),
);

describe("Property 8: no family data and no stored speech", () => {
  it("the system prompt holds no family label and does not depend on the registry", () => {
    const baseline = buildSystemPrompt();
    fc.assert(
      fc.property(registry, (labels) => {
        const prompt = buildSystemPrompt();
        expect(prompt).toBe(baseline);
        expect(contains(prompt, labels)).toBeUndefined();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("realistic names do not appear in the prompt or in any tool result", () => {
    const names = ["Hana", "Taro", "Yuki", "さくら", "ハナ", "太郎", "Mama", "Papa", "Grandma"];
    expect(contains(buildSystemPrompt(), names)).toBeUndefined();
    for (const text of allToolResults(names)) expect(contains(text, names)).toBeUndefined();
  });

  it("no tool result holds a label, even when the model puts one in the tool input", () => {
    fc.assert(
      fc.property(registry, (labels) => {
        for (const text of allToolResults(labels.slice(0, 5))) {
          expect(contains(text, labels)).toBeUndefined();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("every text frame of a session holds no label", () => {
    fc.assert(
      fc.property(registry, fc.array(fc.tuple(sessionEvent, fc.integer({ min: 0, max: 20_000 })), { maxLength: 40 }), (labels, steps) => {
        let state = initialSession(NOW);
        let now = NOW;
        const frames: string[] = [];
        for (const [event, dt] of steps) {
          now += dt;
          const r = stepSession(state, event, now, DEFAULT_VOICE_CONFIG);
          state = r.state;
          for (const effect of r.effects) {
            let frame: TextFrame | undefined;
            if (effect.type === "publishState") frame = { t: "state", state: effect.state };
            if (effect.type === "publishEnd") frame = { t: "end", reason: effect.reason };
            if (frame !== undefined) frames.push(encodeOut(frame));
          }
        }
        for (const f of frames) expect(contains(f, labels)).toBeUndefined();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  const ALLOWED_KEYS = new Set([
    "sessionId", // the item's key, not a payload field
    "deviceId",
    "client",
    "target",
    "ownerSub",
    "role",
    "phase",
    "startedAt",
    "expiresAt",
    "clientTokenHash",
    "observerTokenHash",
    "endReason",
    "endedAt",
    "endRequested",
  ]);
  const FORBIDDEN_KEYS = /audio|transcript|text|pcm|token$/i;

  const sessionRecord: fc.Arbitrary<SessionRecord & { secret: string }> = fc
    .record({
      sessionId: fc.uuid(),
      deviceId: fc.constantFrom("warashi-01", "warashi-02"),
      client: fc.constantFrom<"device" | "browser">("device", "browser"),
      target: fc.constantFrom<"real" | "virtual">("real", "virtual"),
      ownerSub: fc.option(fc.uuid(), { nil: null }),
      role: fc.constantFrom<"family" | "reviewer" | "device">("family", "reviewer", "device"),
      phase: fc.constantFrom<SessionRecord["phase"]>("starting", "live", "ending", "ended"),
      startedAt: fc.integer({ min: 0, max: 4_000_000_000_000 }),
      expiresAt: fc.integer({ min: 0, max: 4_000_000_000_000 }),
      clientTokenHash: hash64,
      observerTokenHash: fc.option(hash64, { nil: null }),
      endReason: fc.option(endReasonArb, { nil: null }),
      endedAt: fc.option(fc.integer({ min: 0, max: 4_000_000_000_000 }), { nil: null }),
      endRequested: fc.boolean(),
      secret: tokenSecret,
    });

  it("every item given to putSession has only the allowed keys, no label and no raw token", async () => {
    await fc.assert(
      fc.asyncProperty(registry, fc.array(sessionRecord, { minLength: 1, maxLength: 6 }), async (labels, recs) => {
        const store = new FakeVoiceStore(NOW);
        for (const rec of recs) {
          const { secret, ...stored } = rec;
          void secret; // the raw secret must never reach the store
          await store.putSession(stored);
        }
        expect(store.putSessionCalls).toHaveLength(recs.length);
        store.putSessionCalls.forEach((call, i) => {
          for (const key of Object.keys(call)) {
            expect(ALLOWED_KEYS.has(key)).toBe(true);
            expect(FORBIDDEN_KEYS.test(key) && !/Hash$/.test(key)).toBe(false);
          }
          const json = JSON.stringify(call);
          const rec = recs[i];
          expect(contains(json, labels)).toBeUndefined();
          expect(json).not.toContain(rec.secret);
          expect(json).not.toContain(`${rec.sessionId}.${rec.secret}`);
          expect(call.clientTokenHash).toMatch(/^[0-9a-f]{64}$/);
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  describe("logging", () => {
    let restore: ((line: string) => void) | undefined;
    afterEach(() => {
      if (restore !== undefined) setLogSink(restore);
      restore = undefined;
    });

    it("a logged session id has at most 8 characters, and no token, audio or text is logged", () => {
      fc.assert(
        fc.property(
          fc.uuid(),
          tokenSecret,
          fc.string({ minLength: 1, maxLength: 20 }),
          registry,
          (sid, secret, speech, labels) => {
            const lines: string[] = [];
            restore = setLogSink((l) => lines.push(l));
            const token = `${sid}.${secret}`;
            logVoice("session.end", sid, {
              reason: "silence",
              sessionId: sid,
              token,
              clientToken: token,
              pcm: speech,
              text: speech,
              transcript: speech,
            });
            setLogSink(restore);
            restore = undefined;
            expect(lines).toHaveLength(1);
            const line = lines[0] as string;
            const parsed = JSON.parse(line) as Record<string, unknown>;
            expect(typeof parsed.session).toBe("string");
            expect((parsed.session as string).length).toBeLessThanOrEqual(8);
            expect(parsed.session).toBe(sid.slice(0, 8));
            expect(line).not.toContain(sid);
            expect(line).not.toContain(secret);
            expect(contains(line, labels)).toBeUndefined();
            for (const key of ["pcm", "text", "transcript", "token", "clientToken", "sessionId"]) {
              expect(key in parsed).toBe(false);
            }
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
