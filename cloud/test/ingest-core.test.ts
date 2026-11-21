/**
 * Unit tests for the ingest core (cloud-judgement task 13.2).
 * Requirements 3, 4.3 to 4.5, 10.1 to 10.3, 10.5, 10.6, 10.8 to 10.10, 12.1 to 12.3.
 * Also covers `releaseClaim` (FakeStateStore and the DynamoDB adapter), which lets a redelivery
 * complete after a failed write (R4.5, R10.10).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStateStore } from "../lambda/_shared/adapters/dynamo.js";
import { setLogSink } from "../lambda/_shared/safelog.js";
import {
  ENCOUNTER_TTL_DAYS,
  IngestWriteError,
  MESSAGE_CLAIM_TTL_S,
  handleIngest,
  type IngestDeps,
} from "../lambda/ingest/ingest-core.js";
import { FakeRepository, FakeStateStore } from "./fakes.js";

const FIXTURES = fileURLToPath(new URL("../../docs/fixtures/schema-v1/", import.meta.url));
const NOW_MS = Date.parse("2026-11-20T13:00:00.000Z");
const ENC = "c1d2e3f4-0000-4000-8000-000000000001";

type Json = Record<string, unknown>;

function fixture(type: string, overrides: Json = {}): Json {
  const base = JSON.parse(readFileSync(`${FIXTURES}${type}.json`, "utf8")) as Json;
  return { ...base, topicDeviceId: base["deviceId"], ...overrides };
}

let seq = 0;
/** A fixture with a fresh message id. */
function fresh(type: string, overrides: Json = {}): Json {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  return fixture(type, { id, ...overrides });
}

function setup() {
  const repo = new FakeRepository(() => NOW_MS);
  const state = new FakeStateStore({ now: () => NOW_MS });
  const deps: IngestDeps = { repo, state, nowMs: () => NOW_MS };
  return { repo, state, deps };
}

/** A repository whose chosen method rejects while `failing.on` is true. */
function failingRepo(repo: FakeRepository, method: "appendEvent" | "updateEncounter" | "putStatusReport") {
  const control = { on: true };
  const wrapped = Object.create(repo) as FakeRepository;
  const original = repo[method].bind(repo) as (...args: unknown[]) => Promise<unknown>;
  (wrapped as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
    if (control.on) throw new Error(`${method} failed`);
    return original(...args);
  };
  return { repo: wrapped, control };
}

let restoreSink: (line: string) => void;
beforeEach(() => {
  restoreSink = setLogSink(() => undefined);
});
afterEach(() => {
  setLogSink(restoreSink);
});

