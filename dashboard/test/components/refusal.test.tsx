/**
 * The dashboard shows why the doll refused a command (remote-feedback F2, F3), and disables the
 * look and lantern buttons while the doll rests.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPanel } from "../../src/components/ControlPanel";
import { RemoteActions } from "../../src/components/RemoteActions";
import { COPY } from "../../src/content/copy";
import { refusalMessage } from "../../src/lib/refusal";
import { FakeApiClient } from "../helpers/FakeApiClient";

afterEach(cleanup);

const DEVICE = "warashi-01";
const CMD = "11111111-1111-4111-8111-111111111111";
const REJECTED = { ok: true as const, value: { status: "rejected" as const, code: "command_rejected_state" } };
const PENDING = { ok: true as const, value: { status: "pending" as const } };

describe("ControlPanel refusals", () => {
  it("replaces 'sent' with the reason when the doll refuses the command", async () => {
    const api = new FakeApiClient()
      .script("command", { ok: true, value: { id: CMD, deviceOnline: true } })
      .script("commandResult", REJECTED);
    render(<ControlPanel api={api} role="family" deviceId={DEVICE} refusalPollMs={1} refusalWaitMs={200} />);
    await userEvent.click(screen.getByRole("button", { name: COPY.controls.sleep }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain(COPY.refusal.state));
    expect(api.callsOf("commandResult")[0]?.args).toEqual([CMD]);
  });

  it("keeps 'sent' when no refusal arrives", async () => {
    const api = new FakeApiClient()
      .script("command", { ok: true, value: { id: CMD, deviceOnline: true } })
      .script("commandResult", PENDING);
    render(<ControlPanel api={api} role="family" deviceId={DEVICE} refusalPollMs={1} refusalWaitMs={30} />);
    await userEvent.click(screen.getByRole("button", { name: COPY.controls.sleep }));
    await waitFor(() => expect(api.callsOf("commandResult").length).toBeGreaterThan(1));
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByRole("status").textContent).toContain(COPY.controls.sent);
  });

  it("does not ask an offline doll", async () => {
    const api = new FakeApiClient().script("command", { ok: true, value: { id: CMD, deviceOnline: false } });
    render(<ControlPanel api={api} role="family" deviceId={DEVICE} refusalPollMs={1} refusalWaitMs={30} />);
    await userEvent.click(screen.getByRole("button", { name: COPY.controls.sleep }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain(COPY.controls.offline));
    expect(api.callsOf("commandResult")).toHaveLength(0);
  });

  it.each(["sleeping", "cooldown"])("disables look and lantern while the doll is %s", (state) => {
    render(<ControlPanel api={new FakeApiClient()} role="family" deviceId={DEVICE} dollState={state} />);
    for (const name of [COPY.controls.lookLeft, COPY.controls.lookRight, "Set the lantern"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect((screen.getByRole("button", { name: COPY.controls.sleep }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(COPY.controls.restingHint)).toBeTruthy();
  });

  it("enables look and lantern during a visit", () => {
    render(<ControlPanel api={new FakeApiClient()} role="family" deviceId={DEVICE} dollState="seeking" />);
    expect((screen.getByRole("button", { name: COPY.controls.lookLeft }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(COPY.controls.restingHint)).toBeNull();
  });
});

describe("RemoteActions refusals", () => {
  it("stops waiting for a refused photo and says why", async () => {
    const api = new FakeApiClient()
      .script("photoRequest", { ok: true, value: { id: CMD, requestId: "req-1", deviceOnline: true } })
      .script("photo", { ok: true, value: { status: "pending" } })
      .script("commandResult", REJECTED);
    render(<RemoteActions api={api} deviceId={DEVICE} pollMs={1} waitMs={500} />);
    await userEvent.click(screen.getByRole("button", { name: COPY.remote.photoButton }));
    await screen.findByText(refusalMessage("command_rejected_state"));
    expect(api.callsOf("commandResult")[0]?.args).toEqual([CMD]);
    expect((screen.getByRole("button", { name: COPY.remote.photoButton }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("still waits for the picture when the cloud gives no command id", async () => {
    const api = new FakeApiClient()
      .script("photoRequest", { ok: true, value: { requestId: "req-1", deviceOnline: true } })
      .script("photo", { ok: true, value: { status: "pending" } });
    render(<RemoteActions api={api} deviceId={DEVICE} pollMs={1} waitMs={30} />);
    await userEvent.click(screen.getByRole("button", { name: COPY.remote.photoButton }));
    await screen.findByText(COPY.remote.photoTimeout);
    expect(api.callsOf("commandResult")).toHaveLength(0);
  });

  it("says why a typed line was refused", async () => {
    const api = new FakeApiClient()
      .script("say", { ok: true, value: { id: CMD, deviceOnline: true } })
      .script("commandResult", { ok: true, value: { status: "rejected", code: "audio_busy" } });
    render(<RemoteActions api={api} deviceId={DEVICE} refusalPollMs={1} refusalWaitMs={200} />);
    await userEvent.type(screen.getByRole("textbox"), "こんにちは");
    await userEvent.click(screen.getByRole("button", { name: COPY.remote.sayButton }));
    await screen.findByText(COPY.refusal.audioBusy);
  });
});

describe("remote control (remote-mode M1 to M3)", () => {
  it("starts remote control with mode.set remote and asks for the status again", async () => {
    const api = new FakeApiClient().script("command", { ok: true, value: { id: CMD, deviceOnline: true } });
    let refreshed = 0;
    render(
      <ControlPanel
        api={api}
        role="family"
        deviceId={DEVICE}
        dollState="sleeping"
        onSent={() => (refreshed += 1)}
        refusalPollMs={1}
        refusalWaitMs={10}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: COPY.controls.remoteStart }));
    await waitFor(() => expect(refreshed).toBe(1));
    expect(api.callsOf("command")[0]?.args[1]).toEqual({ type: "mode.set", data: { mode: "remote" } });
  });

  it("enables look and lantern and explains how remote control ends", () => {
    render(<ControlPanel api={new FakeApiClient()} role="family" deviceId={DEVICE} dollState="remote" />);
    expect((screen.getByRole("button", { name: COPY.controls.lookLeft }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(COPY.controls.remoteHint)).toBeTruthy();
    expect(screen.queryByText(COPY.controls.restingHint)).toBeNull();
  });
});
