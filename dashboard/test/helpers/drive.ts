// Scenario driver for property tests: runs the pure engine against a manual clock.
import { initialState, step } from "../../src/simulation/engine";
import type {
  Input,
  Output,
  ScenarioPlan,
  SchemaMessage,
  SimConfig,
  SimState,
} from "../../src/simulation/types";

/** Simulated time after which `drive` gives up (design: 130 s, cooldown included). */
export const MAX_SIM_MS = 130_000;
/** Playback time assumed when an `audio.play` has no `durationHintMs`. */
export const DEFAULT_AUDIO_MS = 3000;

export interface DriveOptions {
  /** Config overrides for `initialState`. */
  config?: Partial<SimConfig>;
  /** Extra inputs delivered at a simulated time (ms since start), before that tick. */
  script?: ReadonlyArray<{ atMs: number; input: Input }>;
  /** Stop after this many simulated ms. Default 130,000. */
  maxMs?: number;
  /** When false, `audio.play` is never answered (tests the audio deadline). Default true. */
  answerAudio?: boolean;
}

export interface DriveResult {
  /** The state after each step, the first one after `start`. */
  states: SimState[];
  /** Outputs of every step, flattened, in order. */
  outputs: Output[];
  /** Only the `message` outputs' envelopes. */
  messages: SchemaMessage[];
  /** Simulated time of the last step. */
  endedAtMs: number;
  /** True when the engine was sleeping with `running` false at the end. */
  finished: boolean;
}

function isAtRest(s: SimState): boolean {
  return s.deviceState === "sleeping" && !s.running;
}

export function drive(
  plan: ScenarioPlan,
  seed: number,
  gap: number,
  options: DriveOptions = {},
): DriveResult {
  const maxMs = options.maxMs ?? MAX_SIM_MS;
  const answer = options.answerAudio ?? true;
  const tickGap = Math.max(1, Math.floor(gap));
  const script = [...(options.script ?? [])].sort((a, b) => a.atMs - b.atMs);

  const states: SimState[] = [];
  const outputs: Output[] = [];
  const audioDue: { at: number; playId: string }[] = [];

  let state = initialState(options.config);
  let now = 0;

  const run = (input: Input): void => {
    const result = step(state, input, now);
    state = result.state;
    outputs.push(...result.outputs);
    for (const o of result.outputs) {
      if (o.kind === "audio.play" && answer) {
        audioDue.push({ at: now + (o.durationHintMs ?? DEFAULT_AUDIO_MS), playId: o.playId });
      }
    }
    states.push(state);
  };

  run({ kind: "user", action: { type: "start", plan, seed } });

  let scriptIndex = 0;
  while (!isAtRest(state) && now < maxMs) {
    now += tickGap;
    while (scriptIndex < script.length && script[scriptIndex]!.atMs <= now) {
      run(script[scriptIndex]!.input);
      scriptIndex++;
    }
    for (let i = 0; i < audioDue.length; ) {
      const due = audioDue[i]!;
      if (due.at <= now) {
        audioDue.splice(i, 1);
        run({ kind: "internal", event: { type: "audio.finished", playId: due.playId } });
      } else {
        i++;
      }
    }
    run({ kind: "tick" });
  }

  const messages: SchemaMessage[] = [];
  for (const o of outputs) if (o.kind === "message") messages.push(o.envelope);
  return { states, outputs, messages, endedAtMs: now, finished: isAtRest(state) };
}
