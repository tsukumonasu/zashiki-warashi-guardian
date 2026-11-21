// Feature: voice-conversation, Property 5: Daily caps
// Validates: Requirements 3.2, 3.3, 3.4, 3.5

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applicableScopes,
  counterKey,
  dayBucket,
  incrementCaps,
  retryAfterSeconds,
  type CapRequest,
} from "../../lambda/_shared/voice/caps.js";
import { DEFAULT_VOICE_CONFIG, type VoiceConfig } from "../../lambda/_shared/voice/config.js";
import { FakeVoiceStore } from "./voice-store-fake.js";

const NUM_RUNS = 200;
const DAY_MS = 86_400_000;

const caps = fc.record({
  family: fc.integer({ min: 0, max: 4 }),
  reviewer: fc.integer({ min: 0, max: 2 }),
  device: fc.integer({ min: 0, max: 4 }),
  global: fc.integer({ min: 0, max: 8 }),
});

const requestArb: fc.Arbitrary<{ req: CapRequest; nowMs: number }> = fc
  .record({
    sub: fc.constantFrom("u1", "u2", "u3"),
    kind: fc.constantFrom("family", "reviewer", "device"),
    real: fc.boolean(),
    day: fc.integer({ min: 20_000, max: 20_002 }),
    // Include the exact boundaries of a day.
    offset: fc.oneof(fc.constantFrom(0, 1, DAY_MS - 1), fc.integer({ min: 0, max: DAY_MS - 1 })),
  })
  .map(({ sub, kind, real, day, offset }) => ({
    req: {
      ownerSub: kind === "device" ? null : sub,
      role: kind,
      usesRealDoll: kind === "device" ? true : real,
    } as CapRequest,
    nowMs: day * DAY_MS + offset,
  }));

function configFrom(c: { family: number; reviewer: number; device: number; global: number }): VoiceConfig {
  return {
    ...DEFAULT_VOICE_CONFIG,
    perUserPerDay: { family: c.family, reviewer: c.reviewer },
    deviceStartsPerDay: c.device,
    globalPerDay: c.global,
  };
}

describe("Property 5: daily caps", () => {
  it("accepted starts per scope per day never exceed the cap; rejections change nothing; Retry-After is valid", async () => {
    await fc.assert(
      fc.asyncProperty(caps, fc.array(requestArb, { minLength: 1, maxLength: 60 }), async (c, steps) => {
        const config = configFrom(c);
        const store = new FakeVoiceStore(0);
        const model = new Map<string, number>(); // key -> accepted count
        const seenKeys = new Set<string>();

        for (const { req, nowMs } of steps) {
          const day = dayBucket(nowMs);
          const scopes = applicableScopes(req, config).map((s) => ({
            ...s,
            key: counterKey(s.scope, day),
          }));
          scopes.forEach((s) => seenKeys.add(s.key));
          const before = new Map([...seenKeys].map((k) => [k, store.counterValue(k)]));

          const refusing = scopes.find((s) => (model.get(s.key) ?? 0) >= s.cap);
          const result = await incrementCaps(store, req, config, nowMs);

          if (refusing === undefined) {
            expect(result).toEqual({ ok: true });
            for (const s of scopes) model.set(s.key, (model.get(s.key) ?? 0) + 1);
          } else {
            expect(result.ok).toBe(false);
            if (!result.ok) {
              expect(result.scope).toBe(refusing.kind);
              expect(Number.isInteger(result.retryAfterS)).toBe(true);
              expect(result.retryAfterS).toBeGreaterThanOrEqual(1);
              expect(result.retryAfterS).toBeLessThanOrEqual(86_400);
              expect(result.retryAfterS).toBe(retryAfterSeconds(nowMs));
            }
            // A rejection leaves every counter unchanged.
            for (const k of seenKeys) expect(store.counterValue(k)).toBe(before.get(k));
          }

          // Counters equal the accepted starts and never exceed the cap; days are independent.
          for (const s of scopes) {
            expect(store.counterValue(s.key)).toBe(model.get(s.key) ?? 0);
            // A user key is shared by roles with different caps, so the bound is checked
            // against the cap of the request that was accepted.
            if (refusing === undefined) expect(store.counterValue(s.key)).toBeLessThanOrEqual(s.cap);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("retryAfterSeconds is an integer from 1 to 86,400 for any time", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_000_000_000_000 }), (nowMs) => {
        const r = retryAfterSeconds(nowMs);
        expect(Number.isInteger(r)).toBe(true);
        expect(r).toBeGreaterThanOrEqual(1);
        expect(r).toBeLessThanOrEqual(86_400);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
