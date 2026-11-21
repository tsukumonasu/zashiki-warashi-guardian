// Unit tests for the TTL helpers (R11.4).
import { describe, expect, it } from "vitest";
import { filterLive, isLive, ttlFor } from "../lambda/_shared/ttl.js";

describe("ttlFor", () => {
  it("equals creation plus 2,592,000 s for 30 days", () => {
    const createdAtMs = 1_800_000_000_000;
    expect(ttlFor(createdAtMs, 30)).toBe(1_800_000_000 + 2_592_000);
  });

  it("drops sub-second parts of the creation time", () => {
    expect(ttlFor(1_800_000_000_999, 30)).toBe(1_800_000_000 + 2_592_000);
  });

  it("handles other day counts", () => {
    expect(ttlFor(0, 1)).toBe(86_400);
    expect(ttlFor(0, 7)).toBe(604_800);
  });
});

describe("isLive and filterLive", () => {
  it("treats an item as expired at its ttl second", () => {
    expect(isLive({ ttl: 100 }, 99)).toBe(true);
    expect(isLive({ ttl: 100 }, 100)).toBe(false);
    expect(isLive({ ttl: 100 }, 101)).toBe(false);
  });

  it("never expires an item without a numeric ttl", () => {
    expect(isLive({}, 1e12)).toBe(true);
    expect(isLive({ ttl: null }, 1e12)).toBe(true);
    expect(isLive({ ttl: Number.NaN }, 1e12)).toBe(true);
  });

  it("keeps live items in order", () => {
    const items = [{ id: "a", ttl: 50 }, { id: "b", ttl: 200 }, { id: "c" }, { id: "d", ttl: 150 }];
    expect(filterLive(items, 100).map((i) => i.id)).toEqual(["b", "c", "d"]);
  });
});
