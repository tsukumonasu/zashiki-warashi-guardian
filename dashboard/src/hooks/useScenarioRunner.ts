/**
 * Runs the pure simulation engine in the browser (Requirements 2.2, 2.5, 2.7, 8.4 to 8.7, 10.1).
 *
 * - Ticks the engine every `TICK_MS` with the injected clock.
 * - Forwards `audio.play` / `audio.stop` outputs to the AudioPlayer and feeds
 *   `audio.finished` / `audio.failed` back as internal events.
 * - Keeps the `SimState` and appends each finished encounter to the simulated Timeline.
 * - An engine exception is stored and rethrown during render, so an error boundary catches it.
 *
 * The caller passes the plan to `start(plan, ...)`. The hook does not care where the plan comes
 * from, so Live cloud mode (task 12.4) can build it from a `POST /simulate` response and pass
 * `mode: "live"`.
 *
 * Clock, player and timer are injected so tests need no real time.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import catalog from "../simulation/data/voice-catalog.json";
import { initialState, step } from "../simulation/engine";
import { buildSimEncounter, insertSimulated } from "../simulation/timeline";
import type { Input, Output, ScenarioPlan, SimEncounter, SimState } from "../simulation/types";
import type { AudioPlayer } from "../lib/audio";
import { systemClock, type Clock } from "../lib/clock";

export const TICK_MS = 50;

/** The part of the global timer functions the hook uses. */
export interface Timer {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemTimer: Timer = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface ScenarioRunnerOptions {
  player: AudioPlayer;
  clock?: Clock;
  timer?: Timer;
}

export type RunMode = "simulation" | "live";

export interface ScenarioRunner {
  state: SimState;
  running: boolean;
  /** Simulated encounters, newest first, at most 50. */
  encounters: readonly SimEncounter[];
  /** Call from a click handler: it unlocks audio inside the user gesture. */
  start(plan: ScenarioPlan, options?: { seed?: number; mode?: RunMode; audioSrc?: string | null }): void;
  stop(): void;
  /** Unlocks audio. Call inside the click handler, before any `await`. */
  unlock(): void;
}

interface CatalogLine {
  id: string;
  audio: string | null;
}
const CATALOG = catalog as CatalogLine[];

/** URL of the bundled WAV file of a line, or null when the line has none. */
export function audioSrcFor(lineId: string): string | null {
  const audio = CATALOG.find((l) => l.id === lineId)?.audio ?? null;
  return audio === null ? null : `/audio/${audio.split("/").pop()}`;
}

export function useScenarioRunner(options: ScenarioRunnerOptions): ScenarioRunner {
  const { player } = options;
  const clock = options.clock ?? systemClock;
  const timer = options.timer ?? systemTimer;

  const stateRef = useRef<SimState>(initialState());
  const [state, setState] = useState<SimState>(stateRef.current);
  const [encounters, setEncounters] = useState<readonly SimEncounter[]>([]);
  const [error, setError] = useState<unknown>(null);
  const modeRef = useRef<RunMode>("simulation");
  /** MP3 of a live response that replaces the bundled WAV of the reaction line. */
  const audioOverrideRef = useRef<string | null>(null);
  const lineRef = useRef<{ ja: string; en: string }>({ ja: "", en: "" });
  const verdictRef = useRef<SimState["verdict"]>(null);
  const handleRef = useRef<unknown>(null);
  const failedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (handleRef.current !== null) timer.clearInterval(handleRef.current);
    handleRef.current = null;
  }, [timer]);

  const dispatchRef = useRef<(input: Input) => void>(() => undefined);

  const handleOutputs = useCallback(
    (outputs: Output[], after: SimState) => {
      for (const o of outputs) {
        if (o.kind === "audio.play") {
          lineRef.current = { ja: o.ja, en: o.en };
          player.play(
            { playId: o.playId, src: audioOverrideRef.current ?? audioSrcFor(o.lineId), minHoldMs: o.durationHintMs ?? 0 },
            {
              finished: (playId) =>
                dispatchRef.current({ kind: "internal", event: { type: "audio.finished", playId } }),
              failed: (playId) =>
                dispatchRef.current({
                  kind: "internal",
                  event: { type: "audio.failed", playId, code: "audio_failed" },
                }),
            },
          );
        } else if (o.kind === "audio.stop") {
          player.stop();
        } else if (o.envelope.type === "encounter.ended") {
          const base = buildSimEncounter(after.log, { mode: modeRef.current, ...lineRef.current });
          // `judgement.result` is a command the engine receives, so it is not in the message
          // log. Take the verdict from the machine's visible label and the plan's confidence.
          const label = verdictRef.current;
          const attempts = after.plan?.attempts ?? [];
          const planned = attempts[attempts.length - 1] ?? null;
          const record: SimEncounter =
            base.verdict === null && label !== null && label !== "offline"
              ? {
                  ...base,
                  verdict: label,
                  confidence: planned?.verdict === label ? planned.confidence : null,
                  notified: label === "stranger" && base.reaction?.kind === "stranger",
                }
              : base;
          setEncounters((list) => insertSimulated(list, record));
        }
      }
    },
    [player],
  );

  const dispatch = useCallback(
    (input: Input) => {
      if (failedRef.current) return;
      try {
        const result = step(stateRef.current, input, clock.now());
        stateRef.current = result.state;
        if (result.state.verdict !== null) verdictRef.current = result.state.verdict;
        setState(result.state);
        handleOutputs(result.outputs, result.state);
        if (!result.state.running && result.state.deviceState === "sleeping") clearTimer();
      } catch (e) {
        failedRef.current = true;
        clearTimer();
        player.stop();
        setError(e);
      }
    },
    [clock, clearTimer, handleOutputs, player],
  );
  dispatchRef.current = dispatch;

  const start = useCallback(
    (plan: ScenarioPlan, opts?: { seed?: number; mode?: RunMode; audioSrc?: string | null }) => {
      player.unlock(); // inside the click handler: browsers require a gesture
      if (stateRef.current.running || failedRef.current) return;
      modeRef.current = opts?.mode ?? "simulation";
      audioOverrideRef.current = opts?.audioSrc ?? null;
      lineRef.current = { ja: "", en: "" };
      verdictRef.current = null;
      const seed = opts?.seed ?? clock.now() % 0x7fffffff;
      dispatch({ kind: "user", action: { type: "start", plan, seed } });
      clearTimer();
      handleRef.current = timer.setInterval(() => dispatchRef.current({ kind: "tick" }), TICK_MS);
    },
    [clock, timer, player, dispatch, clearTimer],
  );

  const unlock = useCallback(() => player.unlock(), [player]);

  const stop = useCallback(() => {
    dispatch({ kind: "user", action: { type: "stop" } });
  }, [dispatch]);

  useEffect(
    () => () => {
      clearTimer();
      player.stop();
    },
    [clearTimer, player],
  );

  // Rethrow in render so the nearest error boundary shows the recovery text.
  if (error !== null) throw error;

  return { state, running: state.running, encounters, start, stop, unlock };
}
