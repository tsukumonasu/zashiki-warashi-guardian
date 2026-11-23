import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ControlPanel } from "../../src/components/ControlPanel";
import { DevicePanel } from "../../src/components/DevicePanel";
import { COPY } from "../../src/content/copy";
import { POLL_INTERVAL_MS, useDeviceStatus } from "../../src/hooks/useDeviceStatus";
import type { CommandResponse, DeviceStatusResponse } from "../../src/lib/api";
import type { StatusReportData } from "../../src/simulation/types";
import { FakeApiClient } from "../helpers/FakeApiClient";

function report(motionEnabled: boolean): StatusReportData {
  return {
    state: "sleeping",
    mode: "guard",
    panDeg: 5,
    tiltDeg: -3,
    lantern: 0.5,
    cameraActive: false,
    micActive: false,
    motionEnabled,
    uptimeSec: 10,
    agentVersion: "test",
  };
}

function statusResponse(online: boolean, motionEnabled = true): DeviceStatusResponse {
  return {
    deviceId: "warashi-01",
    online,
    lastSeenAt: online ? "2026-11-20T12:00:00.000Z" : null,
    status: online ? report(motionEnabled) : null,
  };
}

describe("DevicePanel", () => {
  it("shows the connection and the doll's activity as separate lines when online", () => {
    render(<DevicePanel role="family" response={statusResponse(true)} />);
    expect(screen.getByText(COPY.device.connected)).toBeTruthy();
    expect(screen.getByText(COPY.house.states.sleeping)).toBeTruthy();
    expect(screen.getByText(COPY.device.modeGuard)).toBeTruthy();
    expect(screen.queryByText("sleeping")).toBeNull();
    expect(screen.queryByText(COPY.device.motionOff)).toBeNull();
  });

  it("shows the out-of-reach text when offline or unknown", () => {
    const { rerender } = render(<DevicePanel role="family" response={statusResponse(false)} />);
    expect(screen.getByText(COPY.device.outOfReach)).toBeTruthy();
    expect(screen.getByText(`${COPY.device.lastSeen}: ${COPY.device.neverSeen}`)).toBeTruthy();
    rerender(<DevicePanel role="family" response={null} />);
    expect(screen.getByText(COPY.device.outOfReach)).toBeTruthy();
  });

  it("describes the head and the lantern in words", () => {
    render(<DevicePanel role="family" response={statusResponse(true)} />);
    const d = COPY.device;
    expect(screen.getByText(`${d.right} 5° / ${d.down} 3°`)).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
  });
  it("shows the motion notice only when motionEnabled is false", () => {
    render(<DevicePanel role="family" response={statusResponse(true, false)} />);
    expect(screen.getByText(COPY.device.motionOff)).toBeTruthy();
  });

  it("shows a locked panel to a visitor", () => {
    render(<DevicePanel role="visitor" response={statusResponse(true)} />);
    expect(screen.queryByText(COPY.device.connected)).toBeNull();
    expect(screen.getAllByText(COPY.locked.visitor).length).toBeGreaterThan(0);
  });
});

