/**
 * Language check and unsafe-text check for assistant text (R9.4 to R9.8).
 *
 * Pure module, no AWS imports. The doll must speak Japanese; the watchdog uses these functions to
 * end a session whose model drifts into another language or says a blocked word.
 *
 * A "letter" is any Unicode letter. A "Japanese letter" is hiragana, katakana (including the
 * prolonged sound mark) or a kanji (Han).
 */

/** Fewer letters than this give no verdict: too short to tell a language. */
const MIN_LETTERS = 4;

/** Share of Japanese letters at which one turn counts as Japanese. */
const OK_RATIO = 0.6;

/** Number of non-Japanese turns (with enough letters) that makes the verdict `bad`. */
const BAD_TURN_COUNT = 2;

const LETTER = /\p{L}/u;
const JAPANESE_LETTER = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\u30FC]/u;

interface LetterCounts {
  letters: number;
  japanese: number;
}

function countLetters(text: unknown): LetterCounts {
  const counts: LetterCounts = { letters: 0, japanese: 0 };
  if (typeof text !== "string") return counts;
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    counts.letters += 1;
    if (JAPANESE_LETTER.test(ch)) counts.japanese += 1;
  }
  return counts;
}

/**
 * Share of letters that are kana or kanji, from 0 to 1, or `null` when the text has fewer than
 * four letters. Never throws; a non-string gives `null`.
 */
export function japaneseRatio(text: string): number | null {
  const { letters, japanese } = countLetters(text);
  if (letters < MIN_LETTERS) return null;
  return japanese / letters;
}

/**
 * Verdict over the assistant turns so far.
 *
 * - `ok`: one turn with at least four letters reaches 60 % Japanese letters.
 * - `bad`: no such turn, and at least two turns with four or more letters hold no Japanese letter.
 * - `undecided`: anything else, including turns shorter than four letters.
 *
 * `ok` wins over `bad`, so appending a Japanese turn to an `ok` list keeps it `ok` (R9.7).
 */
export function languageVerdict(turns: readonly string[]): "ok" | "bad" | "undecided" {
  let noJapanese = 0;
  for (const turn of turns) {
    const { letters, japanese } = countLetters(turn);
    if (letters < MIN_LETTERS) continue;
    if (japanese / letters >= OK_RATIO) return "ok";
    if (japanese === 0) noJapanese += 1;
  }
  return noJapanese >= BAD_TURN_COUNT ? "bad" : "undecided";
}

/**
 * True when `text` contains any blocked word, ignoring letter case. Empty blocked words are
 * skipped, because an empty string would match every text.
 */
export function isUnsafeAssistantText(text: string, blocked: readonly string[]): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  const haystack = text.toLowerCase();
  return blocked.some((word) => {
    const needle = typeof word === "string" ? word.toLowerCase() : "";
    return needle.length > 0 && haystack.includes(needle);
  });
}
