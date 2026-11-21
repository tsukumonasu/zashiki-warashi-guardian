/**
 * Live cloud mode (Requirement 12): runs a scenario through `GET /samples` and `POST /simulate`
 * and turns the answer into a plan for `useScenarioRunner.start(plan, { mode: "live" })`.
 *
 * - No `simulate` call while the switch is off, and none for `network_down` (12.2, 12.6).
 * - `generate` is true only when the box is ticked and the role is family or reviewer (12.3, 12.4).
 * - 429 and every other failure give a message and an offer to run in Simulation mode, never a
 *   retry, and never a Timeline entry: this hook only returns a plan, and a failure returns none
 *   (12.8, 12.9).
 * - Step durations are measured here with the injected clock, in the browser (12.10).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient, ApiError, SimulateResponse } from "../lib/api";
import { systemClock, type Clock } from "../lib/clock";
import { COPY } from "../content/copy";
import { planFromResponse, sampleLabelFor } from "../simulation/plans";
import type { ScenarioId, ScenarioPlan, State } from "../simulation/types";

export type LiveRole = "family" | "reviewer";

export type LiveOutcome =
  | {
      kind: "plan";
      plan: ScenarioPlan;
      /** Pre-signed MP3 of the generated line, or null. */
      audioSrc: string | null;
      response: SimulateResponse;
    }
  /** `network_down`: the offline scenario runs without a call. */
  | { kind: "no_call"; plan: ScenarioPlan }
  | { kind: "failed" };

export interface LiveNotice {
  message: string;
  /** The scenario the user can run again in Simulation mode. */
  scenario: ScenarioId;
}

export interface LiveStep {
  state: State;
  durationMs: number;
}

export interface LiveCloud {
  enabled: boolean;
  setEnabled(on: boolean): void;
  generate: boolean;
  setGenerate(on: boolean): void;
  /** True when the signed-in role may use the generate tick. */
  canGenerate: boolean;
  busy: boolean;
  notice: LiveNotice | null;
  dismissNotice(): void;
  /** `latencyMs` of the last successful live response. */
  latency: { total: number; search: number } | null;
  /** Text of the last live speech, shown next to the subtitle. */
  speechText: { ja: string; en: string } | null;
  /** Fetches the plan for a scenario. Call after `runner.unlock()` in the click handler. */
  run(scenario: ScenarioId): Promise<LiveOutcome>;
  /** Clears latency, speech and step list for a new run. */
  reset(): void;
}

function messageFor(error: ApiError): string {
  if (error.code === "rate_limited") return COPY.live.rateLimited(error.retryAfterS ?? 60);
  return COPY.live.noAnswer;
}

export function useLiveCloud(api: ApiClient | undefined, role: LiveRole | undefined): LiveCloud {
  const [enabled, setEnabled] = useState(false);
  const [generate, setGenerate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<LiveNotice | null>(null);
  const [latency, setLatency] = useState<LiveCloud["latency"]>(null);
  const [speechText, setSpeechText] = useState<LiveCloud["speechText"]>(null);
  const samplesRef = useRef<{ sampleId: string; label: string }[] | null>(null);
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    [],
  );

  const available = api !== undefined && role !== undefined;
  const canGenerate = available;

  const reset = useCallback(() => {
    setLatency(null);
    setSpeechText(null);
    setNotice(null);
  }, []);

  const run = useCallback(
    async (scenario: ScenarioId): Promise<LiveOutcome> => {
      if (api === undefined) return { kind: "failed" };
      const label = sampleLabelFor(scenario);
      if (label === null) {
        // Requirement 12.6: the offline scenario needs no cloud.
        setNotice({ message: COPY.live.networkDown, scenario });
        return { kind: "no_call", plan: planFromResponse(scenario, null) };
      }
      setBusy(true);
      setNotice(null);
      const fail = (message: string): LiveOutcome => {
        if (aliveRef.current) setNotice({ message, scenario });
        return { kind: "failed" };
      };
      try {
        if (samplesRef.current === null) {
          const listed = await api.samples();
          if (!listed.ok) return fail(messageFor(listed.error));
          samplesRef.current = listed.value.samples;
        }
        const sample = samplesRef.current.find((s) => s.label === label);
        if (sample === undefined) return fail(COPY.live.noAnswer);
        const res = await api.simulate(sample.sampleId, generate);
        if (!res.ok) return fail(messageFor(res.error));
        const response = res.value;
        if (aliveRef.current) {
          setLatency({ ...response.latencyMs });
          setSpeechText(response.speech ? { ja: response.speech.ja, en: response.speech.en } : null);
        }
        return {
          kind: "plan",
          plan: planFromResponse(scenario, response),
          audioSrc: response.speech?.mp3Url ?? null,
          response,
        };
      } finally {
        if (aliveRef.current) setBusy(false);
      }
    },
    [api, generate],
  );

  return {
    enabled: available && enabled,
    setEnabled,
    generate,
    setGenerate,
    canGenerate,
    busy,
    notice,
    dismissNotice: () => setNotice(null),
    latency,
    speechText,
    run,
    reset,
  };
}

/**
 * Durations of the device states of one live run, measured with `clock` in the browser.
 * A step is recorded when the doll leaves a state. `sleeping` is not a step.
 */
export function useLiveSteps(
  deviceState: State,
  active: boolean,
  clock: Clock = systemClock,
): { steps: readonly LiveStep[]; reset(): void } {
  const [steps, setSteps] = useState<readonly LiveStep[]>([]);
  const last = useRef<{ state: State; at: number }>({ state: deviceState, at: clock.now() });

  useEffect(() => {
    const now = clock.now();
    const prev = last.current;
    if (prev.state === deviceState) return;
    last.current = { state: deviceState, at: now };
    if (active && prev.state !== "sleeping") {
      setSteps((list) => [...list, { state: prev.state, durationMs: Math.max(0, now - prev.at) }]);
    }
  }, [deviceState, active, clock]);

  const reset = useCallback(() => setSteps([]), []);
  return { steps, reset };
}
