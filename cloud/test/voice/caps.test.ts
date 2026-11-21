// Unit tests for the daily caps and lock keys of voice sessions.
// Validates: Requirements 3.1, 3.2, 3.6, 3.9, 15.2

import { describe, expect, it } from "vitest";
import {
  COUNTER_TTL_S,
  DEVICE_SCOPE,
  GLOBAL_SCOPE,
  counterKey,
  dayBucket,
  incrementCaps,
  lockKey,
  retryAfterSeconds,
  userScope,
  type CapRequest,
} from "../../lambda/_shared/voice/caps.js";
import { DEFAULT_VOICE_CONFIG, type VoiceConfig } from "../../lambda/_shared/voice/config.js";
import { FakeVoiceStore } from "./voice-store-fake.js";

const DAY_MS = 86_400_000;
const DAY = 20_000;
const NOON = DAY * DAY_MS + 12 * 3_600_000;

function config(over: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    ...DEFAULT_VOICE_CONFIG,
    perUserPerDay: { family: 3, reviewer: 2 },
    deviceStartsPerDay: 3,
    globalPerDay: 5,
    ...over,
  };
}

const family = (sub = "u1", usesRealDoll = true): CapRequest => ({ ownerSub: sub, role: "family", usesRealDoll });
const reviewer = (sub = "r1"): CapRequest => ({ ownerSub: sub, role: "reviewer", usesRealDoll: false });
const doll: CapRequest = { ownerSub: null, role: "device", usesRealDoll: true };

const keys = (sub: string) => ({
  user: counterKey(userScope(sub), DAY),
  device: counterKey(DEVICE_SCOPE, DAY),
  global: counterKey(GLOBAL_SCOPE, DAY),
});

describe("incrementCaps counter order", () => {
  it("increments user, device, global in that order, with the two-day TTL", async () => {
    const store = new FakeVoiceStore(NOON);
    const calls: Array<[string, number, number]> = [];
    const orig = store.incrementCounter.bind(store);
    store.incrementCounter = async (key, cap, ttl) => {
      calls.push([key, cap, ttl]);
      return orig(key, cap, ttl);
    };
    const k = keys("u1");
    expect(await incrementCaps(store, family("u1"), config(), NOON)).toEqual({ ok: true });
    expect(calls).toEqual([
      [k.user, 3, COUNTER_TTL_S],
      [k.device, 3, COUNTER_TTL_S],
      [k.global, 5, COUNTER_TTL_S],
    ]);
  });

  it("a doll-started session has no user scope; a virtual doll has no device scope", async () => {
    const store = new FakeVoiceStore(NOON);
    const k = keys("u1");
    await incrementCaps(store, doll, config(), NOON);
    expect(store.counterValue(k.device)).toBe(1);
    expect(store.counterValue(k.global)).toBe(1);
    expect(store.counterValue(k.user)).toBe(0);

    await incrementCaps(store, family("u1", false), config(), NOON);
    expect(store.counterValue(k.user)).toBe(1);
    expect(store.counterValue(k.device)).toBe(1);
    expect(store.counterValue(k.global)).toBe(2);
  });
});

describe("release on rejection", () => {
  it("a global refusal releases the user and device counters", async () => {
    const store = new FakeVoiceStore(NOON);
    const cfg = config({ globalPerDay: 1 });
    const k = keys("u1");
    expect(await incrementCaps(store, family("u1"), cfg, NOON)).toEqual({ ok: true });
    const result = await incrementCaps(store, family("u1"), cfg, NOON);
    expect(result).toEqual({ ok: false, scope: "global", retryAfterS: retryAfterSeconds(NOON) });
    expect(store.counterValue(k.user)).toBe(1);
    expect(store.counterValue(k.device)).toBe(1);
    expect(store.counterValue(k.global)).toBe(1);
  });

  it("a user refusal increments nothing else", async () => {
    const store = new FakeVoiceStore(NOON);
    const cfg = config({ perUserPerDay: { family: 1, reviewer: 2 } });
    await incrementCaps(store, family("u1"), cfg, NOON);
    const result = await incrementCaps(store, family("u1"), cfg, NOON);
    expect(result).toMatchObject({ ok: false, scope: "user" });
    expect(store.counterValue(keys("u1").device)).toBe(1);
    expect(store.counterValue(keys("u1").global)).toBe(1);
  });

  it("a device refusal releases the user counter", async () => {
    const store = new FakeVoiceStore(NOON);
    const cfg = config({ deviceStartsPerDay: 1 });
    await incrementCaps(store, family("u1"), cfg, NOON);
    const result = await incrementCaps(store, family("u2"), cfg, NOON);
    expect(result).toMatchObject({ ok: false, scope: "device" });
    expect(store.counterValue(keys("u2").user)).toBe(0);
    expect(store.counterValue(keys("u2").global)).toBe(1);
  });

  it("releases earlier counters when the store throws, then rethrows", async () => {
    const store = new FakeVoiceStore(NOON);
    const orig = store.incrementCounter.bind(store);
    store.incrementCounter = async (key, cap, ttl) => {
      if (key === keys("u1").global) throw new Error("boom");
      return orig(key, cap, ttl);
    };
    await expect(incrementCaps(store, family("u1"), config(), NOON)).rejects.toThrow("boom");
    expect(store.counterValue(keys("u1").user)).toBe(0);
    expect(store.counterValue(keys("u1").device)).toBe(0);
  });
});

