/**
 * Unit tests for the Judge core (`handleSnapshot`), cloud-judgement task 12.2.
 *
 * Everything runs on the in-memory fakes with a fake clock. No network, no AWS.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAIM_TTL_S,
  decodeJpeg,
  handleSnapshot,
  LOOK_TTL_S,
  type LookStore,
  PUBLISH_TIMEOUT_MS,
  type JudgeDeps,
  type SnapshotEvent,
} from "../lambda/judge/judge-core.js";
import { DEFAULT_CONFIG } from "../lambda/_shared/config.js";
import { setLogSink } from "../lambda/_shared/safelog.js";
import type { SearchOutcome } from "../lambda/_shared/verdict.js";
import {
  FakeAwsError,
  FakeDeviceBus,
  FakeFaceSearch,
  FakeNotifier,
  FakeRepository,
  FakeSnapshotStore,
  FakeStateStore,
} from "./fakes.js";

const DEVICE = "warashi-01";
const ENCOUNTER = "c1d2e3f4-0000-4000-8000-000000000001";
const TS = "2026-11-20T12:34:56.789Z";
const T0 = Date.parse(TS);

const BOX = { left: 0.3, top: 0.2, width: 0.3, height: 0.4 };
const GOOD_QUALITY = { sharpness: 80, brightness: 120, yawDeg: 5 };

const FAMILY: SearchOutcome = { kind: "face", box: BOX, faceConfidence: 99, bestSimilarity: 97 };
const STRANGER: SearchOutcome = { kind: "face", box: BOX, faceConfidence: 99, bestSimilarity: null };
const BAND: SearchOutcome = { kind: "face", box: BOX, faceConfidence: 99, bestSimilarity: 80 };

/** A fake that can move the clock while a search runs, to model a slow Rekognition call. */
class SlowFaceSearch extends FakeFaceSearch {
  constructor(private readonly clock: { t: number }) {
    super();
  }
  searchCostMs = 0;
  override async search(...args: Parameters<FakeFaceSearch["search"]>): ReturnType<FakeFaceSearch["search"]> {
    this.clock.t += this.searchCostMs;
    return super.search(...args);
  }
}

function jpegBase64(size = 1000): string {
  const bytes = new Uint8Array(size);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return Buffer.from(bytes).toString("base64");
}

function snapshotEvent(
  overrides: {
    snapshotId?: string;
    jpeg?: string;
    encounterId?: string | null;
    id?: string;
    requestId?: string | null;
  } = {},
): SnapshotEvent {
  return {
    v: 1,
    id: overrides.id ?? "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10",
    ts: TS,
    deviceId: DEVICE,
    encounterId: overrides.encounterId === undefined ? ENCOUNTER : overrides.encounterId,
    type: "snapshot.captured",
    data: {
      snapshotId: overrides.snapshotId ?? "snap-1",
      width: 640,
      height: 480,
      panDeg: 0,
      tiltDeg: 0,
      jpegBase64: overrides.jpeg ?? jpegBase64(),
      requestId: overrides.requestId === undefined ? null : overrides.requestId,
    },
    topicDeviceId: DEVICE,
  };
}

type Harness = {
  deps: JudgeDeps;
  clock: { t: number };
  faces: SlowFaceSearch;
  snapshots: FakeSnapshotStore;
  bus: FakeDeviceBus;
  notifier: FakeNotifier;
  state: FakeStateStore;
  repository: FakeRepository;
  sleeps: number[];
  /** When true, `sleep(2000)` resolves, so a hanging publish times out. */
  fireTimeout: { on: boolean };
  logs: Record<string, unknown>[];
};

let h: Harness;
let restoreSink: ReturnType<typeof setLogSink>;