describe("useDeviceStatus polling", () => {
  function setup(enabled: boolean, visible: () => boolean) {
    const api = new FakeApiClient().script("deviceStatus", { ok: true, value: statusResponse(true) });
    let tick: () => void = () => {};
    let intervalMs = 0;
    let stopped = false;
    const setRepeating = (fn: () => void, ms: number) => {
      tick = fn;
      intervalMs = ms;
      return () => {
        stopped = true;
      };
    };
    const hook = renderHook(() => useDeviceStatus({ api, enabled, setRepeating, isVisible: visible }));
    return { api, hook, fire: () => tick(), interval: () => intervalMs, stopped: () => stopped };
  }

  it("polls once on open, then on each 30 s tick while visible", async () => {
    let visible = true;
    const s = setup(true, () => visible);
    await waitFor(() => expect(s.hook.result.current.statusFetch.kind).toBe("ok"));
    expect(s.interval()).toBe(POLL_INTERVAL_MS);
    expect(s.api.callsOf("deviceStatus")).toHaveLength(1);

    await act(async () => s.fire());
    expect(s.api.callsOf("deviceStatus")).toHaveLength(2);

    visible = false;
    await act(async () => s.fire());
    expect(s.api.callsOf("deviceStatus")).toHaveLength(2);

    s.hook.unmount();
    expect(s.stopped()).toBe(true);
  });

  it("does not poll when disabled", () => {
    const s = setup(false, () => true);
    expect(s.api.callsOf("deviceStatus")).toHaveLength(0);
    expect(s.hook.result.current.statusFetch.kind).toBe("none");
  });

  it("reports failed when the call fails", async () => {
    const api = new FakeApiClient().script("deviceStatus", {
      ok: false,
      error: { code: "internal", message: "x" },
    });
    const { result } = renderHook(() =>
      useDeviceStatus({ api, enabled: true, setRepeating: () => () => {}, isVisible: () => true }),
    );
    await waitFor(() => expect(result.current.statusFetch.kind).toBe("failed"));
    expect(result.current.response).toBeNull();
  });
});

describe("ControlPanel", () => {
  function deferred() {
    let resolve!: (v: { ok: true; value: CommandResponse }) => void;
    const promise = new Promise<{ ok: true; value: CommandResponse }>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("sends one POST /commands per activation and shows the sent message", async () => {
    const api = new FakeApiClient().script("command", {
      ok: true,
      value: { id: "11111111-1111-4111-8111-111111111111", deviceOnline: true },
    });
    render(<ControlPanel api={api} role="family" deviceId="warashi-01" />);
    await userEvent.click(screen.getByRole("button", { name: COPY.controls.lookLeft }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain(COPY.controls.sent));
    expect(api.callsOf("command")).toHaveLength(1);
    expect(api.callsOf("command")[0]?.args[0]).toBe("warashi-01");

    await userEvent.click(screen.getByRole("button", { name: COPY.controls.sleep }));
    await waitFor(() => expect(api.callsOf("command")).toHaveLength(2));
  });

  it("shows the offline message when deviceOnline is false", async () => {
    const api = new FakeApiClient().script("command", {
      ok: true,
      value: { id: "11111111-1111-4111-8111-111111111111", deviceOnline: false },
    });
    render(<ControlPanel api={api} role="family" deviceId="warashi-01" />);
    await userEvent.click(screen.getByRole("button", { name: COPY.controls.wake }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain(COPY.controls.offline));
  });

  it("disables the controls while a command is pending", async () => {
    const d = deferred();
    const api = new FakeApiClient().script("command", () => d.promise);
    render(<ControlPanel api={api} role="family" deviceId="warashi-01" />);
    const left = screen.getByRole("button", { name: COPY.controls.lookLeft }) as HTMLButtonElement;
    await userEvent.click(left);
    await waitFor(() => expect(left.disabled).toBe(true));
    expect((screen.getByRole("button", { name: COPY.controls.lookRight }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.callsOf("command")).toHaveLength(1);

    await act(async () => d.resolve({ ok: true, value: { id: "x", deviceOnline: true } }));
    await waitFor(() => expect(left.disabled).toBe(false));
  });

  it("does not retry automatically after a failure", async () => {
    const api = new FakeApiClient().script("command", {
      ok: false,
      error: { code: "internal", message: "x" },
    });
    render(<ControlPanel api={api} role="family" deviceId="warashi-01" />);
    await userEvent.click(screen.getByRole("button", { name: COPY.controls.lookRight }));
    await waitFor(() => expect(screen.getByRole("button", { name: COPY.controls.tryAgain })).toBeTruthy());
    expect(api.callsOf("command")).toHaveLength(1);
  });

  it("gives reviewers locked controls that send nothing", async () => {
    const api = new FakeApiClient();
    render(<ControlPanel api={api} role="reviewer" deviceId="warashi-01" />);
    const sleep = screen.getByRole("button", { name: COPY.controls.sleep });
    expect(sleep.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(sleep);
    expect(api.callsOf("command")).toHaveLength(0);
  });
});
