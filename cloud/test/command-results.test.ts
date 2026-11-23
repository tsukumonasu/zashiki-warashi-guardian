/**
 * Tests for command refusals (remote-feedback F2, F3; `docs/schema.md`, "HTTP API":
 * `GET /commands/{id}` and the `id` of `POST /photos`).
 *
 * Ingest records `CMD#<refId>` for every `error.reported` that names a command, with or without an
 * encounter, and the read route reports it to the family. Everything runs on in-memory fakes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handlePostPhoto } from "../lambda/api-admin/photos-core.js";
import { handleGetCommandResult } from "../lambda/api-read/commands-core.js";
import { ApiError } from "../lambda/_shared/http.js";
import type { CommandRejection, CommandResultReader, CommandResultStore } from "../lambda/_shared/ports.js";
import { setLogSink } from "../lambda/_shared/safelog.js";
import { COMMAND_RESULT_TTL_S, handleIngest, type IngestDeps } from "../lambda/ingest/ingest-core.js";
import { FakeDeviceBus, FakeRepository, FakeStateStore } from "./fakes.js";

const FIXTURES = fileURLToPath(new URL("../../docs/fixtures/schema-v1/", import.meta.url));
const NOW_MS = Date.parse("2026-11-20T13:00:00.000Z");
const COMMAND_ID = "5585a425-6d25-4e82-8420-34871e6320c2";

type Json = Record<string, unknown>;

class FakeResults implements CommandResultStore, CommandResultReader {
  readonly items = new Map<string, CommandRejection>();
  failPut = false;

  async putRejection(rejection: CommandRejection): Promise<void> {
    if (this.failPut) throw new Error("put failed");
    this.items.set(rejection.id, rejection);
  }

  async getRejection(id: string): Promise<CommandRejection | null> {
    return this.items.get(id) ?? null;
  }
}

let seq = 0;

/** An `error.reported` from the golden fixture with a fresh id and the given data fields. */
function errorReported(data: Json, overrides: Json = {}): Json {
  const base = JSON.parse(readFileSync(`${FIXTURES}error.reported.json`, "utf8")) as Json;
  seq += 1;
  return {
    ...base,
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    topicDeviceId: base["deviceId"],
    data: { ...(base["data"] as Json), ...data },
    ...overrides,
  };
}

function setup() {
  const results = new FakeResults();
  const repo = new FakeRepository(() => NOW_MS);
  const deps: IngestDeps = {
    repo,
    state: new FakeStateStore({ now: () => NOW_MS }),
    results,
    nowMs: () => NOW_MS,
  };
  return { results, repo, deps };
}

let restoreSink: (line: string) => void;
beforeEach(() => {
  restoreSink = setLogSink(() => undefined);
});
afterEach(() => {
  setLogSink(restoreSink);
});

describe("ingest: command refusals", () => {
  it("records a refusal under the refused command id for one day", async () => {
    const { results, deps } = setup();
    await handleIngest(errorReported({ code: "command_rejected_state", refId: COMMAND_ID }), deps);
    expect(results.items.get(COMMAND_ID)).toEqual({
      id: COMMAND_ID,
      deviceId: "warashi-01",
      code: "command_rejected_state",
      ttl: Math.floor(NOW_MS / 1000) + COMMAND_RESULT_TTL_S,
    });
  });

  it("records a refusal that has no encounter, and still stores no encounter event", async () => {
    const { results, repo, deps } = setup();
    const result = await handleIngest(
      errorReported({ code: "command_rejected_state", refId: COMMAND_ID }, { encounterId: null }),
      deps,
    );
    expect(result).toEqual({ outcome: "no_encounter" });
    expect(results.items.get(COMMAND_ID)?.code).toBe("command_rejected_state");
    expect(await repo.listEvents("c1d2e3f4-0000-4000-8000-000000000001")).toEqual([]);
  });

  it("records nothing for an error that names no command", async () => {
    const { results, deps } = setup();
    await handleIngest(errorReported({ code: "camera_failed", refId: null }), deps);
    expect(results.items.size).toBe(0);
  });

  it("records nothing for other event types", async () => {
    const { results, deps } = setup();
    const base = JSON.parse(readFileSync(`${FIXTURES}state.changed.json`, "utf8")) as Json;
    await handleIngest({ ...base, topicDeviceId: base["deviceId"] }, deps);
    expect(results.items.size).toBe(0);
  });

  it("fails the message when the refusal cannot be written, so it is redelivered", async () => {
    const { results, deps } = setup();
    results.failPut = true;
    const message = errorReported({ code: "speak_rejected", refId: COMMAND_ID });
    await expect(handleIngest(message, deps)).rejects.toThrow();
    results.failPut = false;
    await handleIngest(message, deps);
    expect(results.items.get(COMMAND_ID)?.code).toBe("speak_rejected");
  });
});

describe("GET /commands/{id}", () => {
  const ask = (role: "family" | "reviewer", id = COMMAND_ID) => ({ role, pathParameters: { id } });

  function readSetup(rejection: Partial<CommandRejection> | null = null) {
    const results = new FakeResults();
    if (rejection !== null) {
      results.items.set(COMMAND_ID, {
        id: COMMAND_ID,
        deviceId: "warashi-01",
        code: "command_rejected_state",
        ttl: Math.floor(NOW_MS / 1000) + 60,
        ...rejection,
      });
    }
    return { results, nowMs: NOW_MS };
  }

  it("is pending while no refusal has arrived", async () => {
    expect(await handleGetCommandResult(ask("family"), readSetup())).toEqual({ status: "pending" });
  });

  it("is rejected with the doll's code once a refusal is recorded", async () => {
    expect(await handleGetCommandResult(ask("family"), readSetup({}))).toEqual({
      status: "rejected",
      code: "command_rejected_state",
    });
  });

  it("is pending again after the record expired", async () => {
    const deps = readSetup({ ttl: Math.floor(NOW_MS / 1000) - 1 });
    expect(await handleGetCommandResult(ask("family"), deps)).toEqual({ status: "pending" });
  });

  it("refuses the reviewer", async () => {
    const error = await handleGetCommandResult(ask("reviewer"), readSetup({})).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("forbidden");
  });

  it.each(["", "a b", "x".repeat(65), "../x"])("rejects the id %j", async (id) => {
    const error = await handleGetCommandResult(ask("family", id), readSetup()).catch((e: unknown) => e);
    expect((error as ApiError).code).toBe("validation_failed");
  });
});

describe("POST /photos: command id (F3)", () => {
  it("returns the id of the published snapshot.request envelope", async () => {
    const bus = new FakeDeviceBus();
    let n = 0;
    const result = await handlePostPhoto(
      { role: "family", userSub: "user-1", body: { deviceId: "warashi-01" } },
      {
        bus,
        repository: new FakeRepository(() => NOW_MS),
        state: new FakeStateStore({ now: () => NOW_MS }),
        config: { statusIntervalS: 60 },
        newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
        nowMs: NOW_MS,
      },
    );
    const envelope = bus.published[0]!.envelope;
    expect(result.id).toBe(envelope.id);
    expect(result.id).not.toBe(result.requestId);
  });
});
