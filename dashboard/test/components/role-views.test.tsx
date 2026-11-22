import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ControlPanel } from "../../src/components/ControlPanel";
import { DevicePanel } from "../../src/components/DevicePanel";
import { COPY } from "../../src/content/copy";
import { FamilyPage } from "../../src/pages/Family";
import { Timeline } from "../../src/pages/Timeline";
import type { Role } from "../../src/lib/roles";
import type { Encounter } from "../../src/simulation/types";
import { FakeApiClient } from "../helpers/FakeApiClient";

const ENCOUNTER_ID = "c1d2e3f4-0000-4000-8000-000000000001";
const BASE = "/illustrations";

function encounter(over: Partial<Encounter>): Encounter {
  return {
    encounterId: ENCOUNTER_ID,
    deviceId: "warashi-01",
    startedAt: "2026-11-20T12:34:56.789Z",
    endedAt: "2026-11-20T12:35:30.100Z",
    state: "cooldown",
    verdict: "stranger",
    confidence: 0.97,
    reaction: { kind: "stranger", lineId: "stranger_first", offline: false },
    notified: true,
    snapshot: null,
    illustration: null,
    events: [],
    ...over,
  };
}

const FAMILY_ENCOUNTER = encounter({
  snapshot: { url: "https://example.invalid/signed", expiresAt: "2026-11-20T12:40:00.000Z" },
});
const REVIEWER_ENCOUNTER = encounter({ illustration: "silhouette-stranger" });

function apiFor(e: Encounter): FakeApiClient {
  return new FakeApiClient()
    .script("encounters", { ok: true, value: { items: [{ ...e }], nextCursor: null } })
    .script("encounter", { ok: true, value: e })
    .script("faces", { ok: true, value: { members: [] } })
    .script("me", { ok: true, value: { role: "family", consentNoticeVersion: "1", limits: { simulatePerHour: 5, generatePerHour: 5 } } })
    .script("command", { ok: true, value: { id: "x", deviceOnline: true } });
}

async function openFirstEncounter(): Promise<void> {
  const user = userEvent.setup();
  // Each table row holds the verdict in one cell and the open button in another.
  const real = await waitFor(() => {
    const found = screen
      .getAllByRole("button", { expanded: false })
      .find((b) => b.closest("tr")?.textContent?.includes("Stranger"));
    if (!found) throw new Error("entry not loaded yet");
    return found;
  });
  expect(real).toBeDefined();
  await user.click(real!);
  await screen.findByLabelText("Encounter detail");
}

describe("Visitor view", () => {
  const role: Role = "visitor";

  it("locks the device panel, the controls, the real timeline and the family page", async () => {
    const api = apiFor(FAMILY_ENCOUNTER);
    const { container } = render(
      <>
        <DevicePanel role={role} response={null} />
        <ControlPanel api={api} role={role} deviceId="warashi-01" />
        <Timeline api={api} role={role} illustrationBase={BASE} simulated={[]} />
        <FamilyPage api={api} role={role} />
      </>,
    );
    const lockedTexts = container.querySelectorAll(".locked-explanation");
    expect(lockedTexts.length).toBeGreaterThan(0);
    for (const el of lockedTexts) expect(el.textContent).toBe("Sign in to see the real doll.");
    expect(screen.getAllByText(COPY.locked.visitor).length).toBeGreaterThanOrEqual(4);
    for (const b of container.querySelectorAll("button.locked-control")) {
      expect(b.getAttribute("aria-disabled")).toBe("true");
    }
    expect(api.calls).toEqual([]);
  });
});

describe("Reviewer view", () => {
  const role: Role = "reviewer";

  it("shows Locked_Controls with aria-disabled and sends no command when activated", async () => {
    const api = apiFor(REVIEWER_ENCOUNTER);
    const user = userEvent.setup();
    const { container } = render(<ControlPanel api={api} role={role} deviceId="warashi-01" />);
    const locked = Array.from(container.querySelectorAll("button.locked-control"));
    expect(locked.length).toBeGreaterThan(0);
    for (const b of locked) {
      expect(b.getAttribute("aria-disabled")).toBe("true");
      expect(b.getAttribute("aria-describedby")).not.toBeNull();
      await user.click(b);
    }
    expect(api.callsOf("command")).toHaveLength(0);
    expect(api.calls).toEqual([]);
  });

  it("shows a silhouette, no snapshot, no face box and no member data in a real encounter", async () => {
    const api = apiFor(REVIEWER_ENCOUNTER);
    const { container } = render(<Timeline api={api} role={role} illustrationBase={BASE} simulated={[]} />);
    await openFirstEncounter();
    const img = await screen.findByAltText("Illustration of the visit");
    expect(img.getAttribute("src")).toBe(`${BASE}/silhouette-stranger.svg`);
    expect(screen.queryByAltText("Snapshot taken by the doll")).toBeNull();
    expect(container.querySelector("img[src*='example.invalid']")).toBeNull();
    expect(container.textContent ?? "").not.toMatch(/faceCount|displayName|memberId|jpegBase64/);
  });

  it("locks the family page and makes no /faces request", async () => {
    const api = apiFor(REVIEWER_ENCOUNTER);
    const { container } = render(<FamilyPage api={api} role={role} />);
    expect(screen.getAllByText(COPY.family.lockedFaces).length).toBeGreaterThan(0);
    for (const b of container.querySelectorAll("button.locked-control")) {
      expect(b.getAttribute("aria-disabled")).toBe("true");
    }
    expect(container.querySelector("input[type=file]")).toBeNull();
    expect(api.callsOf("faces")).toHaveLength(0);
    expect(api.callsOf("faceUpload")).toHaveLength(0);
    expect(api.callsOf("faceRegister")).toHaveLength(0);
    expect(api.callsOf("faceDelete")).toHaveLength(0);
  });
});

describe("Family view", () => {
  const role: Role = "family";

  it("shows the snapshot thumbnail in a real encounter", async () => {
    const api = apiFor(FAMILY_ENCOUNTER);
    render(<Timeline api={api} role={role} illustrationBase={BASE} simulated={[]} />);
    await openFirstEncounter();
    const img = await screen.findByAltText("Snapshot taken by the doll");
    expect(img.getAttribute("src")).toBe("https://example.invalid/signed");
    expect(screen.queryByAltText("Illustration of the visit")).toBeNull();
  });

  it("enables the Control_Panel and sends one command per activation", async () => {
    const api = apiFor(FAMILY_ENCOUNTER);
    const user = userEvent.setup();
    const { container } = render(<ControlPanel api={api} role={role} deviceId="warashi-01" />);
    expect(container.querySelector("button.locked-control")).toBeNull();
    const left = screen.getByRole("button", { name: COPY.controls.lookLeft });
    expect(left.hasAttribute("disabled")).toBe(false);
    expect(left.getAttribute("aria-disabled")).toBeNull();
    await user.click(left);
    await waitFor(() => expect(api.callsOf("command")).toHaveLength(1));
  });
});
