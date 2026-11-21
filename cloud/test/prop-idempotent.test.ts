/**
 * Property 12: Idempotent handling (cloud-judgement task 13.3).
 *
 * The same envelope id or `snapshotId` delivered N times (2 to 10) to the Judge core and the
 * Ingest core produces the side effects of one delivery. Runs on the in-memory fakes.
 *
 * **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.7**
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../lambda/_shared/config.js";
import { setLogSink } from "../lambda/_shared/safelog.js";
import type { SearchOutcome } from "../lambda/_shared/verdict.js";
import { handleIngest, type IngestDeps } from "../lambda/ingest/ingest-core.js";
import { handleSnapshot, type JudgeDeps, type SnapshotEvent } from "../lambda/judge/judge-core.js";
import {
  FakeDeviceBus,
  FakeFaceSearch,
  FakeNotifier,
  FakeRepository,
  FakeSnapshotStore,
  FakeStateStore,
} from "./fakes.js";

const FIXTURES = fileURLToPath(new URL("../../docs/fixtures/schema-v1/", import.meta.url));
const TS = "2026-11-20T12:34:56.789Z";
const NOW_MS = Date.parse(TS);
const DEVICE = "warashi-01";
const ENC = "c1d2e3f4-0000-4000-8000-000000000001";
const BOX = { left: 0.3, top: 0.2, width: 0.3, height: 0.4 };
const GOOD_QUALITY = { sharpness: 80, brightness: 120, yawDeg: 5 };

const OUTCOMES: Record<string, SearchOutcome> = {
  family: { kind: "face", box: BOX, faceConfidence: 99, bestSimilarity: 97 },
  stranger: { kind: "face", box: BOX, faceConfidence: 99, bestSimilarity: null },
  no_face: { kind: "no_face" },
};

let restoreSink: (line: string) => void;
beforeEach(() => {
  restoreSink = setLogSink(() => undefined);
});
afterEach(() => {
  setLogSink(restoreSink);
});

// ---------------------------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------------------------

function snapshotEvent(snapshotId: string, messageId: string): SnapshotEvent {
  const bytes = new Uint8Array(500);
  bytes.set([0xff, 0xd8, 0xff]);
  return {
    v: 1,
    id: messageId,
    ts: TS,
    deviceId: DEVICE,
    encounterId: ENC,
    type: "snapshot.captured",
    data: {
      snapshotId,
      width: 640,
      height: 480,
      panDeg: 0,
      tiltDeg: 0,
      jpegBase64: Buffer.from(bytes).toString("base64"),
    },
    topicDeviceId: DEVICE,
  };
}

async function runJudge(kind: string, snapshotId: string, deliveries: number, concurrent: boolean) {
  const now = (): number => NOW_MS;
  const repository = new FakeRepository(now);
  const state = new FakeStateStore({ now, repository });
  const faces = new FakeFaceSearch();
  faces.defaultSearch = OUTCOMES[kind] as SearchOutcome;
  faces.defaultDetect = { faces: 1, quality: GOOD_QUALITY, box: BOX };
  const snapshots = new FakeSnapshotStore();
  const bus = new FakeDeviceBus();
  const notifier = new FakeNotifier();
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
    sleep: () => new Promise<void>(() => undefined), // never resolves: no publish timeout
  };
  const event = snapshotEvent(snapshotId, "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10");
  if (concurrent) {
    await Promise.all(Array.from({ length: deliveries }, () => handleSnapshot(event, deps)));
  } else {
    for (let i = 0; i < deliveries; i += 1) await handleSnapshot(event, deps);
  }
  return {
    published: bus.published,
    events: await repository.listEvents(ENC),
    meta: await repository.getEncounter(ENC, NOW_MS),
    sent: notifier.sent,
    searches: faces.searchCalls.length,
    puts: snapshots.putCalls,
    objects: snapshots.objects.size,
  };
}

describe("Judge idempotency", () => {
  it("Feature: cloud-judgement, Property 12: Idempotent handling (Judge)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("family", "stranger", "no_face"),
        fc.stringMatching(/^[A-Za-z0-9_-]{1,40}$/),
        fc.integer({ min: 2, max: 10 }),
        fc.boolean(),
        async (kind, snapshotId, n, concurrent) => {
          const once = await runJudge(kind, snapshotId, 1, false);
          const many = await runJudge(kind, snapshotId, n, concurrent);
          expect(many).toEqual(once);
          expect(many.published).toHaveLength(1);
          expect(many.events).toHaveLength(1);
          expect(many.searches).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

const ENCOUNTER_TYPES = [
  "presence.detected",
  "snapshot.captured",
  "state.changed",
  "reaction.performed",
  "encounter.ended",
  "error.reported",
] as const;
const ALL_TYPES = [...ENCOUNTER_TYPES, "status.report", "status.offline"] as const;

function fixture(type: string, id: string): Json {
  const base = JSON.parse(readFileSync(`${FIXTURES}${type}.json`, "utf8")) as Json;
  return { ...base, id, topicDeviceId: base["deviceId"] };
}

type FailPoint = "none" | "appendEvent" | "updateEncounter";

/**
 * A repository whose chosen method rejects on its first call only, to model a failed write that
 * the redelivery then completes (R4.5, R10.10).
 */
function flakyRepo(repo: FakeRepository, method: FailPoint): FakeRepository {
  if (method === "none") return repo;
  const wrapped = Object.create(repo) as FakeRepository;
  const original = repo[method].bind(repo) as (...args: unknown[]) => Promise<unknown>;
  let failed = false;
  (wrapped as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
    if (!failed) {
      failed = true;
      throw new Error(`${method} failed`);
    }
    return original(...args);
  };
  return wrapped;
}

async function runIngest(type: string, deliveries: number, failPoint: FailPoint) {
  const repo = new FakeRepository(() => NOW_MS);
  const state = new FakeStateStore({ now: () => NOW_MS });
  const deps: IngestDeps = { repo: flakyRepo(repo, failPoint), state, nowMs: () => NOW_MS };
  const message = fixture(type, "00000000-0000-4000-8000-0000000000aa");
  for (let i = 0; i < deliveries; i += 1) {
    try {
      await handleIngest(message, deps);
    } catch {
      // A failed write throws so the broker redelivers; the next loop turn is that redelivery.
    }
  }
  return {
    events: await repo.listEvents(ENC),
    meta: await repo.getEncounter(ENC, NOW_MS),
    status: await repo.getDeviceStatus(DEVICE),
  };
}

describe("Ingest idempotency", () => {
  it("Feature: cloud-judgement, Property 12: Idempotent handling (Ingest redelivery)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_TYPES),
        fc.integer({ min: 2, max: 10 }),
        async (type, n) => {
          const once = await runIngest(type, 1, "none");
          const many = await runIngest(type, n, "none");
          expect(many).toEqual(once);
          expect(many.events.length).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Feature: cloud-judgement, Property 12: Idempotent handling (Ingest after a failed write)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ENCOUNTER_TYPES),
        fc.constantFrom<FailPoint>("appendEvent", "updateEncounter"),
        fc.integer({ min: 2, max: 10 }),
        async (type, failPoint, n) => {
          const once = await runIngest(type, 1, "none");
          const many = await runIngest(type, n, failPoint);
          expect(many).toEqual(once);
        },
      ),
      { numRuns: 100 },
    );
  });
});
