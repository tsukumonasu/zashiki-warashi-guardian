/**
 * Tests for the remote actions (`docs/schema.md`, "HTTP API": `POST /photos`,
 * `GET /photos/{requestId}`, `POST /say`) and the judge's photo branch.
 *
 * Everything runs on the in-memory fakes, with no network and no AWS.
 */
import { describe, expect, it } from "vitest";
import { handlePostPhoto, PHOTOS_PER_HOUR, type PhotoDeps } from "../lambda/api-admin/photos-core.js";
import {
  handlePostSay,
  MAX_WAV_BYTES,
  SAY_SUBTITLE_EN,
  SAY_URL_TTL_S,
  SAYS_PER_HOUR,
  type SayDeps,
} from "../lambda/api-say/say-core.js";
import { handleGetPhoto } from "../lambda/api-read/photos-core.js";
import { DEFAULT_CONFIG } from "../lambda/_shared/config.js";
import { ApiError } from "../lambda/_shared/http.js";
import type { PhotoReader, PhotoRecord, PhotoStore } from "../lambda/_shared/ports.js";
import { handleSnapshot, type JudgeDeps, type SnapshotEvent } from "../lambda/judge/judge-core.js";
import { FakeDeviceBus, FakeFaceSearch, FakeNotifier, FakeRepository, FakeSnapshotStore, FakeSpeechSynth, FakeStateStore } from "./fakes.js";

const DEVICE = "warashi-01";
const NOW = Date.parse("2026-11-20T12:00:00.000Z");
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

function ids(): () => string {
  let seq = 0;
  return () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
}

// ---------------------------------------------------------------------------------------------
// POST /photos
// ---------------------------------------------------------------------------------------------

function photoSetup() {
  const bus = new FakeDeviceBus();
  const repository = new FakeRepository(() => NOW);
  const state = new FakeStateStore({ now: () => NOW });
  const deps: PhotoDeps = {
    bus,
    repository,
    state,
    config: { statusIntervalS: 60 },
    newId: ids(),
    nowMs: NOW,
  };
  return { bus, repository, state, deps };
}

const familyPhoto = { role: "family" as const, userSub: "user-1", body: { deviceId: DEVICE } };

