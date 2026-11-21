// Feature: cloud-judgement, Property 16: Rate limit
// Validates: Requirements 15.10, 15.13
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  HOUR_MS,
  bucketOf,
  guardSimulate,
  retryAfterSeconds,
  type CounterPort,
  type RateLimits,
} from "../lambda/_shared/ratelimit.js";

/** In-memory counter store: a conditional increment that only counts while below the limit. */
class MemoryCounters implements CounterPort {
  readonly counts = new Map<string, number>();

  async incrementCounter(key: string, limit: number): Promise<{ allowed: boolean; count: number }> {
    const current = this.counts.get(key) ?? 0;
    if (current >= limit) return { allowed: false, count: current };
    this.counts.set(key, current + 1);
    return { allowed: true, count: current + 1 };
  }

  async releaseCounter(key: string): Promise<void> {
    this.counts.set(key, (this.counts.get(key) ?? 0) - 1);
  }
}

/** A released counter stays at 0; a missing key means the same thing. */
function nonZero(counts: Map<string, number>): Map<string, number> {
  return new Map([...counts].filter(([, n]) => n !== 0));
}

interface Request {
  user: string;
  generate: boolean;
  advanceMs: number;
}

const limitsArb: fc.Arbitrary<RateLimits> = fc.record({
  simPerHour: fc.integer({ min: 1, max: 5 }),
  genPerHour: fc.integer({ min: 1, max: 5 }),
  simPerDay: fc.integer({ min: 1, max: 12 }),
});

/** Gaps are mostly short, sometimes jump over an hour or a day boundary. */
const advanceArb = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 0, max: 60_000 }) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 2 * HOUR_MS }) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 2 * DAY_MS }) },
);
const requestArb: fc.Arbitrary<Request> = fc.record({
  user: fc.constantFrom("u1", "u2", "u3"),
  generate: fc.boolean(),
  advanceMs: advanceArb,
});
// Starts close to an hour or day boundary half of the time.
const startArb = fc.oneof(
  fc.integer({ min: 0, max: 10 * DAY_MS }),
  fc
    .tuple(fc.integer({ min: 1, max: 100 }), fc.integer({ min: 0, max: 5000 }))
    .map(([n, back]) => n * DAY_MS - back),
);

describe("Property 16: rate limit", () => {
  it("Feature: cloud-judgement, Property 16: Rate limit - accepted requests never exceed the limits and a new bucket restarts the count", async () => {
    await fc.assert(
      fc.asyncProperty(
        limitsArb,
        startArb,
        fc.array(requestArb, { minLength: 1, maxLength: 60 }),
        async (limits, start, requests) => {
          const store = new MemoryCounters();
          // Oracle: accepted counts per (user, hour), per (user, hour) for generate, per day.
          const simHour = new Map<string, number>();
          const genHour = new Map<string, number>();
          const simDay = new Map<number, number>();
          let now = start;

          for (const req of requests) {
            now += req.advanceMs;
            const hour = bucketOf(now, HOUR_MS);
            const day = bucketOf(now, DAY_MS);
            const hKey = `${req.user}#${hour}`;
            const before = new Map(store.counts);

            const expectedAllowed =
              (simHour.get(hKey) ?? 0) < limits.simPerHour &&
              (simDay.get(day) ?? 0) < limits.simPerDay &&
              (!req.generate || (genHour.get(hKey) ?? 0) < limits.genPerHour);

            const result = await guardSimulate(
              req.user,
              req.generate,
              limits,
              now,
              store,
            );

            expect(result.allowed).toBe(expectedAllowed);
            if (result.allowed) {
              simHour.set(hKey, (simHour.get(hKey) ?? 0) + 1);
              simDay.set(day, (simDay.get(day) ?? 0) + 1);
              if (req.generate) genHour.set(hKey, (genHour.get(hKey) ?? 0) + 1);
            } else {
              // R15.13: a rejected request leaves every counter unchanged.
              expect(nonZero(store.counts)).toEqual(nonZero(before));
              expect(Number.isInteger(result.retryAfterS)).toBe(true);
              expect(result.retryAfterS).toBeGreaterThanOrEqual(1);
              expect(result.retryAfterS).toBeLessThanOrEqual(86_400);
            }

            for (const n of simHour.values()) expect(n).toBeLessThanOrEqual(limits.simPerHour);
            for (const n of genHour.values()) expect(n).toBeLessThanOrEqual(limits.genPerHour);
            for (const n of simDay.values()) expect(n).toBeLessThanOrEqual(limits.simPerDay);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Feature: cloud-judgement, Property 16: Rate limit - Retry-After points at the end of the rejecting bucket", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 * DAY_MS }), fc.constantFrom(HOUR_MS, DAY_MS), (now, windowMs) => {
        const s = retryAfterSeconds(now, windowMs);
        const endMs = (bucketOf(now, windowMs) + 1) * windowMs;
        expect(s).toBeGreaterThanOrEqual(1);
        expect(s).toBeLessThanOrEqual(86_400);
        // The bucket changes no later than s seconds from now.
        expect(bucketOf(now + s * 1000, windowMs)).toBeGreaterThan(bucketOf(now, windowMs));
        expect(now + s * 1000).toBeGreaterThanOrEqual(endMs);
      }),
      { numRuns: 100 },
    );
  });
});
