/**
 * Audio player for the simulation (design D10, Requirements 8.1, 8.2, 8.4 to 8.7).
 *
 * One shared audio element is unlocked inside a user gesture and reused for all
 * playback, because browsers (iOS Safari in particular) only let an element play
 * later if it was started during a gesture. Nothing plays before `unlock()`.
 *
 * Each `play()` request ends with exactly one callback: `finished` or `failed`.
 * Muted: `finished` after the hold time. No audio file (`src` null) while not
 * muted: `failed("audio_missing")` after the hold time (Requirement 8.5).
 * `stop()` and a newer `play()` cancel the pending request without a callback.
 */

/** Minimum time a subtitle stays visible when no sound plays (Requirement 8.1). */
export const MIN_SUBTITLE_HOLD_MS = 3000;

export interface AudioRequest {
  playId: string;
  /** URL of the audio file, or null when the line has no audio file. */
  src: string | null;
  minHoldMs: number;
}

export interface AudioCallbacks {
  finished(playId: string): void;
  failed(playId: string, code: string): void;
}

export interface AudioPlayer {
  /** Call inside a user gesture (a click handler). */
  unlock(): void;
  play(req: AudioRequest, cb: AudioCallbacks): void;
  stop(): void;
  setMuted(muted: boolean): void;
  readonly muted: boolean;
}

/** The part of `HTMLAudioElement` this module uses, so tests can pass a fake. */
export interface AudioElementLike {
  src: string;
  currentTime: number;
  muted: boolean;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(type: "ended" | "error", listener: () => void): void;
  removeEventListener(type: "ended" | "error", listener: () => void): void;
}

export type AudioElementFactory = () => AudioElementLike;

/** Hold time for a request that plays no sound. */
export function holdTimeMs(minHoldMs: number): number {
  const requested = Number.isFinite(minHoldMs) ? minHoldMs : 0;
  return Math.max(requested, MIN_SUBTITLE_HOLD_MS);
}

/** A data URI of a WAV file with one silent 16-bit mono sample (8 kHz). */
export function silentWavDataUri(): string {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 38, true); // file size minus 8
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, 2, true);
  // The last two bytes (one sample) stay 0: silence.
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

const defaultFactory: AudioElementFactory = () => new Audio();

export function createAudioPlayer(
  createElement: AudioElementFactory = defaultFactory,
): AudioPlayer {
  let element: AudioElementLike | null = null;
  let unlocked = false;
  let muted = false;
  /** Cancels the pending request, if any, without calling back. */
  let cancelPending: (() => void) | null = null;

  const shared = (): AudioElementLike => {
    element ??= createElement();
    return element;
  };

  const cancel = (): void => {
    const fn = cancelPending;
    cancelPending = null;
    fn?.();
  };

  const player: AudioPlayer = {
    get muted() {
      return muted;
    },

    unlock() {
      if (unlocked) return;
      unlocked = true;
      const el = shared();
      el.src = silentWavDataUri();
      try {
        const result = el.play();
        if (result && typeof result.catch === "function") {
          result.catch(() => {
            // A blocked unlock only means later playback may fail; play() reports it.
          });
        }
      } catch {
        // Same as above.
      }
    },

    play(req, cb) {
      cancel();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let el: AudioElementLike | null = null;

      const onEnded = (): void => settle(() => cb.finished(req.playId));
      const onError = (): void => settle(() => cb.failed(req.playId, "audio_failed"));

      const cleanup = (): void => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (el) {
          el.removeEventListener("ended", onEnded);
          el.removeEventListener("error", onError);
        }
      };
      const settle = (notify: (() => void) | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (cancelPending === cancelThis) cancelPending = null;
        notify?.();
      };
      const cancelThis = (): void => {
        if (settled) return;
        const wasPlaying = el !== null;
        settle(null);
        if (wasPlaying) el?.pause();
      };
      cancelPending = cancelThis;

      // Muted: show the subtitle for the hold time, then finish.
      if (muted) {
        timer = setTimeout(() => settle(() => cb.finished(req.playId)), holdTimeMs(req.minHoldMs));
        return;
      }

      // Requirement 8.5: no audio file is a failure, reported after the same hold
      // so the subtitle stays readable and the scenario continues.
      if (req.src === null) {
        timer = setTimeout(
          () => settle(() => cb.failed(req.playId, "audio_missing")),
          holdTimeMs(req.minHoldMs),
        );
        return;
      }

      // Requirement 8.4: no sound before a user gesture.
      if (!unlocked) {
        settle(() => cb.failed(req.playId, "audio_blocked"));
        return;
      }

      el = shared();
      el.muted = false;
      el.addEventListener("ended", onEnded);
      el.addEventListener("error", onError);
      el.src = req.src;
      el.currentTime = 0;
      try {
        const result = el.play();
        if (result && typeof result.catch === "function") {
          result.catch(() => settle(() => cb.failed(req.playId, "audio_blocked")));
        }
      } catch {
        settle(() => cb.failed(req.playId, "audio_blocked"));
      }
    },

    stop() {
      cancel();
    },

    setMuted(value) {
      muted = value;
      // Muting during playback silences the sound but lets the request end
      // normally, so the runner is never left waiting without a callback.
      if (element) element.muted = value;
    },
  };
  return player;
}