describe("handleIngest: encounter events", () => {
  it.each(["presence.detected", "snapshot.captured", "state.changed", "reaction.performed", "encounter.ended", "error.reported"])(
    "stores %s under its encounter (R10.1)",
    async (type) => {
      const { repo, deps } = setup();
      const result = await handleIngest(fresh(type), deps);
      expect(result).toEqual({ outcome: "event_stored" });
      const events = await repo.listEvents(ENC);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe(type);
      expect(events[0]).not.toHaveProperty("topicDeviceId");
    },
  );

  it("removes jpegBase64 and marks hasImage on a snapshot (R10.2)", async () => {
    const { repo, deps } = setup();
    await handleIngest(fresh("snapshot.captured"), deps);
    const data = (await repo.listEvents(ENC))[0]?.data as Json;
    expect(data).not.toHaveProperty("jpegBase64");
    expect(data["hasImage"]).toBe(true);
    expect(data["snapshotId"]).toBeTypeOf("string");
  });

  it("creates the meta item on the first event (R10.8)", async () => {
    const { repo, deps } = setup();
    expect(await repo.getEncounter(ENC, NOW_MS)).toBeNull();
    await handleIngest(fresh("presence.detected", { ts: "2026-11-20T12:34:56.789Z" }), deps);
    expect(await repo.getEncounter(ENC, NOW_MS)).toMatchObject({
      encounterId: ENC,
      deviceId: "warashi-01",
      startedAt: "2026-11-20T12:34:56.789Z",
      endedAt: null,
      state: null,
      verdict: null,
      notified: false,
    });
  });

  it("keeps startedAt from the first event when a later one arrives (R10.8)", async () => {
    const { repo, deps } = setup();
    await handleIngest(fresh("presence.detected", { ts: "2026-11-20T12:00:00.000Z" }), deps);
    await handleIngest(fresh("state.changed", { ts: "2026-11-20T12:00:05.000Z" }), deps);
    expect((await repo.getEncounter(ENC, NOW_MS))?.startedAt).toBe("2026-11-20T12:00:00.000Z");
  });

  it("updates the meta item for state.changed, reaction.performed and encounter.ended (R10.3)", async () => {
    const { repo, deps } = setup();
    await handleIngest(fresh("state.changed"), deps);
    expect((await repo.getEncounter(ENC, NOW_MS))?.state).toBe("waking");

    await handleIngest(fresh("reaction.performed"), deps);
    expect((await repo.getEncounter(ENC, NOW_MS))?.reaction).toEqual({
      kind: "family",
      lineId: "greet_family_01",
      offline: false,
    });

    await handleIngest(fresh("encounter.ended", { ts: "2026-11-20T12:40:00.000Z" }), deps);
    expect((await repo.getEncounter(ENC, NOW_MS))?.endedAt).toBe("2026-11-20T12:40:00.000Z");
  });

  it("leaves the meta item unchanged for events that carry no meta field", async () => {
    const { repo, deps } = setup();
    await handleIngest(fresh("state.changed"), deps);
    const before = await repo.getEncounter(ENC, NOW_MS);
    await handleIngest(fresh("snapshot.captured"), deps);
    await handleIngest(fresh("error.reported"), deps);
    expect(await repo.getEncounter(ENC, NOW_MS)).toEqual(before);
  });

  it("gives the encounter a 30-day ttl counted from now (R11.4)", async () => {
    const { repo, deps } = setup();
    await handleIngest(fresh("presence.detected"), deps);
    const days = ENCOUNTER_TTL_DAYS * 86_400_000;
    expect(await repo.getEncounter(ENC, NOW_MS + days - 1)).not.toBeNull();
    expect(await repo.getEncounter(ENC, NOW_MS + days)).toBeNull();
  });

  it("changes nothing for an event id that is already stored (R10.9)", async () => {
    const { repo, deps } = setup();
    const event = fresh("state.changed");
    await handleIngest(event, deps);
    const before = await repo.getEncounter(ENC, NOW_MS);
    // A new state store forgets the claim, so only the stored-event check can drop it.
    const second: IngestDeps = { ...deps, state: new FakeStateStore({ now: () => NOW_MS }) };
    expect(await handleIngest(event, second)).toEqual({ outcome: "duplicate" });
    expect(await repo.listEvents(ENC)).toHaveLength(1);
    expect(await repo.getEncounter(ENC, NOW_MS)).toEqual(before);
  });

  it("drops a redelivery by its message claim (R4.4)", async () => {
    const { repo, deps } = setup();
    const event = fresh("state.changed");
    expect(await handleIngest(event, deps)).toEqual({ outcome: "event_stored" });
    expect(await handleIngest(event, deps)).toEqual({ outcome: "duplicate" });
    expect(await repo.listEvents(ENC)).toHaveLength(1);
  });

  it("stores nothing for a null encounterId (R10.5)", async () => {
    const { repo, deps } = setup();
    const result = await handleIngest(fresh("state.changed", { encounterId: null }), deps);
    expect(result).toEqual({ outcome: "no_encounter" });
    expect(repo.hasEncounter(ENC)).toBe(false);
  });

  it("stores nothing for an unknown type, a bad message or a command (R10.6)", async () => {
    const { repo, deps } = setup();
    expect(await handleIngest(fresh("state.changed", { type: "mystery.event" }), deps)).toEqual({
      outcome: "ignored",
    });
    expect(await handleIngest(fresh("state.changed", { data: { to: 5 } }), deps)).toEqual({
      outcome: "malformed",
    });
    expect(await handleIngest(fresh("gaze"), deps)).toEqual({ outcome: "ignored" });
    expect(repo.hasEncounter(ENC)).toBe(false);
  });

  it("drops data fields outside the contract before storage (R8.2)", async () => {
    const { repo, deps } = setup();
    const base = fresh("state.changed");
    const event = { ...base, data: { ...(base["data"] as Json), name: "Hanako" } };
    await handleIngest(event, deps);
    expect(JSON.stringify(await repo.listEvents(ENC))).not.toContain("Hanako");
  });
});

