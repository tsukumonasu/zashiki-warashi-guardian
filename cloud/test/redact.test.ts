// Unit tests for the Redactor (R14.1, R14.6).
import { describe, expect, it } from "vitest";
import { illustrationFor, redactEncounter } from "../lambda/_shared/redact.js";
import type { EncounterRecord, Verdict } from "../lambda/_shared/types.js";

function envelope(type: string, data: Record<string, unknown>, n: number): never {
  return {
    v: 1,
    id: `00000000-0000-4000-8000-00000000000${n}`,
    ts: "2026-11-20T12:34:56.789Z",
    deviceId: "warashi-01",
    encounterId: "c1d2e3f4-0000-4000-8000-000000000001",
    type,
    data,
  } as unknown as never;
}

function record(verdict: Verdict | null): EncounterRecord {
  return {
    encounterId: "c1d2e3f4-0000-4000-8000-000000000001",
    deviceId: "warashi-01",
    startedAt: "2026-11-20T12:34:56.789Z",
    endedAt: null,
    state: "cooldown",
    verdict,
    confidence: 0.9,
    reaction: { kind: "family", lineId: "greet_1", offline: false },
    notified: false,
    snapshot: { url: "https://example.invalid/signed", expiresAt: "2026-11-20T12:40:00.000Z" },
    illustration: null,
    events: [
      envelope("presence.detected", { source: "pir" }, 1),
      envelope("snapshot.captured", { snapshotId: "s1", width: 640, hasImage: true }, 2),
      envelope("judgement.result", { verdict: "family", face: { left: 0.1, top: 0.1 } }, 3),
    ],
  };
}

describe("illustrationFor", () => {
  it.each([
    ["family", "silhouette-family"],
    ["stranger", "silhouette-stranger"],
    ["no_face", "silhouette-none"],
    ["uncertain", "silhouette-uncertain"],
    [null, "silhouette-uncertain"],
    ["unexpected", "silhouette-uncertain"],
  ])("maps %s to %s", (verdict, expected) => {
    expect(illustrationFor(verdict)).toBe(expected);
  });
});

describe("redactEncounter", () => {
  it("returns the family record unchanged (identity)", () => {
    const rec = record("family");
    expect(redactEncounter(rec, "family")).toBe(rec);
  });

  it.each([
    ["family", "silhouette-family"],
    ["stranger", "silhouette-stranger"],
    ["no_face", "silhouette-none"],
    ["uncertain", "silhouette-uncertain"],
    [null, "silhouette-uncertain"],
  ] as const)("gives a reviewer the illustration for verdict %s", (verdict, illustration) => {
    const out = redactEncounter(record(verdict), "reviewer");
    expect(out.illustration).toBe(illustration);
    expect(out.snapshot).toBeNull();
  });

  it("removes image and face data at every depth, keeping event order and count", () => {
    const rec = record("family");
    const out = redactEncounter(rec, "reviewer");
    const text = JSON.stringify(out);
    for (const word of ["hasImage", "jpegBase64", "face\"", "example.invalid"]) {
      expect(text).not.toContain(word);
    }
    expect(out.events.map((e) => e.type)).toEqual(rec.events.map((e) => e.type));
    expect(out.events[0]).toEqual(rec.events[0]);
    expect(out.verdict).toBe("family");
  });

  it("does not mutate the input and is idempotent", () => {
    const rec = record("stranger");
    const before = JSON.stringify(rec);
    const once = redactEncounter(rec, "reviewer");
    expect(JSON.stringify(rec)).toBe(before);
    expect(redactEncounter(once, "reviewer")).toEqual(once);
  });
});