describe("midnight rollover", () => {
  it("dayBucket changes exactly at UTC midnight", () => {
    expect(dayBucket(DAY * DAY_MS)).toBe(DAY);
    expect(dayBucket((DAY + 1) * DAY_MS - 1)).toBe(DAY);
    expect(dayBucket((DAY + 1) * DAY_MS)).toBe(DAY + 1);
  });

  it("retryAfterSeconds counts to the next midnight and stays within 1..86400", () => {
    expect(retryAfterSeconds(DAY * DAY_MS)).toBe(86_400);
    expect(retryAfterSeconds(NOON)).toBe(12 * 3600);
    expect(retryAfterSeconds((DAY + 1) * DAY_MS - 1)).toBe(1);
  });

  it("a full day restarts after midnight", async () => {
    const store = new FakeVoiceStore(NOON);
    const cfg = config({ perUserPerDay: { family: 1, reviewer: 2 } });
    const lastMs = (DAY + 1) * DAY_MS - 1000;
    store.setNow(lastMs);
    expect(await incrementCaps(store, family("u1"), cfg, lastMs)).toEqual({ ok: true });
    const refused = await incrementCaps(store, family("u1"), cfg, lastMs);
    expect(refused).toEqual({ ok: false, scope: "user", retryAfterS: 1 });

    const next = (DAY + 1) * DAY_MS;
    store.setNow(next);
    expect(await incrementCaps(store, family("u1"), cfg, next)).toEqual({ ok: true });
  });
});

describe("reviewer cap", () => {
  it("allows two starts and refuses the third with scope user", async () => {
    const store = new FakeVoiceStore(NOON);
    const cfg = config({ reviewerVoiceEnabled: true, perUserPerDay: { family: 10, reviewer: 2 } });
    expect(await incrementCaps(store, reviewer(), cfg, NOON)).toEqual({ ok: true });
    expect(await incrementCaps(store, reviewer(), cfg, NOON)).toEqual({ ok: true });
    expect(await incrementCaps(store, reviewer(), cfg, NOON)).toMatchObject({ ok: false, scope: "user" });
    expect(store.counterValue(keys("r1").user)).toBe(2);
    // A reviewer uses the virtual doll only: no device counter.
    expect(store.counterValue(keys("r1").device)).toBe(0);
  });
});

describe("independent keys", () => {
  it("different users have separate counters", async () => {
    const store = new FakeVoiceStore(NOON);
    const cfg = config({ perUserPerDay: { family: 1, reviewer: 2 }, deviceStartsPerDay: 10 });
    expect(await incrementCaps(store, family("u1"), cfg, NOON)).toEqual({ ok: true });
    expect(await incrementCaps(store, family("u2"), cfg, NOON)).toEqual({ ok: true });
    expect(await incrementCaps(store, family("u1"), cfg, NOON)).toMatchObject({ ok: false });
  });

  it("lock keys are device#<id> for the real doll and sim#<sub> for a virtual one", () => {
    expect(lockKey("real", "warashi-01", "u1")).toBe("device#warashi-01");
    expect(lockKey("virtual", "warashi-01", "u1")).toBe("sim#u1");
    expect(lockKey("virtual", "warashi-01", "u2")).not.toBe(lockKey("virtual", "warashi-01", "u1"));
  });

  it("locks on different keys do not block each other", async () => {
    const store = new FakeVoiceStore(NOON);
    expect(await store.acquireLock("device#a", "s1", NOON, NOON + 1000)).toBe(true);
    expect(await store.acquireLock("device#b", "s2", NOON, NOON + 1000)).toBe(true);
    expect(await store.acquireLock("sim#u1", "s3", NOON, NOON + 1000)).toBe(true);
  });
});

describe("lock semantics", () => {
  it("refuses a second session while the lock is live", async () => {
    const store = new FakeVoiceStore(NOON);
    expect(await store.acquireLock("device#a", "s1", NOON, NOON + 1000)).toBe(true);
    expect(await store.acquireLock("device#a", "s2", NOON + 999, NOON + 2000)).toBe(false);
    expect(store.lockOwner("device#a")).toBe("s1");
  });

  it("allows takeover once expiresAt has passed", async () => {
    const store = new FakeVoiceStore(NOON);
    await store.acquireLock("device#a", "s1", NOON, NOON + 1000);
    expect(await store.acquireLock("device#a", "s2", NOON + 1000, NOON + 2000)).toBe(true);
    expect(store.lockOwner("device#a", NOON + 1000)).toBe("s2");
  });

  it("only the owner can release; a release frees the key", async () => {
    const store = new FakeVoiceStore(NOON);
    await store.acquireLock("device#a", "s1", NOON, NOON + 1000);
    await store.releaseLock("device#a", "other");
    expect(store.lockOwner("device#a")).toBe("s1");
    await store.releaseLock("device#a", "s1");
    expect(await store.acquireLock("device#a", "s2", NOON, NOON + 1000)).toBe(true);
  });
});