describe("handleIngest: sender check", () => {
  it("rejects a deviceId that differs from the topic and stores nothing (R3.1)", async () => {
    const { repo, deps } = setup();
    const result = await handleIngest(fresh("state.changed", { topicDeviceId: "warashi-02" }), deps);
    expect(result).toEqual({ outcome: "mismatch" });
    expect(repo.hasEncounter(ENC)).toBe(false);
  });

  it.each([
    ["no topic id", { topicDeviceId: undefined }],
    ["empty topic id", { topicDeviceId: "" }],
    ["different case", { topicDeviceId: "Warashi-01" }],
    ["empty deviceId", { deviceId: "" }],
    ["non-string deviceId", { deviceId: 7 }],
  ])("treats %s as a mismatch (R3.3)", async (_name, overrides) => {
    const { deps } = setup();
    expect(await handleIngest(fresh("state.changed", overrides), deps)).toEqual({
      outcome: "mismatch",
    });
  });

  it("treats a non-object message as a mismatch", async () => {
    const { deps } = setup();
    expect(await handleIngest("nope", deps)).toEqual({ outcome: "mismatch" });
  });

  it("logs the id and the topic id only (R3.2)", async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const { deps } = setup();
    await handleIngest(fresh("state.changed", { topicDeviceId: "warashi-02" }), deps);
    const entry = lines.map((l) => JSON.parse(l) as Json).find((e) => e["event"] === "security_mismatch");
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain("sleeping");
  });
});

describe("handleIngest: status", () => {
  const device = "warashi-01";

  it("stores a report, then offline, then a later report (R12.1, R12.3)", async () => {
    const { repo, deps } = setup();
    let now = NOW_MS;
    const timed: IngestDeps = { ...deps, nowMs: () => now };

    expect(await handleIngest(fresh("status.report"), timed)).toEqual({ outcome: "status_stored" });
    expect(await repo.getDeviceStatus(device)).toMatchObject({
      lastReportAtMs: NOW_MS,
      lastOfflineAtMs: null,
      status: { state: "sleeping", mode: "guard" },
    });

    now = NOW_MS + 10_000;
    expect(await handleIngest(fresh("status.offline"), timed)).toEqual({ outcome: "offline_marked" });
    expect(await repo.getDeviceStatus(device)).toMatchObject({
      lastReportAtMs: NOW_MS,
      lastOfflineAtMs: NOW_MS + 10_000,
    });

    now = NOW_MS + 20_000;
    await handleIngest(fresh("status.report"), timed);
    const record = await repo.getDeviceStatus(device);
    expect(record?.lastReportAtMs).toBe(NOW_MS + 20_000);
    expect(record?.lastOfflineAtMs).toBe(NOW_MS + 10_000);
  });

  it("uses the arrival time and never the message ts (R12.1, R12.2)", async () => {
    const { repo, deps } = setup();
    await handleIngest(fresh("status.report", { ts: "2020-01-01T00:00:00.000Z" }), deps);
    expect((await repo.getDeviceStatus(device))?.lastReportAtMs).toBe(NOW_MS);
    await handleIngest(fresh("status.offline", { ts: "2099-01-01T00:00:00.000Z" }), deps);
    expect((await repo.getDeviceStatus(device))?.lastOfflineAtMs).toBe(NOW_MS);
  });

  it("creates no encounter for status messages", async () => {
    const { repo, deps } = setup();
    await handleIngest(fresh("status.report"), deps);
    expect(repo.hasEncounter(ENC)).toBe(false);
  });
});

