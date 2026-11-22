/**
 * Consent notice translations (docs/schema.md, `GET /me`): grouping by version, the fallback to
 * English, the bundled files' structure, and the Family page in Japanese still sending the same
 * notice version.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { noticeFor, noticesFromFiles } from "../../src/content/consent";
import { COPY, setLanguage } from "../../src/content/copy";
import { FamilyPage } from "../../src/pages/Family";
import { FakeApiClient } from "../helpers/FakeApiClient";

const CONSENT_DIR = join(__dirname, "..", "..", "src", "content", "consent");

afterEach(() => {
  setLanguage("en");
});

describe("noticesFromFiles and noticeFor", () => {
  const notices = noticesFromFiles({
    "../content/consent/1.md": "en 1",
    "../content/consent/1.ja.md": "ja 1",
    "../content/consent/1.1.md": "en 1.1",
    "../content/consent/2.ja.md": "ja 2 without a source",
  });

  it("groups a translation under the same version as its English source", () => {
    expect(notices["1"]).toEqual({ en: "en 1", ja: "ja 1" });
    expect(notices["1.ja"]).toBeUndefined();
  });

  it("treats a dot in a version as part of the version unless a known language follows", () => {
    expect(notices["1.1"]).toEqual({ en: "en 1.1" });
  });

  it("picks the requested language, falls back to English, and ignores a translation without a source", () => {
    expect(noticeFor(notices, "1", "ja")).toBe("ja 1");
    expect(noticeFor(notices, "1", "en")).toBe("en 1");
    expect(noticeFor(notices, "1.1", "ja")).toBe("en 1.1");
    expect(noticeFor(notices, "2", "ja")).toBeUndefined();
    expect(noticeFor(notices, "9", "en")).toBeUndefined();
  });
});

/** Heading and paragraph blocks, split the way the Family page renders them. */
function blocks(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b !== "");
}

describe("bundled consent notices", () => {
  const files = readdirSync(CONSENT_DIR).filter((f) => f.endsWith(".md"));

  it("has an English source for every translation, with the same heading and paragraph layout", () => {
    for (const file of files.filter((f) => /\.[a-z]{2}\.md$/.test(f))) {
      const source = file.replace(/\.[a-z]{2}\.md$/, ".md");
      expect(files, `${file} needs ${source}`).toContain(source);
      const t = blocks(readFileSync(join(CONSENT_DIR, file), "utf8"));
      const s = blocks(readFileSync(join(CONSENT_DIR, source), "utf8"));
      expect(t.length, file).toBe(s.length);
      expect(t.map((b) => b.startsWith("# ")), file).toEqual(s.map((b) => b.startsWith("# ")));
    }
  });

  it("offers a Japanese notice for version 1", () => {
    expect(files).toContain("1.ja.md");
  });
});

describe("FamilyPage in Japanese", () => {
  function scripted(): FakeApiClient {
    return new FakeApiClient()
      .script("me", {
        ok: true,
        value: { role: "family", consentNoticeVersion: "1", limits: { simulatePerHour: 10, generatePerHour: 5 } },
      })
      .script("faces", { ok: true, value: { members: [] } })
      .script("faceUpload", {
        ok: true,
        value: { url: "https://upload.example.invalid/", fields: { key: "k" }, stagingKey: "staging/abc", expiresInS: 300 },
      })
      .script("faceRegister", { ok: true, value: { memberId: "11111111-1111-4111-8111-111111111111", faceCount: 1 } });
  }

  it("shows the Japanese notice and still accepts notice version 1", async () => {
    URL.createObjectURL = () => "blob:test/0";
    URL.revokeObjectURL = () => undefined;
    setLanguage("ja");
    const api = scripted();
    const user = userEvent.setup();
    render(<FamilyPage api={api} role="family" upload={() => Promise.resolve({ ok: true })} />);

    expect(await screen.findByRole("heading", { level: 3, name: "顔の登録についてのお知らせ" })).toBeTruthy();
    await user.type(screen.getByLabelText(COPY.family.nameLabel), "Hana");
    await user.upload(screen.getByLabelText(COPY.family.photoLabel), new File(["x"], "face.jpg", { type: "image/jpeg" }));
    await user.click(screen.getByLabelText(COPY.family.consentLabel));
    await user.click(screen.getByRole("button", { name: COPY.family.register }));

    expect(await screen.findByText(COPY.family.registered)).toBeTruthy();
    expect(api.callsOf("faceRegister")[0]?.args[0]).toMatchObject({ consent: { noticeVersion: "1", accepted: true } });
  });
});
