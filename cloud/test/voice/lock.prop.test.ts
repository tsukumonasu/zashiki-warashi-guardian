// Feature: voice-conversation, Property 2: Never two sessions at once
// Validates: Requirements 3.6, 3.7, 3.8, 3.9

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { lockKey } from "../../lambda/_shared/voice/caps.js";
import { FakeVoiceStore } from "./voice-store-fake.js";

const NUM_RUNS = 200;

const keys = [
  lockKey("real", "warashi-01", "u1"),
  lockKey("real", "warashi-02", "u1"),
  lockKey("virtual", "warashi-01", "u1"),
  lockKey("virtual", "warashi-01", "u2"),
];

type Op =
  | { op: "start"; key: number; ttlMs: number }
  | { op: "end"; pick: number }
  | { op: "crash"; pick: number }
  | { op: "advance"; ms: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    op: fc.constant("start" as const),
    key: fc.integer({ min: 0, max: keys.length - 1 }),
    ttlMs: fc.integer({ min: 1, max: 5_000 }),
  }),
  fc.record({ op: fc.constant("end" as const), pick: fc.nat(50) }),
  fc.record({ op: fc.constant("crash" as const), pick: fc.nat(50) }),
  fc.record({ op: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 3_000 }) }),
);

describe("Property 2: never two sessions at once", () => {
  it("matches a reference model: one unexpired holder per key, keys independent", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 60 }), async (ops) => {
        const store = new FakeVoiceStore(1_000);
        // Reference model: key -> holder with expiry.
        const model = new Map<string, { sessionId: string; expiresAtMs: number }>();
        // Sessions that started and have not ended or crashed.
        const live: { sessionId: string; key: string }[] = [];
        let counter = 0;

        const modelOwner = (key: string): string | null => {
          const m = model.get(key);
          return m !== undefined && m.expiresAtMs > store.now() ? m.sessionId : null;
        };

        for (const o of ops) {
          if (o.op === "start") {
            const key = keys[o.key]!;
            const sessionId = `s${counter++}`;
            const expected = modelOwner(key) === null;
            const nowMs = store.now();
            const ok = await store.acquireLock(key, sessionId, nowMs, nowMs + o.ttlMs);
            expect(ok).toBe(expected);
            if (ok) {
              model.set(key, { sessionId, expiresAtMs: nowMs + o.ttlMs });
              live.push({ sessionId, key });
              // A successful start owns the lock.
              expect(store.lockOwner(key)).toBe(sessionId);
            }
          } else if (o.op === "end" && live.length > 0) {
            const [s] = live.splice(o.pick % live.length, 1);
            await store.releaseLock(s!.key, s!.sessionId);
            // Only the owner frees it; a stale session leaves a newer holder alone.
            if (model.get(s!.key)?.sessionId === s!.sessionId) model.delete(s!.key);
            if (model.get(s!.key) === undefined) {
              expect(store.lockOwner(s!.key)).toBeNull();
            }
          } else if (o.op === "crash" && live.length > 0) {
            // No cleanup: the lock stays until its expiresAt passes.
            live.splice(o.pick % live.length, 1);
          } else if (o.op === "advance") {
            store.advance(o.ms);
          }

          // Invariant: the store and the model agree on every key's unexpired holder.
          for (const key of keys) {
            expect(store.lockOwner(key)).toBe(modelOwner(key));
          }
        }

        // Every lock is free once all expiry times have passed.
        store.advance(10_000);
        for (const key of keys) expect(store.lockOwner(key)).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("different keys never block each other", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(keys, { minLength: 1 }),
        fc.integer({ min: 1, max: 10_000 }),
        async (subset, ttlMs) => {
          const store = new FakeVoiceStore(0);
          for (const [i, key] of subset.entries()) {
            expect(await store.acquireLock(key, `s${i}`, 0, ttlMs)).toBe(true);
          }
          for (const [i, key] of subset.entries()) {
            expect(store.lockOwner(key)).toBe(`s${i}`);
            expect(await store.acquireLock(key, "other", 0, ttlMs)).toBe(false);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
