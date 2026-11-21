/**
 * Cached voice lines: types and the pure choice function.
 *
 * The line catalog lives in `voice-lines.json` (generated from
 * `device/warashi_agent/voice/lines.toml`). This module has no AWS imports and no I/O,
 * so the randomness is passed in and the choice is deterministic for a given input.
 */

export type Category = "family" | "stranger" | "uncertain";

export type VoiceLine = { id: string; category: Category; ja: string; en: string };

/**
 * Pick one line of `category`, or `null` when the category has no line.
 *
 * `rand` is expected in [0, 1). `Math.floor(rand * n)` can still round up to `n` for the
 * largest double below 1 when `n` is not a power of two, so the index is clamped to `n - 1`.
 * A non-finite or negative `rand` selects the first line instead of an invalid index.
 */
export function chooseLine(
  lines: readonly VoiceLine[],
  category: Category,
  rand: number,
): VoiceLine | null {
  const candidates = lines.filter((line) => line.category === category);
  const count = candidates.length;
  if (count === 0) {
    return null;
  }
  const safeRand = Number.isFinite(rand) && rand > 0 ? rand : 0;
  const index = Math.min(Math.floor(safeRand * count), count - 1);
  return candidates[index] ?? null;
}
