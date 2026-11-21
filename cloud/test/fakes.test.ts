import { describe, expect, it } from "vitest";
import type { EncounterMeta } from "../lambda/_shared/ports.js";
import { FakeRepository, FakeStateStore } from "./fakes.js";

/** Unit tests for the in-memory state fakes (cloud-judgement Requirements 4.1, 9.1, 9.7, 15.10). */

const WINDOW = 600_000;

function makeClock(start = 1_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function meta(encounterId: string, deviceId = "warashi-01"): EncounterMeta {
  return {
    encounterId,
    deviceId,
    startedAt: "2026-11-20T12:00:00.000Z",
    endedAt: null,
    state: null,
    verdict: null,
    confidence: null,
    reaction: null,
    notified: false,
    snapshotKey: null,
    errorCount: 0,
  };
}

describe("FakeStateStore.claim", () => {
  it("succeeds once per key and fails for a second claim", async () => {
    const store = new FakeStateStore();
    expect(await store.claim("a", 60)).toBe(true);
    expect(await store.claim("a", 60)).toBe(false);
    expect(await store.claim("b", 60)).toBe(true);
  });

  it("succeeds again after the claim TTL has passed", async () => {
    const clock = makeClock();
    const store = new FakeStateStore({ now: clock.now });
    expect(await store.claim("a", 10)).toBe(true);
    clock.advance(9_999);
    expect(await store.claim("a", 10)).toBe(false);
    clock.advance(1);
    expect(await store.claim("a", 10)).toBe(true);
  });
});

describe("FakeStateStore.claimNotifySlot", () => {
  it("grants the slot, then refuses the same encounter", async () => {
    const clock = makeClock();
    const store = new FakeStateStore({ now: clock.now });
    expect(await store.claimNotifySlot("d1", "e1", clock.now(), WINDOW)).toBe(true);
    expect(await store.lastNotifiedAtMs("d1")).toBe(clock.now());
    clock.advance(WINDOW * 2);
    expect(await store.claimNotifySlot("d1", "e1", clock.now(), WINDOW)).toBe(false);
  });

  it("refuses another encounter of the same device inside the window", async () => {
    const clock = makeClock();
    const store = new FakeStateStore({ now: clock.now });
    expect(await store.claimNotifySlot("d1", "e1", clock.now(), WINDOW)).toBe(true);
    clock.advance(WINDOW - 1);
    expect(await store.claimNotifySlot("d1", "e2", clock.now(), WINDOW)).toBe(false);
  });

  it("grants another encounter once the window has elapsed", async () => {
    const clock = makeClock();
    const store = new FakeStateStore({ now: clock.now });
    await store.claimNotifySlot("d1", "e1", clock.now(), WINDOW);
    clock.advance(WINDOW);
    expect(await store.claimNotifySlot("d1", "e2", clock.now(), WINDOW)).toBe(true);
    expect(await store.lastNotifiedAtMs("d1")).toBe(clock.now());
  });

  it("keeps windows of different devices independent", async () => {
    const clock = makeClock();
    const store = new FakeStateStore({ now: clock.now });
    expect(await store.claimNotifySlot("d1", "e1", clock.now(), WINDOW)).toBe(true);
    expect(await store.claimNotifySlot("d2", "e2", clock.now(), WINDOW)).toBe(true);
  });

  it("refuses an encounter whose repository meta is already notified, and leaves the slot alone", async () => {
    const clock = makeClock();
    const repository = new FakeRepository(clock.now);
    await repository.createEncounterIfAbsent({ ...meta("e1"), notified: true }, 3600);
    const store = new FakeStateStore({ now: clock.now, repository });
    expect(await store.claimNotifySlot("d1", "e1", clock.now(), WINDOW)).toBe(false);
    expect(await store.lastNotifiedAtMs("d1")).toBeNull();
  });

  it("sets notified on the repository meta when it grants the slot", async () => {
    const clock = makeClock();
    const repository = new FakeRepository(clock.now);
    await repository.createEncounterIfAbsent(meta("e1"), 3600);
    const store = new FakeStateStore({ now: clock.now, repository });
    expect(await store.claimNotifySlot("warashi-01", "e1", clock.now(), WINDOW)).toBe(true);
    expect(repository.isNotified("e1")).toBe(true);
  });
});

describe("FakeStateStore.releaseNotifySlot", () => {
  it("clears a fresh slot and lets the same encounter claim again", async () => {
    const clock = makeClock();
    const repository = new FakeRepository(clock.now);
    await repository.createEncounterIfAbsent(meta("e1"), 3600);
    const store = new FakeStateStore({ now: clock.now, repository });
    await store.claimNotifySlot("d1", "e1", clock.now(), WINDOW);
    await store.releaseNotifySlot("d1", "e1");
    expect(await store.lastNotifiedAtMs("d1")).toBeNull();
    expect(repository.isNotified("e1")).toBe(false);
    expect(await store.claimNotifySlot("d1", "e1", clock.now(), WINDOW)).toBe(true);
  });

  it("restores the previous slot value after an older window had elapsed", async () => {
    const clock = makeClock();
    const store = new FakeStateStore({ now: clock.now });
    const first = clock.now();
    await store.claimNotifySlot("d1", "e1", first, WINDOW);
    clock.advance(WINDOW);
    await store.claimNotifySlot("d1", "e2", clock.now(), WINDOW);
    await store.releaseNotifySlot("d1", "e2");
    expect(await store.lastNotifiedAtMs("d1")).toBe(first);
  });

  it("does nothing when another encounter owns the slot", async () => {
    const clock = makeClock();
    const store = new FakeStateStore({ now: clock.now });
    await store.claimNotifySlot("d1", "e1", clock.now(), WINDOW);
    await store.releaseNotifySlot("d1", "e2");
    expect(await store.lastNotifiedAtMs("d1")).toBe(clock.now());
    expect(await store.claimNotifySlot("d1", "e1", clock.now(), WINDOW)).toBe(false);
  });
});

describe("FakeStateStore.incrementCounter", () => {
  it("allows increments up to the limit and then refuses without counting", async () => {
    const store = new FakeStateStore();
    expect(await store.incrementCounter("k", 2, 60)).toEqual({ allowed: true, count: 1 });
    expect(await store.incrementCounter("k", 2, 60)).toEqual({ allowed: true, count: 2 });
    expect(await store.incrementCounter("k", 2, 60)).toEqual({ allowed: false, count: 2 });
    expect(store.counterValue("k")).toBe(2);
  });

  it("starts again after the counter TTL, which later increments do not extend", async () => {
    const clock = makeClock();
    const store = new FakeStateStore({ now: clock.now });
    await store.incrementCounter("k", 2, 10);
    clock.advance(5_000);
    await store.incrementCounter("k", 2, 10);
    clock.advance(5_000);
    expect(store.counterValue("k")).toBe(0);
    expect(await store.incrementCounter("k", 2, 10)).toEqual({ allowed: true, count: 1 });
  });

  it("frees capacity on release and never goes below zero", async () => {
    const store = new FakeStateStore();
    await store.incrementCounter("k", 1, 60);
    expect((await store.incrementCounter("k", 1, 60)).allowed).toBe(false);
    await store.releaseCounter("k");
    expect(await store.incrementCounter("k", 1, 60)).toEqual({ allowed: true, count: 1 });
    await store.releaseCounter("k");
    await store.releaseCounter("k");
    expect(store.counterValue("k")).toBe(0);
  });
});
