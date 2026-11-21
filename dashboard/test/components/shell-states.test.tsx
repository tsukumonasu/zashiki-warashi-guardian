/**
 * Shell states (task 13.10): Reduced_Motion, the offline banner and the error boundary.
 *
 * Requirements 17.3, 17.4, 19.1, 19.3, 19.5.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import { COPY } from "../../src/content/copy";
import { FamilyPage } from "../../src/pages/Family";
import type { ScenarioId } from "../../src/simulation/types";
import { FakeApiClient } from "../helpers/FakeApiClient";
import { renderScenarioHouse } from "./scenarioHarness";

const control = vi.hoisted(() => ({ landingThrows: false }));

// The Landing page is the first child inside the error boundary, so it is the throwing child.
vi.mock("../../src/pages/Landing", () => ({
  Landing: () => {
    if (control.landingThrows) throw new Error("boom");
    return <p>landing</p>;
  },
}));

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => value });
}

function stubMatchMedia(reduce: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

beforeEach(() => {
  // No config.json: the app runs without cloud, which is all these tests need.
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  control.landingThrows = false;
  setOnLine(true);
  vi.restoreAllMocks();
});

const ALL_SCENARIOS: ScenarioId[] = ["family_home", "stranger_night", "nobody_there", "network_down"];

describe("Reduced_Motion", () => {
  async function runFamilyHome(reduce: boolean) {
    stubMatchMedia(reduce);
    const h = renderScenarioHouse();
    await h.start("family_home");
    const doll = screen.getByRole("img");
    const reducedFlag = doll.getAttribute("data-reduced");
    h.runUntilRest();
    const looping = document.querySelectorAll("animate, animateTransform, animateMotion, set").length;
    const inlineAnimation = doll.style.animation;
    return { h, reducedFlag, looping, inlineAnimation };
  }

  it("draws targets and shows no looping animation", async () => {
    const run = await runFamilyHome(true);
    expect(run.reducedFlag).toBe("true");
    expect(run.looping).toBe(0);
    expect(run.inlineAnimation).toBe("");
  });

  it("emits the same states, subtitles and Timeline entries as without reduced motion", async () => {
    const reduced = await runFamilyHome(true);
    const reducedSeen = {
      states: reduced.h.stateLabels,
      subtitles: reduced.h.subtitles,
      encounters: reduced.h.encounters().map((e) => ({ ...e })),
    };
    document.body.innerHTML = "";
    const normal = await runFamilyHome(false);
    expect(normal.reducedFlag).toBe("false");
    expect(reducedSeen.states).toEqual(normal.h.stateLabels);
    expect(reducedSeen.subtitles).toEqual(normal.h.subtitles);
    expect(reducedSeen.encounters).toEqual(normal.h.encounters().map((e) => ({ ...e })));
  });
});

describe("Offline banner", () => {
  it("is hidden while the browser is online", async () => {
    setOnLine(true);
    render(<App />);
    await act(async () => undefined);
    expect(screen.queryByText(COPY.shell.offlineBanner)).toBeNull();
  });

  it("shows the banner and disables the real-doll controls when navigator.onLine is false", async () => {
    setOnLine(false);
    const { container } = render(<App />);
    await act(async () => undefined);
    expect(screen.getByText(COPY.shell.offlineBanner)).toBeTruthy();
    const group = container.querySelector("fieldset.real-doll__group") as HTMLFieldSetElement;
    expect(group.disabled).toBe(true);
    const buttons = Array.from(group.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.matches(":disabled")).toBe(true);
  });

  it("disables the Live cloud switch in House when offline and enables it when online", () => {
    const api = new FakeApiClient();
    renderScenarioHouse({ api, role: "family", online: false });
    const sw = screen.getByRole("switch", { name: COPY.live.switchLabel }) as HTMLInputElement;
    expect(sw.disabled).toBe(true);
    expect(screen.getByText(COPY.shell.offlineLive)).toBeTruthy();
    cleanup();
    renderScenarioHouse({ api, role: "family" });
    const on = screen.getByRole("switch", { name: COPY.live.switchLabel }) as HTMLInputElement;
    expect(on.disabled).toBe(false);
    expect(screen.queryByText(COPY.shell.offlineLive)).toBeNull();
  });

  it("disables the face actions on FamilyPage when offline", async () => {
    const member = {
      memberId: "11111111-1111-4111-8111-111111111111",
      displayName: "Hana",
      createdAt: "2026-11-20T12:00:00.000Z",
      consentVersion: "1",
      faceCount: 1,
    };
    const api = new FakeApiClient()
      .script("me", {
        ok: true,
        value: { role: "family", consentNoticeVersion: "1", limits: { simulatePerHour: 10, generatePerHour: 5 } },
      })
      .script("faces", { ok: true, value: { members: [member] } });
    render(<FamilyPage api={api} role="family" online={false} />);
    await screen.findByText("Hana", { selector: ".face-name" });
    expect(screen.getByText(COPY.shell.offlineFaces)).toBeTruthy();
    expect((screen.getByRole("button", { name: COPY.family.register }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(COPY.family.photoLabel) as HTMLInputElement).disabled).toBe(true);
    const del = screen.getAllByRole("button").find((b) => b.textContent?.startsWith(COPY.family.delete));
    expect((del as HTMLButtonElement).disabled).toBe(true);
  });

  it("reacts to the offline and online events", async () => {
    setOnLine(true);
    render(<App />);
    await act(async () => undefined);
    act(() => {
      setOnLine(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByText(COPY.shell.offlineBanner)).toBeTruthy();
    act(() => {
      setOnLine(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByText(COPY.shell.offlineBanner)).toBeNull();
  });

  it.each(ALL_SCENARIOS)("still runs the %s scenario to rest while offline", async (scenario) => {
    setOnLine(false);
    const h = renderScenarioHouse();
    await h.start(scenario);
    h.runUntilRest();
    expect(h.timer.active()).toBe(false);
    expect(h.encounters()).toHaveLength(1);
    expect(h.stateLabels[h.stateLabels.length - 1]).toBe(COPY.house.states.sleeping);
  });
});

describe("Error boundary", () => {
  it("shows the recovery text and keeps the header, Mute_Control and Privacy_Indicator", async () => {
    control.landingThrows = true;
    // React reports a caught render error to the console; keep the test output clean.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container } = render(<App />);
    await act(async () => undefined);

    const alert = screen.getByText(COPY.shell.errorBoundary);
    expect(alert.closest("[role=alert]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();

    expect(container.querySelector("header.app-header")).not.toBeNull();
    expect(screen.getByRole("button", { name: COPY.shell.mute })).toBeTruthy();
    expect(container.querySelector(".privacy-indicator")).not.toBeNull();
  });

  it("does not show the recovery text when nothing throws", async () => {
    render(<App />);
    await act(async () => undefined);
    expect(screen.queryByText(COPY.shell.errorBoundary)).toBeNull();
  });
});
