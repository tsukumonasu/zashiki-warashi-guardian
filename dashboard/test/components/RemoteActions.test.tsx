import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteActions } from "../../src/components/RemoteActions";
import { COPY } from "../../src/content/copy";
import type { ApiError, PhotoStatus } from "../../src/lib/api";
import { RealDollPage } from "../../src/pages/RealDoll";
import { FakeApiClient } from "../helpers/FakeApiClient";

afterEach(cleanup);

const DEVICE = "warashi-01";
const URL = "https://example.invalid/photo.jpg";

function err(code: ApiError["code"], retryAfterS?: number): { ok: false; error: ApiError } {
  return { ok: false, error: { code, message: "x", ...(retryAfterS === undefined ? {} : { retryAfterS }) } };
}

function setup(photos: PhotoStatus[] = [{ status: "ready", url: URL, expiresAt: "2026-11-20T12:05:00.000Z" }]) {
  const api = new FakeApiClient();
  api.script("photoRequest", { ok: true, value: { requestId: "req-1", deviceOnline: true } });
  const queue = [...photos];
  api.script("photo", () => {
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return Promise.resolve({ ok: true as const, value: next });
  });
  api.script("say", { ok: true, value: { id: "cmd-1", deviceOnline: true } });
  render(<RemoteActions api={api} deviceId={DEVICE} pollMs={1} waitMs={200} />);
  return api;
}

describe("take a photo", () => {
  it("asks for a photo and shows it once the cloud has it", async () => {
    const api = setup([{ status: "pending" }, { status: "pending" }, { status: "ready", url: URL, expiresAt: "x" }]);
    await userEvent.click(screen.getByRole("button", { name: COPY.remote.photoButton }));
    const img = await screen.findByRole("img", { name: COPY.remote.photoAlt });
    expect(img.getAttribute("src")).toBe(URL);
    expect(api.callsOf("photoRequest")[0]?.args).toEqual([DEVICE]);
    expect(api.callsOf("photo").length).toBeGreaterThanOrEqual(3);
    expect(api.callsOf("photo")[0]?.args).toEqual(["req-1"]);
  });

  it("sends one request even when clicked twice quickly", async () => {
    const api = setup();
    const button = screen.getByRole("button", { name: COPY.remote.photoButton });
    await userEvent.dblClick(button);
    await screen.findByRole("img");
    expect(api.callsOf("photoRequest")).toHaveLength(1);
  });

  it("does not wait for an offline doll", async () => {
    const api = setup();
    api.script("photoRequest", { ok: true, value: { requestId: "req-2", deviceOnline: false } });
    await userEvent.click(screen.getByRole("button", { name: COPY.remote.photoButton }));
    await screen.findByText(COPY.remote.offline);
    expect(api.callsOf("photo")).toHaveLength(0);
  });

  it("gives up after the wait time", async () => {
    setup([{ status: "pending" }]);
    await userEvent.click(screen.getByRole("button", { name: COPY.remote.photoButton }));
    await screen.findByText(COPY.remote.photoTimeout);
    expect(screen.getByRole("button", { name: COPY.remote.photoButton })).toBeTruthy();
  });

  it("explains a failed request and a rate limit", async () => {
    const api = setup();
    api.script("photoRequest", err("internal"));
    await userEvent.click(screen.getByRole("button", { name: COPY.remote.photoButton }));
    await screen.findByText(COPY.remote.photoFailed);
    api.script("photoRequest", err("rate_limited", 90));
    await userEvent.click(screen.getByRole("button", { name: COPY.remote.photoButton }));
    await screen.findByText(COPY.remote.limited(90));
  });
});

describe("make the doll speak", () => {
  it("sends the trimmed text and clears the field", async () => {
    const api = setup();
    const input = screen.getByLabelText(COPY.remote.sayLabel) as HTMLInputElement;
    await userEvent.type(input, "  そこで なにをしているの？ ");
    await userEvent.click(screen.getByRole("button", { name: COPY.remote.sayButton }));
    await screen.findByText(COPY.remote.saySent);
    expect(api.callsOf("say")[0]?.args).toEqual([DEVICE, "そこで なにをしているの？"]);
    expect(input.value).toBe("");
  });

  it("keeps the button off while the field is empty", () => {
    setup();
    expect((screen.getByRole("button", { name: COPY.remote.sayButton }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("limits the field to 60 characters", () => {
    setup();
    expect((screen.getByLabelText(COPY.remote.sayLabel) as HTMLInputElement).maxLength).toBe(60);
  });

  it("shows the reason when the cloud refuses the text", async () => {
    const api = setup();
    api.script("say", err("validation_failed"));
    await userEvent.type(screen.getByLabelText(COPY.remote.sayLabel), "ころす");
    await userEvent.click(screen.getByRole("button", { name: COPY.remote.sayButton }));
    await screen.findByText(COPY.remote.sayInvalid);
  });

  it("says the request was not stored when the doll is offline", async () => {
    const api = setup();
    api.script("say", { ok: true, value: { id: "cmd-2", deviceOnline: false } });
    await userEvent.type(screen.getByLabelText(COPY.remote.sayLabel), "こんにちは");
    await userEvent.click(screen.getByRole("button", { name: COPY.remote.sayButton }));
    await screen.findByText(COPY.remote.offline);
  });

  it("warns that she speaks to everyone nearby", () => {
    setup();
    expect(screen.getByText(COPY.remote.sayWarning)).toBeTruthy();
  });
});

describe("who sees the remote actions", () => {
  const page = (role: "family" | "reviewer" | "visitor") =>
    render(
      <RealDollPage
        api={new FakeApiClient()}
        role={role}
        online
        cloudAvailable={false}
        voice={null}
        deviceResponse={null}
      />,
    );

  it("shows them to the family", async () => {
    page("family");
    await waitFor(() => expect(screen.getByRole("button", { name: COPY.remote.photoButton })).toBeTruthy());
  });

  it.each(["reviewer", "visitor"] as const)("hides them from the %s", (role) => {
    page(role);
    expect(screen.queryByRole("button", { name: COPY.remote.photoButton })).toBeNull();
    expect(screen.queryByLabelText(COPY.remote.sayLabel)).toBeNull();
  });
});
