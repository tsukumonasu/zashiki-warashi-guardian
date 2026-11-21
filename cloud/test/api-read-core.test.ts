/**
 * Unit tests for the `api-read` core (cloud-judgement task 15.4).
 * Requirements: 11.8, 12.4, 12.5, 13.14, 13.15, 13.16, 14.8.
 */

import { describe, expect, it } from "vitest";

import {
  handleDeviceStatus,
  handleGetEncounter,
  handleListEncounters,
  handleMe,
  handleSamples,
  isOnline,
  SNAPSHOT_URL_TTL_S,
  type ReadDeps,
  type ReadRequest,
  type SnapshotUrlSigner,
} from "../lambda/api-read/api-read-core.js";
import type { Role } from "../lambda/_shared/authz.js";
import { DEFAULT_CONFIG } from "../lambda/_shared/config.js";
import { ApiError } from "../lambda/_shared/http.js";
import type { Envelope } from "../lambda/_shared/messages.js";
import type { EncounterMeta, StatusReportData } from "../lambda/_shared/ports.js";
import { FakeRepository } from "./fakes.js";

const NOW_MS = Date.parse("2026-11-20T12:00:00.000Z");
const DEVICE = "warashi-01";

class FakeSigner implements SnapshotUrlSigner {
  readonly calls: { key: string; ttlS: number }[] = [];
  result: string | null = "https://example.invalid/signed";
  fail = false;
  async sign(key: string, ttlS: number): Promise<string | null> {
    this.calls.push({ key, ttlS });
    if (this.fail) throw new Error("signer down");
    return this.result;
  }
}

/** A repository that stamps a `ttl` (epoch seconds) on returned items, like DynamoDB rows. */
class TtlRepository extends FakeRepository {
  readonly ttls = new Map<string, number>();
  override async listEncounters(...args: Parameters<FakeRepository["listEncounters"]>) {
    const page = await super.listEncounters(...args);
    return { ...page, items: page.items.map((m) => this.stamp(m)) };
  }
  override async getEncounter(...args: Parameters<FakeRepository["getEncounter"]>) {
    const meta = await super.getEncounter(...args);
    return meta === null ? null : this.stamp(meta);
  }
  private stamp(meta: EncounterMeta): EncounterMeta {
    const ttl = this.ttls.get(meta.encounterId);
    return ttl === undefined ? meta : ({ ...meta, ttl } as EncounterMeta);
  }
}

function meta(n: number, over: Partial<EncounterMeta> = {}): EncounterMeta {
  return {
    encounterId: `enc-${String(n).padStart(3, "0")}`,
    deviceId: DEVICE,
    startedAt: new Date(NOW_MS - 1000 * 60 * (100 - n)).toISOString(),
    endedAt: null,
    state: "cooldown",
    verdict: "stranger",
    confidence: 0.9,
    reaction: { kind: "stranger", lineId: "stranger_first", offline: false },
    notified: true,
    snapshotKey: `snapshots/enc-${n}.jpg`,
    errorCount: 0,
    ...over,
  };
}

function setup(configOver: Partial<ReadDeps["config"]> = {}) {
  const repository = new TtlRepository(() => NOW_MS);
  const signer = new FakeSigner();
  const deps: ReadDeps = {
    repository,
    signer,
    config: { ...DEFAULT_CONFIG, ...configOver },
    consentNoticeVersion: "2026-11",
    nowMs: NOW_MS,
  };
  return { repository, signer, deps };
}

function req(role: Role, query: Record<string, string> = {}, pathParameters: Record<string, string> = {}): ReadRequest {
  return { role, query, pathParameters };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
  return "no error";
}

const REPORT: StatusReportData = {
  state: "sleeping",
  mode: "guard",
  panDeg: 0,
  tiltDeg: 0,
  lantern: 0,
  cameraActive: false,
  micActive: false,
  motionEnabled: false,
  uptimeSec: 10,
  agentVersion: "0.1.0",
};

describe("GET /me and GET /samples", () => {
  it("returns the role limits for each role", () => {
    const { deps } = setup();
    const reviewer = handleMe(req("reviewer"), deps);
    expect(reviewer).toEqual({
      role: "reviewer",
      consentNoticeVersion: "2026-11",
      limits: { simulatePerHour: DEFAULT_CONFIG.reviewerSimulatePerHour, generatePerHour: DEFAULT_CONFIG.reviewerGeneratePerHour },
    });
    expect(handleMe(req("family"), deps).limits).toEqual({
      simulatePerHour: DEFAULT_CONFIG.familySimulatePerHour,
      generatePerHour: DEFAULT_CONFIG.familyGeneratePerHour,
    });
  });

  it("lists samples with id and label only, for both roles", async () => {
    const { repository, deps } = setup();
    repository.setSamples([{ id: "mom_1", label: "family" }, { id: "nobody", label: "no_face" }]);
    for (const role of ["family", "reviewer"] as const) {
      expect(await handleSamples(req(role), deps)).toEqual({
        samples: [{ sampleId: "mom_1", label: "family" }, { sampleId: "nobody", label: "no_face" }],
      });
    }
  });
});