describe("handleIngest: a failing write (R4.5, R10.10)", () => {
  it("throws IngestWriteError, keeps earlier items and releases the claim", async () => {
    const { repo, state } = setup();
    const first = fresh("state.changed");
    await handleIngest(first, { repo, state, nowMs: () => NOW_MS });
    const before = await repo.getEncounter(ENC, NOW_MS);

    const { repo: broken } = failingRepo(repo, "appendEvent");
    const second = fresh("reaction.performed");
    await expect(handleIngest(second, { repo: broken, state, nowMs: () => NOW_MS })).rejects.toBeInstanceOf(
      IngestWriteError,
    );

    expect(await repo.listEvents(ENC)).toHaveLength(1);
    expect(await repo.getEncounter(ENC, NOW_MS)).toEqual(before);
  });

  it("lets the redelivery complete after a failed append", async () => {
    const { repo, state } = setup();
    const { repo: broken, control } = failingRepo(repo, "appendEvent");
    const event = fresh("state.changed");
    await expect(handleIngest(event, { repo: broken, state, nowMs: () => NOW_MS })).rejects.toThrow(
      IngestWriteError,
    );

    control.on = false;
    expect(await handleIngest(event, { repo, state, nowMs: () => NOW_MS })).toEqual({
      outcome: "event_stored",
    });
    expect(await repo.listEvents(ENC)).toHaveLength(1);
    // The claim is held again after the success: a third delivery is a duplicate.
    expect(await handleIngest(event, { repo, state, nowMs: () => NOW_MS })).toEqual({
      outcome: "duplicate",
    });
  });

  it("lets the redelivery complete after a failed meta update", async () => {
    const { repo, state } = setup();
    const { repo: broken, control } = failingRepo(repo, "updateEncounter");
    const event = fresh("state.changed");
    await expect(handleIngest(event, { repo: broken, state, nowMs: () => NOW_MS })).rejects.toThrow(
      IngestWriteError,
    );
    control.on = false;
    // The event item exists from the first attempt, so the retry reports it as stored already.
    expect(await handleIngest(event, { repo, state, nowMs: () => NOW_MS })).toEqual({
      outcome: "duplicate",
    });
  });

  it("lets the redelivery complete after a failed status write", async () => {
    const { repo, state } = setup();
    const { repo: broken, control } = failingRepo(repo, "putStatusReport");
    const event = fresh("status.report");
    await expect(handleIngest(event, { repo: broken, state, nowMs: () => NOW_MS })).rejects.toThrow(
      IngestWriteError,
    );
    expect(await repo.getDeviceStatus("warashi-01")).toBeNull();
    control.on = false;
    expect(await handleIngest(event, { repo, state, nowMs: () => NOW_MS })).toEqual({
      outcome: "status_stored",
    });
  });

  it("reports a failing claim as IngestWriteError and releases nothing", async () => {
    const { repo, state } = setup();
    let released = 0;
    const brokenState = Object.create(state) as FakeStateStore;
    brokenState.claim = async () => {
      throw new Error("claim failed");
    };
    brokenState.releaseClaim = async () => {
      released += 1;
    };
    const event = fresh("state.changed");
    await expect(handleIngest(event, { repo, state: brokenState, nowMs: () => NOW_MS })).rejects.toThrow(
      IngestWriteError,
    );
    expect(released).toBe(0);
    expect(repo.hasEncounter(ENC)).toBe(false);
  });

  it("still throws the write error when releasing the claim fails too", async () => {
    const { repo, state } = setup();
    const { repo: broken } = failingRepo(repo, "appendEvent");
    const brokenState = Object.create(state) as FakeStateStore;
    brokenState.releaseClaim = async () => {
      throw new Error("release failed");
    };
    const error = await handleIngest(fresh("state.changed"), {
      repo: broken,
      state: brokenState,
      nowMs: () => NOW_MS,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IngestWriteError);
    expect(((error as IngestWriteError).cause as Error).message).toBe("appendEvent failed");
  });

  it("does not release the claim of a duplicate", async () => {
    const { repo, state, deps } = setup();
    const event = fresh("state.changed");
    await handleIngest(event, deps);
    await handleIngest(event, deps);
    expect(await state.claim(`MSG#${event["id"] as string}`, MESSAGE_CLAIM_TTL_S)).toBe(false);
    expect(await repo.listEvents(ENC)).toHaveLength(1);
  });
});

describe("FakeStateStore.releaseClaim", () => {
  it("lets the key be claimed again", async () => {
    const store = new FakeStateStore();
    expect(await store.claim("MSG#a", 60)).toBe(true);
    await store.releaseClaim("MSG#a");
    expect(await store.claim("MSG#a", 60)).toBe(true);
  });

  it("does nothing for an unknown key", async () => {
    const store = new FakeStateStore();
    await store.releaseClaim("MSG#none");
    expect(await store.claim("MSG#none", 60)).toBe(true);
  });
});

describe("DynamoDB state store releaseClaim", () => {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));
  const mock = mockClient(doc);
  beforeEach(() => mock.reset());
  const store = () => createStateStore({ client: doc, tableName: "t", now: () => NOW_MS });

  it("deletes the claim item only if it still has the claimedAt this store wrote", async () => {
    mock.on(PutCommand).resolves({});
    mock.on(DeleteCommand).resolves({});
    const s = store();
    await s.claim("MSG#abc", 600);
    await s.releaseClaim("MSG#abc");
    const input = mock.commandCalls(DeleteCommand)[0]?.args[0].input;
    expect(input?.Key).toEqual({ pk: "MSG#abc", sk: "DEDUP" });
    expect(input?.ConditionExpression).toBe("claimedAt = :claimedAt");
    expect(input?.ExpressionAttributeValues).toEqual({ ":claimedAt": NOW_MS });
  });

  it("does nothing for a claim this store did not make", async () => {
    await store().releaseClaim("MSG#other");
    expect(mock.commandCalls(DeleteCommand)).toHaveLength(0);
  });

  it("ignores a failed condition but surfaces other errors", async () => {
    mock.on(PutCommand).resolves({});
    const conditional = Object.assign(new Error("c"), { name: "ConditionalCheckFailedException" });
    mock.on(DeleteCommand).rejectsOnce(conditional).rejectsOnce(new Error("boom"));
    const s = store();
    await s.claim("MSG#a", 600);
    await expect(s.releaseClaim("MSG#a")).resolves.toBeUndefined();
    await s.claim("MSG#b", 600);
    await expect(s.releaseClaim("MSG#b")).rejects.toThrow("boom");
  });
});
