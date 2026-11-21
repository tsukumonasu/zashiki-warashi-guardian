// Feature: dashboard-simulation, Property 17: Inserting keeps the existing order and the 50-entry cap
// **Validates: Requirements 10.4, 10.12**
import fc from "fast-check";
import { describe, it, expect } from "vitest";
import {
  compareEncounters,
  insertSimulated,
  MAX_SIMULATED_ENCOUNTERS,
  sortEncounters,
} from "../../src/simulation/timeline";
import type { SimEncounter } from "../../src/simulation/types";

const RUNS = { numRuns: 200 };

const BASE_MS = Date.UTC(2026, 10, 20, 12, 0, 0, 0);

/** Few distinct times (0..30 s) so that equal `startedAt` values, and tie-breaks by id, occur often. */
const arbOffsetMs = fc.integer({ min: 0, max: 30 }).map((n) => n * 1000);

function makeEncounter(offsetMs: number, n: number): SimEncounter {
  return {
    encounterId: `c1d2e3f4-0000-4000-8000-${String(n).padStart(12, "0")}`,
    deviceId: "warashi-sim",
    startedAt: new Date(BASE_MS + offsetMs).toISOString(),
    endedAt: null,
    state: null,
    verdict: null,
    confidence: null,
    reaction: null,
    notified: false,
    snapshot: null,
    illustration: null,
    events: [],
    mode: "simulation",
    line: null,
  };
}

/** A sorted list of 0..50 encounters (often exactly at the cap) and a new one with a distinct id. */
const arbScenario = fc
  .tuple(fc.array(arbOffsetMs, { maxLength: MAX_SIMULATED_ENCOUNTERS }), arbOffsetMs, fc.boolean())
  .map(([offsets, newOffset, full]) => {
    const offs = full && offsets.length < MAX_SIMULATED_ENCOUNTERS
      ? [...offsets, ...Array.from({ length: MAX_SIMULATED_ENCOUNTERS - offsets.length }, () => 0)]
      : offsets;
    const old = sortEncounters(offs.map((o, i) => makeEncounter(o, i)));
    const added = makeEncounter(newOffset, 1000);
    return { old, added };
  });

/** Returns `list[i]` or fails the test: satisfies `noUncheckedIndexedAccess` without hiding a missing entry. */
function at(list: readonly SimEncounter[], i: number): SimEncounter {
  const item = list[i];
  if (item === undefined) throw new Error(`no encounter at index ${i} (length ${list.length})`);
  return item;
}

const ids = (list: readonly SimEncounter[]): string[] => list.map((e) => e.encounterId);

describe("Property 17: Inserting keeps the existing order and the 50-entry cap", () => {
  it("returns a sorted list of at most 50 entries", () => {
    fc.assert(
      fc.property(arbScenario, ({ old, added }) => {
        const result = insertSimulated(old, added);
        expect(result.length).toBe(Math.min(MAX_SIMULATED_ENCOUNTERS, old.length + 1));
        for (let i = 1; i < result.length; i++) {
          expect(compareEncounters(at(result, i - 1), at(result, i))).toBeLessThanOrEqual(0);
        }
      }),
      RUNS,
    );
  });

  it("keeps the relative order of the old entries it retains", () => {
    fc.assert(
      fc.property(arbScenario, ({ old, added }) => {
        const result = insertSimulated(old, added);
        const oldIds = new Set(ids(old));
        const retained = ids(result).filter((id) => oldIds.has(id));
        // The retained old entries are a prefix of the old list: the cap only cuts from the end.
        expect(retained).toEqual(ids(old).slice(0, retained.length));
      }),
      RUNS,
    );
  });

  it("contains the new entry unless it is older than all kept entries; a dropped entry is the oldest", () => {
    fc.assert(
      fc.property(arbScenario, ({ old, added }) => {
        const result = insertSimulated(old, added);
        const all = sortEncounters([added, ...old]);
        const dropped = all.filter((e) => !ids(result).includes(e.encounterId));

        if (old.length < MAX_SIMULATED_ENCOUNTERS) {
          expect(dropped).toEqual([]);
          expect(ids(result)).toContain(added.encounterId);
          return;
        }
        // Full list: exactly one entry is dropped, and it is not newer than any kept entry.
        expect(dropped).toHaveLength(1);
        for (const kept of result) {
          expect(compareEncounters(kept, at(dropped, 0))).toBeLessThanOrEqual(0);
        }
        if (!ids(result).includes(added.encounterId)) {
          for (const kept of result) {
            expect(compareEncounters(kept, added)).toBeLessThan(0);
          }
        }
      }),
      RUNS,
    );
  });

  it("does not change the input list", () => {
    fc.assert(
      fc.property(arbScenario, ({ old, added }) => {
        const before = ids(old);
        insertSimulated(old, added);
        expect(ids(old)).toEqual(before);
      }),
      RUNS,
    );
  });
});
