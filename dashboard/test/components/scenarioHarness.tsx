/**
 * Harness for the scenario component tests (tasks 13.1 to 13.4).
 *
 * Renders `House` with a manual clock, a `FakePlayer` and a timer that fires only when told to,
 * so no real time passes. `runUntilRest` advances all three in 50 ms steps and records what the
 * page showed after each step. The simulated Timeline entries that `House` reports through
 * `onEncounters` are rendered with `TimelineList`, as the Timeline page does.
 */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { TimelineList } from "../../src/components/TimelineList";
import { COPY } from "../../src/content/copy";
import { House, type HouseProps } from "../../src/pages/House";
import { TICK_MS, type Timer } from "../../src/hooks/useScenarioRunner";
import { createManualClock, type Clock } from "../../src/lib/clock";
import type { ScenarioId, SimEncounter } from "../../src/simulation/types";
import { FakePlayer } from "../helpers/fakePlayer";

/** A timer that fires only when the test says so. */
export interface FakeTimer extends Timer {
  fire(): void;
  active(): boolean;
}

export function createFakeTimer(): FakeTimer {
  let fn: (() => void) | null = null;
  return {
    setInterval: (f) => {
      fn = f;
      return 1;
    },
    clearInterval: () => {
      fn = null;
    },
    fire: () => fn?.(),
    active: () => fn !== null,
  };
}

/** What the page showed at one moment. */
export interface Frame {
  state: string;
  verdict: string;
  subtitle: { ja: string; en: string } | null;
}

export interface Harness {
  clock: Clock & { advance(ms: number): void };
  player: FakePlayer;
  timer: FakeTimer;
  /** Distinct consecutive state labels seen so far, starting with the label at render time. */
  stateLabels: string[];
  /** Every distinct non-empty subtitle seen, in order. */
  subtitles: { ja: string; en: string }[];
  /** Every frame recorded, including the one at render time. */
  frames: Frame[];
  /** Latest encounters reported through `onEncounters`. */
  encounters(): readonly SimEncounter[];
  /** Clicks the button of a scenario (by its visible text). */
  start(scenario: ScenarioId): Promise<void>;
  /** Reads the page now and records it. */
  snapshot(): Frame;
  /** Advances time in 50 ms steps until the engine stops running, or fails after `maxSteps`. */
  runUntilRest(maxSteps?: number): Frame[];
  /** The simulated Timeline list as rendered. */
  timelineList(): HTMLElement;
}

/** Wrapper that renders House plus the simulated Timeline list. */
function Page(props: HouseProps & { sink: (e: readonly SimEncounter[]) => void }): ReactElement {
  const { sink, onEncounters, ...house } = props;
  const [items, setItems] = useState<readonly SimEncounter[]>([]);
  return (
    <>
      <House
        {...house}
        onEncounters={(e) => {
          sink(e);
          setItems(e);
          onEncounters?.(e);
        }}
      />
      <TimelineList
        heading={COPY.timeline.simulatedHeading}
        items={items}
        emptyText={COPY.timeline.empty}
        onOpen={() => undefined}
      />
    </>
  );
}

export function renderScenarioHouse(overrides: Partial<HouseProps> = {}): Harness {
  const clock = createManualClock(1_000_000);
  const player = new FakePlayer();
  const timer = createFakeTimer();
  let latest: readonly SimEncounter[] = [];

  render(<Page clock={clock} player={player} timer={timer} sink={(e) => (latest = e)} {...overrides} />);

  const frames: Frame[] = [];
  const stateLabels: string[] = [];
  const subtitles: { ja: string; en: string }[] = [];

  function snapshot(): Frame {
    const box = screen.getByTestId("subtitle");
    const ja = box.querySelector(".subtitle__ja")?.textContent ?? "";
    const en = box.querySelector(".subtitle__en")?.textContent ?? "";
    const frame: Frame = {
      state: screen.getByTestId("state-label").textContent ?? "",
      verdict: screen.getByTestId("verdict-label").textContent ?? "",
      subtitle: ja === "" && en === "" ? null : { ja, en },
    };
    frames.push(frame);
    if (stateLabels[stateLabels.length - 1] !== frame.state) stateLabels.push(frame.state);
    const last = subtitles[subtitles.length - 1];
    if (frame.subtitle && (last?.ja !== frame.subtitle.ja || last?.en !== frame.subtitle.en)) {
      subtitles.push(frame.subtitle);
    }
    return frame;
  }
  snapshot();

  return {
    clock,
    player,
    timer,
    stateLabels,
    subtitles,
    frames,
    encounters: () => latest,
    async start(scenario) {
      await userEvent.click(screen.getByRole("button", { name: COPY.scenarios[scenario] }));
      snapshot();
    },
    snapshot,
    runUntilRest(maxSteps = 4000) {
      const seen: Frame[] = [];
      for (let i = 0; i < maxSteps; i++) {
        act(() => {
          clock.advance(TICK_MS);
          player.advance(TICK_MS);
          timer.fire();
        });
        seen.push(snapshot());
        if (!timer.active()) return seen;
      }
      throw new Error(`scenario did not reach rest within ${maxSteps} steps of ${TICK_MS} ms`);
    },
    timelineList() {
      return screen.getByRole("region", { name: COPY.timeline.simulatedHeading });
    },
  };
}

/** Text of the entries (table rows) of the simulated Timeline list. */
export function timelineItemTexts(list: HTMLElement): string[] {
  return within(list)
    .queryAllByRole("row")
    .slice(1) // the header row
    .map((row) => row.textContent ?? "");
}
