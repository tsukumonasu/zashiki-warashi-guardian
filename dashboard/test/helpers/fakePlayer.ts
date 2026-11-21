import {
  holdTimeMs,
  type AudioCallbacks,
  type AudioPlayer,
  type AudioRequest,
} from "../../src/lib/audio";

interface Pending {
  req: AudioRequest;
  cb: AudioCallbacks;
  dueMs: number;
  /** Not muted and no audio file: ends with `failed`. */
  missing: boolean;
}

/**
 * An `AudioPlayer` with a manual clock. Nothing happens until `advance(ms)`.
 * A request that plays no sound (muted or `src` null) is due after
 * `max(minHoldMs, 3000)`; a request with sound is due after `audioDurationMs`.
 * Each request gets exactly one callback.
 */
export class FakePlayer implements AudioPlayer {
  muted = false;
  nowMs = 0;
  unlocked = false;
  /** How long a playback with sound lasts. */
  audioDurationMs = 1000;
  /** When set, the next playback with sound is blocked and fails with this code. */
  blockNextWith: string | null = null;
  /** Every request received, in order. */
  readonly requests: AudioRequest[] = [];
  private pending: Pending | null = null;

  unlock(): void {
    this.unlocked = true;
  }

  play(req: AudioRequest, cb: AudioCallbacks): void {
    this.requests.push(req);
    this.pending = null; // a newer request replaces the old one without a callback
    const silent = this.muted || req.src === null;
    if (!silent && (!this.unlocked || this.blockNextWith !== null)) {
      const code = this.blockNextWith ?? "audio_blocked";
      this.blockNextWith = null;
      cb.failed(req.playId, code);
      return;
    }
    const wait = silent ? holdTimeMs(req.minHoldMs) : this.audioDurationMs;
    this.pending = { req, cb, dueMs: this.nowMs + wait, missing: !this.muted && req.src === null };
  }

  stop(): void {
    this.pending = null;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /** True while a request waits for its callback. */
  get isPending(): boolean {
    return this.pending !== null;
  }

  /** Moves the clock forward and fires the callback of a request that is due. */
  advance(ms: number): void {
    this.nowMs += ms;
    const p = this.pending;
    if (p && this.nowMs >= p.dueMs) {
      this.pending = null;
      // Requirement 8.5: an unmuted request without an audio file fails after the hold.
      if (p.missing) p.cb.failed(p.req.playId, "audio_missing");
      else p.cb.finished(p.req.playId);
    }
  }
}
