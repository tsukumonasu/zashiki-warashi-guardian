import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PrivacyIndicator } from "../../src/components/PrivacyIndicator";
import { INDICATOR_TEXT, type StatusFetch } from "../../src/simulation/indicator";
import type { StatusReportData } from "../../src/simulation/types";

function report(cameraActive: boolean, micActive: boolean): StatusReportData {
  return {
    state: "sleeping",
    mode: "guard",
    panDeg: 0,
    tiltDeg: 0,
    lantern: 0,
    cameraActive,
    micActive,
    motionEnabled: false,
    uptimeSec: 10,
    agentVersion: "test",
  };
}

function okFetch(cameraActive: boolean, micActive: boolean): StatusFetch {
  return { kind: "ok", online: true, status: report(cameraActive, micActive) };
}

describe("PrivacyIndicator", () => {
  it("shows the simulation text for a visitor with no status fetch", () => {
    render(<PrivacyIndicator statusFetch={{ kind: "none" }} />);
    const indicator = screen.getByRole("status");
    expect(indicator.textContent).toContain(INDICATOR_TEXT.simulation);
    expect(indicator.getAttribute("data-kind")).toBe("simulation");
    expect(indicator.hidden).toBe(false);
    expect(indicator.getAttribute("aria-hidden")).toBeNull();
    expect(indicator.style.display).not.toBe("none");
    expect(screen.getAllByText(INDICATOR_TEXT.simulation, { exact: false })).toHaveLength(1);
  });

  it("shows the unknown text when the status call failed", () => {
    render(<PrivacyIndicator statusFetch={{ kind: "failed" }} />);
    const indicator = screen.getByRole("status");
    expect(indicator.textContent).toContain("Camera and microphone state unknown");
    expect(indicator.getAttribute("data-kind")).toBe("unknown");
    expect(indicator.hidden).toBe(false);
  });

  it("shows the off text only for an online doll with both flags false", () => {
    render(<PrivacyIndicator statusFetch={okFetch(false, false)} />);
    const indicator = screen.getByRole("status");
    expect(indicator.textContent).toContain("Camera off, microphone off");
    expect(indicator.getAttribute("data-kind")).toBe("off");
  });

  it("shows only the camera text when only the camera is active", () => {
    render(<PrivacyIndicator statusFetch={okFetch(true, false)} />);
    const indicator = screen.getByRole("status");
    expect(indicator.textContent).toContain("Camera on");
    expect(indicator.textContent).not.toContain("Microphone on");
    expect(indicator.textContent).not.toContain("Camera off");
  });

  it("shows only the microphone text when only the microphone is active", () => {
    render(<PrivacyIndicator statusFetch={okFetch(false, true)} />);
    const indicator = screen.getByRole("status");
    expect(indicator.textContent).toContain("Microphone on");
    expect(indicator.textContent).not.toContain("Camera on");
  });

  it("pairs every state with a visible symbol next to its text", () => {
    const fetches: StatusFetch[] = [
      { kind: "none" },
      { kind: "failed" },
      okFetch(false, false),
      okFetch(true, true),
    ];
    for (const statusFetch of fetches) {
      const { container, unmount } = render(<PrivacyIndicator statusFetch={statusFetch} />);
      const symbols = container.querySelectorAll(".privacy-symbol");
      expect(symbols.length).toBeGreaterThan(0);
      for (const symbol of symbols) {
        expect(symbol.textContent?.trim()).not.toBe("");
        expect(symbol.getAttribute("aria-hidden")).toBe("true");
      }
      expect(screen.getByRole("status").textContent?.replace(/[◉●○?◇]/g, "").trim()).not.toBe("");
      unmount();
    }
  });

  it("shows both texts when camera and microphone are active", () => {
    render(<PrivacyIndicator statusFetch={okFetch(true, true)} />);
    const indicator = screen.getByRole("status");
    expect(indicator.textContent).toContain("Camera on");
    expect(indicator.textContent).toContain("Microphone on");
  });
});
