/**
 * House page: the virtual doll, its subtitle, and the four scenarios in one view (from 360 px).
 *
 * Where a scenario's plan comes from is a prop (`planSource`). The default builds plans from the
 * bundled sample responses, so the page works offline with no backend.
 */
import { InfoTip } from "../components/InfoTip";
import { useEffect, useState } from "react";
import type { ApiClient } from "../lib/api";
import { systemClock } from "../lib/clock";
import { useLiveCloud, useLiveSteps } from "../hooks/useLiveCloud";
import { LiveRegion } from "../components/LiveRegion";
import { ScenarioPanel } from "../components/ScenarioPanel";
import { Subtitle } from "../components/Subtitle";
import { VirtualDoll, dollViewFromSim } from "../components/VirtualDoll";
import { COPY } from "../content/copy";
import { useScenarioRunner, type ScenarioRunnerOptions } from "../hooks/useScenarioRunner";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import familySample from "../simulation/data/sample-responses/family.json";
import noFaceSample from "../simulation/data/sample-responses/no_face.json";
import strangerSample from "../simulation/data/sample-responses/stranger.json";
import { planFromResponse, type PlanResponse } from "../simulation/plans";
import type { Role } from "../lib/roles";
import type { ScenarioId, ScenarioPlan, SimEncounter } from "../simulation/types";
import "./House.css";

/**
 * A PlanSource turns a scenario id into the plan the engine runs. The bundled source below is
 * synchronous and offline. Live cloud mode (`useLiveCloud`) replaces it while its switch is on;
 * the audio unlock happens before any await, inside the click handler.
 */
export type PlanSource = (scenario: ScenarioId) => ScenarioPlan;

const BUNDLED: Record<Exclude<ScenarioId, "network_down">, PlanResponse> = {
  family_home: familySample as unknown as PlanResponse,
  stranger_night: strangerSample as unknown as PlanResponse,
  nobody_there: noFaceSample as unknown as PlanResponse,
};

/** Default plan source: bundled Sample_Responses, no network. */
export const bundledPlanSource: PlanSource = (scenario) =>
  planFromResponse(scenario, scenario === "network_down" ? null : BUNDLED[scenario]);

export interface HouseProps extends ScenarioRunnerOptions {
  planSource?: PlanSource;
  /** API client of a signed-in user. Without it there is no "Live cloud" switch. */
  api?: ApiClient;
  /** Role from `GET /me`. Without it, or as a visitor, there is no "Live cloud" switch. */
  role?: Role;
  /** Receives the simulated encounters whenever they change (for the Timeline page). */
  onEncounters?: (encounters: readonly SimEncounter[]) => void;
  /** False while the browser is offline: the Live cloud switch is disabled. Default true. */
  online?: boolean;
}

export function House({
  planSource = bundledPlanSource,
  api,
  role,
  onEncounters,
  online = true,
  ...runnerOptions
}: HouseProps) {
  const runner = useScenarioRunner(runnerOptions);
  const { encounters } = runner;
  useEffect(() => {
    onEncounters?.(encounters);
  }, [encounters, onEncounters]);
  const liveRole = role === "family" || role === "reviewer" ? role : undefined;
  const live = useLiveCloud(api, liveRole);
  const [liveRun, setLiveRun] = useState(false);
  const liveSteps = useLiveSteps(runner.state.deviceState, liveRun, runnerOptions.clock ?? systemClock);
  const showLiveSwitch = api !== undefined && liveRole !== undefined;

  async function startScenario(scenario: ScenarioId): Promise<void> {
    if (!live.enabled || !online) {
      setLiveRun(false);
      runner.start(planSource(scenario));
      return;
    }
    runner.unlock(); // inside the click, before the await (Requirement 8.4)
    live.reset();
    liveSteps.reset();
    const outcome = await live.run(scenario);
    if (outcome.kind === "failed") return; // no run, so no Timeline entry
    const isLive = outcome.kind === "plan";
    setLiveRun(isLive);
    runner.start(outcome.plan, isLive ? { mode: "live", audioSrc: outcome.audioSrc } : undefined);
  }
  const reducedMotion = usePrefersReducedMotion();
  const { state } = runner;

  return (
    <main className="house">
      <h1 className="house__title">
        {COPY.house.heading}
        <InfoTip text={COPY.tips.simulation} />
      </h1>
      <p className="house__intro">{COPY.house.intro}</p>
      <div className="house__layout">
        <div className="house__stage">
          <VirtualDoll view={dollViewFromSim(state)} reducedMotion={reducedMotion} />
          <Subtitle subtitle={state.subtitle} />
        </div>
        <ScenarioPanel
          running={runner.running}
          verdict={state.verdict}
          deviceState={state.deviceState}
          busy={live.busy}
          onStart={(scenario) => void startScenario(scenario)}
          onStop={runner.stop}
        />
        {showLiveSwitch && (
          <section className="live-panel" aria-labelledby="live-heading">
            <h2 id="live-heading" className="scenario-panel__heading">
              {COPY.live.switchLabel}
            </h2>
            <label className="live-panel__row">
              <input
                type="checkbox"
                role="switch"
                checked={live.enabled && online}
                disabled={runner.running || !online}
                onChange={(e) => live.setEnabled(e.target.checked)}
              />{" "}
              {COPY.live.switchLabel}
            </label>
            {!online && <p className="live-panel__offline">{COPY.shell.offlineLive}</p>}
            {live.enabled && online && (
              <label className="live-panel__row">
                <input
                  type="checkbox"
                  checked={live.generate}
                  disabled={runner.running}
                  onChange={(e) => live.setGenerate(e.target.checked)}
                />{" "}
                {COPY.live.generateLabel}
              </label>
            )}
            {live.notice !== null && (
              <div role="status" className="live-panel__notice">
                <p>{live.notice.message}</p>
                {live.notice.message !== COPY.live.networkDown && (
                  <button
                    type="button"
                    className="scenario-panel__button"
                    disabled={runner.running}
                    onClick={() => {
                      const scenario = live.notice?.scenario;
                      live.dismissNotice();
                      live.setEnabled(false);
                      setLiveRun(false);
                      if (scenario) runner.start(planSource(scenario));
                    }}
                  >
                    {COPY.live.runInSimulation}
                  </button>
                )}
              </div>
            )}
            {liveRun && (
              <div className="live-panel__report">
                <p>
                  <strong>{COPY.timeline.liveCloudLabel}</strong>
                </p>
                {live.latency !== null && (
                  <p data-testid="live-latency">
                    {live.latency.total} ms total, {live.latency.search} ms search
                  </p>
                )}
                {live.speechText !== null && (
                  <p data-testid="live-speech">
                    <span lang="ja">{live.speechText.ja}</span> <span>{live.speechText.en}</span>
                  </p>
                )}
                {liveSteps.steps.length > 0 && (
                  <>
                    <p>{COPY.live.measuredInBrowser}</p>
                    <ol data-testid="live-steps">
                      {liveSteps.steps.map((st, i) => (
                        <li key={i}>
                          {COPY.house.states[st.state]}: {st.durationMs} ms
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </div>
            )}
          </section>
        )}
      </div>
      <LiveRegion stateLabel={COPY.house.states[state.deviceState]} subtitle={state.subtitle} />
    </main>
  );
}
