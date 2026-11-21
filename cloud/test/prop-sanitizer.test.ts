// Feature: cloud-judgement, Property 18: Line sanitizer
// Validates: Requirements 7.6
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sanitizeLine } from "../lambda/_shared/sanitizer.js";

const normalize = (text: string): string =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");

/** Pieces that make accepted and rejected lines both likely. */
const piece = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(..."あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんアイウエオ山川花月") },
  { weight: 2, arbitrary: fc.constantFrom("。", "！", "？", "!", "?", ".", "、", "…", " ", "\n") },
  { weight: 1, arbitrary: fc.constantFrom("a", "Z", "ｑ", "é", "Ｂ") },
  { weight: 1, arbitrary: fc.constantFrom("😀", "👻", "🇯🇵", "❤️", "1️⃣", "\u200d") },
  { weight: 1, arbitrary: fc.string({ maxLength: 3, unit: "binary" }) },
);
const textArb = fc
  .array(piece, { maxLength: 60 })
  .map((parts) => parts.join(""));

const blockedArb = fc.array(
  fc.oneof(
    fc.constantFrom("おばけ", "ばか", "BadWord", "だめ", ""),
    fc.string({ minLength: 1, maxLength: 3 }),
  ),
  { maxLength: 4 },
);

/** Sentences as counted by the rule: non-blank segments between terminators. */
function sentenceCount(text: string): number {
  return text
    .split(/[。！？!?.]+/u)
    .filter((part) => part.replace(/[\s…・、，,「」『』（）()]+/gu, "").length > 0).length;
}

describe("Feature: cloud-judgement, Property 18: Line sanitizer", () => {
  it("Feature: cloud-judgement, Property 18: Line sanitizer - null or a line that obeys every rule", () => {
    fc.assert(
      fc.property(textArb, blockedArb, (text, blocked) => {
        const result = sanitizeLine(text, blocked);
        if (result === null) {
          return;
        }
        const length = Array.from(result).length;
        expect(length).toBeGreaterThanOrEqual(1);
        expect(length).toBeLessThanOrEqual(40);
        expect(result).toBe(text.trim());
        expect(/\p{Script=Latin}/u.test(result)).toBe(false);
        expect(/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u200d|\ufe0f|\u20e3/u.test(result)).toBe(false);
        expect(sentenceCount(result)).toBeLessThanOrEqual(2);
        const normalized = normalize(result);
        for (const word of blocked) {
          const needle = normalize(word);
          if (needle.length > 0) {
            expect(normalized.includes(needle)).toBe(false);
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  it("Feature: cloud-judgement, Property 18: Line sanitizer - arbitrary strings never throw", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 100 }), blockedArb, (text, blocked) => {
        const result = sanitizeLine(text, blocked);
        expect(result === null || typeof result === "string").toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("Feature: cloud-judgement, Property 18: Line sanitizer - a blocked word inside a clean line is rejected", () => {
    const clean = fc.array(fc.constantFrom(..."あいうえおかきくけこ"), { maxLength: 10 }).map((c) => c.join(""));
    fc.assert(
      fc.property(clean, clean, fc.constantFrom("おばけ", "ばか", "だめ"), (head, tail, word) => {
        expect(sanitizeLine(`${head}${word}${tail}`, [word])).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});
