// Feature: cloud-judgement, Property 8: No label leakage
// Validates: Requirements 8.1, 8.2
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../lambda/_shared/config.js";
import type { Category, VoiceLine } from "../lambda/_shared/lines.js";
import { decodeEnvelope, encodeEnvelope } from "../lambda/_shared/messages.js";
import { buildStrangerNotification } from "../lambda/_shared/notify.js";
import { buildPrompt } from "../lambda/_shared/persona.js";
import type { FamilyMember } from "../lambda/_shared/ports.js";
import { generateSpeech } from "../lambda/_shared/speech-generator.js";
import { handleSimulate, type SimulateDeps } from "../lambda/api-simulate/simulate-core.js";
import { FakeFaceSearch, FakeRepository, FakeSnapshotStore, FakeSpeechSynth, FakeStateStore } from "./fakes.js";

const LINES: VoiceLine[] = [
  { id: "fam_1", category: "family", ja: "おかえり。", en: "Welcome home." },
  { id: "str_1", category: "stranger", ja: "だれ？", en: "Who is there?" },
  { id: "unc_1", category: "uncertain", ja: "だれか いる？", en: "Is someone there?" },
];

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const FACE_BOX = { left: 0.3, top: 0.3, width: 0.3, height: 0.3 };

type NonFamily = "stranger" | "no_face" | "uncertain";
const SITUATIONS: NonFamily[] = ["stranger", "no_face", "uncertain"];
const CATEGORY: Record<NonFamily, Category> = { stranger: "stranger", no_face: "uncertain", uncertain: "uncertain" };

function outcomeFor(situation: NonFamily) {
  switch (situation) {
    case "stranger":
      return { kind: "face", box: FACE_BOX, faceConfidence: 99, bestSimilarity: 10 } as const;
    case "no_face":
      return { kind: "no_face" } as const;
    case "uncertain":
      return { kind: "face", box: FACE_BOX, faceConfidence: 99, bestSimilarity: 85 } as const;
  }
}

function member(i: number, displayName: string): FamilyMember {
  return {
    memberId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    displayName,
    faceIds: [`face-${i}`],
    consentVersion: "v1",
    consentAt: "2026-01-01T00:00:00.000Z",
    createdBy: "u1",
  };
}

async function simulate(situation: NonFamily, labels: readonly string[], generate: boolean, leakingEn: string | null) {
  const repository = new FakeRepository();
  repository.setSamples([{ id: "sample-one", label: "family" }], { "sample-one": JPEG });
  for (const [i, label] of labels.entries()) await repository.putMember(member(i, label));
  const search = new FakeFaceSearch();
  search.queueSearch(outcomeFor(situation));
  search.queueDetect({ faces: 1, quality: { sharpness: 90, brightness: 60, yawDeg: 0 }, box: FACE_BOX });
  const synth = new FakeSpeechSynth();
  if (leakingEn !== null) synth.queueLine(JSON.stringify({ ja: "だれか、いるの？", en: leakingEn }));
  let n = 0;
  const deps: SimulateDeps = {
    repository,
    search,
    state: new FakeStateStore(),
    store: new FakeSnapshotStore(),
    synth,
    config: DEFAULT_CONFIG,
    lines: LINES,
    blockedWords: [],
    demoCollectionId: "demo-collection",
    clockMs: () => 1_700_000_000_000,
    rand: () => 0,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    allowStrangerGeneration: true,
  };
  return handleSimulate({ role: "reviewer", userSub: "u1", body: { sampleId: "sample-one", generate } }, deps);
}

/** Everything a label may legitimately be a substring of: fixed texts and the label-free outputs. */
async function buildCorpus(): Promise<string> {
  const parts: string[] = LINES.flatMap((l) => [l.id, l.ja, l.en]);
  for (const c of ["family", "stranger", "uncertain"] as const) {
    const p = buildPrompt(c, null);
    parts.push(p.system, p.user);
  }
  const note = buildStrangerNotification({ deviceLabel: "warashi-01", atIso: NOW_ISO, dashboardUrl: URL_TEXT });
  parts.push(note.subject, note.body, NOW_ISO, URL_TEXT);
  for (const s of SITUATIONS) parts.push(JSON.stringify(await simulate(s, [], false, null)));
  return parts.join("\n").toLowerCase();
}

