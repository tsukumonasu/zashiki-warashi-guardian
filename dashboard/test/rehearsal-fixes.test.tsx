/**
 * Fixes from the remote-control rehearsal (11/23 to 11/24): a failed status read keeps the last
 * values, the mode and camera show remote use, times are Japan time, and the control panel uses
 * plain words.
 */
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPanel } from "../src/components/ControlPanel";
import { DevicePanel } from "../src/components/DevicePanel";
import { RemoteActions } from "../src/components/RemoteActions";
import { COPY, copyFor, setLanguage } from "../src/content/copy";
import { useDeviceStatus } from "../src/hooks/useDeviceStatus";
import type { DeviceStatusResponse } from "../src/lib/api";
import { formatJst } from "../src/lib/time";
import { indicatorView } from "../src/simulation/indicator";
import type { StatusReportData } from "../src/simulation/types";
import { FakeApiClient } from "./helpers/FakeApiClient";

afterEach(() => {
  cleanup();
  setLanguage("en");
});

function report(over: Partial<StatusReportData> = {}): StatusReportData {
  return {
    state: "remote",
    mode: "guard",
    panDeg: 0,
    tiltDeg: 0,
    lantern: 0.8,
    cameraActive: false,
    micActive: false,
    motionEnabled: true,
    uptimeSec: 10,
    agentVersion: "test",
    ...over,
  };
}
const online = (s: StatusReportData): DeviceStatusResponse => ({
  deviceId: "warashi-01",
  online: true,
  lastSeenAt: "2026-11-23T13:51:04.123Z",
  status: s,
});

describe("status that fails to load", () => {
  it("keeps the last response and says the data may be old", async () => {
    const api = new FakeApiClient();
    let n = 0;
    api.script("deviceStatus", () =>
      Promise.resolve(
        ++n === 1
          ? { ok: true as const, value: online(report()) }
          : { ok: false as const, error: { code: "internal" as const, message: "x" } },
      ),
    );
    let tick: () => void = () => {};
    const { result } = renderHook(() =>
      useDeviceStatus({
        api,
        enabled: true,
        setRepeating: (fn) => {
          tick = fn;
          return () => {};
        },
        isVisible: () => true,
      }),
    );
    await waitFor(() => expect(result.current.response?.online).toBe(true));
    tick();
    await waitFor(() => expect(result.current.loadFailed).toBe(true));
    expect(result.current.response?.online).toBe(true);
    expect(result.current.statusFetch.kind).toBe("failed");
  });

  it("never says 'never seen' for a read that failed", () => {
    render(<DevicePanel role="family" response={null} loadFailed />);
    expect(screen.getByText(COPY.device.loadFailedNothing)).toBeTruthy();
    expect(screen.queryByText(COPY.device.neverSeen, { exact: false })).toBeNull();
  });

  it("keeps showing the old values next to the warning", () => {
    render(<DevicePanel role="family" response={online(report({ lantern: 1 }))} loadFailed />);
    expect(screen.getByText(COPY.device.loadFailed)).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();
  });
});

describe("mode and camera during remote use", () => {
  it("shows remote control as the mode", () => {
    render(<DevicePanel role="family" response={online(report({ state: "remote" }))} />);
    expect(screen.getByText(COPY.device.modeRemote)).toBeTruthy();
    expect(screen.queryByText(COPY.device.modeGuard)).toBeNull();
  });

  it("shows the camera as on while a photo is awaited, even when the doll has not reported it", () => {
    const off = { kind: "ok", online: true, status: report() } as const;
    expect(indicatorView(off).kind).toBe("off");
    expect(indicatorView(off, true)).toEqual({ kind: "active", parts: ["Camera on"] });
    expect(indicatorView({ kind: "failed" }, true).kind).toBe("active");
  });

  it("tells the page while a photo is on its way", async () => {
    const api = new FakeApiClient();
    api.script("photoRequest", { ok: true, value: { id: "c1", requestId: "r1", deviceOnline: true } });
    api.script("photo", { ok: true, value: { status: "ready", url: "https://example.invalid/p.jpg", expiresAt: "x" } });
    api.script("commandResult", { ok: true, value: { status: "pending" } });
    const seen: boolean[] = [];
    render(<RemoteActions api={api} deviceId="warashi-01" pollMs={1} onWaiting={(w) => seen.push(w)} />);
    await userEvent.click(screen.getByRole("button", { name: COPY.remote.photoButton }));
    await waitFor(() => expect(screen.getByText(COPY.remote.photoReady)).toBeTruthy());
    expect(seen).toContain(true);
    expect(seen.at(-1)).toBe(false);
  });
});

describe("Japan time", () => {
  it("shows UTC times as Japan time without a zone letter", () => {
    expect(formatJst("2026-11-23T13:51:04.123Z")).toBe("2026-11-23 22:51:04");
    expect(formatJst("2026-11-23T15:00:00.000Z")).toBe("2026-11-24 00:00:00");
  });
  it("returns text that is not a time as it is", () => {
    expect(formatJst("never")).toBe("never");
  });
});

describe("control panel wording", () => {
  it("shows no internal ids and has nothing chosen at first", () => {
    setLanguage("ja");
    render(<ControlPanel api={new FakeApiClient()} role="family" deviceId="warashi-01" />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("");
    for (const option of Array.from(select.options)) expect(option.textContent).not.toMatch(/[a-z]+_[a-z_]+:/);
    expect((screen.getByRole("button", { name: COPY.controls.lineSay }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Say it")).toBeNull();
  });

  it("uses 行灯 and never ランタン in Japanese", () => {
    const text = JSON.stringify(copyFor("ja"));
    expect(text).not.toContain("ランタン");
    expect(text).not.toContain("リアルの人形");
    expect(text).not.toContain("家に入る");
  });

  it("names the page like the navigation", () => {
    for (const lang of ["en", "ja"] as const) {
      const c = copyFor(lang);
      expect(c.shell.realDollHeading).toBe(c.shell.nav.doll);
    }
  });

  it("keeps the doll's mode words apart from the resting state words", () => {
    const ja = copyFor("ja");
    expect(ja.house.states.sleeping).not.toContain("眠");
    expect(ja.controls.sleep).toBe("見張りを休ませる");
  });
});
