// Feature: dashboard-simulation, Property 22: Registration is enabled only with consent and a valid name
// **Validates: Requirements 15.4**
import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { canRegister } from "../../src/simulation/faces";

const RUNS = { numRuns: 200 };

const codePoints = (s: string): number => Array.from(s).length;

/** Names mixing ASCII, kanji, astral emoji and combining marks. */
const arbName = fc.oneof(
  fc.string({ maxLength: 60 }),
  fc.string({ unit: "grapheme", maxLength: 60 }),
  fc.string({ unit: "binary", maxLength: 60 }),
  fc.array(
    fc.constantFrom("a", "あ", "座", "😀", "👨‍👩‍👧", "𠮷", "e\u0301", "\u0301", "\u200d"),
    { maxLength: 60 },
  ).map((a) => a.join("")),
);

describe("Property 22: Registration is enabled only with consent and a valid name", () => {
  it("is true exactly when consent is true and the name has 1..40 code points", () => {
    fc.assert(
      fc.property(fc.boolean(), arbName, (consent, name) => {
        const n = codePoints(name);
        expect(canRegister(consent, name)).toBe(consent && n >= 1 && n <= 40);
      }),
      RUNS,
    );
  });

  it("counts boundary lengths in code points for astral and combining names", () => {
    const unit = fc.constantFrom("😀", "𠮷", "e", "\u0301");
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 45 }), unit, (count, ch) => {
        const name = ch.repeat(count);
        expect(canRegister(true, name)).toBe(count >= 1 && count <= 40);
        expect(canRegister(false, name)).toBe(false);
      }),
      RUNS,
    );
  });

  it("accepts 40 emoji (80 UTF-16 units) and rejects 41", () => {
    expect(canRegister(true, "😀".repeat(40))).toBe(true);
    expect(canRegister(true, "😀".repeat(41))).toBe(false);
    expect(canRegister(true, "")).toBe(false);
  });
});
