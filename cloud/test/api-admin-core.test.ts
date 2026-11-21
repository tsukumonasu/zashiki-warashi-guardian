/**
 * Unit tests for the `api-admin` cores: `POST /commands` and the face routes.
 * Requirements: 16.3 to 16.7, 16.9, 16.10, 17.4, 17.5, 17.7, 17.8, 17.10, 17.14, 17.15.
 */

import { describe, expect, it } from "vitest";
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
import type { Role } from "../lambda/_shared/authz.js";
import { ApiError } from "../lambda/_shared/http.js";
import type { VoiceLine } from "../lambda/_shared/lines.js";
import { FakeDeviceBus, FakeFaceSearch, FakeRepository } from "./fakes.js";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const LINES: VoiceLine[] = [{ id: "family_hello", category: "family", ja: "おかえり", en: "Welcome back" }];
const STATUS = {
  state: "sleeping",
  mode: "guard" as const,
  panDeg: 0,
  tiltDeg: 0,
  lantern: 0,
  cameraActive: false,
  micActive: false,
  motionEnabled: false,
  uptimeSec: 10,
  agentVersion: "test",
};

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
  return "no_error";
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

function commandSetup() {
  const bus = new FakeDeviceBus();
  const repository = new FakeRepository();
  let seq = 0;
  const deps: CommandDeps = {
    bus,
    repository,
    config: { statusIntervalS: 60 },
    lines: LINES,
    newId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    nowMs: NOW,
  };
  const send = (body: Record<string, unknown>, role: Role = "family") =>
    handlePostCommand({ role, body }, deps);
  return { bus, repository, deps, send };
}

const cmd = (type: string, data: unknown, deviceId: unknown = "warashi-01") => ({
  deviceId,
  command: { type, data },
});

