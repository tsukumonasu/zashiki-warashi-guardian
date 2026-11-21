/**
 * Log privacy test (cloud-judgement task 17.5, requirements 8.6 and 25.1).
 *
 * Runs every core (judge, ingest, simulate, api-read, commands, faces) on the in-memory fakes with
 * fixtures that hold image bytes, base64 image text, a pre-signed URL, a family display name, face
 * ids and similarity values. All log output is captured (the safelog sink and every `console`
 * method), including the output of failing paths, and none of those values may appear in it.
 * No network is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../lambda/_shared/config.js";
import type { VoiceLine } from "../lambda/_shared/lines.js";
import { setLogSink } from "../lambda/_shared/safelog.js";
import type { FamilyMember } from "../lambda/_shared/ports.js";
import type { SearchOutcome } from "../lambda/_shared/verdict.js";
import { handlePostCommand, type CommandDeps } from "../lambda/api-admin/commands-core.js";
import {
  handleDeleteFace,
  handleFaceUpload,
  handleListFaces,
  handleRegisterFace,
  type FaceStaging,
  type FacesDeps,
  type FacesRequest,
} from "../lambda/api-admin/faces-core.js";
import {
  handleDeviceStatus,
  handleGetEncounter,
  handleListEncounters,
  handleMe,
  handleSamples,
  type ReadDeps,
  type ReadRequest,
} from "../lambda/api-read/api-read-core.js";
import { handleSimulate, type SimulateDeps } from "../lambda/api-simulate/simulate-core.js";
import { handleIngest, type IngestDeps } from "../lambda/ingest/ingest-core.js";
import { handleSnapshot, type JudgeDeps, type SnapshotEvent } from "../lambda/judge/judge-core.js";
import {
  FakeDeviceBus,
  FakeFaceSearch,
  FakeNotifier,
  FakeRepository,
  FakeSnapshotStore,
  FakeSpeechSynth,
  FakeStateStore,
} from "./fakes.js";

// ---------------------------------------------------------------------------------------------
// Sensitive fixture values
// ---------------------------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-11-20T12:34:57.000Z");
const TS = "2026-11-20T12:34:56.789Z";
const DEVICE = "warashi-01";
const ENCOUNTER = "c1d2e3f4-0000-4000-8000-000000000001";

const DISPLAY_NAME = "Hanako Yamada-Privacytest";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const FACE_ID_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const FACE_ID_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PRESIGNED_URL =
  "https://private-bucket.example.invalid/snapshots/secret-key.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeefcafe0123456789";
const PRESIGNED_TOKEN = "deadbeefcafe0123456789";
const SIMILARITY = 97.123456;
const SIMILARITY_TEXT = "97.123456";
const FACE_CONFIDENCE_TEXT = "98.7654321";

/** JPEG-like bytes (signature, then a distinctive pattern) so the base64 text is unique. */
const JPEG_BYTES = (() => {
  const bytes = new Uint8Array(1500);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37 + 11) & 0xff;
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes;
})();
const JPEG_BASE64 = Buffer.from(JPEG_BYTES).toString("base64");

/** Strings that must never appear in any log line. */
const FORBIDDEN: readonly string[] = [
  JPEG_BASE64,
  JPEG_BASE64.slice(200, 260), // a slice from the middle: catches truncated image text
  Buffer.from(JPEG_BYTES.slice(0, 64)).toString("hex"),
  PRESIGNED_URL,
  PRESIGNED_TOKEN,
  "secret-key.jpg",
  DISPLAY_NAME,
  "Privacytest",
  FACE_ID_A,
  FACE_ID_B,
  SIMILARITY_TEXT,
  FACE_CONFIDENCE_TEXT,
];

// ---------------------------------------------------------------------------------------------
// Log capture
// ---------------------------------------------------------------------------------------------

let lines: string[];
let restoreSink: (line: string) => void;
const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  lines = [];
  restoreSink = setLogSink((line) => {
    lines.push(line);
  });
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    consoleSpies.push(
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
      }),
    );
  }
});

afterEach(() => {
  setLogSink(restoreSink);
  for (const spy of consoleSpies.splice(0)) spy.mockRestore();
});

function expectNoLeak(): void {
  const output = lines.join("\n");
  for (const secret of FORBIDDEN) {
    expect(output, `log output leaked: ${secret.slice(0, 24)}...`).not.toContain(secret);
  }
}

