// Unit tests for the snapshot signer core and the api-read signer boundary
// (R11.6, R14.4, R14.10, R14.11).
import { describe, expect, it } from "vitest";
import { rolesFromClaims } from "../lambda/_shared/authz.js";
import { DEFAULT_CONFIG } from "../lambda/_shared/config.js";
import type { EncounterMeta } from "../lambda/_shared/ports.js";
import {
  handleGetEncounter,
  handleListEncounters,
  SNAPSHOT_URL_TTL_S,
  type ReadDeps,
  type ReadRequest,
  type SnapshotUrlSigner,
} from "../lambda/api-read/api-read-core.js";
import {
  handleSign,
  isSnapshotKey,
  SIGNER_MAX_TTL_S,
  type SnapshotSigningPort,
} from "../lambda/snapshot-signer/signer-core.js";
import { FakeRepository } from "./fakes.js";

const KEY = "snapshots/warashi-01/2026/enc-1.jpg";
const SIGNED = "https://signed.example.invalid/object";

class RecordingPort implements SnapshotSigningPort {
  readonly calls: { key: string; ttlS: number }[] = [];
  async signGet(key: string, ttlS: number): Promise<string> {
    this.calls.push({ key, ttlS });
    return SIGNED;
  }
}

describe("handleSign", () => {
  it("signs a family request for a key under snapshots/ and passes the key and lifetime through", async () => {
    const port = new RecordingPort();
    const response = await handleSign({ role: "family", snapshotKey: KEY, ttlS: 300 }, port);
    expect(response).toEqual({ ok: true, url: SIGNED });
    expect(port.calls).toEqual([{ key: KEY, ttlS: 300 }]);
  });

  it("caps the lifetime at 300 seconds", async () => {
    expect(SIGNER_MAX_TTL_S).toBe(300);
    const port = new RecordingPort();
    const refused = await handleSign({ role: "family", snapshotKey: KEY, ttlS: 301 }, port);
    expect(refused).toEqual({ ok: false, code: "invalid_request" });
    expect(port.calls).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "300", null, undefined])(
    "refuses the lifetime %s",
    async (ttlS) => {
      const port = new RecordingPort();
      const response = await handleSign({ role: "family", snapshotKey: KEY, ttlS }, port);
      expect(response).toEqual({ ok: false, code: "invalid_request" });
      expect(port.calls).toEqual([]);
    },
  );

  it.each(["reviewer", "admin", "", null, undefined, 1])("refuses the role %s without signing", async (role) => {
    const port = new RecordingPort();
    const response = await handleSign({ role, snapshotKey: KEY, ttlS: 300 }, port);
    expect(response).toEqual({ ok: false, code: "forbidden" });
    expect(port.calls).toEqual([]);
  });

  it("checks the role before the key, so a reviewer with a bad key still gets forbidden", async () => {
    const port = new RecordingPort();
    const response = await handleSign({ role: "reviewer", snapshotKey: "../etc/passwd", ttlS: 999 }, port);
    expect(response).toEqual({ ok: false, code: "forbidden" });
    expect(port.calls).toEqual([]);
  });

  it.each([
    "other/warashi-01/enc-1.jpg",
    "samples/a.jpg",
    "Snapshots/a.jpg",
    "/snapshots/a.jpg",
    "snapshots",
    "snapshots/../secrets/key",
    "snapshots/a/../../b",
    "snapshots/..",
    "snapshots/./a.jpg",
    "snapshots//a.jpg",
    "snapshots/a/",
    "snapshots/a\\b.jpg",
    "snapshots/a\u0000b.jpg",
    "snapshots/a\nb.jpg",
    `snapshots/${"a".repeat(1100)}`,
    "",
  ])("refuses the key %j", async (snapshotKey) => {
    const port = new RecordingPort();
    const response = await handleSign({ role: "family", snapshotKey, ttlS: 300 }, port);
    expect(response).toEqual({ ok: false, code: "invalid_request" });
    expect(port.calls).toEqual([]);
  });

  it.each([null, undefined, 42, "snapshots/a.jpg", [], "not an object"])(
    "refuses the non-object or incomplete payload %j",
    async (request) => {
      const port = new RecordingPort();
      const response = await handleSign(request, port);
      expect(response.ok).toBe(false);
      expect(port.calls).toEqual([]);
    },
  );

  it("lets a signing failure propagate so the caller can hide the picture", async () => {
    const port: SnapshotSigningPort = {
      signGet: async () => {
        throw new Error("sign failed");
      },
    };
    await expect(handleSign({ role: "family", snapshotKey: KEY, ttlS: 300 }, port)).rejects.toThrow("sign failed");
  });
});

