// Feature: dashboard-simulation, Property 25: Subtitles stay visible long enough
// **Validates: Requirements 8.1, 8.5**
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAudioPlayer,
  holdTimeMs,
  MIN_SUBTITLE_HOLD_MS,
  type AudioElementLike,
} from "../../src/lib/audio";
import { FakePlayer } from "../helpers/fakePlayer";

/** A fake audio element: the test decides when playback ends, errors or is rejected. */
class FakeElement implements AudioElementLike {
  src = "";
  currentTime = 0;
  muted = false;
  rejectPlay = false;
  private listeners: Record<"ended" | "error", Set<() => void>> = {
    ended: new Set(),
    error: new Set(),
  };
  play(): Promise<void> {
    return this.rejectPlay ? Promise.reject(new Error("blocked")) : Promise.resolve();
  }
  pause(): void {}
  addEventListener(type: "ended" | "error", l: () => void): void {
    this.listeners[type].add(l);
  }
  removeEventListener(type: "ended" | "error", l: () => void): void {
    this.listeners[type].delete(l);
  }
  emit(type: "ended" | "error"): void {
    for (const l of [...this.listeners[type]]) l();
  }
}

const arbMinHold = fc.oneof(
  fc.integer({ min: -1000, max: 20000 }),
  fc.constantFrom(0, 3000, 2999, 3001, Number.NaN, Infinity, -Infinity),
);

describe("Property 25: Subtitles stay visible long enough", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("muted: finished once, never before max(minHoldMs, 3000)", async () => {
    await fc.assert(
      fc.asyncProperty(arbMinHold, fc.boolean(), fc.boolean(), async (minHoldMs, hasSrc, unlock) => {
        const player = createAudioPlayer(() => new FakeElement());
        if (unlock) player.unlock();
        player.setMuted(true);
        const calls: string[] = [];
        player.play(
          { playId: "p", src: hasSrc ? "x.wav" : null, minHoldMs },
          { finished: () => calls.push("finished"), failed: (_, c) => calls.push(`failed:${c}`) },
        );
        const hold = holdTimeMs(minHoldMs);
        expect(hold).toBeGreaterThanOrEqual(MIN_SUBTITLE_HOLD_MS);
        await vi.advanceTimersByTimeAsync(hold - 1);
        expect(calls).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls).toEqual(["finished"]);
        await vi.advanceTimersByTimeAsync(60000);
        expect(calls).toEqual(["finished"]);
      }),
      { numRuns: 100 },
    );
  });

  it("not muted, no audio file: failed (audio_missing) once, after the same hold", async () => {
    await fc.assert(
      fc.asyncProperty(arbMinHold, async (minHoldMs) => {
        const player = createAudioPlayer(() => new FakeElement());
        player.unlock();
        const calls: string[] = [];
        player.play(
          { playId: "p", src: null, minHoldMs },
          { finished: () => calls.push("finished"), failed: (_, c) => calls.push(`failed:${c}`) },
        );
        const hold = holdTimeMs(minHoldMs);
        await vi.advanceTimersByTimeAsync(hold - 1);
        expect(calls).toEqual([]);
        await vi.advanceTimersByTimeAsync(60000);
        expect(calls).toEqual(["failed:audio_missing"]);
      }),
      { numRuns: 100 },
    );
  });

  it("with a source: exactly one callback for every playback outcome", async () => {
    const outcome = fc.constantFrom("ended", "error", "rejected", "locked");
    await fc.assert(
      fc.asyncProperty(arbMinHold, outcome, fc.integer({ min: 0, max: 10000 }), async (minHoldMs, o, afterMs) => {
        const el = new FakeElement();
        const player = createAudioPlayer(() => el);
        if (o !== "locked") player.unlock();
        el.rejectPlay = o === "rejected";
        const calls: string[] = [];
        player.play(
          { playId: "p", src: "x.wav", minHoldMs },
          { finished: () => calls.push("finished"), failed: (_, c) => calls.push(`failed:${c}`) },
        );
        await vi.advanceTimersByTimeAsync(afterMs);
        if (o === "ended" || o === "error") {
          expect(calls).toEqual([]);
          el.emit(o);
          el.emit("ended");
          el.emit("error");
        }
        await vi.advanceTimersByTimeAsync(60000);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toBe(
          { ended: "finished", error: "failed:audio_failed", rejected: "failed:audio_blocked", locked: "failed:audio_blocked" }[o],
        );
      }),
      { numRuns: 100 },
    );
  });

  it("FakePlayer follows the same hold rule on its manual clock", () => {
    fc.assert(
      fc.property(arbMinHold, fc.boolean(), fc.boolean(), (minHoldMs, muted, hasSrc) => {
        fc.pre(muted || !hasSrc);
        const fake = new FakePlayer();
        fake.unlock();
        fake.setMuted(muted);
        const calls: string[] = [];
        fake.play(
          { playId: "p", src: hasSrc ? "x.wav" : null, minHoldMs },
          { finished: () => calls.push("finished"), failed: (_, c) => calls.push(`failed:${c}`) },
        );
        const hold = holdTimeMs(minHoldMs);
        fake.advance(hold - 1);
        expect(calls).toEqual([]);
        fake.advance(1);
        fake.advance(60000);
        expect(calls).toEqual([muted ? "finished" : "failed:audio_missing"]);
      }),
      { numRuns: 100 },
    );
  });
});