/** An error whose message carries every secret, as a careless SDK error might. */
function leakyError(name = "LeakyError"): Error {
  const error = new Error(
    `failed for ${DISPLAY_NAME} face ${FACE_ID_A} url ${PRESIGNED_URL} sim ${SIMILARITY_TEXT} image ${JPEG_BASE64}`,
  );
  error.name = name;
  return error;
}

// ---------------------------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------------------------

const BOX = { left: 0.3, top: 0.2, width: 0.3, height: 0.4 };
const GOOD_QUALITY = { sharpness: 80, brightness: 120, yawDeg: 5 };

function snapshotEvent(overrides: Record<string, unknown> = {}, snapshotId = "snap-1"): SnapshotEvent {
  return {
    v: 1,
    id: "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10",
    ts: TS,
    deviceId: DEVICE,
    encounterId: ENCOUNTER,
    type: "snapshot.captured",
    data: { snapshotId, width: 640, height: 480, panDeg: 0, tiltDeg: 0, jpegBase64: JPEG_BASE64 },
    topicDeviceId: DEVICE,
    ...overrides,
  };
}

function judgeSetup() {
  const repository = new FakeRepository(() => NOW_MS);
  const state = new FakeStateStore({ now: () => NOW_MS, repository });
  const faces = new FakeFaceSearch();
  const snapshots = new FakeSnapshotStore();
  const bus = new FakeDeviceBus();
  const notifier = new FakeNotifier();
  let seq = 0;
  const deps: JudgeDeps = {
    faces,
    snapshots,
    bus,
    notifier,
    state,
    repository,
    config: DEFAULT_CONFIG,
    collectionId: "household",
    deviceLabel: () => "Test doll",
    dashboardUrl: "https://dashboard.example.invalid",
    now: () => NOW_MS,
    random: () => 0,
    newId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    sleep: () => Promise.resolve(),
  };
  return { deps, repository, faces, snapshots, bus, notifier, state };
}

const FAMILY_HIT: SearchOutcome = { kind: "face", box: BOX, faceConfidence: 98.7654321, bestSimilarity: SIMILARITY };
const STRANGER_HIT: SearchOutcome = { kind: "face", box: BOX, faceConfidence: 98.7654321, bestSimilarity: null };

describe("judge core logs (R8.6, R25.1)", () => {
  it("keeps image, URL, name, face id and similarity out of the log on success paths", async () => {
    const family = judgeSetup();
    family.faces.queueSearch(FAMILY_HIT);
    await handleSnapshot(snapshotEvent(), family.deps);

    const stranger = judgeSetup();
    stranger.faces.queueSearch(STRANGER_HIT).queueDetect({ faces: 1, quality: GOOD_QUALITY, box: BOX });
    await handleSnapshot(snapshotEvent({}, "snap-2"), stranger.deps);

    // A redelivery, a bad image and a spoofed sender also log; their output carries no image text.
    await handleSnapshot(snapshotEvent({}, "snap-2"), stranger.deps);
    await handleSnapshot(snapshotEvent({ data: { snapshotId: "snap-3", jpegBase64: `${JPEG_BASE64}!` } }), stranger.deps);
    await handleSnapshot(snapshotEvent({ topicDeviceId: PRESIGNED_URL }), stranger.deps);

    expect(lines.length).toBeGreaterThan(0);
    expectNoLeak();
  });

  it("keeps secrets out of the log when search, detect, store, publish, record and notify fail", async () => {
    const search = judgeSetup();
    search.faces.queueSearchError(leakyError());
    await handleSnapshot(snapshotEvent({}, "snap-a"), search.deps);

    const throttled = judgeSetup();
    throttled.faces.queueSearchThrottle().queueSearchError(leakyError("ThrottlingException"));
    await handleSnapshot(snapshotEvent({}, "snap-b"), throttled.deps);

    const detect = judgeSetup();
    detect.faces.queueSearch(STRANGER_HIT).queueDetectError(leakyError());
    await handleSnapshot(snapshotEvent({}, "snap-c"), detect.deps);

    const store = judgeSetup();
    store.snapshots.failNextPut(leakyError());
    store.faces.queueSearch(FAMILY_HIT);
    await handleSnapshot(snapshotEvent({}, "snap-d"), store.deps);

    const publish = judgeSetup();
    publish.bus.failNext(leakyError());
    publish.faces.queueSearch(STRANGER_HIT).queueDetect({ faces: 1, quality: GOOD_QUALITY, box: BOX });
    await handleSnapshot(snapshotEvent({}, "snap-e"), publish.deps);

    const notify = judgeSetup();
    notify.notifier.failNext(leakyError());
    notify.faces.queueSearch(STRANGER_HIT).queueDetect({ faces: 1, quality: GOOD_QUALITY, box: BOX });
    await handleSnapshot(snapshotEvent({}, "snap-f"), notify.deps);

    const record = judgeSetup();
    record.repository.updateEncounter = () => Promise.reject(leakyError());
    record.faces.queueSearch(FAMILY_HIT);
    await handleSnapshot(snapshotEvent({}, "snap-g"), record.deps);

    expect(lines.length).toBeGreaterThan(0);
    expectNoLeak();
  });
});