beforeEach(() => {
  const clock = { t: T0 };
  const now = (): number => clock.t;
  const repository = new FakeRepository(now);
  const state = new FakeStateStore({ now, repository });
  const faces = new SlowFaceSearch(clock);
  const snapshots = new FakeSnapshotStore();
  const bus = new FakeDeviceBus();
  const notifier = new FakeNotifier();
  const sleeps: number[] = [];
  const fireTimeout = { on: false };
  const logs: Record<string, unknown>[] = [];
  restoreSink = setLogSink((line) => {
    logs.push(JSON.parse(line) as Record<string, unknown>);
  });
  let idSeq = 0;
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
    now,
    random: () => 0,
    newId: () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`,
    sleep: (ms) => {
      sleeps.push(ms);
      // Short sleeps (retry jitter) return at once. The publish limit fires only on request.
      if (ms < PUBLISH_TIMEOUT_MS || fireTimeout.on) return Promise.resolve();
      return new Promise<void>(() => undefined);
    },
  };
  h = { deps, clock, faces, snapshots, bus, notifier, state, repository, sleeps, fireTimeout, logs };
});

afterEach(() => {
  setLogSink(restoreSink);
});

function logged(event: string): Record<string, unknown>[] {
  return h.logs.filter((line) => line["event"] === event);
}

/** Sleeps other than the 2 s publish limit, which are the retry delays. */
function retryDelays(): number[] {
  return h.sleeps.filter((ms) => ms < PUBLISH_TIMEOUT_MS);
}

function expectNoSideEffects(): void {
  expect(h.faces.searchCalls).toHaveLength(0);
  expect(h.snapshots.putCalls).toHaveLength(0);
  expect(h.bus.published).toHaveLength(0);
  expect(h.repository.hasEncounter(ENCOUNTER)).toBe(false);
}

describe("verdicts", () => {
  it("family: publishes judgement.result, stores the image, records, does not notify", async () => {
    h.faces.queueSearch(FAMILY);
    const result = await handleSnapshot(snapshotEvent(), h.deps);

    expect(result).toEqual({ outcome: "judged", verdict: "family", published: true, stored: true, notified: false });
    expect(h.bus.published).toHaveLength(1);
    const sent = h.bus.published[0]!;
    expect(sent.topic).toBe(`warashi/${DEVICE}/commands`);
    expect(sent.envelope.type).toBe("judgement.result");
    expect(sent.envelope.encounterId).toBe(ENCOUNTER);
    expect(sent.envelope.data).toMatchObject({ snapshotId: "snap-1", verdict: "family", confidence: 0.97, face: BOX });
    // R6.5: no speak on this path.
    expect(h.bus.published.some((m) => m.envelope.type === "speak")).toBe(false);
    expect(h.snapshots.putCalls).toEqual([`snapshots/${DEVICE}/20261120/snap-1.jpg`]);
    expect(h.faces.detectCalls).toHaveLength(0);
    expect(h.notifier.sent).toHaveLength(0);

    const meta = await h.repository.getEncounter(ENCOUNTER, h.clock.t);
    expect(meta).toMatchObject({
      verdict: "family",
      confidence: 0.97,
      snapshotKey: `snapshots/${DEVICE}/20261120/snap-1.jpg`,
    });
    const events = await h.repository.listEvents(ENCOUNTER);
    expect(events.map((e) => e.type)).toEqual(["judgement.result"]);
  });

  it("stranger: runs DetectFaces, publishes and notifies once", async () => {
    h.faces.queueSearch(STRANGER).queueDetect({ faces: 1, quality: GOOD_QUALITY, box: BOX });
    const result = await handleSnapshot(snapshotEvent(), h.deps);

    expect(result).toEqual({ outcome: "judged", verdict: "stranger", published: true, stored: true, notified: true });
    expect(h.faces.detectCalls).toHaveLength(1);
    expect(h.notifier.sent).toHaveLength(1);
    expect(h.repository.isNotified(ENCOUNTER)).toBe(true);
  });

  it("no face: SearchFacesByImage reporting no face gives no_face with confidence 1", async () => {
    h.faces.queueSearch({ kind: "no_face" });
    const result = await handleSnapshot(snapshotEvent(), h.deps);

    expect(result).toMatchObject({ outcome: "judged", verdict: "no_face", published: true });
    expect(h.bus.published[0]!.envelope.data).toMatchObject({ verdict: "no_face", confidence: 1, face: null });
  });

  it("uncertain band: a middle similarity is never a stranger and does not call DetectFaces", async () => {
    h.faces.queueSearch(BAND);
    const result = await handleSnapshot(snapshotEvent(), h.deps);

    expect(result).toMatchObject({ outcome: "judged", verdict: "uncertain", notified: false });
    expect(h.faces.detectCalls).toHaveLength(0);
    expect(h.notifier.attempts).toBe(0);
  });

  it("a stranger candidate with poor face quality is uncertain", async () => {
    h.faces.queueSearch(STRANGER).queueDetect({ faces: 1, quality: { ...GOOD_QUALITY, sharpness: 1 }, box: BOX });
    const result = await handleSnapshot(snapshotEvent(), h.deps);
    expect(result).toMatchObject({ verdict: "uncertain", notified: false });
  });
});

describe("adapter failures (R5.7, R5.9)", () => {
  it("a search failure gives uncertain with confidence 0 and no DetectFaces", async () => {
    h.faces.queueSearchError(new Error("boom"));
    const result = await handleSnapshot(snapshotEvent(), h.deps);

    expect(result).toMatchObject({ verdict: "uncertain", published: true, notified: false });
    expect(h.bus.published[0]!.envelope.data).toMatchObject({ verdict: "uncertain", confidence: 0, face: null });
    expect(h.faces.detectCalls).toHaveLength(0);
    expect(logged("search_failed")).toHaveLength(1);
  });

  it("InvalidParameterException followed by zero detected faces is no_face", async () => {
    h.faces.queueSearchError(new FakeAwsError("InvalidParameterException"));
    h.faces.queueDetect({ faces: 0, quality: null, box: null });
    const result = await handleSnapshot(snapshotEvent(), h.deps);
    expect(result).toMatchObject({ verdict: "no_face" });
  });

  it("InvalidParameterException with a face present is a failure, so uncertain", async () => {
    h.faces.queueSearchError(new FakeAwsError("InvalidParameterException"));
    h.faces.queueDetect({ faces: 1, quality: GOOD_QUALITY, box: BOX });
    const result = await handleSnapshot(snapshotEvent(), h.deps);
    expect(result).toMatchObject({ verdict: "uncertain" });
  });

  it("InvalidParameterException and a failing DetectFaces is uncertain", async () => {
    h.faces.queueSearchError(new FakeAwsError("InvalidParameterException"));
    h.faces.queueDetectError(new Error("detect failed"));
    const result = await handleSnapshot(snapshotEvent(), h.deps);

    expect(result).toMatchObject({ verdict: "uncertain", published: true });
    expect(logged("detect_failed")).toHaveLength(1);
  });

  it("a failing DetectFaces for a stranger candidate makes the verdict uncertain, never stranger", async () => {
    h.faces.queueSearch(STRANGER).queueDetectError(new Error("detect failed"));
    const result = await handleSnapshot(snapshotEvent(), h.deps);

    expect(result).toMatchObject({ verdict: "uncertain", notified: false });
    expect(h.notifier.attempts).toBe(0);
  });

  it("a snapshot store failure still publishes the verdict and records no snapshot key", async () => {
    h.snapshots.failNextPut();
    h.faces.queueSearch(FAMILY);
    const result = await handleSnapshot(snapshotEvent(), h.deps);

    expect(result).toEqual({ outcome: "judged", verdict: "family", published: true, stored: false, notified: false });
    expect(h.bus.published).toHaveLength(1);
    expect(logged("snapshot_store_failed")).toHaveLength(1);
    const meta = await h.repository.getEncounter(ENCOUNTER, h.clock.t);
    expect(meta?.snapshotKey).toBeNull();
    expect(meta?.verdict).toBe("family");
  });
});

describe("throttling (R5.10)", () => {
  it("retries once after a 50 to 250 ms jitter when under 1.5 s", async () => {
    h.faces.queueSearchThrottle().queueSearch(FAMILY);
    const result = await handleSnapshot(snapshotEvent(), h.deps);

    expect(result).toMatchObject({ verdict: "family" });
    expect(h.faces.searchCalls).toHaveLength(2);
    expect(retryDelays()).toEqual([50]);
  });

  it("jitter follows the injected random value and stays within 50 to 250 ms", async () => {
    h.deps.random = () => 0.999;
    h.faces.queueSearchThrottle().queueSearch(FAMILY);
    await handleSnapshot(snapshotEvent(), h.deps);
    expect(retryDelays()).toEqual([249]);
  });

  it("does not retry when 1.5 s have already passed", async () => {
    h.faces.searchCostMs = 1_500;
    h.faces.queueSearchThrottle().queueSearch(FAMILY);
    const result = await handleSnapshot(snapshotEvent(), h.deps);

    expect(result).toMatchObject({ verdict: "uncertain", published: true });
    expect(h.faces.searchCalls).toHaveLength(1);
    expect(retryDelays()).toEqual([]);
  });

  it("retries at 1,499 ms elapsed", async () => {
    h.faces.searchCostMs = 1_499;
    h.faces.queueSearchThrottle().queueSearch(FAMILY);
    const result = await handleSnapshot(snapshotEvent(), h.deps);

    expect(result).toMatchObject({ verdict: "family" });
    expect(h.faces.searchCalls).toHaveLength(2);
  });

  it("retries only once: a second throttle gives uncertain", async () => {
    h.faces.queueSearchThrottle().queueSearchThrottle().queueSearch(FAMILY);
    const result = await handleSnapshot(snapshotEvent(), h.deps);

    expect(result).toMatchObject({ verdict: "uncertain" });
    expect(h.faces.searchCalls).toHaveLength(2);
  });
});

describe("input checks (R2.4, R2.8)", () => {
  it("ignores a payload without the JPEG signature and has no side effect", async () => {
    const notJpeg = Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])).toString("base64");
    const result = await handleSnapshot(snapshotEvent({ jpeg: notJpeg }), h.deps);

    expect(result).toEqual({ outcome: "ignored", reason: "bad_jpeg_signature" });
    expectNoSideEffects();
  });

  it("ignores a payload under 3 bytes", async () => {
    const tiny = Buffer.from(new Uint8Array([0xff, 0xd8])).toString("base64");
    const result = await handleSnapshot(snapshotEvent({ jpeg: tiny }), h.deps);

    expect(result).toEqual({ outcome: "ignored", reason: "jpeg_too_small" });
    expectNoSideEffects();
  });

  it("ignores an empty payload", async () => {
    const result = await handleSnapshot(snapshotEvent({ jpeg: "" }), h.deps);
    expect(result.outcome).toBe("ignored");
    expectNoSideEffects();
  });

  it("ignores text that is not strict base64", async () => {
    const result = await handleSnapshot(snapshotEvent({ jpeg: "not base64!!" }), h.deps);
    expect(result).toEqual({ outcome: "ignored", reason: "invalid_base64" });
    expectNoSideEffects();
  });

  it("ignores an image above 100,000 bytes and has no side effect", async () => {
    const result = await handleSnapshot(snapshotEvent({ jpeg: jpegBase64(100_001) }), h.deps);

    // The envelope size limit of the decoder may reject it first; either way it is ignored.
    expect(result.outcome).toBe("ignored");
    expectNoSideEffects();
  });

  it("decodeJpeg names the size reason at the 100,000 byte boundary", () => {
    expect(decodeJpeg(jpegBase64(100_000)).ok).toBe(true);
    expect(decodeJpeg(jpegBase64(100_001))).toEqual({ ok: false, reason: "jpeg_too_large" });
    expect(decodeJpeg("A".repeat(140_000))).toEqual({ ok: false, reason: "jpeg_too_large" });
    expect(decodeJpeg(Buffer.from([0xff, 0xd8, 0xff]).toString("base64")).ok).toBe(true);
  });

  it("ignores a snapshot id with characters that are unsafe in a key", async () => {
    const result = await handleSnapshot(snapshotEvent({ snapshotId: "../evil" }), h.deps);
    expect(result).toEqual({ outcome: "ignored", reason: "bad_snapshot_id" });
    expectNoSideEffects();
  });

  it("ignores a message whose deviceId differs from the topic", async () => {
    const result = await handleSnapshot({ ...snapshotEvent(), topicDeviceId: "warashi-02" }, h.deps);
    expect(result).toEqual({ outcome: "ignored", reason: "security_mismatch" });
    expectNoSideEffects();
  });
});

describe("duplicates", () => {
  it("a redelivered snapshot does nothing and a different snapshot id is judged", async () => {
    h.faces.queueSearch(FAMILY, FAMILY);
    await handleSnapshot(snapshotEvent(), h.deps);
    const again = await handleSnapshot(snapshotEvent({ id: "2b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10" }), h.deps);

    expect(again).toEqual({ outcome: "duplicate" });
    expect(h.faces.searchCalls).toHaveLength(1);
    expect(h.bus.published).toHaveLength(1);

    const other = await handleSnapshot(snapshotEvent({ snapshotId: "snap-2" }), h.deps);
    expect(other).toMatchObject({ outcome: "judged" });
  });

  it("claims the snapshot for a day", async () => {
    expect(CLAIM_TTL_S).toBe(86_400);
    h.faces.queueSearch(FAMILY, FAMILY);
    await handleSnapshot(snapshotEvent(), h.deps);
    h.clock.t += (CLAIM_TTL_S + 1) * 1000;
    const later = await handleSnapshot(snapshotEvent(), h.deps);
    expect(later.outcome).toBe("judged");
  });
});

describe("publishing (R6.6, R6.9)", () => {
  it("a publish failure still writes the table and logs publish_failed", async () => {
    h.bus.failNext();
    h.faces.queueSearch(FAMILY);
    const result = await handleSnapshot(snapshotEvent(), h.deps);

    expect(result).toEqual({ outcome: "judged", verdict: "family", published: false, stored: true, notified: false });
    expect(logged("publish_failed")).toHaveLength(1);
    const meta = await h.repository.getEncounter(ENCOUNTER, h.clock.t);
    expect(meta?.verdict).toBe("family");
    expect(await h.repository.listEvents(ENCOUNTER)).toHaveLength(1);
  });

  it("a publish that does not finish within 2 s counts as failed, and the table is still written", async () => {
    h.bus.delayMs = 60_000; // never completes during the test
    h.fireTimeout.on = true;
    h.faces.queueSearch(FAMILY);
    const result = await handleSnapshot(snapshotEvent(), h.deps);

    expect(result).toMatchObject({ outcome: "judged", published: false });
    expect(h.sleeps).toContain(PUBLISH_TIMEOUT_MS);
    expect(logged("publish_failed")[0]).toMatchObject({ reason: "timeout" });
    const meta = await h.repository.getEncounter(ENCOUNTER, h.clock.t);
    expect(meta?.verdict).toBe("family");
  });

  it("passes a null encounterId through and writes no encounter or notification", async () => {
    h.faces.queueSearch(STRANGER).queueDetect({ faces: 1, quality: GOOD_QUALITY, box: BOX });
    const result = await handleSnapshot(snapshotEvent({ encounterId: null }), h.deps);

    expect(result).toMatchObject({ outcome: "judged", verdict: "stranger", published: true, notified: false });
    expect(h.bus.published[0]!.envelope.encounterId).toBeNull();
    expect(h.notifier.attempts).toBe(0);
    expect(logged("record_skipped")).toHaveLength(1);
  });
});

describe("notification (R9.7, R9.8)", () => {
  const strangerSetup = (): void => {
    h.faces.queueSearch(STRANGER).queueDetect({ faces: 1, quality: GOOD_QUALITY, box: BOX });
  };

  it("success: one message that names the device label and carries no image data", async () => {
    strangerSetup();
    await handleSnapshot(snapshotEvent(), h.deps);

    expect(h.notifier.sent).toHaveLength(1);
    const text = `${h.notifier.sent[0]!.subject}\n${h.notifier.sent[0]!.body}`;
    expect(text).toContain("Test doll");
    expect(text).not.toContain("jpeg");
  });

  it("send failure: the slot is released, the verdict stays published, and a later snapshot may notify", async () => {
    h.notifier.failNext();
    strangerSetup();
    const first = await handleSnapshot(snapshotEvent(), h.deps);

    expect(first).toMatchObject({ verdict: "stranger", published: true, notified: false });
    expect(h.notifier.attempts).toBe(1);
    expect(h.repository.isNotified(ENCOUNTER)).toBe(false);
    expect(await h.state.lastNotifiedAtMs(DEVICE)).toBeNull();
    expect(logged("notify_failed")).toHaveLength(1);

    strangerSetup();
    const second = await handleSnapshot(snapshotEvent({ snapshotId: "snap-2" }), h.deps);
    expect(second).toMatchObject({ notified: true });
    expect(h.notifier.sent).toHaveLength(1);
  });

  it("a second stranger snapshot of the same encounter does not notify again", async () => {
    strangerSetup();
    await handleSnapshot(snapshotEvent(), h.deps);
    strangerSetup();
    const second = await handleSnapshot(snapshotEvent({ snapshotId: "snap-2" }), h.deps);

    expect(second).toMatchObject({ verdict: "stranger", notified: false });
    expect(h.notifier.sent).toHaveLength(1);
  });

  it("a stranger in another encounter inside the window does not notify, and one after the window does", async () => {
    strangerSetup();
    await handleSnapshot(snapshotEvent(), h.deps);

    h.clock.t += DEFAULT_CONFIG.notifyWindowMs - 1;
    strangerSetup();
    const inside = await handleSnapshot(
      snapshotEvent({ snapshotId: "snap-2", encounterId: "c1d2e3f4-0000-4000-8000-000000000002" }),
      h.deps,
    );
    expect(inside).toMatchObject({ verdict: "stranger", published: true, notified: false });
    expect(h.notifier.sent).toHaveLength(1);

    h.clock.t += 1;
    strangerSetup();
    const after = await handleSnapshot(
      snapshotEvent({ snapshotId: "snap-3", encounterId: "c1d2e3f4-0000-4000-8000-000000000003" }),
      h.deps,
    );
    expect(after).toMatchObject({ notified: true });
    expect(h.notifier.sent).toHaveLength(2);
  });
});

describe("look result for a snapshot.request (voice-conversation R8.6, R15.4)", () => {
  type Put = { requestId: string; verdict: string; atMs: number; ttlS: number };
  let puts: Put[];
  let failPut: boolean;

  beforeEach(() => {
    puts = [];
    failPut = false;
    const looks: LookStore = {
      putLook: async (requestId, verdict, atMs, ttlS) => {
        if (failPut) throw new Error("dynamo down");
        puts.push({ requestId, verdict, atMs, ttlS });
      },
    };
    h.deps.looks = looks;
  });

  it("writes the verdict under the requestId for 10 minutes", async () => {
    h.faces.queueSearch(FAMILY);
    await handleSnapshot(snapshotEvent({ requestId: "req-1" }), h.deps);
    expect(puts).toEqual([{ requestId: "req-1", verdict: "family", atMs: T0, ttlS: 600 }]);
    expect(LOOK_TTL_S).toBe(600);
  });

  it("writes nothing when the snapshot carries no requestId", async () => {
    h.faces.queueSearch(FAMILY);
    await handleSnapshot(snapshotEvent(), h.deps);
    expect(puts).toEqual([]);
  });

  it("a stranger look still records the verdict and sends the single notification", async () => {
    h.faces.queueSearch(STRANGER).queueDetect({ faces: 1, quality: GOOD_QUALITY, box: BOX });
    const result = await handleSnapshot(snapshotEvent({ requestId: "req-2" }), h.deps);
    expect(puts.map((p) => p.verdict)).toEqual(["stranger"]);
    expect(result).toMatchObject({ outcome: "judged", verdict: "stranger", published: true, notified: true });
    expect(h.notifier.sent).toHaveLength(1);
  });

  it("a failing look write does not change the verdict, the publish or the record", async () => {
    failPut = true;
    h.faces.queueSearch(FAMILY);
    const result = await handleSnapshot(snapshotEvent({ requestId: "req-3" }), h.deps);
    expect(result).toMatchObject({ outcome: "judged", verdict: "family", published: true });
    expect(logged("look_write_failed")).toHaveLength(1);
  });
});

describe("logging (R8.5)", () => {
  it("never logs image text or the similarity of a discarded match", async () => {
    h.faces.queueSearch({ kind: "face", box: BOX, faceConfidence: 99, bestSimilarity: 61.234 });
    h.faces.queueDetect({ faces: 1, quality: GOOD_QUALITY, box: BOX });
    const jpeg = jpegBase64(2000);
    await handleSnapshot(snapshotEvent({ jpeg }), h.deps);

    const all = JSON.stringify(h.logs);
    expect(all).not.toContain(jpeg.slice(0, 40));
    expect(all).not.toContain("61.234");
  });
});
