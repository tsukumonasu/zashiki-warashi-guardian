// Unit tests for the Rate_Limiter (R15.12, R15.13).
import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  HOUR_MS,
  bucketOf,
  guardSimulate,
  retryAfterSeconds,
  simDayKey,
  simHourKey,
  genHourKey,
  withinLimit,
  type CounterPort,
} from "../lambda/_shared/ratelimit.js";

/** In-memory counter store with the semantics of `incrementCounter`. */
function memoryStore() {
  const counts = new Map<string, number>();
  const port: CounterPort = {
    async incrementCounter(key, limit) {
      const count = (counts.get(key) ?? 0) + 1;
      if (count > limit) return { allowed: false, count };
      counts.set(key, count);
      return { allowed: true, count };
    },
    async releaseCounter(key) {
      counts.set(key, (counts.get(key) ?? 0) - 1);
    },
  };
  return { counts, port };
}

const LIMITS = { simPerHour: 2, genPerHour: 1, simPerDay: 100 };

describe("retryAfterSeconds", () => {
  it("is the whole seconds to the end of the bucket, rounded up", () => {
    expect(retryAfterSeconds(0, HOUR_MS)).toBe(3600);
    expect(retryAfterSeconds(HOUR_MS - 1500, HOUR_MS)).toBe(2);
    expect(retryAfterSeconds(HOUR_MS - 1, HOUR_MS)).toBe(1);
  });

  it("stays within 1..86400 for both windows", () => {
    for (const now of [0, 1, 999, HOUR_MS, DAY_MS - 1, DAY_MS, 1.7e12, 1.7e12 + 12345]) {
      for (const w of [HOUR_MS, DAY_MS]) {
        const s = retryAfterSeconds(now, w);
        expect(Number.isInteger(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(1);
        expect(s).toBeLessThanOrEqual(86_400);
      }
    }
    expect(retryAfterSeconds(0, DAY_MS)).toBe(86_400);
  });

  it("falls back to the maximum for a non-finite clock", () => {
    expect(retryAfterSeconds(Number.NaN, HOUR_MS)).toBe(86_400);
  });
});

describe("buckets and keys", () => {
  it("starts a new bucket at the window boundary", () => {
    expect(bucketOf(HOUR_MS - 1, HOUR_MS)).toBe(0);
    expect(bucketOf(HOUR_MS, HOUR_MS)).toBe(1);
    expect(simHourKey("u", 1)).not.toBe(simHourKey("u", 0));
    expect(simHourKey("u", 1)).not.toBe(genHourKey("u", 1));
    expect(simDayKey(3)).toBe("RATE#simday#3");
  });

  it("allows a count equal to the limit and rejects the next", () => {
    expect(withinLimit(2, 2)).toBe(true);
    expect(withinLimit(3, 2)).toBe(false);
  });
});

describe("guardSimulate", () => {
  it("allows up to the hourly limit, then rejects with Retry-After to the hour end", async () => {
    const { port } = memoryStore();
    const now = 10 * HOUR_MS + 5 * 60_000;
    for (let i = 0; i < LIMITS.simPerHour; i++) {
      expect(await guardSimulate("u", false, LIMITS, now, port)).toEqual({ allowed: true });
    }
    const res = await guardSimulate("u", false, LIMITS, now, port);
    expect(res).toEqual({ allowed: false, retryAfterS: 55 * 60 });
  });

  it("restarts counting in the next hour", async () => {
    const { port } = memoryStore();
    const now = 10 * HOUR_MS;
    for (let i = 0; i < LIMITS.simPerHour; i++) {
      await guardSimulate("u", false, LIMITS, now, port);
    }
    expect((await guardSimulate("u", false, LIMITS, now, port)).allowed).toBe(false);
    expect((await guardSimulate("u", false, LIMITS, now + HOUR_MS, port)).allowed).toBe(true);
  });

  it("leaves no counter changed when a later counter rejects", async () => {
    const { counts, port } = memoryStore();
    const now = 10 * HOUR_MS;
    expect((await guardSimulate("u", true, LIMITS, now, port)).allowed).toBe(true);
    const before = new Map(counts);
    const res = await guardSimulate("u", true, LIMITS, now, port);
    expect(res.allowed).toBe(false);
    expect(counts).toEqual(before);
  });

  it("uses the daily window for Retry-After when the global day limit rejects", async () => {
    const { port } = memoryStore();
    const now = 3 * DAY_MS + 3600_000;
    const limits = { ...LIMITS, simPerDay: 1 };
    await guardSimulate("a", false, limits, now, port);
    const res = await guardSimulate("b", false, limits, now, port);
    expect(res).toEqual({ allowed: false, retryAfterS: 23 * 3600 });
  });

  it("releases and rethrows when the store fails", async () => {
    const { counts, port } = memoryStore();
    let calls = 0;
    const failing: CounterPort = {
      async incrementCounter(key, limit, ttl) {
        if (++calls === 2) throw new Error("store down");
        return port.incrementCounter(key, limit, ttl);
      },
      releaseCounter: (key) => port.releaseCounter(key),
    };
    await expect(guardSimulate("u", false, LIMITS, 0, failing)).rejects.toThrow("store down");
    expect([...counts.values()].every((c) => c === 0)).toBe(true);
  });
});
