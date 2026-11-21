// Feature: voice-conversation, Property 9: Language check
// Validates: Requirements 9.4, 9.5, 9.6, 9.7, 9.8

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  isUnsafeAssistantText,
  japaneseRatio,
  languageVerdict,
} from "../../lambda/_shared/voice/language.js";

const NUM_RUNS = 200;

const hiragana = fc.integer({ min: 0x3041, max: 0x3096 }).map((c) => String.fromCodePoint(c));
const katakana = fc.integer({ min: 0x30a1, max: 0x30fa }).map((c) => String.fromCodePoint(c));
const kanji = fc.integer({ min: 0x4e00, max: 0x9fa0 }).map((c) => String.fromCodePoint(c));
const jaLetter = fc.oneof(hiragana, katakana, kanji);
const asciiLetter = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ");
/** Characters that are not letters: digits, spaces and punctuation. */
const nonLetter = fc.constantFrom(..."0123456789 ,.!?-:;'\"()");

const join = (a: string[]) => a.join("");

/** At least four Japanese letters, optionally mixed with non-letters. */
const japaneseTurn = fc
  .tuple(
    fc.array(jaLetter, { minLength: 4, maxLength: 30 }),
    fc.array(nonLetter, { maxLength: 5 }),
  )
  .map(([ja, junk]) => join(ja) + join(junk));

/** A turn with no Japanese letter at all (ASCII letters and non-letters only). */
const noJapaneseTurn = fc
  .array(fc.oneof(asciiLetter, nonLetter), { maxLength: 40 })
  .map(join);

/** A turn with at least four ASCII letters and no Japanese letter. */
const longForeignTurn = fc
  .tuple(fc.array(asciiLetter, { minLength: 4, maxLength: 30 }), fc.array(nonLetter, { maxLength: 5 }))
  .map(([l, n]) => join(l) + join(n));

/** A turn with fewer than four letters of any script. */
const shortTurn = fc
  .tuple(
    fc.array(fc.oneof(asciiLetter, jaLetter), { maxLength: 3 }),
    fc.array(nonLetter, { maxLength: 10 }),
  )
  .map(([l, n]) => join(l) + join(n));

const anyText = fc.oneof(fc.string({ maxLength: 80 }), fc.string({ unit: "binary", maxLength: 80 }));

describe("Property 9: language check", () => {
  it("japaneseRatio is null or within 0..1 and never throws", () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const r = japaneseRatio(text);
        expect(r === null || (r >= 0 && r <= 1)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("appending a Japanese turn to an ok list keeps ok", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(anyText, noJapaneseTurn, japaneseTurn), { maxLength: 6 }),
        japaneseTurn,
        japaneseTurn,
        (rest, okTurn, appended) => {
          const okList = [okTurn, ...rest];
          expect(languageVerdict(okList)).toBe("ok");
          expect(languageVerdict([...okList, appended])).toBe("ok");
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("two or more long turns without Japanese are bad", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(noJapaneseTurn, longForeignTurn), { maxLength: 6 }),
        fc.array(longForeignTurn, { minLength: 2, maxLength: 4 }),
        (others, longs) => {
          expect(languageVerdict([...others, ...longs])).toBe("bad");
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("turns with fewer than four letters are undecided", () => {
    fc.assert(
      fc.property(fc.array(shortTurn, { maxLength: 8 }), (turns) => {
        expect(languageVerdict(turns)).toBe("undecided");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("isUnsafeAssistantText is true for a blocked word in any letter case", () => {
    const word = fc.array(asciiLetter, { minLength: 1, maxLength: 10 }).map(join);
    fc.assert(
      fc.property(
        word,
        fc.string({ maxLength: 20 }),
        fc.string({ maxLength: 20 }),
        fc.array(fc.boolean(), { minLength: 10, maxLength: 10 }),
        fc.array(fc.string({ maxLength: 8 }), { maxLength: 4 }),
        (w, prefix, suffix, flips, otherBlocked) => {
          const cased = [...w].map((c, i) => (flips[i % flips.length] ? c.toUpperCase() : c.toLowerCase())).join("");
          const text = prefix + cased + suffix;
          expect(isUnsafeAssistantText(text, [...otherBlocked, w])).toBe(true);
          expect(isUnsafeAssistantText(text, [w.toUpperCase()])).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