describe("isSnapshotKey", () => {
  it("accepts plain keys under snapshots/", () => {
    expect(isSnapshotKey(KEY)).toBe(true);
    expect(isSnapshotKey("snapshots/a")).toBe(true);
  });

  it("rejects non-strings", () => {
    expect(isSnapshotKey(undefined)).toBe(false);
    expect(isSnapshotKey(7)).toBe(false);
  });
});

describe("api-read and the signer", () => {
  const NOW_MS = Date.parse("2026-11-20T12:40:00.000Z");

  function meta(id: string): EncounterMeta {
    return {
      encounterId: id,
      deviceId: "warashi-01",
      startedAt: "2026-11-20T12:34:56.789Z",
      endedAt: null,
      state: "cooldown",
      verdict: "stranger",
      confidence: 0.9,
      reaction: null,
      notified: false,
      snapshotKey: `snapshots/warashi-01/${id}.jpg`,
      errorCount: 0,
    };
  }

  async function setup(): Promise<{ deps: ReadDeps; signCalls: { key: string; ttlS: number }[] }> {
    const repository = new FakeRepository(() => NOW_MS);
    await repository.createEncounterIfAbsent(meta("enc-1"), 3 * 86_400);
    const signCalls: { key: string; ttlS: number }[] = [];
    const signer: SnapshotUrlSigner = {
      sign: async (key, ttlS) => {
        signCalls.push({ key, ttlS });
        return SIGNED;
      },
    };
    const deps: ReadDeps = {
      repository,
      signer,
      config: DEFAULT_CONFIG,
      consentNoticeVersion: "v1",
      nowMs: NOW_MS,
    };
    return { deps, signCalls };
  }

  function request(role: ReadRequest["role"]): ReadRequest {
    return { role, query: {}, pathParameters: { id: "enc-1" } };
  }

  it("never calls the signer for a reviewer, in a list or a detail", async () => {
    const { deps, signCalls } = await setup();
    const list = await handleListEncounters(request("reviewer"), deps);
    const detail = await handleGetEncounter(request("reviewer"), deps);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.snapshot).toBeNull();
    expect(detail.snapshot).toBeNull();
    expect(signCalls).toEqual([]);
  });

  it("never calls the signer for a token that carries both groups", async () => {
    const { deps, signCalls } = await setup();
    const role = rolesFromClaims({ "cognito:groups": ["family", "reviewer"] });
    expect(role).toBe("reviewer");
    const detail = await handleGetEncounter(request(role ?? "reviewer"), deps);
    expect(detail.snapshot).toBeNull();
    expect(signCalls).toEqual([]);
  });

  it("asks the signer for a 300-second URL for family only", async () => {
    const { deps, signCalls } = await setup();
    const detail = await handleGetEncounter(request("family"), deps);
    expect(SNAPSHOT_URL_TTL_S).toBe(SIGNER_MAX_TTL_S);
    expect(signCalls).toEqual([{ key: "snapshots/warashi-01/enc-1.jpg", ttlS: 300 }]);
    expect(detail.snapshot?.url).toBe(SIGNED);
    expect(detail.snapshot?.expiresAt).toBe(new Date(NOW_MS + 300_000).toISOString());
  });

  it("keeps the encounter and hides the picture when signing fails", async () => {
    const { deps } = await setup();
    const failing: ReadDeps = {
      ...deps,
      signer: {
        sign: async () => {
          throw new Error("invoke failed");
        },
      },
    };
    const detail = await handleGetEncounter(request("family"), failing);
    expect(detail.encounterId).toBe("enc-1");
    expect(detail.snapshot).toBeNull();
  });
});