// ---------------------------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------------------------

function ingestSetup() {
  const repo = new FakeRepository(() => NOW_MS);
  const state = new FakeStateStore({ now: () => NOW_MS });
  const deps: IngestDeps = { repo, state, nowMs: () => NOW_MS };
  return { repo, state, deps };
}

function ingestEvent(type: string, data: Record<string, unknown>, id: string): Record<string, unknown> {
  return { v: 1, id, ts: TS, deviceId: DEVICE, encounterId: ENCOUNTER, type, data, topicDeviceId: DEVICE };
}

describe("ingest core logs (R8.6, R25.1)", () => {
  it("keeps secrets out of the log for stored, rejected and failed messages", async () => {
    const { repo, deps } = ingestSetup();
    const snapshotData = { snapshotId: "snap-1", width: 640, height: 480, panDeg: 0, tiltDeg: 0, jpegBase64: JPEG_BASE64 };
    await handleIngest(ingestEvent("snapshot.captured", snapshotData, "00000000-0000-4000-8000-000000000001"), deps);
    await handleIngest(
      ingestEvent(
        "error.reported",
        { code: "audio_failed", message: `${DISPLAY_NAME} ${PRESIGNED_URL}`, refId: null },
        "00000000-0000-4000-8000-000000000002",
      ),
      deps,
    );
    // Rejected input: spoofed topic, unknown type with image text, malformed body, a URL as id.
    await handleIngest({ ...ingestEvent("state.changed", {}, "x"), topicDeviceId: "other" }, deps);
    await handleIngest(ingestEvent("not.a.type", { jpegBase64: JPEG_BASE64, name: DISPLAY_NAME }, "00000000-0000-4000-8000-000000000003"), deps);
    await handleIngest(ingestEvent("state.changed", { jpegBase64: JPEG_BASE64 }, PRESIGNED_URL), deps);
    await handleIngest({ ...ingestEvent("presence.detected", { source: "pir" }, PRESIGNED_URL), deviceId: 42 }, deps);

    // Write failures, with the repository error carrying every secret.
    repo.appendEvent = () => Promise.reject(leakyError());
    await expect(
      handleIngest(ingestEvent("snapshot.captured", snapshotData, "00000000-0000-4000-8000-000000000004"), deps),
    ).rejects.toThrow();
    const brokenState = ingestSetup();
    brokenState.state.claim = () => Promise.reject(leakyError());
    await expect(
      handleIngest(ingestEvent("snapshot.captured", snapshotData, "00000000-0000-4000-8000-000000000005"), brokenState.deps),
    ).rejects.toThrow();

    expect(lines.length).toBeGreaterThan(0);
    expectNoLeak();
  });
});

// ---------------------------------------------------------------------------------------------
// Simulate
// ---------------------------------------------------------------------------------------------

const LINES: VoiceLine[] = [
  { id: "fam_1", category: "family", ja: "おかえり。", en: "Welcome home." },
  { id: "str_1", category: "stranger", ja: "だれ？", en: "Who is there?" },
  { id: "unc_1", category: "uncertain", ja: "だれか いる？", en: "Is someone there?" },
];

const MEMBER: FamilyMember = {
  memberId: MEMBER_ID,
  displayName: DISPLAY_NAME,
  faceIds: [FACE_ID_A, FACE_ID_B],
  consentVersion: "2026-11",
  consentAt: "2026-11-01T00:00:00.000Z",
  createdBy: "user-1",
};

