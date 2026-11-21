import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPY } from "../../src/content/copy";
import type { FaceMember } from "../../src/lib/api";
import { buildUploadForm, type UploadResult, type UploadTicket } from "../../src/lib/upload";
import { FamilyPage } from "../../src/pages/Family";
import { FakeApiClient } from "./../helpers/FakeApiClient";

const MEMBER: FaceMember = {
  memberId: "11111111-1111-4111-8111-111111111111",
  displayName: "Hana",
  createdAt: "2026-11-20T12:00:00.000Z",
  consentVersion: "1",
  faceCount: 1,
};

function scripted(members: FaceMember[] = []): FakeApiClient {
  return new FakeApiClient()
    .script("me", {
      ok: true,
      value: { role: "family", consentNoticeVersion: "1", limits: { simulatePerHour: 10, generatePerHour: 5 } },
    })
    .script("faces", { ok: true, value: { members } })
    .script("faceUpload", {
      ok: true,
      value: { url: "https://upload.example.invalid/", fields: { key: "staging/abc", policy: "p" }, stagingKey: "staging/abc", expiresInS: 300 },
    })
    .script("faceRegister", { ok: true, value: { memberId: MEMBER.memberId, faceCount: 1 } })
    .script("faceDelete", { ok: true, value: null });
}

const okUpload = (): Promise<UploadResult> => Promise.resolve({ ok: true });

let created: string[];
let revoked: string[];

