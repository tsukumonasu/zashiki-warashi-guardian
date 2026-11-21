import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiveRegion } from "../../src/components/LiveRegion";
import { Subtitle } from "../../src/components/Subtitle";
import { VirtualDoll, type DollView } from "../../src/components/VirtualDoll";

const view: DollView = {
  deviceState: "gazing",
  pan: 10,
  tilt: 0,
  panTarget: 20,
  tiltTarget: 0,
  lantern: 0.2,
  lanternTarget: 1,
  eye: "open",
};

function svg(): HTMLElement {
  return screen.getByRole("img");
}

describe("VirtualDoll", () => {
  it("has role img with the doll label", () => {
    render(<VirtualDoll view={view} reducedMotion={false} />);
    expect(svg().getAttribute("aria-label")).toBe(
      "Zashiki-warashi doll, state gazing, head turned right, lantern dim",
    );
  });

  it("draws current values normally and targets under reduced motion", () => {
    const { rerender } = render(<VirtualDoll view={view} reducedMotion={false} />);
    expect(svg().style.getPropertyValue("--doll-lantern")).toBe("0.200");
    rerender(<VirtualDoll view={view} reducedMotion={true} />);
    expect(svg().style.getPropertyValue("--doll-lantern")).toBe("1.000");
    expect(svg().getAttribute("data-reduced")).toBe("true");
  });

  it("draws the greeting pose for a real conversing state", () => {
    render(<VirtualDoll view={{ ...view, deviceState: "conversing" }} reducedMotion={false} />);
    expect(svg().getAttribute("data-pose")).toBe("greeting");
  });
});

describe("Subtitle and LiveRegion", () => {
  it("shows both languages and announces them politely", () => {
    const subtitle = { ja: "おかえり", en: "Welcome home" };
    render(
      <>
        <Subtitle subtitle={subtitle} />
        <LiveRegion stateLabel="greeting" subtitle={subtitle} />
      </>,
    );
    expect(screen.getByTestId("subtitle").textContent).toContain("Welcome home");
    const live = screen.getByTestId("live-subtitle");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("おかえり Welcome home");
    expect(screen.getByTestId("live-state").textContent).toBe("greeting");
  });
});