const NOW_ISO = "2026-11-20T12:34:56.789Z";
const URL_TEXT = "https://dashboard.example.invalid/";
const CORPUS = await buildCorpus();

const labelArb = fc
  .oneof(
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.stringMatching(/^[A-Z][a-z]{2,9}$/),
    fc.stringMatching(/^[ぁ-んァ-ヶ一-龠]{1,6}$/),
  )
  .filter((s) => s.trim().length > 0 && !CORPUS.includes(s.toLowerCase()));
const registryArb = fc.array(labelArb, { minLength: 0, maxLength: 100 });

const TOP_LEVEL = ["v", "id", "ts", "deviceId", "encounterId", "type", "data"];
const ALLOWED_DATA: Record<string, string[]> = {
  "judgement.result": ["snapshotId", "verdict", "confidence", "face"],
  speak: ["lineId", "audioUrl", "ja", "en"],
};

describe("Property 8: No label leakage", () => {
  it("Feature: cloud-judgement, Property 8: No label leakage (simulate outputs)", async () => {
    await fc.assert(
      fc.asyncProperty(
        registryArb,
        fc.constantFrom(...SITUATIONS),
        fc.boolean(),
        fc.boolean(),
        async (labels, situation, generate, modelLeaks) => {
          const leak = labels.length > 0 && modelLeaks ? `Hello ${labels[0]}` : null;
          const res = await simulate(situation, labels, generate, leak);
          const text = JSON.stringify(res).toLowerCase();
          for (const label of labels) expect(text.includes(label.toLowerCase())).toBe(false);
          // Output contains only contract fields (R8.2).
          for (const env of res.commands) {
            expect(Object.keys(env).sort()).toEqual([...TOP_LEVEL].sort());
            expect(Object.keys(env.data as object).sort()).toEqual([...(ALLOWED_DATA[env.type] ?? [])].sort());
          }
          expect(res.commands[0]?.type).toBe("judgement.result");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Feature: cloud-judgement, Property 8: No label leakage (prompt, speech, notification)", async () => {
    await fc.assert(
      fc.asyncProperty(
        registryArb,
        fc.constantFrom(...SITUATIONS),
        fc.boolean(),
        async (labels, situation, useModel) => {
          const category = CATEGORY[situation];
          const prompt = buildPrompt(category, null);
          const note = buildStrangerNotification({ deviceLabel: "warashi-01", atIso: NOW_ISO, dashboardUrl: URL_TEXT });
          const synth = new FakeSpeechSynth();
          if (useModel) synth.queueLine(JSON.stringify({ ja: "だれか、いるの？", en: "ok" }));
          const speech = await generateSpeech(category, null, {
            synth,
            lines: LINES,
            rand: 0,
            blockedWords: [],
            allowStrangerGeneration: true,
          });
          const text = [prompt.system, prompt.user, note.subject, note.body, speech.ja, speech.en, ...synth.mp3Calls]
            .join("\n")
            .toLowerCase();
          for (const label of labels) expect(text.includes(label.toLowerCase())).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Feature: cloud-judgement, Property 8: No label leakage (status.report drops extra fields)", () => {
    fc.assert(
      fc.property(labelArb, (label) => {
        const raw = JSON.stringify({
          v: 1,
          id: "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a0c",
          ts: NOW_ISO,
          deviceId: "warashi-01",
          encounterId: null,
          type: "status.report",
          data: {
            state: "sleeping",
            mode: "guard",
            panDeg: 0,
            tiltDeg: 0,
            lantern: 0,
            cameraActive: false,
            micActive: false,
            motionEnabled: false,
            uptimeSec: 1,
            agentVersion: "0.1.0",
            displayName: label,
            who: label,
          },
        });
        const decoded = decodeEnvelope(raw);
        expect(decoded.kind).toBe("valid");
        if (decoded.kind !== "valid") return;
        const keys = Object.keys(decoded.message.data as object).sort();
        expect(keys).toEqual(
          ["state", "mode", "panDeg", "tiltDeg", "lantern", "cameraActive", "micActive", "motionEnabled", "uptimeSec", "agentVersion"].sort(),
        );
        expect(encodeEnvelope(decoded.message)).not.toContain(label);
      }),
      { numRuns: 100 },
    );
  });
});
