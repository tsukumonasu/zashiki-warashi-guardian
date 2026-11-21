// Feature: dashboard-simulation, Property 16: Timeline order is total and stable
// **Validates: Requirements 10.2, 10.3**
import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { compareEncounters, sortEncounters } from "../../src/simulation/timeline";
import type { Encounter } from "../../src/simulation/types";

const RUNS = { numRuns: 200 };

/** Few distinct timestamps and ids, so ties on `startedAt` (and full duplicates) are common. */
const arbStartedAt = fc
  .integer({ min: 0, max: 5 })
  .map((i) => new Date(Date.UTC(2026, 10, 20, 12, 0, i)).toISOString());
const arbId = fc.integer({ min: 0, max: 7 }).map((i) => `enc-${i}`);

const arbEncounter: fc.Arbitrary<Encounter> = fc
  .record({ startedAt: arbStartedAt, encounterId: arbId, tag: fc.integer() })
  .map(({ startedAt, encounterId, tag }) => ({
    encounterId,
    deviceId: `warashi-${tag}`, // carries identity so the multiset can be compared
    startedAt,
    endedAt: null,
    state: null,
    verdict: null,
    confidence: null,
    reaction: null,
    notified: false,
    snapshot: null,
    illustration: null,
    events: [],
  }));

const arbList = fc.array(arbEncounter, { maxLength: 30 });

/** A list whose `encounterId` values are all distinct, plus a shuffled copy of it. */
const arbDistinctWithPermutation = fc
  .uniqueArray(arbEncounter, { selector: (e) => e.encounterId, maxLength: 8 })
  .chain((list) =>
    fc
      .shuffledSubarray(list, { minLength: list.length, maxLength: list.length })
      .map((permuted) => ({ list, permuted })),
  );

const key = (e: Encounter): string => `${e.startedAt}|${e.encounterId}|${e.deviceId}`;

describe("Property 16: Timeline order is total and stable", () => {
  it("orders by startedAt descending, then encounterId ascending, keeping the same multiset", () => {
    fc.assert(
      fc.property(arbList, (list) => {
        const before = structuredClone(list);
        const sorted = sortEncounters(list);
        expect(list).toEqual(before); // input untouched
        expect(sorted.map(key).sort()).toEqual(list.map(key).sort());
        for (let i = 1; i < sorted.length; i++) {
          const a = sorted[i - 1]!;
          const b = sorted[i]!;
          expect(compareEncounters(a, b)).toBeLessThanOrEqual(0);
          if (a.startedAt === b.startedAt) {
            expect(a.encounterId <= b.encounterId).toBe(true);
          } else {
            expect(a.startedAt > b.startedAt).toBe(true);
          }
        }
      }),
      RUNS,
    );
  });

  it("sorting the sorted result again returns it unchanged", () => {
    fc.assert(
      fc.property(arbList, (list) => {
        const once = sortEncounters(list);
        expect(sortEncounters(once)).toEqual(once);
      }),
      RUNS,
    );
  });

  it("sorting any permutation gives the same order when encounterIds are distinct", () => {
    fc.assert(
      fc.property(arbDistinctWithPermutation, ({ list, permuted }) => {
        expect(sortEncounters(permuted)).toEqual(sortEncounters(list));
      }),
      RUNS,
    );
  });
});
