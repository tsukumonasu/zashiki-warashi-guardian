/**
 * Property 13: Spoof guard (cloud-judgement task 13.4).
 *
 * A message whose `deviceId` differs from `topicDeviceId` (including a missing, non-string or
 * empty `deviceId`, and a missing or non-string `topicDeviceId`) causes no write, no publish, no
 * notification and no search. The log has a `security_mismatch` entry without any payload.
 *
 * Runs the Ingest core and the Judge core on the in-memory fakes. No network, no AWS.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../lambda/_shared/config.js";
import { setLogSink } from "../lambda/_shared/safelog.js";
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
const NOW_MS = Date.parse("2026-11-20T13:00:00.000Z");
const NUM_RUNS = 150;
const SECRET_DEVICE_ID = "attacker-claimed-device";

type Json = Record<string, unknown>;

/** Device-to-cloud fixture types that the ingest rules deliver. */
const INGEST_TYPES = readdirSync(FIXTURES)
  .map((name) => name.replace(/\.json$/, ""))
  .filter((type) =>
    [
      "presence.detected",
      "snapshot.captured",
      "state.changed",
      "reaction.performed",
      "encounter.ended",
      "error.reported",
      "status.report",
      "status.offline",
    ].includes(type),
  );

function fixture(type: string): Json {
  return JSON.parse(readFileSync(`${FIXTURES}${type}.json`, "utf8")) as Json;
}

/** A `deviceId` value that is a mismatch whatever the topic id is, or a bad topic id. */
type Spoof = { deviceId: unknown; topicDeviceId: unknown; omitDeviceId: boolean; omitTopic: boolean };

const topicIdArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,20}$/);

const spoofArb: fc.Arbitrary<Spoof> = fc.oneof(
  // A different string. Case and whitespace variants are mismatches too (exact comparison).
  fc
    .tuple(topicIdArb, fc.string({ maxLength: 20 }))
    .filter(([topic, other]) => topic !== other)
    .map(([topic, other]) => ({ deviceId: other, topicDeviceId: topic, omitDeviceId: false, omitTopic: false })),
  topicIdArb.map((topic) => ({
    deviceId: `${topic} `,
    topicDeviceId: topic,
    omitDeviceId: false,
    omitTopic: false,
  })),
  topicIdArb.map((topic) => ({
    deviceId: topic.toUpperCase() === topic ? topic.toLowerCase() + "x" : topic.toUpperCase(),
    topicDeviceId: topic,
    omitDeviceId: false,
    omitTopic: false,
  })),
  // Empty deviceId.
  topicIdArb.map((topic) => ({ deviceId: "", topicDeviceId: topic, omitDeviceId: false, omitTopic: false })),
  // Missing deviceId.
  topicIdArb.map((topic) => ({ deviceId: undefined, topicDeviceId: topic, omitDeviceId: true, omitTopic: false })),
  // Non-string deviceId.
  fc
    .tuple(
      topicIdArb,
      fc.oneof(
        fc.integer(),
        fc.double({ noNaN: true }),
        fc.boolean(),
        fc.constant(null),
        fc.array(fc.string(), { maxLength: 2 }),
        fc.dictionary(fc.string({ maxLength: 5 }), fc.string({ maxLength: 5 }), { maxKeys: 2 }),
      ),
    )
    .map(([topic, bad]) => ({ deviceId: bad, topicDeviceId: topic, omitDeviceId: false, omitTopic: false })),
  // Valid deviceId, but the topic id is missing, empty or not a string.
  fc
    .tuple(
      topicIdArb,
      fc.oneof(fc.constant(""), fc.integer(), fc.boolean(), fc.constant(null), fc.constant([] as unknown[])),
    )
    .map(([device, bad]) => ({ deviceId: device, topicDeviceId: bad, omitDeviceId: false, omitTopic: false })),
  topicIdArb.map((device) => ({ deviceId: device, topicDeviceId: undefined, omitDeviceId: false, omitTopic: true })),
);

function spoofed(base: Json, spoof: Spoof, uniqueId: string): Json {
  const message: Json = { ...base, id: uniqueId };
  if (spoof.omitDeviceId) delete message["deviceId"];
  else message["deviceId"] = spoof.deviceId;
  if (!spoof.omitTopic) message["topicDeviceId"] = spoof.topicDeviceId;
  return message;
}

