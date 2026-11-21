/**
 * Live cloud component tests (task 13.7).
 * Requirements: 12.2, 12.3, 12.4, 12.6, 12.8, 12.9.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { COPY } from "../../src/content/copy";
import type { SimulateResponse } from "../../src/lib/api";
import familySample from "../../src/simulation/data/sample-responses/family.json";
import { FakeApiClient } from "../helpers/FakeApiClient";
import { renderScenarioHouse, timelineItemTexts } from "./scenarioHarness";

const SAMPLES = [
  { sampleId: "family_01", label: "family" as const },
  { sampleId: "stranger_01", label: "stranger" as const },
  { sampleId: "no_face_01", label: "no_face" as const },
];

function scriptedApi(): FakeApiClient {
  return new FakeApiClient()
    .script("samples", { ok: true, value: { samples: SAMPLES } })
    .script("simulate", { ok: true, value: familySample as unknown as SimulateResponse });
}

function liveSwitch(): HTMLElement {
  return screen.getByRole("switch", { name: COPY.live.switchLabel });
}

describe("House: Live cloud mode", () => {
  it("makes no simulate call while the switch is off", async () => {
    const api = scriptedApi();
    const h = renderScenarioHouse({ api, role: "family" });
    expect((liveSwitch() as HTMLInputElement).checked).toBe(false);

    await h.start("family_home");
    h.runUntilRest();

    expect(api.callsOf("simulate")).toHaveLength(0);
    expect(api.callsOf("samples")).toHaveLength(0);
    expect(h.encounters()[0]!.mode).toBe("simulation");
  });

  it("calls simulate once with generate false and the matching sampleId when on", async () => {
    const api = scriptedApi();
    const h = renderScenarioHouse({ api, role: "family" });
    await userEvent.click(liveSwitch());

    await h.start("family_home");
    await waitFor(() => expect(h.timer.active()).toBe(true));
    h.runUntilRest();

    expect(api.callsOf("simulate")).toHaveLength(1);
    expect(api.callsOf("simulate")[0]!.args).toEqual(["family_01", false]);
    expect(h.encounters()).toHaveLength(1);
    expect(h.encounters()[0]!.mode).toBe("live");
    expect(timelineItemTexts(h.timelineList())[0]).toContain(COPY.timeline.liveCloudLabel);
  });

  it("sends generate true when the tick box is ticked", async () => {
    const api = scriptedApi();
    const h = renderScenarioHouse({ api, role: "reviewer" });
    await userEvent.click(liveSwitch());
    await userEvent.click(screen.getByRole("checkbox", { name: COPY.live.generateLabel }));

    await h.start("family_home");
    await waitFor(() => expect(h.timer.active()).toBe(true));
    h.runUntilRest();

    expect(api.callsOf("simulate")).toHaveLength(1);
    expect(api.callsOf("simulate")[0]!.args).toEqual(["family_01", true]);
  });

  it("makes no cloud call for network_down, even with the switch on", async () => {
    const api = scriptedApi();
    const h = renderScenarioHouse({ api, role: "family" });
    await userEvent.click(liveSwitch());

    await h.start("network_down");
    await screen.findByText(COPY.live.networkDown);
    h.runUntilRest();

    expect(api.calls).toEqual([]);
  });

  it("shows the rate-limit message, offers Simulation mode and adds no Timeline entry", async () => {
    const api = scriptedApi().script("simulate", {
      ok: false,
      error: { code: "rate_limited", message: "slow down", retryAfterS: 42 },
    });
    const h = renderScenarioHouse({ api, role: "family" });
    await userEvent.click(liveSwitch());

    await h.start("family_home");

    expect(await screen.findByText(COPY.live.rateLimited(42))).toBeTruthy();
    expect(screen.getByRole("button", { name: COPY.live.runInSimulation })).toBeTruthy();
    expect(h.timer.active()).toBe(false);
    expect(h.encounters()).toHaveLength(0);
    expect(timelineItemTexts(h.timelineList())).toEqual([]);
    expect(api.callsOf("simulate")).toHaveLength(1); // never retried
  });

  it("shows the no-answer message on timeout and adds no Timeline entry", async () => {
    const api = scriptedApi().script("simulate", {
      ok: false,
      error: { code: "timeout", message: "The cloud did not answer in time." },
    });
    const h = renderScenarioHouse({ api, role: "family" });
    await userEvent.click(liveSwitch());

    await h.start("family_home");

    expect(await screen.findByText(COPY.live.noAnswer)).toBeTruthy();
    expect(h.timer.active()).toBe(false);
    expect(h.encounters()).toHaveLength(0);
    expect(api.callsOf("simulate")).toHaveLength(1);
  });
});
