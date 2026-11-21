// Injectable clock, so time-dependent code can be tested without real time.

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface ManualClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

/** A clock that moves only when told to. */
export function createManualClock(startMs = 0): ManualClock {
  let t = startMs;
  return {
    now: () => t,
    set: (ms) => {
      t = ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}