describe("POST /commands", () => {
  it("publishes a valid command once with qos 1 and a null encounterId", async () => {
    const { bus, repository, send } = commandSetup();
    await repository.putStatusReport("warashi-01", STATUS, NOW - 1000);
    const result = await send(cmd("gaze", { panDeg: 10, tiltDeg: -5 }));
    expect(result.deviceOnline).toBe(true);
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(bus.published).toHaveLength(1);
    const message = bus.published[0]!;
    expect(message.qos).toBe(1);
    expect(message.topic).toBe("warashi/warashi-01/commands");
    expect(message.envelope.encounterId).toBeNull();
    expect(message.envelope.id).toBe(result.id);
    expect(message.envelope.data).toEqual({ panDeg: 10, tiltDeg: -5 });
  });

  it("clamps gaze and lantern values", async () => {
    const { bus, send } = commandSetup();
    await send(cmd("gaze", { panDeg: 500, tiltDeg: -500 }));
    await send(cmd("lantern", { level: 7, fadeMs: 99_999 }));
    await send(cmd("lantern", { level: -2, fadeMs: -5 }));
    await send(cmd("gaze", { panDeg: -61, tiltDeg: 31 }));
    expect(bus.published.map((m) => m.envelope.data)).toEqual([
      { panDeg: 60, tiltDeg: -30 },
      { level: 1, fadeMs: 10_000 },
      { level: 0, fadeMs: 0 },
      { panDeg: -60, tiltDeg: 30 },
    ]);
  });

  it("publishes a cached speak line and mode.set", async () => {
    const { bus, send } = commandSetup();
    await send(cmd("speak", { lineId: "family_hello" }));
    await send(cmd("mode.set", { mode: "sleep" }));
    expect(bus.published[0]!.envelope.data).toEqual({
      lineId: "family_hello",
      audioUrl: null,
      ja: "おかえり",
      en: "Welcome back",
    });
    expect(bus.published[1]!.envelope.data).toEqual({ mode: "sleep" });
  });

  const invalidBodies: [string, Record<string, unknown>][] = [
    ["unknown type", cmd("judgement.result", {})],
    ["missing command", { deviceId: "warashi-01" }],
    ["command not an object", { deviceId: "warashi-01", command: "gaze" }],
    ["data not an object", cmd("gaze", null)],
    ["speak with audioUrl", cmd("speak", { lineId: "family_hello", audioUrl: "https://x.invalid/a.wav" })],
    ["speak unknown line", cmd("speak", { lineId: "nope" })],
    ["speak without lineId", cmd("speak", {})],
    ["mode other than guard or sleep", cmd("mode.set", { mode: "party" })],
    ["gaze missing field", cmd("gaze", { panDeg: 1 })],
    ["gaze string number", cmd("gaze", { panDeg: "1", tiltDeg: 1 })],
    ["gaze NaN", cmd("gaze", { panDeg: Number.NaN, tiltDeg: 1 })],
    ["gaze Infinity", cmd("gaze", { panDeg: 1, tiltDeg: Number.POSITIVE_INFINITY })],
    ["lantern missing fadeMs", cmd("lantern", { level: 0.5 })],
    ["empty deviceId", cmd("gaze", { panDeg: 1, tiltDeg: 1 }, "")],
    ["deviceId too long", cmd("gaze", { panDeg: 1, tiltDeg: 1 }, "a".repeat(65))],
    ["deviceId bad character", cmd("gaze", { panDeg: 1, tiltDeg: 1 }, "a/b")],
    ["deviceId not a string", cmd("gaze", { panDeg: 1, tiltDeg: 1 }, 5)],
  ];

  it.each(invalidBodies)("rejects %s with validation_failed and publishes nothing", async (_name, body) => {
    const { bus, send } = commandSetup();
    expect(await codeOf(send(body))).toBe("validation_failed");
    expect(bus.published).toHaveLength(0);
  });

  it("accepts a 64-character deviceId", async () => {
    const { bus, send } = commandSetup();
    await send(cmd("mode.set", { mode: "guard" }, "a".repeat(64)));
    expect(bus.published).toHaveLength(1);
  });

  it("publishes once and reports offline for an offline or unknown doll", async () => {
    const { bus, repository, send } = commandSetup();
    expect((await send(cmd("mode.set", { mode: "guard" }))).deviceOnline).toBe(false);
    await repository.putStatusReport("warashi-01", STATUS, NOW - 1000);
    await repository.markOffline("warashi-01", NOW - 500);
    expect((await send(cmd("mode.set", { mode: "guard" }))).deviceOnline).toBe(false);
    expect(bus.published).toHaveLength(2);
  });

  it("publishes even when the status read fails", async () => {
    const { bus, deps } = commandSetup();
    deps.repository = {
      getDeviceStatus: async () => {
        throw new Error("db down");
      },
    };
    const result = await handlePostCommand({ role: "family", body: cmd("mode.set", { mode: "guard" }) }, deps);
    expect(result.deviceOnline).toBe(false);
    expect(bus.published).toHaveLength(1);
  });

  it("denies the reviewer without publishing", async () => {
    const { bus, send } = commandSetup();
    expect(await codeOf(send(cmd("mode.set", { mode: "guard" }), "reviewer"))).toBe("forbidden");
    expect(bus.published).toHaveLength(0);
  });

  it("answers a publish failure with a generic internal error and no retry", async () => {
    const { bus, send } = commandSetup();
    bus.failNext(new Error("arn:aws:iot:secret-topic certificate stack"));
    try {
      await send(cmd("mode.set", { mode: "guard" }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.code).toBe("internal");
      expect(apiError.message).not.toMatch(/warashi\/|arn:|certificate|stack|secret/i);
    }
    expect(bus.published).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Faces
// ---------------------------------------------------------------------------------------------

const VERSION = "2026-11";
const STAGING_KEY = "faces-staging/abc-123";
const OTHER_UUID = "11111111-1111-4111-8111-111111111111";

class FakeStaging implements FaceStaging {
  readonly objects = new Map<string, Uint8Array>();
  readonly deleted: string[] = [];
  failDelete = false;
  uploads: Parameters<FaceStaging["createUpload"]>[0][] = [];

  async createUpload(options: Parameters<FaceStaging["createUpload"]>[0]) {
    this.uploads.push(options);
    return { url: "https://staging.example.invalid/", fields: { key: options.key } };
  }
  async read(key: string) {
    return this.objects.get(key) ?? null;
  }
  async delete(key: string) {
    this.deleted.push(key);
    if (this.failDelete) throw new Error("delete failed");
    this.objects.delete(key);
  }
}

function faceSetup() {
  const repository = new FakeRepository();
  const faces = new FakeFaceSearch();
  const staging = new FakeStaging();
  staging.objects.set(STAGING_KEY, new Uint8Array([1, 2, 3]));
  let seq = 0;
  const deps: FacesDeps = {
    repository,
    faces,
    staging,
    collectionId: "warashi-household",
    consentNoticeVersion: VERSION,
    nowMs: NOW,
    newId: () => `22222222-2222-4222-8222-${String(++seq).padStart(12, "0")}`,
  };
  const request = (body: Record<string, unknown>, extra: Partial<FacesRequest> = {}): FacesRequest => ({
    role: "family",
    userId: "user-1",
    body,
    pathParameters: {},
    ...extra,
  });
  // Each registration consumes (deletes) its staged photo, so every call stages a fresh one.
  const register = (overrides: Record<string, unknown> = {}, extra: Partial<FacesRequest> = {}) => {
    if (!staging.objects.has(STAGING_KEY)) staging.objects.set(STAGING_KEY, new Uint8Array([1, 2, 3]));
    return handleRegisterFace(
      request(
        {
          stagingKey: STAGING_KEY,
          displayName: "Haru",
          memberId: null,
          consent: { noticeVersion: VERSION, accepted: true },
          ...overrides,
        },
        extra,
      ),
      deps,
    );
  };
  return { repository, faces, staging, deps, request, register };
}

describe("face registration", () => {
  it("registers a new member with an opaque ExternalImageId and deletes the staged photo", async () => {
    const { repository, faces, staging, register } = faceSetup();
    const result = await register();
    expect(result.faceCount).toBe(1);
    expect(faces.indexCalls).toEqual([{ collectionId: "warashi-household", externalImageId: result.memberId }]);
    const member = await repository.getMember(result.memberId);
    expect(member).toMatchObject({
      displayName: "Haru",
      consentVersion: VERSION,
      consentAt: "2026-11-20T12:00:00.000Z",
      createdBy: "user-1",
    });
    expect(member?.faceIds).toHaveLength(1);
    expect(staging.deleted).toEqual([STAGING_KEY]);
  });

  it("rejects a consent version mismatch or a missing acceptance with consent_required", async () => {
    const { faces, staging, register } = faceSetup();
    expect(await codeOf(register({ consent: { noticeVersion: "old", accepted: true } }))).toBe("consent_required");
    expect(await codeOf(register({ consent: { noticeVersion: VERSION, accepted: false } }))).toBe("consent_required");
    expect(await codeOf(register({ consent: { noticeVersion: VERSION } }))).toBe("consent_required");
    expect(faces.indexCalls).toHaveLength(0);
    expect(staging.deleted).toEqual([STAGING_KEY, STAGING_KEY, STAGING_KEY]);
  });

  it("rejects a bad display name", async () => {
    const { repository, faces, staging, register } = faceSetup();
    for (const displayName of ["", "a".repeat(41), 5, undefined]) {
      expect(await codeOf(register({ displayName }))).toBe("validation_failed");
    }
    expect(faces.indexCalls).toHaveLength(0);
    expect(await repository.listMembers()).toHaveLength(0);
    expect(staging.deleted).toHaveLength(4);
    // 40 characters, counted as code points, is accepted.
    await register({ displayName: "あ".repeat(40) });
  });

  it("rejects zero faces and two faces, removes indexed faces and deletes the staged photo", async () => {
    const { repository, faces, staging, register } = faceSetup();
    faces.queueIndexCount(0, 2);
    expect(await codeOf(register())).toBe("face_count_invalid");
    expect(await codeOf(register())).toBe("face_count_invalid");
    expect(faces.indexed.size).toBe(0);
    expect(faces.deleteCalls).toHaveLength(1);
    expect(await repository.listMembers()).toHaveLength(0);
    expect(staging.deleted).toEqual([STAGING_KEY, STAGING_KEY]);
  });

  it("answers an index failure with internal and still cleans staging", async () => {
    const { faces, staging, register } = faceSetup();
    faces.failNextIndex();
    expect(await codeOf(register())).toBe("internal");
    expect(staging.deleted).toEqual([STAGING_KEY]);
  });

  it("answers a failed cleanup of wrong-count faces with internal", async () => {
    const { faces, staging, register } = faceSetup();
    faces.queueIndexCount(2).failNextDelete();
    expect(await codeOf(register())).toBe("internal");
    expect(staging.deleted).toEqual([STAGING_KEY]);
  });

  it("rejects an unknown memberId with not_found and deletes the staged photo", async () => {
    const { faces, staging, register } = faceSetup();
    expect(await codeOf(register({ memberId: OTHER_UUID }))).toBe("not_found");
    expect(faces.indexCalls).toHaveLength(0);
    expect(staging.deleted).toEqual([STAGING_KEY]);
  });

  it("rejects a malformed memberId", async () => {
    const { register } = faceSetup();
    expect(await codeOf(register({ memberId: "nope" }))).toBe("validation_failed");
  });

  it("adds a photo to an existing member and keeps name and consent", async () => {
    const { repository, faces, staging, register } = faceSetup();
    const first = await register();
    staging.objects.set(STAGING_KEY, new Uint8Array([4]));
    const second = await register({ memberId: first.memberId, displayName: "Different" });
    expect(second).toEqual({ memberId: first.memberId, faceCount: 2 });
    expect(faces.indexCalls[1]!.externalImageId).toBe(first.memberId);
    const member = await repository.getMember(first.memberId);
    expect(member?.displayName).toBe("Haru");
    expect(member?.faceIds).toHaveLength(2);
    expect(member?.consentAt).toBe("2026-11-20T12:00:00.000Z");
  });

  it("rejects a missing staged object and an unsafe staging key", async () => {
    const { staging, register } = faceSetup();
    expect(await codeOf(register({ stagingKey: "faces-staging/missing" }))).toBe("validation_failed");
    for (const stagingKey of ["../etc/passwd", "faces-staging/../x", "snapshots/a", "faces-staging/a/b", 5]) {
      expect(await codeOf(register({ stagingKey }))).toBe("validation_failed");
    }
    // Only the well-formed key of the first call is deleted; unsafe keys are never touched.
    expect(staging.deleted).toEqual(["faces-staging/missing"]);
  });

  it("ignores a failing staging delete", async () => {
    const { staging, register } = faceSetup();
    staging.failDelete = true;
    expect((await register()).faceCount).toBe(1);
  });

  it("denies the reviewer on every face route", async () => {
    const { faces, request, deps, register } = faceSetup();
    expect(await codeOf(register({}, { role: "reviewer" }))).toBe("forbidden");
    expect(await codeOf(handleListFaces(request({}, { role: "reviewer" }), deps))).toBe("forbidden");
    expect(await codeOf(handleFaceUpload(request({}, { role: "reviewer" }), deps))).toBe("forbidden");
    expect(
      await codeOf(
        handleDeleteFace(request({}, { role: "reviewer", pathParameters: { memberId: OTHER_UUID } }), deps),
      ),
    ).toBe("forbidden");
    expect(faces.indexCalls).toHaveLength(0);
  });
});

describe("face list, upload and delete", () => {
  it("lists members without face ids", async () => {
    const { request, deps, register } = faceSetup();
    expect(await handleListFaces(request({}), deps)).toEqual({ members: [] });
    const { memberId } = await register();
    const listed = await handleListFaces(request({}), deps);
    expect(listed.members).toEqual([
      {
        memberId,
        displayName: "Haru",
        createdAt: "2026-11-20T12:00:00.000Z",
        consentVersion: VERSION,
        faceCount: 1,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain("faceIds");
  });

  it("creates a 300 second JPEG or PNG upload of 1 to 5,000,000 bytes", async () => {
    const { request, deps, staging } = faceSetup();
    const upload = await handleFaceUpload(request({}), deps);
    expect(upload.expiresInS).toBe(300);
    expect(upload.stagingKey).toMatch(/^faces-staging\/[A-Za-z0-9_-]+$/);
    expect(staging.uploads[0]).toMatchObject({
      contentTypes: ["image/jpeg", "image/png"],
      minBytes: 1,
      maxBytes: 5_000_000,
      ttlS: 300,
    });
  });

  it("deletes the vectors and the record", async () => {
    const { repository, faces, request, deps, register } = faceSetup();
    const { memberId } = await register();
    const result = await handleDeleteFace(request({}, { pathParameters: { memberId } }), deps);
    expect(result).toBeUndefined();
    expect(faces.indexed.size).toBe(0);
    expect(await repository.getMember(memberId)).toBeNull();
  });

  it("answers not_found for an unknown or malformed member id", async () => {
    const { request, deps } = faceSetup();
    expect(await codeOf(handleDeleteFace(request({}, { pathParameters: { memberId: OTHER_UUID } }), deps))).toBe(
      "not_found",
    );
    expect(await codeOf(handleDeleteFace(request({}, { pathParameters: { memberId: "x" } }), deps))).toBe("not_found");
    expect(await codeOf(handleDeleteFace(request({}), deps))).toBe("not_found");
  });

  it("keeps the record when deleting the vectors fails, and a repeat succeeds", async () => {
    const { repository, faces, request, deps, register } = faceSetup();
    const { memberId } = await register();
    faces.failNextDelete();
    const req = request({}, { pathParameters: { memberId } });
    expect(await codeOf(handleDeleteFace(req, deps))).toBe("internal");
    expect(await repository.getMember(memberId)).not.toBeNull();
    await handleDeleteFace(req, deps);
    expect(await repository.getMember(memberId)).toBeNull();
    expect(faces.indexed.size).toBe(0);
  });
});
