/**
 * Sequence reorder window for audio frames. Pure, no clock.
 *
 * Delivers frames in increasing `seq` with no duplicates. Holds at most `window` frames while
 * waiting for a missing `seq`; when more would be held, it gives up on the gap, counts the
 * skipped numbers in `missed()` and delivers on. Frames behind the delivery point are dropped.
 */

export interface Reorder {
  push(seq: number, pcm: string): readonly { seq: number; pcm: string }[];
  missed(): number;
}

export function makeReorder(window: number): Reorder {
  const size = Number.isFinite(window) ? Math.max(1, Math.floor(window)) : 1;
  const held = new Map<number, string>();
  let next: number | null = null; // next seq to deliver; set by the first frame
  let missed = 0;

  function drain(out: { seq: number; pcm: string }[]): void {
    while (next !== null && held.has(next)) {
      out.push({ seq: next, pcm: held.get(next) as string });
      held.delete(next);
      next += 1;
    }
  }

  return {
    push(seq, pcm) {
      if (!Number.isSafeInteger(seq) || seq < 0) return [];
      if (next === null) next = seq;
      if (seq < next || held.has(seq)) return [];
      held.set(seq, pcm);
      const out: { seq: number; pcm: string }[] = [];
      drain(out);
      while (held.size > size) {
        const lowest = Math.min(...held.keys());
        missed += lowest - (next as number);
        next = lowest;
        drain(out);
      }
      return out;
    },
    missed: () => missed,
  };
}