function simulateSetup() {
  const repository = new FakeRepository(() => NOW_MS);
  repository.setSamples([{ id: "sample-one", label: "family" }], { "sample-one": JPEG_BYTES });
  void repository.putMember(MEMBER);
  const search = new FakeFaceSearch();
  const state = new FakeStateStore({ now: () => NOW_MS });
  const store = new FakeSnapshotStore();
  const synth = new FakeSpeechSynth();
  let n = 0;
  const deps: SimulateDeps = {
    repository,
    search,
    state,
    store,
    synth,
    config: DEFAULT_CONFIG,
    lines: LINES,
    blockedWords: [],
    demoCollectionId: "demo-collection",
    clockMs: () => NOW_MS,
    rand: () => 0,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  };
  return { deps, repository, search, store, synth, state };
}

describe("simulate core logs (R8.6, R25.1)", () => {
  it("keeps secrets out of the log on success, rate-limit and failure paths", async () => {
    const ok = simulateSetup();
    ok.search.queueSearch(FAMILY_HIT);
    const response = await handleSimulate(
      { role: "family", userSub: "user-1", body: { sampleId: "sample-one", generate: true } },
      ok.deps,
    );
    // The response itself may hold a signed URL, but the log must not.
    expect(response.verdict).toBe("family");

    const failing = simulateSetup();
    failing.search.queueSearchError(leakyError());
    await expect(
      handleSimulate({ role: "reviewer", userSub: "user-2", body: { sampleId: "sample-one" } }, failing.deps),
    ).rejects.toThrow();

    const bad = simulateSetup();
    await expect(
      handleSimulate({ role: "reviewer", userSub: "user-2", body: { sampleId: PRESIGNED_URL } }, bad.deps),
    ).rejects.toThrow();

    const storeFails = simulateSetup();
    storeFails.search.queueSearch(FAMILY_HIT);
    storeFails.store.failNextPut(leakyError());
    storeFails.synth.queueLine(JSON.stringify({ ja: "おかえり、まってたよ。", en: "Welcome back." }));
    await handleSimulate(
      { role: "family", userSub: "user-1", body: { sampleId: "sample-one", generate: true } },
      storeFails.deps,
    );

    expectNoLeak();
  });
});

// ---------------------------------------------------------------------------------------------
// API read
// ---------------------------------------------------------------------------------------------

function readSetup() {
  const repository = new FakeRepository(() => NOW_MS);
  repository.setSamples([{ id: "sample-one", label: "family" }]);
  const deps: ReadDeps = {
    repository,
    signer: { sign: async () => PRESIGNED_URL },
    config: DEFAULT_CONFIG,
    consentNoticeVersion: "2026-11",
    nowMs: NOW_MS,
  };
  return { repository, deps };
}

describe("api-read core logs (R8.6, R25.1)", () => {
  it("keeps secrets out of the log for every read route and a failing repository", async () => {
    const { repository, deps } = readSetup();
    await repository.createEncounterIfAbsent(
      {
        encounterId: ENCOUNTER,
        deviceId: DEVICE,
        startedAt: TS,
        endedAt: null,
        state: "cooldown",
        verdict: "family",
        confidence: SIMILARITY / 100,
        reaction: null,
        notified: false,
        snapshotKey: "snapshots/secret-key.jpg",
        errorCount: 0,
      },
      3600,
    );
    const request = (role: ReadRequest["role"], over: Partial<ReadRequest> = {}): ReadRequest => ({
      role,
      query: {},
      pathParameters: {},
      ...over,
    });
    for (const role of ["family", "reviewer"] as const) {
      handleMe(request(role), deps);
      await handleSamples(request(role), deps);
      await handleListEncounters(request(role), deps);
      await handleGetEncounter(request(role, { pathParameters: { id: ENCOUNTER } }), deps);
      await handleDeviceStatus(request(role, { query: { deviceId: DEVICE } }), deps);
    }

    const broken = readSetup();
    broken.repository.listEncounters = () => Promise.reject(leakyError());
    broken.repository.getEncounter = () => Promise.reject(leakyError());
    await expect(handleListEncounters(request("family"), broken.deps)).rejects.toThrow();
    await expect(
      handleGetEncounter(request("family", { pathParameters: { id: ENCOUNTER } }), broken.deps),
    ).rejects.toThrow();

    expectNoLeak();
  });
});

// ---------------------------------------------------------------------------------------------
// Commands and faces
// ---------------------------------------------------------------------------------------------