describe("GET /encounters", () => {
  it("pages newest first with a cursor and ends with nextCursor null (R13.14)", async () => {
    const { repository, deps } = setup();
    for (let n = 1; n <= 5; n++) await repository.createEncounterIfAbsent(meta(n), 86_400);

    const first = await handleListEncounters(req("family", { limit: "2" }), deps);
    expect(first.items.map((i) => i.encounterId)).toEqual(["enc-005", "enc-004"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await handleListEncounters(req("family", { limit: "2", cursor: first.nextCursor! }), deps);
    expect(second.items.map((i) => i.encounterId)).toEqual(["enc-003", "enc-002"]);

    const third = await handleListEncounters(req("family", { limit: "2", cursor: second.nextCursor! }), deps);
    expect(third.items.map((i) => i.encounterId)).toEqual(["enc-001"]);
    expect(third.nextCursor).toBeNull();
  });

  it("defaults the limit to 20 and returns empty events in list items", async () => {
    const { repository, deps } = setup();
    for (let n = 1; n <= 25; n++) await repository.createEncounterIfAbsent(meta(n), 86_400);
    const page = await handleListEncounters(req("family"), deps);
    expect(page.items).toHaveLength(20);
    expect(page.items.every((i) => i.events.length === 0)).toBe(true);
  });

  it.each(["0", "51", "-1", "1.5", "abc", "", "1000"])("rejects limit %j", async (limit) => {
    const { deps } = setup();
    expect(await code(handleListEncounters(req("family", { limit }), deps))).toBe("validation_failed");
  });

  it.each(["1", "50"])("accepts the limit boundary %s", async (limit) => {
    const { deps } = setup();
    await expect(handleListEncounters(req("family", { limit }), deps)).resolves.toEqual({ items: [], nextCursor: null });
  });

  it("rejects a cursor with bad characters and a cursor the store did not issue (R13.15)", async () => {
    const { deps } = setup();
    expect(await code(handleListEncounters(req("family", { cursor: "not valid!" }), deps))).toBe("validation_failed");
    expect(await code(handleListEncounters(req("family", { cursor: "bm90LWpzb24" }), deps))).toBe("validation_failed");
  });

  it("hides items past their TTL before DynamoDB deletes them (R11.8)", async () => {
    const { repository, deps } = setup();
    await repository.createEncounterIfAbsent(meta(1), 86_400);
    await repository.createEncounterIfAbsent(meta(2), 86_400);
    await repository.createEncounterIfAbsent(meta(3), 86_400);
    const nowS = Math.floor(NOW_MS / 1000);
    repository.ttls.set("enc-001", nowS - 1);
    repository.ttls.set("enc-002", nowS); // at the boundary: expired
    repository.ttls.set("enc-003", nowS + 1);
    const page = await handleListEncounters(req("family"), deps);
    expect(page.items.map((i) => i.encounterId)).toEqual(["enc-003"]);
  });

  it("gives the family a signed snapshot and a null snapshot when none exists", async () => {
    const { repository, signer, deps } = setup();
    await repository.createEncounterIfAbsent(meta(1), 86_400);
    await repository.createEncounterIfAbsent(meta(2, { snapshotKey: null }), 86_400);
    const page = await handleListEncounters(req("family"), deps);
    const withImage = page.items.find((i) => i.encounterId === "enc-001");
    const without = page.items.find((i) => i.encounterId === "enc-002");
    expect(withImage?.snapshot).toEqual({
      url: "https://example.invalid/signed",
      expiresAt: new Date(NOW_MS + SNAPSHOT_URL_TTL_S * 1000).toISOString(),
    });
    expect(without?.snapshot).toBeNull();
    expect(signer.calls).toEqual([{ key: "snapshots/enc-1.jpg", ttlS: 300 }]);
    expect(withImage?.illustration).toBeNull();
  });

  it("gives snapshot null when the signer returns null or fails", async () => {
    const { repository, signer, deps } = setup();
    await repository.createEncounterIfAbsent(meta(1), 86_400);
    signer.result = null;
    expect((await handleListEncounters(req("family"), deps)).items[0]?.snapshot).toBeNull();
    signer.result = "https://example.invalid/signed";
    signer.fail = true;
    const page = await handleListEncounters(req("family"), deps);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.snapshot).toBeNull();
  });

  it("redacts for the reviewer: illustration, no snapshot, signer never called", async () => {
    const { repository, signer, deps } = setup();
    await repository.createEncounterIfAbsent(meta(1), 86_400);
    const page = await handleListEncounters(req("reviewer"), deps);
    expect(page.items[0]?.snapshot).toBeNull();
    expect(page.items[0]?.illustration).toBe("silhouette-stranger");
    expect(signer.calls).toHaveLength(0);
  });

  it("returns an empty list to the reviewer when real encounters are hidden, but not to the family (R14.8)", async () => {
    const { repository, signer, deps } = setup({ reviewerRealEncounters: "hidden" });
    await repository.createEncounterIfAbsent(meta(1), 86_400);
    expect(await handleListEncounters(req("reviewer"), deps)).toEqual({ items: [], nextCursor: null });
    expect((await handleListEncounters(req("family"), deps)).items).toHaveLength(1);
    expect(signer.calls).toHaveLength(1);
  });
});

describe("GET /encounters/{id}", () => {
  const event: Envelope = {
    v: 1,
    id: "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10",
    ts: "2026-11-20T11:00:00.000Z",
    deviceId: DEVICE,
    encounterId: "enc-001",
    type: "snapshot.captured",
    data: { snapshotId: "s1", hasImage: true },
  } as Envelope;

  it("returns events in time order for the family with a signed snapshot", async () => {
    const { repository, deps } = setup();
    await repository.createEncounterIfAbsent(meta(1), 86_400);
    const later = { ...event, id: "11111111-3a52-4d0f-9d53-2f1f3c1f7a10", ts: "2026-11-20T11:00:02.000Z" } as Envelope;
    await repository.appendEvent("enc-001", later, 86_400);
    await repository.appendEvent("enc-001", event, 86_400);
    const record = await handleGetEncounter(req("family", {}, { id: "enc-001" }), deps);
    expect(record.events.map((e) => e.ts)).toEqual([event.ts, later.ts]);
    expect(record.snapshot?.url).toBe("https://example.invalid/signed");
  });

  it("redacts the reviewer's events and never signs", async () => {
    const { repository, signer, deps } = setup();
    await repository.createEncounterIfAbsent(meta(1, { verdict: "family" }), 86_400);
    await repository.appendEvent(
      "enc-001",
      { ...event, data: { snapshotId: "s1", hasImage: true, jpegBase64: "AAAA", face: { left: 0 } } } as Envelope,
      86_400,
    );
    const record = await handleGetEncounter(req("reviewer", {}, { id: "enc-001" }), deps);
    expect(record.illustration).toBe("silhouette-family");
    expect(record.snapshot).toBeNull();
    expect(JSON.stringify(record.events)).not.toMatch(/jpegBase64|hasImage|"face"/);
    expect(record.events).toHaveLength(1);
    expect(signer.calls).toHaveLength(0);
  });

  it("gives snapshot null when the encounter has no stored image", async () => {
    const { repository, deps } = setup();
    await repository.createEncounterIfAbsent(meta(1, { snapshotKey: null }), 86_400);
    expect((await handleGetEncounter(req("family", {}, { id: "enc-001" }), deps)).snapshot).toBeNull();
  });

  it("gives not_found for unknown, malformed, missing and TTL-expired ids (R13.16, R11.8)", async () => {
    const { repository, deps } = setup();
    await repository.createEncounterIfAbsent(meta(1), 86_400);
    repository.ttls.set("enc-001", Math.floor(NOW_MS / 1000) - 5);
    await repository.createEncounterIfAbsent(meta(2), 86_400);
    for (const id of ["nope", "enc-001", "bad id!", "../x"]) {
      expect(await code(handleGetEncounter(req("family", {}, { id }), deps))).toBe("not_found");
    }
    expect(await code(handleGetEncounter(req("family"), deps))).toBe("not_found");
    expect((await handleGetEncounter(req("family", {}, { id: "enc-002" }), deps)).encounterId).toBe("enc-002");
  });

  it("gives not_found to the reviewer for every id when hidden (R14.8)", async () => {
    const { repository, deps } = setup({ reviewerRealEncounters: "hidden" });
    await repository.createEncounterIfAbsent(meta(1), 86_400);
    expect(await code(handleGetEncounter(req("reviewer", {}, { id: "enc-001" }), deps))).toBe("not_found");
    expect((await handleGetEncounter(req("family", {}, { id: "enc-001" }), deps)).encounterId).toBe("enc-001");
  });

  it("treats an invalid setting like hidden", async () => {
    const { repository, deps } = setup({ reviewerRealEncounters: "bogus" as never });
    await repository.createEncounterIfAbsent(meta(1), 86_400);
    expect(await code(handleGetEncounter(req("reviewer", {}, { id: "enc-001" }), deps))).toBe("not_found");
  });
});

describe("GET /device/status", () => {
  const INTERVAL_MS = DEFAULT_CONFIG.statusIntervalS * 1000;

  it("returns the empty status for a device that never reported (R12.5)", async () => {
    const { deps } = setup();
    for (const role of ["family", "reviewer"] as const) {
      expect(await handleDeviceStatus(req(role, { deviceId: "warashi-09" }), deps)).toEqual({
        deviceId: "warashi-09",
        online: false,
        lastSeenAt: null,
        status: null,
      });
    }
  });

  it("is empty when only an offline mark exists", async () => {
    const { repository, deps } = setup();
    await repository.markOffline(DEVICE, NOW_MS - 1000);
    expect(await handleDeviceStatus(req("family"), deps)).toMatchObject({ online: false, lastSeenAt: null, status: null });
  });

  it("is online with a recent report and shows lastSeenAt as arrival time (R12.4)", async () => {
    const { repository, deps } = setup();
    const arrival = NOW_MS - 5_000;
    await repository.putStatusReport(DEVICE, REPORT, arrival);
    expect(await handleDeviceStatus(req("reviewer"), deps)).toEqual({
      deviceId: DEVICE,
      online: true,
      lastSeenAt: new Date(arrival).toISOString(),
      status: REPORT,
    });
  });

  it("applies the 3 x interval rule at its boundary", async () => {
    const { repository, deps } = setup();
    await repository.putStatusReport(DEVICE, REPORT, NOW_MS - 3 * INTERVAL_MS);
    expect((await handleDeviceStatus(req("family"), deps)).online).toBe(true);
    await repository.putStatusReport(DEVICE, REPORT, NOW_MS - 3 * INTERVAL_MS - 1);
    const stale = await handleDeviceStatus(req("family"), deps);
    expect(stale.online).toBe(false);
    expect(stale.status).toEqual(REPORT); // last known status stays visible
    expect(stale.lastSeenAt).not.toBeNull();
  });

  it("uses the configured interval", async () => {
    const { repository, deps } = setup({ statusIntervalS: 10 });
    await repository.putStatusReport(DEVICE, REPORT, NOW_MS - 31_000);
    expect((await handleDeviceStatus(req("family"), deps)).online).toBe(false);
    await repository.putStatusReport(DEVICE, REPORT, NOW_MS - 30_000);
    expect((await handleDeviceStatus(req("family"), deps)).online).toBe(true);
  });

  it("is offline when the last offline mark is later than the last report, online again after a newer report", async () => {
    const { repository, deps } = setup();
    await repository.putStatusReport(DEVICE, REPORT, NOW_MS - 10_000);
    await repository.markOffline(DEVICE, NOW_MS - 5_000);
    expect((await handleDeviceStatus(req("family"), deps)).online).toBe(false);
    await repository.putStatusReport(DEVICE, REPORT, NOW_MS - 1_000);
    expect((await handleDeviceStatus(req("family"), deps)).online).toBe(true);
  });

  it("rejects a malformed deviceId", async () => {
    const { deps } = setup();
    for (const deviceId of ["", "a b", "x".repeat(65), "a/b"]) {
      expect(await code(handleDeviceStatus(req("family", { deviceId }), deps))).toBe("validation_failed");
    }
  });

  it("defaults to the configured device", async () => {
    const { repository, deps } = setup();
    await repository.putStatusReport(DEVICE, REPORT, NOW_MS);
    expect((await handleDeviceStatus(req("family"), deps)).deviceId).toBe(DEVICE);
  });
});

describe("isOnline", () => {
  it("treats an equal report and offline time as offline-free only when the report is not older", () => {
    expect(isOnline(1000, 1000, 1500, 60)).toBe(true);
    expect(isOnline(999, 1000, 1500, 60)).toBe(false);
    expect(isOnline(1000, null, 1000 + 180_000, 60)).toBe(true);
    expect(isOnline(1000, null, 1000 + 180_001, 60)).toBe(false);
  });
});