let lines: Json[];
let restoreSink: ReturnType<typeof setLogSink>;
beforeEach(() => {
  lines = [];
  restoreSink = setLogSink((line) => {
    lines.push(JSON.parse(line) as Json);
  });
});
afterEach(() => {
  setLogSink(restoreSink);
});

/** The log has exactly the mismatch entry, and it holds ids only, no payload. */
function expectMismatchLog(messageId: string): void {
  const entries = lines.filter((line) => line["event"] === "security_mismatch");
  expect(entries).toHaveLength(1);
  const entry = entries[0] as Json;
  expect(Object.keys(entry).sort()).toEqual(["event", "id", "topicDeviceId"]);
  expect(entry["id"]).toBe(messageId);
  const text = JSON.stringify(lines);
  expect(text).not.toContain("jpegBase64");
  expect(text).not.toContain("/9j/");
}

describe("Feature: cloud-judgement, Property 13: Spoof guard", () => {
  it("fixtures for every ingest type exist", () => {
    expect(INGEST_TYPES.length).toBe(8);
  });

  it("Ingest drops a mismatched sender with no write and logs security_mismatch", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...INGEST_TYPES), spoofArb, fc.uuid(), async (type, spoof, uuid) => {
        lines = [];
        const repo = new FakeRepository(() => NOW_MS);
        const state = new FakeStateStore({ now: () => NOW_MS, repository: repo });
        const deps: IngestDeps = { repo, state, nowMs: () => NOW_MS };
        const message = spoofed(fixture(type), spoof, uuid);

        const result = await handleIngest(message, deps);

        expect(result).toEqual({ outcome: "mismatch" });
        const encounterId = fixture(type)["encounterId"];
        if (typeof encounterId === "string") {
          expect(repo.hasEncounter(encounterId)).toBe(false);
          expect(await repo.listEvents(encounterId)).toEqual([]);
        }
        // Status table: nothing written for either device id.
        expect(await repo.getDeviceStatus(String(fixture(type)["deviceId"]))).toBeNull();
        if (typeof spoof.deviceId === "string") expect(await repo.getDeviceStatus(spoof.deviceId)).toBeNull();
        if (typeof spoof.topicDeviceId === "string") {
          expect(await repo.getDeviceStatus(spoof.topicDeviceId)).toBeNull();
        }
        // No claim was taken: the id can still be claimed.
        expect(await state.claim(`MSG#${uuid}`, 60)).toBe(true);
        expectMismatchLog(uuid);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Judge drops a mismatched sender with no search, store, publish, write or notification", async () => {
    await fc.assert(
      fc.asyncProperty(spoofArb, fc.uuid(), async (spoof, uuid) => {
        lines = [];
        const repository = new FakeRepository(() => NOW_MS);
        const state = new FakeStateStore({ now: () => NOW_MS, repository });
        const faces = new FakeFaceSearch();
        const snapshots = new FakeSnapshotStore();
        const bus = new FakeDeviceBus();
        const notifier = new FakeNotifier();
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
          newId: () => "00000000-0000-4000-8000-000000000001",
          sleep: () => new Promise<void>(() => undefined),
        };
        const base = fixture("snapshot.captured");
        const message = spoofed(base, spoof, uuid) as SnapshotEvent;
        const snapshotId = (base["data"] as Json)["snapshotId"] as string;
        const encounterId = base["encounterId"] as string;

        const result = await handleSnapshot(message, deps);

        expect(result).toEqual({ outcome: "ignored", reason: "security_mismatch" });
        expect(faces.searchCalls).toHaveLength(0);
        expect(faces.detectCalls).toHaveLength(0);
        expect(snapshots.putCalls).toHaveLength(0);
        expect(bus.published).toHaveLength(0);
        expect(notifier.attempts).toBe(0);
        expect(repository.hasEncounter(encounterId)).toBe(false);
        expect(await repository.listEvents(encounterId)).toEqual([]);
        expect(await state.claim(`SNAP#${snapshotId}`, 60)).toBe(true);
        expectMismatchLog(uuid);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("the log never repeats the claimed deviceId", async () => {
    const repo = new FakeRepository(() => NOW_MS);
    const state = new FakeStateStore({ now: () => NOW_MS, repository: repo });
    const message = { ...fixture("presence.detected"), deviceId: SECRET_DEVICE_ID, topicDeviceId: "warashi-01" };
    await handleIngest(message, { repo, state, nowMs: () => NOW_MS });
    expect(JSON.stringify(lines)).not.toContain(SECRET_DEVICE_ID);
  });
});
