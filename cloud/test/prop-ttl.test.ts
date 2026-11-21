// Feature: cloud-judgement, Property 20: TTL filter
// Validates: Requirements 11.5
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { filterLive, isLive, ttlFor, type TtlItem } from "../lambda/_shared/ttl.js";

const secondsArb = fc.integer({ min: 0, max: 4_000_000_000 });

/** Items with a numeric ttl, a missing ttl, or a null ttl. */
const itemArb: fc.Arbitrary<TtlItem & { readonly n: number }> = fc.oneof(
  fc.record({ n: fc.integer(), ttl: secondsArb }),
  fc.record({ n: fc.integer() }),
  fc.record({ n: fc.integer(), ttl: fc.constant(null) }),
);

describe("Feature: cloud-judgement, Property 20: TTL filter", () => {
  it("filterLive never returns an item with ttl <= now, and keeps every other item in order", () => {
    fc.assert(
      fc.property(fc.array(itemArb, { maxLength: 50 }), secondsArb, (items, now) => {
        const result = filterLive(items, now);
        for (const item of result) {
          if (typeof item.ttl === "number") {
            expect(item.ttl).toBeGreaterThan(now);
          }
        }
        const expected = items.filter(
          (item) => typeof item.ttl !== "number" || item.ttl > now,
        );
        expect(result).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });

  it("isLive is false exactly when ttl <= now (boundary included)", () => {
    fc.assert(
      fc.property(secondsArb, secondsArb, (ttl, now) => {
        expect(isLive({ ttl }, now)).toBe(ttl > now);
      }),
      { numRuns: 200 },
    );
  });

  it("an item created at t with a positive retention expires after exactly that many days", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        fc.integer({ min: 1, max: 30 }),
        (createdAtMs, days) => {
          const ttl = ttlFor(createdAtMs, days);
          expect(isLive({ ttl }, Math.floor(createdAtMs / 1000))).toBe(true);
          expect(isLive({ ttl }, ttl)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