describe("POST /photos", () => {
  it("publishes one snapshot.request with purpose photo and returns its requestId", async () => {
    const { bus, deps } = photoSetup();
    const result = await handlePostPhoto(familyPhoto, deps);
    expect(bus.published).toHaveLength(1);
    const sent = bus.published[0]!;
    expect(sent.topic).toBe(`warashi/${DEVICE}/commands`);
    expect(sent.envelope.type).toBe("snapshot.request");
    expect(sent.envelope.encounterId).toBeNull();
    expect(sent.envelope.data).toEqual({ requestId: result.requestId, purpose: "photo" });
    expect(result.deviceOnline).toBe(false);
  });

  it("reports an online doll", async () => {
    const { repository, deps } = photoSetup();
    await repository.putStatusReport(DEVICE, STATUS, NOW - 1000);
    expect((await handlePostPhoto(familyPhoto, deps)).deviceOnline).toBe(true);
  });

  it("refuses the reviewer and publishes nothing", async () => {
    const { bus, deps } = photoSetup();
    expect(await codeOf(handlePostPhoto({ ...familyPhoto, role: "reviewer" }, deps))).toBe("forbidden");
    expect(bus.published).toHaveLength(0);
  });

  it.each([{}, { deviceId: "" }, { deviceId: "a b" }, { deviceId: 5 }, { deviceId: "x".repeat(65) }])(
    "rejects the body %j",
    async (body) => {
      const { bus, deps } = photoSetup();
      expect(await codeOf(handlePostPhoto({ ...familyPhoto, body }, deps))).toBe("validation_failed");
      expect(bus.published).toHaveLength(0);
    },
  );

  it("limits the requests per hour and says when to retry", async () => {
    const { bus, deps } = photoSetup();
    for (let i = 0; i < PHOTOS_PER_HOUR; i += 1) await handlePostPhoto(familyPhoto, deps);
    const error = await handlePostPhoto(familyPhoto, deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("rate_limited");
    expect((error as ApiError).retryAfterS).toBeGreaterThanOrEqual(1);
    expect(bus.published).toHaveLength(PHOTOS_PER_HOUR);
  });

  it("answers internal when the publish fails", async () => {
    const { bus, deps } = photoSetup();
    bus.failNext();
    expect(await codeOf(handlePostPhoto(familyPhoto, deps))).toBe("internal");
  });
});

// ---------------------------------------------------------------------------------------------
// GET /photos/{requestId}
// ---------------------------------------------------------------------------------------------

class FakePhotos implements PhotoReader, PhotoStore {
  readonly items = new Map<string, PhotoRecord>();
  failPut = false;
  async getPhoto(requestId: string): Promise<PhotoRecord | null> {
    return this.items.get(requestId) ?? null;
  }
  async putPhoto(photo: PhotoRecord): Promise<void> {
    if (this.failPut) throw new Error("put failed");
    this.items.set(photo.requestId, photo);
  }
}

function record(overrides: Partial<PhotoRecord> = {}): PhotoRecord {
  return {
    requestId: "req-1",
    deviceId: DEVICE,
    snapshotKey: "snapshots/warashi-01/20261120/snap-1.jpg",
    atMs: NOW,
    ttl: Math.floor(NOW / 1000) + 3 * 86_400,
    ...overrides,
  };
}

describe("GET /photos/{requestId}", () => {
  function readSetup(signed: string | null = "https://signed.example.invalid/photo") {
    const photos = new FakePhotos();
    const calls: { key: string; ttlS: number }[] = [];
    const deps = {
      photos,
      signer: {
        sign: async (key: string, ttlS: number) => {
          calls.push({ key, ttlS });
          return signed;
        },
      },
      nowMs: NOW,
    };
    return { photos, calls, deps };
  }
  const ask = (role: "family" | "reviewer", requestId = "req-1") => ({
    role,
    pathParameters: { requestId },
  });

  it("is pending for an id that has no picture yet", async () => {
    const { deps } = readSetup();
    expect(await handleGetPhoto(ask("family"), deps)).toEqual({ status: "pending" });
  });

  it("is ready with a 5-minute URL once the picture is indexed", async () => {
    const { photos, calls, deps } = readSetup();
    await photos.putPhoto(record());
    const result = await handleGetPhoto(ask("family"), deps);
    expect(result).toEqual({
      status: "ready",
      url: "https://signed.example.invalid/photo",
      expiresAt: new Date(NOW + 300_000).toISOString(),
    });
    expect(calls).toEqual([{ key: record().snapshotKey, ttlS: 300 }]);
  });

  it("is pending again after the item expired", async () => {
    const { photos, deps } = readSetup();
    await photos.putPhoto(record({ ttl: Math.floor(NOW / 1000) - 1 }));
    expect(await handleGetPhoto(ask("family"), deps)).toEqual({ status: "pending" });
  });

  it("is pending when the signer has no URL", async () => {
    const { photos, deps } = readSetup(null);
    await photos.putPhoto(record());
    expect(await handleGetPhoto(ask("family"), deps)).toEqual({ status: "pending" });
  });

  it("never reaches the signer for the reviewer", async () => {
    const { photos, calls, deps } = readSetup();
    await photos.putPhoto(record());
    expect(await codeOf(handleGetPhoto(ask("reviewer"), deps))).toBe("forbidden");
    expect(calls).toHaveLength(0);
  });

  it.each(["", "a b", "a_b", "x".repeat(65)])("rejects the id %j", async (requestId) => {
    const { deps } = readSetup();
    expect(await codeOf(handleGetPhoto(ask("family", requestId), deps))).toBe("validation_failed");
  });
});

// ---------------------------------------------------------------------------------------------
// POST /say
// ---------------------------------------------------------------------------------------------

function saySetup() {
  const bus = new FakeDeviceBus();
  const repository = new FakeRepository(() => NOW);
  const state = new FakeStateStore({ now: () => NOW });
  const synth = new FakeSpeechSynth();
  const store = new FakeSnapshotStore();
  const deps: SayDeps = {
    bus,
    repository,
    state,
    config: { statusIntervalS: 60 },
    synth,
    store,
    blockedWords: [],
    newId: ids(),
    nowMs: NOW,
  };
  return { bus, repository, state, synth, store, deps };
}

const say = (text: unknown, role: "family" | "reviewer" = "family") => ({
  role,
  userSub: "user-1",
  body: { deviceId: DEVICE, text },
});

describe("POST /say", () => {
  it("makes a WAV, stores it under audio/say/ and sends a remote speak", async () => {
    const { bus, store, synth, deps } = saySetup();
    const result = await handlePostSay(say("そこで なにをしているの？"), deps);

    expect(synth.wavCalls).toEqual(["そこで なにをしているの？"]);
    const [key] = store.putCalls;
    expect(key).toMatch(/^audio\/say\/[0-9a-f-]+\.wav$/);
    expect(store.contentTypes.get(key!)).toBe("audio/wav");
    expect(store.signCalls).toEqual([{ key, ttlS: SAY_URL_TTL_S }]);

    expect(bus.published).toHaveLength(1);
    const sent = bus.published[0]!;
    expect(sent.topic).toBe(`warashi/${DEVICE}/commands`);
    expect(sent.envelope.id).toBe(result.id);
    expect(sent.envelope.type).toBe("speak");
    expect(sent.envelope.encounterId).toBeNull();
    expect(sent.envelope.data).toEqual({
      lineId: null,
      audioUrl: expect.stringContaining("https://snapshots.example.invalid/audio/say/"),
      ja: "そこで なにをしているの？",
      en: SAY_SUBTITLE_EN,
      remote: true,
    });
  });

  it("refuses the reviewer before any work", async () => {
    const { bus, synth, deps } = saySetup();
    expect(await codeOf(handlePostSay(say("こんにちは", "reviewer"), deps))).toBe("forbidden");
    expect(synth.wavCalls).toHaveLength(0);
    expect(bus.published).toHaveLength(0);
  });

  it.each([
    ["not a string", 5],
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["too long", "あ".repeat(61)],
    ["latin letters", "hello こんにちは"],
    ["emoji", "こんにちは😀"],
    ["a threat word", "ころすよ"],
    ["four sentences", "いち。に。さん。よん。"],
  ])("rejects text that is %s and does nothing", async (_name, text) => {
    const { bus, store, synth, deps } = saySetup();
    expect(await codeOf(handlePostSay(say(text), deps))).toBe("validation_failed");
    expect(synth.wavCalls).toHaveLength(0);
    expect(store.putCalls).toHaveLength(0);
    expect(bus.published).toHaveLength(0);
  });

  it("accepts 60 characters", async () => {
    const { deps } = saySetup();
    await expect(handlePostSay(say("あ".repeat(60)), deps)).resolves.toMatchObject({ deviceOnline: false });
  });

  it("applies the configured blocked words", async () => {
    const { deps } = saySetup();
    expect(await codeOf(handlePostSay(say("ひみつのことば"), { ...deps, blockedWords: ["ひみつ"] }))).toBe(
      "validation_failed",
    );
  });

  it("limits the messages per hour", async () => {
    const { bus, deps } = saySetup();
    for (let i = 0; i < SAYS_PER_HOUR; i += 1) await handlePostSay(say("こんにちは"), deps);
    expect(await codeOf(handlePostSay(say("こんにちは"), deps))).toBe("rate_limited");
    expect(bus.published).toHaveLength(SAYS_PER_HOUR);
  });

  it("answers internal, with no text in the message, when the synthesis fails", async () => {
    const { bus, synth, store, deps } = saySetup();
    synth.failNextWav();
    const error = await handlePostSay(say("ひみつのメッセージ"), deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("internal");
    expect((error as ApiError).message).not.toContain("ひみつ");
    expect(store.putCalls).toHaveLength(0);
    expect(bus.published).toHaveLength(0);
  });

  it("refuses a WAV above the size the device accepts", async () => {
    const { bus, synth, deps } = saySetup();
    synth.wav16k = async () => new Uint8Array(MAX_WAV_BYTES + 1);
    expect(await codeOf(handlePostSay(say("こんにちは"), deps))).toBe("internal");
    expect(bus.published).toHaveLength(0);
  });

  it("answers internal when the publish fails", async () => {
    const { bus, deps } = saySetup();
    bus.failNext();
    expect(await codeOf(handlePostSay(say("こんにちは"), deps))).toBe("internal");
  });
});

// ---------------------------------------------------------------------------------------------
// Judge: a snapshot with purpose "photo"
// ---------------------------------------------------------------------------------------------

describe("judge: remote photo", () => {
  const ENCOUNTER = "c1d2e3f4-0000-4000-8000-000000000001";
  const TS = "2026-11-20T12:34:56.789Z";

  function jpegBase64(): string {
    const bytes = new Uint8Array(500);
    bytes.set([0xff, 0xd8, 0xff]);
    return Buffer.from(bytes).toString("base64");
  }

  function photoEvent(
    data: Record<string, unknown> = {},
    encounterId: string | null = ENCOUNTER,
  ): SnapshotEvent {
    return {
      v: 1,
      id: "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10",
      ts: TS,
      deviceId: DEVICE,
      encounterId,
      type: "snapshot.captured",
      data: {
        snapshotId: "snap-photo-1",
        width: 640,
        height: 480,
        panDeg: 0,
        tiltDeg: 0,
        jpegBase64: jpegBase64(),
        requestId: "req-1",
        purpose: "photo",
        ...data,
      },
      topicDeviceId: DEVICE,
    };
  }

  function judgeSetup(withPhotos = true) {
    const now = (): number => NOW;
    const repository = new FakeRepository(now);
    const state = new FakeStateStore({ now, repository });
    const faces = new FakeFaceSearch();
    const snapshots = new FakeSnapshotStore();
    const bus = new FakeDeviceBus();
    const notifier = new FakeNotifier();
    const photos = new FakePhotos();
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
      newId: ids(),
      sleep: () => Promise.resolve(),
      ...(withPhotos ? { photos } : {}),
    };
    return { deps, faces, snapshots, bus, notifier, photos, repository };
  }

  it("stores the picture and the index item, and does nothing else", async () => {
    const { deps, faces, snapshots, bus, notifier, photos } = judgeSetup();
    const result = await handleSnapshot(photoEvent(), deps);

    expect(result).toEqual({ outcome: "photo", stored: true });
    expect(snapshots.putCalls).toEqual(["snapshots/warashi-01/20261120/snap-photo-1.jpg"]);
    expect(photos.items.get("req-1")).toEqual({
      requestId: "req-1",
      deviceId: DEVICE,
      snapshotKey: "snapshots/warashi-01/20261120/snap-photo-1.jpg",
      atMs: NOW,
      ttl: Math.floor(NOW / 1000) + DEFAULT_CONFIG.snapshotExpiryDays * 86_400,
    });
    expect(faces.searchCalls).toHaveLength(0);
    expect(bus.published).toHaveLength(0);
    expect(notifier.sent).toHaveLength(0);
  });

  it("keeps the picture on the encounter so the timeline can show it", async () => {
    const { deps, repository } = judgeSetup();
    await handleSnapshot(photoEvent(), deps);
    const meta = await repository.getEncounter(ENCOUNTER, NOW);
    expect(meta?.snapshotKey).toBe("snapshots/warashi-01/20261120/snap-photo-1.jpg");
    expect(meta?.verdict).toBeNull();
  });

  it("ignores a photo without a requestId", async () => {
    const { deps, snapshots, photos } = judgeSetup();
    const result = await handleSnapshot(photoEvent({ requestId: null }), deps);
    expect(result).toEqual({ outcome: "ignored", reason: "photo_without_request" });
    expect(snapshots.putCalls).toHaveLength(0);
    expect(photos.items.size).toBe(0);
  });

  it("ignores a photo when no photo store is wired", async () => {
    const { deps, snapshots } = judgeSetup(false);
    const result = await handleSnapshot(photoEvent(), deps);
    expect(result).toEqual({ outcome: "ignored", reason: "photo_without_request" });
    expect(snapshots.putCalls).toHaveLength(0);
  });

  it("treats a redelivered photo as a duplicate", async () => {
    const { deps, snapshots } = judgeSetup();
    await handleSnapshot(photoEvent(), deps);
    expect(await handleSnapshot(photoEvent(), deps)).toEqual({ outcome: "duplicate" });
    expect(snapshots.putCalls).toHaveLength(1);
  });

  it("leaves no index item when the picture could not be stored", async () => {
    const { deps, snapshots, photos } = judgeSetup();
    snapshots.failNextPut();
    expect(await handleSnapshot(photoEvent(), deps)).toEqual({ outcome: "photo", stored: false });
    expect(photos.items.size).toBe(0);
  });

  it("reports stored: false when the index item could not be written", async () => {
    const { deps, photos } = judgeSetup();
    photos.failPut = true;
    expect(await handleSnapshot(photoEvent(), deps)).toEqual({ outcome: "photo", stored: false });
  });

  it("still judges a snapshot without a purpose", async () => {
    const { deps, faces } = judgeSetup();
    faces.queueSearch({ kind: "no_face" });
    const event = photoEvent({ purpose: null, requestId: null, snapshotId: "snap-2" });
    const result = await handleSnapshot(event, deps);
    expect(result.outcome).toBe("judged");
  });
});
