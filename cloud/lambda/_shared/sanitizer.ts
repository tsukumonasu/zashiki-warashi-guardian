/**
 * Line sanitizer for generated doll lines (Requirement 7.6).
 *
 * Accepts a line only when it has 1 to 40 characters, at most two sentences, no Latin letters,
 * no emoji, no blocked word and no threat. Anything else returns `null`, and the caller falls
 * back to a cached line. Pure: no AWS imports, no I/O.
 */

/** Longest accepted line, in Unicode code points. */
export const MAX_LINE_CHARS = 40;

/** Most sentences an accepted line may have. */
export const MAX_SENTENCES = 2;

/**
 * Words that signal harm, death, injury or violence (persona safety rules).
 * Matched as substrings after normalization, so a false positive only costs a cached fallback.
 */
const THREAT_WORDS: readonly string[] = [
  "殺",
  "ころす",
  "ころし",
  "ころさ",
  "ころせ",
  "死",
  "しぬ",
  "しね",
  "しに",
  "しんで",
  "しんだ",
  "傷",
  "けが",
  "怪我",
  "なぐ",
  "殴",
  "蹴",
  "刺す",
  "ささる",
  "おそう",
  "襲",
  "のろう",
  "のろって",
  "呪",
  "たたり",
  "祟",
  "ひどいめ",
  "ゆるさない",
  "許さない",
  "くるしめ",
  "苦しめ",
  "こわしてやる",
  "ただじゃ",
];

const LATIN_LETTER = /\p{Script=Latin}/u;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u200d|\ufe0f|\u20e3/u;
/** Sentence terminators. A run of ellipsis dots is a pause, not a terminator. */
const SENTENCE_END = /[。！？!?.]+/u;

/** Normalize for matching: NFKC, lower case, and no whitespace. */
function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

function countSentences(text: string): number {
  return text
    .split(SENTENCE_END)
    .filter((part) => part.replace(/[\s…・、，,「」『』（）()]+/gu, "").length > 0).length;
}

/**
 * Return the trimmed text when it passes every rule, otherwise `null`.
 *
 * `blockedWords` entries are compared case-insensitively after Unicode normalization;
 * empty entries are ignored.
 */
export function sanitizeLine(text: string, blockedWords: readonly string[]): string | null {
  if (typeof text !== "string") {
    return null;
  }
  const line = text.trim();
  const length = Array.from(line).length;
  if (length < 1 || length > MAX_LINE_CHARS) {
    return null;
  }
  if (LATIN_LETTER.test(line) || EMOJI.test(line)) {
    return null;
  }
  if (countSentences(line) > MAX_SENTENCES) {
    return null;
  }
  const normalized = normalizeForMatch(line);
  const forbidden = [...THREAT_WORDS, ...blockedWords];
  for (const word of forbidden) {
    const needle = normalizeForMatch(word);
    if (needle.length > 0 && normalized.includes(needle)) {
      return null;
    }
  }
  return line;
}
