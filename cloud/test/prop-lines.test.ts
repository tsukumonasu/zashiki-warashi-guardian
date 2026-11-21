// Feature: cloud-judgement, Property 19: Line choice
// Validates: Requirements 7.2, 7.3
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chooseLine, type Category, type VoiceLine } from "../lambda/_shared/lines.js";

const CATEGORIES: readonly Category[] = ["family", "stranger", "uncertain"];
const LARGEST_BELOW_ONE = 1 - Number.EPSILON / 2;

const categoryArb = fc.constantFrom(...CATEGORIES);
const lineArb: fc.Arbitrary<VoiceLine> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  category: categoryArb,
  ja: fc.string({ maxLength: 20 }),
  en: fc.string({ maxLength: 20 }),
});
const linesArb = fc.array(lineArb, { maxLength: 30 });

/** `rand` in [0, 1), always including 0 and the largest double below 1. */
const randArb = fc.oneof(
  fc.constantFrom(0, LARGEST_BELOW_ONE),
  fc.double({ min: 0, max: LARGEST_BELOW_ONE, noNaN: true }),
);

describe("Feature: cloud-judgement, Property 19: Line choice", () => {
  it("Feature: cloud-judgement, Property 19: Line choice - category, determinism and range", () => {
    fc.assert(
      fc.property(linesArb, categoryArb, randArb, (lines, category, rand) => {
        const candidates = lines.filter((line) => line.category === category);
        const first = chooseLine(lines, category, rand);
        const second = chooseLine(lines, category, rand);

        expect(second).toBe(first);
        if (candidates.length === 0) {
          expect(first).toBeNull();
        } else {
          expect(first).not.toBeNull();
          expect(first?.category).toBe(category);
          expect(candidates).toContain(first);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("Feature: cloud-judgement, Property 19: Line choice - edge values of rand", () => {
    const lines: VoiceLine[] = Array.from({ length: 3 }, (_, i) => ({
      id: `u${i}`,
      category: "uncertain",
      ja: "j",
      en: "e",
    }));
    expect(chooseLine(lines, "uncertain", 0)?.id).toBe("u0");
    expect(chooseLine(lines, "uncertain", LARGEST_BELOW_ONE)?.id).toBe("u2");
    expect(chooseLine(lines, "family", 0.5)).toBeNull();
    expect(chooseLine([], "stranger", 0.5)).toBeNull();
  });
});