describe("commands core logs (R8.6, R25.1)", () => {
  it("keeps secrets out of the log for accepted, rejected and failed commands", async () => {
    const bus = new FakeDeviceBus();
    const repository = new FakeRepository(() => NOW_MS);
    let seq = 0;
    const deps: CommandDeps = {
      bus,
      repository,
      config: DEFAULT_CONFIG,
      lines: LINES,
      newId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
      nowMs: NOW_MS,
    };
    const post = (body: Record<string, unknown>, role: "family" | "reviewer" = "family") =>
      handlePostCommand({ role, body }, deps);

    await post({ deviceId: DEVICE, command: { type: "speak", data: { lineId: "fam_1" } } });
    await post({ deviceId: DEVICE, command: { type: "gaze", data: { panDeg: 10, tiltDeg: 5 } } });
    await expect(post({ deviceId: DEVICE, command: { type: "speak", data: { audioUrl: PRESIGNED_URL } } })).rejects.toThrow();
    await expect(post({ deviceId: PRESIGNED_URL, command: { type: "gaze", data: {} } })).rejects.toThrow();
    await expect(post({ deviceId: DEVICE, command: { type: "gaze", data: { panDeg: 1, tiltDeg: 1 } } }, "reviewer")).rejects.toThrow();
    repository.getDeviceStatus = () => Promise.reject(leakyError());
    bus.failNext(leakyError());
    await expect(post({ deviceId: DEVICE, command: { type: "lantern", data: { level: 1, fadeMs: 100 } } })).rejects.toThrow();

    expectNoLeak();
  });
});

class FakeStaging implements FaceStaging {
  readonly objects = new Map<string, Uint8Array>();
  failDelete = false;
  async createUpload(options: Parameters<FaceStaging["createUpload"]>[0]) {
    return { url: PRESIGNED_URL, fields: { key: options.key, policy: PRESIGNED_TOKEN } };
  }
  async read(key: string) {
    return this.objects.get(key) ?? null;
  }
  async delete(key: string) {
    if (this.failDelete) throw leakyError();
    this.objects.delete(key);
  }
}

describe("faces core logs (R8.6, R25.1)", () => {
  it("keeps secrets out of the log for list, upload, register, delete and their failures", async () => {
    const repository = new FakeRepository(() => NOW_MS);
    const faces = new FakeFaceSearch();
    const staging = new FakeStaging();
    let seq = 0;
    const deps: FacesDeps = {
      repository,
      faces,
      staging,
      collectionId: "warashi-household",
      consentNoticeVersion: "2026-11",
      nowMs: NOW_MS,
      newId: () => `22222222-2222-4222-8222-${String(++seq).padStart(12, "0")}`,
    };
    const request = (body: Record<string, unknown> = {}, extra: Partial<FacesRequest> = {}): FacesRequest => ({
      role: "family",
      userId: "user-1",
      body,
      pathParameters: {},
      ...extra,
    });
    const register = (over: Record<string, unknown> = {}) => {
      staging.objects.set("faces-staging/photo-1", JPEG_BYTES);
      return handleRegisterFace(
        request({
          stagingKey: "faces-staging/photo-1",
          displayName: DISPLAY_NAME,
          memberId: null,
          consent: { noticeVersion: "2026-11", accepted: true },
          ...over,
        }),
        deps,
      );
    };

    const registered = await register();
    await handleListFaces(request(), deps);
    await handleFaceUpload(request(), deps);

    // Failure paths: wrong consent, no face, two faces, index failure, cleanup failure.
    await expect(register({ consent: { noticeVersion: "old", accepted: true } })).rejects.toThrow();
    faces.queueIndexCount(0);
    await expect(register()).rejects.toThrow();
    faces.queueIndexCount(2);
    await expect(register()).rejects.toThrow();
    faces.failNextIndex(leakyError());
    await expect(register()).rejects.toThrow();
    staging.failDelete = true;
    await register({ memberId: registered.memberId }).catch(() => undefined);
    staging.failDelete = false;

    // Delete: failing vector delete keeps the record, then a clean delete.
    faces.failNextDelete(leakyError());
    await expect(
      handleDeleteFace(request({}, { pathParameters: { memberId: registered.memberId } }), deps),
    ).rejects.toThrow();
    await handleDeleteFace(request({}, { pathParameters: { memberId: registered.memberId } }), deps);

    // Reviewer attempts change nothing and log nothing sensitive.
    await expect(handleListFaces(request({}, { role: "reviewer" }), deps)).rejects.toThrow();

    expectNoLeak();
  });
});