beforeEach(() => {
  created = [];
  revoked = [];
  URL.createObjectURL = (): string => {
    const url = `blob:test/${created.length}`;
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string): void => {
    revoked.push(url);
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Waits for the notice to load, then fills the form so that Register is enabled. */
async function fillForm(user: ReturnType<typeof userEvent.setup>, consent = true): Promise<void> {
  await screen.findByRole("heading", { level: 3 }); // consent notice title
  await user.type(screen.getByLabelText(COPY.family.nameLabel), "Hana");
  await user.upload(
    screen.getByLabelText(COPY.family.photoLabel),
    new File(["x"], "face.jpg", { type: "image/jpeg" }),
  );
  if (consent) await user.click(screen.getByLabelText(COPY.family.consentLabel));
}

describe("FamilyPage", () => {
  it("builds the upload form with every pre-signed field first and `file` last", () => {
    const form = buildUploadForm({ key: "k", policy: "p", signature: "s" }, new Blob(["x"]));
    const keys = [...form.keys()];
    expect(keys).toEqual(["key", "policy", "signature", "file"]);
  });

  it("uploads in order: faceUpload, upload, faceRegister, then reloads the list", async () => {
    const api = scripted();
    const order: string[] = [];
    const upload = vi.fn((_ticket: UploadTicket, _file: Blob) => {
      order.push("upload");
      return okUpload();
    });
    api.script("faceUpload", () => {
      order.push("faceUpload");
      return { ok: true, value: { url: "https://upload.example.invalid/", fields: { key: "k" }, stagingKey: "staging/abc", expiresInS: 300 } };
    });
    api.script("faceRegister", () => {
      order.push("faceRegister");
      return { ok: true, value: { memberId: MEMBER.memberId, faceCount: 1 } };
    });
    const user = userEvent.setup();
    render(<FamilyPage api={api} role="family" upload={upload} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: COPY.family.register }));

    expect(await screen.findByText(COPY.family.registered)).toBeTruthy();
    expect(order).toEqual(["faceUpload", "upload", "faceRegister"]);
    expect(upload.mock.calls[0]?.[0]).toEqual({ url: "https://upload.example.invalid/", fields: { key: "k" } });
    expect(api.callsOf("faceRegister")[0]?.args[0]).toEqual({
      stagingKey: "staging/abc",
      displayName: "Hana",
      memberId: null,
      consent: { noticeVersion: "1", accepted: true },
    });
    expect(api.callsOf("faces")).toHaveLength(2);
  });

  it("keeps Register disabled until the consent box is ticked", async () => {
    const user = userEvent.setup();
    render(<FamilyPage api={scripted()} role="family" upload={okUpload} />);
    await fillForm(user, false);
    const register = screen.getByRole("button", { name: COPY.family.register }) as HTMLButtonElement;
    expect(register.disabled).toBe(true);
    await user.click(screen.getByLabelText(COPY.family.consentLabel));
    expect(register.disabled).toBe(false);
  });

  it("shows the one-face message on face_count_invalid and discards the photo", async () => {
    const api = scripted().script("faceRegister", {
      ok: false,
      error: { code: "face_count_invalid", message: "x" },
    });
    const user = userEvent.setup();
    render(<FamilyPage api={api} role="family" upload={okUpload} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: COPY.family.register }));

    expect((await screen.findByRole("alert")).textContent).toBe(COPY.family.oneFace);
    expect(screen.queryByAltText(COPY.family.previewAlt)).toBeNull();
    expect(created).toHaveLength(1);
    expect(revoked).toEqual(created);
  });

  it("clears consent, reloads /me and asks again on consent_required", async () => {
    const api = scripted().script("faceRegister", {
      ok: false,
      error: { code: "consent_required", message: "x" },
    });
    const user = userEvent.setup();
    render(<FamilyPage api={api} role="family" upload={okUpload} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: COPY.family.register }));

    expect((await screen.findByRole("alert")).textContent).toBe(COPY.family.consentAgain);
    expect((screen.getByLabelText(COPY.family.consentLabel) as HTMLInputElement).checked).toBe(false);
    expect(api.callsOf("me")).toHaveLength(2);
    expect(revoked).toEqual(created);
  });

  it("revokes the preview URL after a successful registration", async () => {
    const user = userEvent.setup();
    render(<FamilyPage api={scripted()} role="family" upload={okUpload} />);
    await fillForm(user);
    expect(created).toHaveLength(1);
    expect(revoked).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: COPY.family.register }));
    await screen.findByText(COPY.family.registered);
    expect(revoked).toEqual(created);
  });

  it("does not call faceRegister when the upload fails", async () => {
    const api = scripted();
    const user = userEvent.setup();
    render(<FamilyPage api={api} role="family" upload={() => Promise.resolve({ ok: false })} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: COPY.family.register }));

    expect((await screen.findByRole("alert")).textContent).toBe(COPY.family.registerFailed);
    expect(api.callsOf("faceRegister")).toHaveLength(0);
  });

  it("asks for confirmation before deleting and sends no request on Cancel", async () => {
    const api = scripted([MEMBER]);
    const user = userEvent.setup();
    render(<FamilyPage api={api} role="family" upload={okUpload} />);
    await user.click(await screen.findByRole("button", { name: /^Delete\s+Hana$/ }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(COPY.family.deleteTitle("Hana"));
    expect(api.callsOf("faceDelete")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: COPY.family.cancel }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.callsOf("faceDelete")).toHaveLength(0);
  });

  it("deletes the member after confirmation and removes it from the list", async () => {
    const api = scripted([MEMBER]);
    const user = userEvent.setup();
    render(<FamilyPage api={api} role="family" upload={okUpload} />);
    await user.click(await screen.findByRole("button", { name: /^Delete\s+Hana$/ }));
    await user.click(screen.getByRole("button", { name: COPY.family.confirmDelete }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.callsOf("faceDelete")[0]?.args).toEqual([MEMBER.memberId]);
    expect(await screen.findByText(COPY.family.noMembers)).toBeTruthy();
  });

  it("shows Locked controls and sends no /faces request to a reviewer", () => {
    const api = scripted();
    render(<FamilyPage api={api} role="reviewer" upload={okUpload} />);
    expect(screen.getAllByText(COPY.family.lockedFaces)).toHaveLength(2);
    expect(api.calls).toHaveLength(0);
  });
});
