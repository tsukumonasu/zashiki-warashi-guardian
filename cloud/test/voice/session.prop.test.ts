// Feature: voice-conversation, Property 1: Session always terminates
// Validates: Requirements 6.1, 6.2, 6.3, 6.7, 6.8

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE_CONFIG, type VoiceConfig } from "../../lambda/_shared/voice/config.js";
import type { EndReason } from "../../lambda/_shared/voice/frames.js";
import {
  CLEANUP_GRACE_MS,
  initialSession,
  stepSession,
  type Effect,
  type Phase,
  type SessionEvent,
} from "../../lambda/_shared/voice/session.js";

const NUM_RUNS = 200;
const TICK_MS = 1000;
const PHASE_ORDER: Record<Phase, number> = { starting: 0, live: 1, ending: 2, ended: 3 };
const FINISH_TYPES = ["publishEnd", "notifyDevice", "releaseLock", "recordSession"] as const;

const endReason = fc.constantFrom<EndReason>(
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

/** A configuration inside the allowed ranges (design table "Cloud settings"). */
const configArb: fc.Arbitrary<VoiceConfig> = fc
  .record({
    maxSeconds: fc.integer({ min: 30, max: 420 }),
    silenceSeconds: fc.integer({ min: 5, max: 60 }),
    noClientSeconds: fc.integer({ min: 5, max: 60 }),
    recheckSeconds: fc.oneof(fc.constant(0), fc.integer({ min: 10, max: 120 })),
  })
  .map((c) => ({ ...DEFAULT_VOICE_CONFIG, ...c, blockedWords: ["forbidden"] }));

const eventArb: fc.Arbitrary<SessionEvent> = fc.oneof(
  fc.constant<SessionEvent>({ t: "tick" }),
  fc.constant<SessionEvent>({ t: "hello" }),
  fc.constant<SessionEvent>({ t: "streamOpened" }),
  fc.constant<SessionEvent>({ t: "activity" }),
  fc
    .constantFrom("こんにちは、おかえりなさい", "hello there friend", "this is forbidden", "")
    .map((text): SessionEvent => ({ t: "assistantText", text })),
  fc
    .record({ id: fc.constantFrom("a", "b", "c"), name: fc.constantFrom("look", "turn_head", "other") })
    .map(({ id, name }): SessionEvent => ({ t: "toolUse", id, name })),
  fc.constantFrom("a", "b", "c").map((id): SessionEvent => ({ t: "toolDone", id })),
  fc
    .record({
      verdict: fc.constantFrom("family", "stranger", "no_face", "uncertain" as const),
      silent: fc.boolean(),
    })
    .map(({ verdict, silent }): SessionEvent => ({ t: "verdict", verdict, silent })),
  endReason.map((reason): SessionEvent => ({ t: "endRequest", reason })),
  fc.boolean().map((ok): SessionEvent => ({ t: "streamClosed", ok })),
);

/** One scripted step: time advance (0..1000 ms) and an event. A tick follows every event. */
const scriptArb = fc.array(fc.record({ dt: fc.integer({ min: 0, max: TICK_MS }), event: eventArb }), {
  maxLength: 60,
});

describe("Property 1: Session always terminates", () => {
  it("ends within the bound, absorbs events afterwards, finishes once and never goes backward", () => {
    fc.assert(
      fc.property(
        configArb,
        fc.integer({ min: 0, max: 1_000_000 }),
        scriptArb,
        fc.array(eventArb, { maxLength: 10 }),
        (cfg, start, script, afterEvents) => {
          const deadline = start + (cfg.maxSeconds + cfg.noClientSeconds) * 1000 + CLEANUP_GRACE_MS;
          let s = initialSession(start);
          let now = start;
          const log: Effect[] = [];
          let firstReason: EndReason | null = null;
          let endedAt: number | null = null;

          const apply = (e: SessionEvent, at: number) => {
            const before = s;
            const r = stepSession(s, e, at, cfg);
            // Phase never moves backward.
            expect(PHASE_ORDER[r.state.phase]).toBeGreaterThanOrEqual(PHASE_ORDER[before.phase]);
            if (before.phase === "ended") {
              // `ended` absorbs every event: same state, no effects.
              expect(r.state).toBe(before);
              expect(r.effects).toEqual([]);
            }
            // The first end reason wins and never changes.
            if (firstReason === null && r.state.endReason !== null) firstReason = r.state.endReason;
            if (firstReason !== null) expect(r.state.endReason).toBe(firstReason);
            if (before.phase !== "ended" && r.state.phase === "ended") endedAt = at;
            log.push(...r.effects);
            s = r.state;
          };

          // Random events; ticks are never more than 1 s apart because one follows each event.
          for (const { dt, event } of script) {
            now += dt;
            apply(event, now);
            apply({ t: "tick" }, now);
          }
          // Then only ticks until the session ends or the bound is passed.
          while (s.phase !== "ended" && now <= deadline) {
            now += TICK_MS;
            apply({ t: "tick" }, now);
          }

          expect(s.phase).toBe("ended");
          expect(endedAt).not.toBeNull();
          expect(endedAt!).toBeLessThanOrEqual(deadline);

          // The four finish effects appear exactly once, in order, after closeStream.
          const types = log.map((x) => x.type);
          for (const t of FINISH_TYPES) expect(types.filter((x) => x === t)).toHaveLength(1);
          const finishAt = types.indexOf("publishEnd");
          expect(types.slice(finishAt, finishAt + 4)).toEqual([...FINISH_TYPES]);
          expect(types.filter((x) => x === "closeStream").length).toBeGreaterThanOrEqual(1);
          expect(types.indexOf("closeStream")).toBeLessThan(finishAt);
          for (const effect of log) {
            if ("reason" in effect) expect(effect.reason).toBe(firstReason);
          }

          // Absorbing: any further event changes nothing.
          for (const e of afterEvents) {
            const r = stepSession(s, e, now + 1, cfg);
            expect(r.state).toBe(s);
            expect(r.effects).toEqual([]);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("ends a session that only receives ticks no later than noClientSeconds plus the grace", () => {
    fc.assert(
      fc.property(configArb, fc.integer({ min: 0, max: 1_000_000 }), (cfg, start) => {
        let s = initialSession(start);
        let now = start;
        while (s.phase !== "ended") {
          now += TICK_MS;
          s = stepSession(s, { t: "tick" }, now, cfg).state;
          expect(now - start).toBeLessThanOrEqual((cfg.noClientSeconds + 1) * 1000 + CLEANUP_GRACE_MS + TICK_MS);
        }
        expect(s.endReason).toBe("no_client");
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
