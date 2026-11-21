/**
 * Scenario buttons, verdict label and state label (Requirements 1.2, 1.3, 2.1, 2.5, 2.6, 2.7, 3.7).
 *
 * Presentational: it knows nothing about where a plan comes from. The House page decides that.
 * While a scenario runs, the four buttons are disabled and a "Stop" button appears.
 */
import { COPY } from "../content/copy";
import { SCENARIOS } from "../simulation/plans";
import type { ScenarioId, State, VerdictLabel } from "../simulation/types";

export interface ScenarioPanelProps {
  running: boolean;
  /** True while a live request is pending: the buttons wait so a run cannot start twice. */
  busy?: boolean;
  verdict: VerdictLabel | null;
  deviceState: State;
  onStart(scenario: ScenarioId): void;
  onStop(): void;
}

export function ScenarioPanel({ running, busy = false, verdict, deviceState, onStart, onStop }: ScenarioPanelProps) {
  return (
    <section className="scenario-panel" aria-labelledby="scenario-heading">
      <h2 id="scenario-heading" className="scenario-panel__heading">
        {COPY.house.scenariosHeading}
      </h2>
      <div className="scenario-panel__buttons">
        {SCENARIOS.map((scenario) => (
          <button
            key={scenario}
            type="button"
            className="scenario-panel__button"
            disabled={running || busy}
            onClick={() => onStart(scenario)}
          >
            {COPY.scenarios[scenario]}
          </button>
        ))}
        {running && (
          <button type="button" className="scenario-panel__button scenario-panel__stop" onClick={onStop}>
            {COPY.scenarios.stop}
          </button>
        )}
      </div>
      <dl className="scenario-panel__status">
        <div>
          <dt>{COPY.house.stateLabel}</dt>
          <dd data-testid="state-label">{COPY.house.states[deviceState]}</dd>
        </div>
        <div>
          <dt>{COPY.house.verdictLabel}</dt>
          <dd data-testid="verdict-label">{verdict === null ? COPY.house.noVerdict : COPY.verdicts[verdict]}</dd>
        </div>
      </dl>
    </section>
  );
}
