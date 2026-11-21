/**
 * Unit tests for the speech generator and the simulate core (cloud-judgement task 14.3).
 * Requirements: 7.7, 7.9, 7.13, 15.1, 15.2, 15.3, 15.5, 15.8, 15.12.
 * Everything runs on the in-memory fakes; nothing touches a network.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../lambda/_shared/config.js";
import { ApiError } from "../lambda/_shared/http.js";
import type { VoiceLine } from "../lambda/_shared/lines.js";
import { generateSpeech } from "../lambda/_shared/speech-generator.js";
import { handleSimulate, type SimulateDeps } from "../lambda/api-simulate/simulate-core.js";
import { FakeFaceSearch, FakeRepository, FakeSnapshotStore, FakeSpeechSynth, FakeStateStore } from "./fakes.js";
import { FakeDeviceBus } from "./fakes.js";

const LINES: VoiceLine[] = [
  { id: "fam_1", category: "family", ja: "おかえり。", en: "Welcome home." },
  { id: "str_1", category: "stranger", ja: "だれ？", en: "Who is there?" },
  { id: "unc_1", category: "uncertain", ja: "だれか いる？", en: "Is someone there?" },
];
const GOOD_JSON = JSON.stringify({ ja: "おかえり、まってたよ。", en: "Welcome back, I waited." });

function speechDeps(synth: FakeSpeechSynth, extra: { allowStrangerGeneration?: boolean; timeoutMs?: number } = {}) {
  return { synth, lines: LINES, rand: 0, blockedWords: ["ばか"], ...extra };
}

describe("generateSpeech", () => {
  it("returns a generated line with MP3 on success", async () => {
    const synth = new FakeSpeechSynth().queueLine(GOOD_JSON);
    const out = await generateSpeech("family", null, speechDeps(synth));
    expect(out).toMatchObject({ generated: true, lineId: null, ja: "おかえり、まってたよ。" });
    expect(out.mp3).not.toBeNull();
  });

  it("falls back to a cached line when Bedrock fails (R7.7)", async () => {
    const synth = new FakeSpeechSynth().queueLineError(new Error("boom"));
    const out = await generateSpeech("family", null, speechDeps(synth));
    expect(out).toMatchObject({ generated: false, lineId: "fam_1", mp3: null });
    expect(synth.mp3Calls).toEqual([]);
  });

  it("falls back on a Bedrock timeout", async () => {
    const synth = new FakeSpeechSynth();
    synth.line = () => new Promise(() => undefined);
    const out = await generateSpeech("family", null, speechDeps(synth, { timeoutMs: 10 }));
    expect(out).toMatchObject({ generated: false, lineId: "fam_1" });
  });

  it.each([
    ["not JSON", "this is not json"],
    ["JSON without en", JSON.stringify({ ja: "おかえり。" })],
    ["non-string ja", JSON.stringify({ ja: 3, en: "x" })],
    ["no line at all", null],
  ])("falls back on a bad reply: %s (R7.7)", async (_name, reply) => {
    const synth = new FakeSpeechSynth().queueLine(reply);
    const out = await generateSpeech("uncertain", null, speechDeps(synth));
    expect(out).toMatchObject({ generated: false, lineId: "unc_1", mp3: null });
  });

  it("falls back when the sanitizer rejects the line (R7.7)", async () => {
    const rejected = [
      JSON.stringify({ ja: "ばかだね。", en: "You fool." }), // blocked word
      JSON.stringify({ ja: "hello", en: "hello" }), // Latin letters
      JSON.stringify({ ja: "しんでしまえ", en: "threat" }), // threat word
    ];
    for (const reply of rejected) {
      const synth = new FakeSpeechSynth().queueLine(reply);
      const out = await generateSpeech("family", null, speechDeps(synth));
      expect(out).toMatchObject({ generated: false, lineId: "fam_1" });
      expect(synth.mp3Calls).toEqual([]);
    }
  });

  it("keeps the line with mp3 null when Polly fails (R7.9)", async () => {
    const synth = new FakeSpeechSynth().queueLine(GOOD_JSON);
    synth.failNextMp3();
    const out = await generateSpeech("family", null, speechDeps(synth));
    expect(out).toMatchObject({ generated: true, lineId: null, mp3: null, ja: "おかえり、まってたよ。" });
  });

  it("uses a cached stranger line and no AWS call by default (R7.13)", async () => {
    const synth = new FakeSpeechSynth().queueLine(GOOD_JSON);
    const out = await generateSpeech("stranger", null, speechDeps(synth));
    expect(out).toMatchObject({ generated: false, lineId: "str_1" });
    expect(synth.lineCalls).toEqual([]);
    expect(synth.mp3Calls).toEqual([]);
  });

  it("generates a stranger line only when enabled", async () => {
    const synth = new FakeSpeechSynth().queueLine(GOOD_JSON);
    const out = await generateSpeech("stranger", null, speechDeps(synth, { allowStrangerGeneration: true }));
    expect(out.generated).toBe(true);
    expect(synth.lineCalls).toHaveLength(1);
  });

  it("throws when the catalog has no line of the category", async () => {
    const synth = new FakeSpeechSynth();
    await expect(generateSpeech("family", null, { ...speechDeps(synth), lines: [] })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function setup(config = DEFAULT_CONFIG) {
  const repository = new FakeRepository();
  repository.setSamples([{ id: "sample-one", label: "family" }], { "sample-one": JPEG });
  const search = new FakeFaceSearch();
  const state = new FakeStateStore();
  const store = new FakeSnapshotStore();
  const synth = new FakeSpeechSynth();
  const bus = new FakeDeviceBus();
  let n = 0;
  const deps: SimulateDeps = {
    repository,
    search,
    state,
    store,
    synth,
    config,
    lines: LINES,
    blockedWords: [],
    demoCollectionId: "demo-collection",
    clockMs: () => 1_700_000_000_000,
    rand: () => 0,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  };
  return { deps, repository, search, state, store, synth, bus };
}

const FACE_BOX = { left: 0.3, top: 0.3, width: 0.3, height: 0.3 };
const FAMILY_HIT = { kind: "face", box: FACE_BOX, faceConfidence: 99, bestSimilarity: 97 } as const;

async function code(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected ApiError");
}

describe("handleSimulate", () => {
  it("answers a valid sample from the demo collection with ordered envelopes", async () => {
    const { deps, search } = setup();
    search.queueSearch(FAMILY_HIT);
    const res = await handleSimulate({ role: "family", userSub: "u1", body: { sampleId: "sample-one" } }, deps);
    expect(res.verdict).toBe("family");
    expect(search.searchCalls[0]?.collectionId).toBe("demo-collection");
    expect(res.commands.map((c) => c.type)).toEqual(["judgement.result", "speak"]);
    for (const c of res.commands) {
      expect(c.deviceId).toBe("warashi-sim");
      expect(c.encounterId).toBeNull();
    }
    expect(res.speech).toMatchObject({ lineId: "fam_1", generated: false, mp3Url: null });
    expect(res.latencyMs.search).toBeLessThanOrEqual(res.latencyMs.total);
  });

  it("rejects an unknown sampleId with validation_failed (R15.1)", async () => {
    const { deps, search } = setup();
    const err = await code(handleSimulate({ role: "family", userSub: "u1", body: { sampleId: "nope" } }, deps));
    expect(err.code).toBe("validation_failed");
    expect(search.searchCalls).toEqual([]);
  });

  it.each([
    ["missing", {}],
    ["not a string", { sampleId: 5 }],
    ["upper case", { sampleId: "Sample" }],
    ["slash", { sampleId: "a/b" }],
    ["empty", { sampleId: "" }],
    ["too long", { sampleId: "a".repeat(65) }],
  ])("rejects a malformed sampleId: %s (R15.1)", async (_name, body) => {
    const { deps, search } = setup();
    const err = await code(handleSimulate({ role: "family", userSub: "u1", body }, deps));
    expect(err.code).toBe("validation_failed");
    expect(search.searchCalls).toEqual([]);
  });

  it.each([["true"], [1], [null], [{}]])("rejects a non-boolean generate %j (R15.2)", async (generate) => {
    const { deps, search, state } = setup();
    const err = await code(
      handleSimulate({ role: "family", userSub: "u1", body: { sampleId: "sample-one", generate } }, deps),
    );
    expect(err.code).toBe("validation_failed");
    expect(search.searchCalls).toEqual([]);
    // Nothing was counted either.
    expect(await state.incrementCounter("probe", 1, 60)).toMatchObject({ allowed: true, count: 1 });
  });

  it("answers 429 with Retry-After and no search when over the limit (R15.12)", async () => {
    const { deps, search, synth } = setup({ ...DEFAULT_CONFIG, reviewerSimulatePerHour: 1 });
    search.queueSearch(FAMILY_HIT);
    const request = { role: "reviewer", userSub: "r1", body: { sampleId: "sample-one" } } as const;
    await handleSimulate(request, deps);
    expect(search.searchCalls).toHaveLength(1);
    const err = await code(handleSimulate(request, deps));
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfterS).toBeGreaterThanOrEqual(1);
    expect(err.retryAfterS).toBeLessThanOrEqual(86_400);
    expect(search.searchCalls).toHaveLength(1);
    expect(synth.lineCalls).toEqual([]);
  });

  it("limits generation separately and calls no AWS service when refused", async () => {
    const { deps, search, synth } = setup({ ...DEFAULT_CONFIG, reviewerGeneratePerHour: 1 });
    search.queueSearch(FAMILY_HIT, FAMILY_HIT);
    synth.queueLine(GOOD_JSON);
    const request = { role: "reviewer", userSub: "r1", body: { sampleId: "sample-one", generate: true } } as const;
    const first = await handleSimulate(request, deps);
    expect(first.speech).toMatchObject({ generated: true });
    expect(first.speech?.mp3Url).not.toBeNull();
    const err = await code(handleSimulate(request, deps));
    expect(err.code).toBe("rate_limited");
    expect(search.searchCalls).toHaveLength(1);
    expect(synth.lineCalls).toHaveLength(1);
  });

  it("ignores extra body fields and accepts no image (R15.5)", async () => {
    const { deps, search } = setup();
    search.queueSearch(FAMILY_HIT);
    const res = await handleSimulate(
      {
        role: "family",
        userSub: "u1",
        body: { sampleId: "sample-one", image: "AAAA", collectionId: "household", deviceId: "warashi-01", x: 1 },
      },
      deps,
    );
    expect(res.sampleId).toBe("sample-one");
    expect(search.searchCalls).toHaveLength(1);
    expect(search.searchCalls[0]?.collectionId).toBe("demo-collection");
    expect(search.searchCalls[0]?.image).toEqual(JPEG);
  });

  it("publishes nothing and writes no encounter (R15.8)", async () => {
    const { deps, search, repository, bus } = setup();
    search.queueSearch(FAMILY_HIT);
    const res = await handleSimulate({ role: "family", userSub: "u1", body: { sampleId: "sample-one" } }, deps);
    expect(bus.published).toEqual([]);
    expect(await repository.listEncounters("warashi-sim", 50, null, 0)).toEqual({ items: [], nextCursor: null });
    for (const c of res.commands) expect(repository.hasEncounter(c.encounterId ?? "")).toBe(false);
  });

  it("returns 500 internal without partial output when the search fails (R15.9)", async () => {
    const { deps, search } = setup();
    search.queueSearchError(new Error("secret detail"));
    const err = await code(handleSimulate({ role: "family", userSub: "u1", body: { sampleId: "sample-one" } }, deps));
    expect(err.code).toBe("internal");
    expect(err.message).not.toContain("secret");
  });

  it("falls back to a cached line when Bedrock fails during generation", async () => {
    const { deps, search, synth } = setup();
    search.queueSearch(FAMILY_HIT);
    synth.queueLineError(new Error("boom"));
    const res = await handleSimulate(
      { role: "family", userSub: "u1", body: { sampleId: "sample-one", generate: true } },
      deps,
    );
    expect(res.speech).toMatchObject({ lineId: "fam_1", generated: false, mp3Url: null });
  });
});
