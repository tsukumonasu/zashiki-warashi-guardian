/**
 * In-memory fakes for every port in `lambda/_shared/ports.ts` (cloud-judgement task 11.2).
 *
 * The fakes model the DynamoDB design (`attribute_not_exists` puts, TTL on claims and counters,
 * the notify-slot transaction) so handler and core tests run on a laptop with no AWS account.
 * No fake imports an AWS SDK. Time is passed in as a `now` function so tests stay deterministic.
 */

import type { Category } from "../lambda/_shared/lines.js";
import { topicFor, type Envelope } from "../lambda/_shared/messages.js";
import type {
  DeviceBus,
  DeviceStatusRecord,
  EncounterMeta,
  EncounterPage,
  EncounterPatch,
  FaceSearch,
  FamilyMember,
  Notifier,
  Repository,
  SampleEntry,
  SnapshotStore,
  SpeechSynth,
  StateStore,
  StatusReportData,
} from "../lambda/_shared/ports.js";
import type { FaceBox, FaceQuality, SearchOutcome } from "../lambda/_shared/verdict.js";

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

export type Clock = () => number;

/** An error that carries an AWS-style `name`, such as `ThrottlingException`. */
export class FakeAwsError extends Error {
  constructor(name: string, message = name) {
    super(message);
    this.name = name;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------------------
// FakeFaceSearch
// ---------------------------------------------------------------------------------------------

/** One scripted result: a value to return, or an error to reject with. */
export type Scripted<T> = { value: T } | { error: Error };

export type DetectResult = { faces: number; quality: FaceQuality; box: FaceBox | null };

export type SearchCall = { image: Uint8Array; collectionId: string; floor: number };

/**
 * Scripted face search. Each call takes the next queued step; with an empty queue it returns the
 * default (`no_face` for search, no faces for detect). Failures are queued like results.
 */
export class FakeFaceSearch implements FaceSearch {
  readonly searchCalls: SearchCall[] = [];
  readonly detectCalls: Uint8Array[] = [];
  /** Added latency per call in milliseconds (real timers). */
  searchDelayMs = 0;
  defaultSearch: SearchOutcome = { kind: "no_face" };
  defaultDetect: DetectResult = { faces: 0, quality: null, box: null };

  private readonly searchQueue: Scripted<SearchOutcome>[] = [];
  private readonly detectQueue: Scripted<DetectResult>[] = [];

  queueSearch(...outcomes: SearchOutcome[]): this {
    for (const value of outcomes) this.searchQueue.push({ value });
    return this;
  }

  queueSearchError(error: Error): this {
    this.searchQueue.push({ error });
    return this;
  }

  /** Queue a `ThrottlingException`, which the judge retries once (R5.10). */
  queueSearchThrottle(): this {
    return this.queueSearchError(new FakeAwsError("ThrottlingException", "Rate exceeded"));
  }

  queueDetect(...results: DetectResult[]): this {
    for (const value of results) this.detectQueue.push({ value });
    return this;
  }

  queueDetectError(error: Error): this {
    this.detectQueue.push({ error });
    return this;
  }

  async search(image: Uint8Array, collectionId: string, floor: number): Promise<SearchOutcome> {
    this.searchCalls.push({ image, collectionId, floor });
    if (this.searchDelayMs > 0) await sleep(this.searchDelayMs);
    const step = this.searchQueue.shift();
    if (step === undefined) return clone(this.defaultSearch);
    if ("error" in step) throw step.error;
    return clone(step.value);
  }

  /** Faces currently in the fake collections: face id to its collection and external image id. */
  readonly indexed = new Map<string, { collectionId: string; externalImageId: string }>();
  readonly indexCalls: { collectionId: string; externalImageId: string }[] = [];
  readonly deleteCalls: { collectionId: string; faceIds: string[] }[] = [];
  private readonly indexCounts: number[] = [];
  private readonly indexFailures: Error[] = [];
  private readonly deleteFailures: Error[] = [];
  private faceSeq = 0;

  /** Number of faces the next `indexFaces` calls index, taken in order. Default is 1. */
  queueIndexCount(...counts: number[]): this {
    this.indexCounts.push(...counts);
    return this;
  }

  failNextIndex(error: Error = new Error("index failed")): this {
    this.indexFailures.push(error);
    return this;
  }

  failNextDelete(error: Error = new Error("delete failed")): this {
    this.deleteFailures.push(error);
    return this;
  }

  async indexFaces(_image: Uint8Array, collectionId: string, externalImageId: string): Promise<string[]> {
    this.indexCalls.push({ collectionId, externalImageId });
    const failure = this.indexFailures.shift();
    if (failure !== undefined) throw failure;
    const count = this.indexCounts.shift() ?? 1;
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      this.faceSeq += 1;
      const faceId = `00000000-0000-4000-8000-${String(this.faceSeq).padStart(12, "0")}`;
      this.indexed.set(faceId, { collectionId, externalImageId });
      ids.push(faceId);
    }
    return ids;
  }

  async deleteFaces(collectionId: string, faceIds: readonly string[]): Promise<void> {
    this.deleteCalls.push({ collectionId, faceIds: [...faceIds] });
    const failure = this.deleteFailures.shift();
    if (failure !== undefined) throw failure;
    for (const faceId of faceIds) this.indexed.delete(faceId);
  }

  async detect(image: Uint8Array): Promise<DetectResult> {
    this.detectCalls.push(image);
    const step = this.detectQueue.shift();
    if (step === undefined) return clone(this.defaultDetect);
    if ("error" in step) throw step.error;
    return clone(step.value);
  }
}

// ---------------------------------------------------------------------------------------------
// FakeSnapshotStore
// ---------------------------------------------------------------------------------------------

export class FakeSnapshotStore implements SnapshotStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly putCalls: string[] = [];
  readonly signCalls: { key: string; ttlS: number }[] = [];
  /** Errors for the next `put` calls, taken in order. */
  private readonly putFailures: Error[] = [];

  failNextPut(error: Error = new Error("put failed")): this {
    this.putFailures.push(error);
    return this;
  }

  async put(key: string, jpeg: Uint8Array): Promise<void> {
    this.putCalls.push(key);
    const failure = this.putFailures.shift();
    if (failure !== undefined) throw failure;
    this.objects.set(key, jpeg.slice());
  }

  async signGet(key: string, ttlS: number): Promise<string> {
    this.signCalls.push({ key, ttlS });
    return `https://snapshots.example.invalid/${key}?X-Amz-Signature=fake&ttl=${ttlS}`;
  }
}

// ---------------------------------------------------------------------------------------------
// FakeDeviceBus
// ---------------------------------------------------------------------------------------------

export type PublishedMessage = {
  topic: string;
  qos: 1;
  deviceId: string;
  envelope: Envelope;
};

export class FakeDeviceBus implements DeviceBus {
  readonly published: PublishedMessage[] = [];
  /** Added latency per publish in milliseconds (real timers). */
  delayMs = 0;
  private readonly failures: Error[] = [];

  failNext(error: Error = new Error("publish failed")): this {
    this.failures.push(error);
    return this;
  }

  async publish(deviceId: string, envelope: Envelope): Promise<void> {
    if (this.delayMs > 0) await sleep(this.delayMs);
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    this.published.push({
      topic: topicFor(deviceId, "commands"),
      qos: 1,
      deviceId,
      envelope: clone(envelope),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// FakeNotifier
// ---------------------------------------------------------------------------------------------

export class FakeNotifier implements Notifier {
  readonly sent: { subject: string; body: string }[] = [];
  /** Number of `send` calls, including failed ones. */
  attempts = 0;
  private readonly failures: Error[] = [];

  failNext(error: Error = new Error("send failed")): this {
    this.failures.push(error);
    return this;
  }

  async send(message: { subject: string; body: string }): Promise<void> {
    this.attempts += 1;
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    this.sent.push({ subject: message.subject, body: message.body });
  }
}

// ---------------------------------------------------------------------------------------------
// FakeSpeechSynth
// ---------------------------------------------------------------------------------------------

/** A WAV with a valid 44-byte header and the given PCM payload (16 kHz, mono, 16-bit). */
function makeWav(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

export class FakeSpeechSynth implements SpeechSynth {
  readonly lineCalls: { situation: Category; hint: string | null }[] = [];
  readonly mp3Calls: string[] = [];
  readonly wavCalls: string[] = [];
  /** Returned by `line` when nothing is queued. `null` means "no generated line". */
  defaultLine: string | null = null;

  private readonly lineQueue: Scripted<string | null>[] = [];
  private readonly mp3Failures: Error[] = [];
  private readonly wavFailures: Error[] = [];

  queueLine(...lines: (string | null)[]): this {
    for (const value of lines) this.lineQueue.push({ value });
    return this;
  }

  queueLineError(error: Error): this {
    this.lineQueue.push({ error });
    return this;
  }

  failNextMp3(error: Error = new Error("mp3 failed")): this {
    this.mp3Failures.push(error);
    return this;
  }

  failNextWav(error: Error = new Error("wav failed")): this {
    this.wavFailures.push(error);
    return this;
  }

  async line(situation: Category, hint: string | null): Promise<string | null> {
    this.lineCalls.push({ situation, hint });
    const step = this.lineQueue.shift();
    if (step === undefined) return this.defaultLine;
    if ("error" in step) throw step.error;
    return step.value;
  }

  async mp3(text: string): Promise<Uint8Array> {
    this.mp3Calls.push(text);
    const failure = this.mp3Failures.shift();
    if (failure !== undefined) throw failure;
    // ID3 tag marker followed by the text: enough for a test to tell outputs apart.
    return new Uint8Array([0x49, 0x44, 0x33, ...new TextEncoder().encode(text)]);
  }

  async wav16k(text: string): Promise<Uint8Array> {
    this.wavCalls.push(text);
    const failure = this.wavFailures.shift();
    if (failure !== undefined) throw failure;
    return makeWav(new Uint8Array(Math.max(2, (text.length * 2) | 0)));
  }
}

// ---------------------------------------------------------------------------------------------
// FakeRepository
// ---------------------------------------------------------------------------------------------

/** Thrown by `listEncounters` for a cursor this fake did not issue. The API maps it to 400. */
export class InvalidCursorError extends Error {
  constructor() {
    super("invalid cursor");
    this.name = "InvalidCursorError";
  }
}

type StoredEncounter = { meta: EncounterMeta; expiresAtMs: number };
type StoredEvent = { sk: string; envelope: Envelope; expiresAtMs: number };

type CursorKey = { startedAt: string; encounterId: string };

function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorKey {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as CursorKey).startedAt === "string" &&
      typeof (parsed as CursorKey).encounterId === "string"
    ) {
      const { startedAt, encounterId } = parsed as CursorKey;
      return { startedAt, encounterId };
    }
  } catch {
    // fall through
  }
  throw new InvalidCursorError();
}

/** Newest first: later `startedAt` first, then larger `encounterId` first. */
function compareNewestFirst(a: CursorKey, b: CursorKey): number {
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1;
  if (a.encounterId !== b.encounterId) return a.encounterId < b.encounterId ? 1 : -1;
  return 0;
}

export class FakeRepository implements Repository {
  private readonly encounters = new Map<string, StoredEncounter>();
  /** `ENC#<id>` partition: `EVT#<ts>#<messageId>` sort key to event. */
  private readonly events = new Map<string, Map<string, StoredEvent>>();
  private readonly statuses = new Map<string, DeviceStatusRecord>();
  private readonly members = new Map<string, FamilyMember>();
  private samples: SampleEntry[] = [];
  private readonly sampleImages = new Map<string, Uint8Array>();

  constructor(private readonly now: Clock = Date.now) {}

  // Test helpers ---------------------------------------------------------------------------

  /** Replace the sample manifest and the image bytes (keyed by sample id). */
  setSamples(entries: SampleEntry[], images: Record<string, Uint8Array> = {}): void {
    this.samples = clone(entries);
    this.sampleImages.clear();
    for (const [id, bytes] of Object.entries(images)) this.sampleImages.set(id, bytes.slice());
  }

  /** The `notified` flag of an encounter, `false` when it does not exist. */
  isNotified(encounterId: string): boolean {
    return this.encounters.get(encounterId)?.meta.notified === true;
  }

  /** Used by `FakeStateStore` for the notify-slot transaction. No-op for an unknown encounter. */
  setNotified(encounterId: string, notified: boolean): void {
    const item = this.encounters.get(encounterId);
    if (item !== undefined) item.meta.notified = notified;
  }

  hasEncounter(encounterId: string): boolean {
    return this.encounters.has(encounterId);
  }

  // Encounters -----------------------------------------------------------------------------

  async createEncounterIfAbsent(meta: EncounterMeta, ttlS: number): Promise<boolean> {
    // attribute_not_exists(pk): an expired item that DynamoDB has not purged yet still counts.
    if (this.encounters.has(meta.encounterId)) return false;
    this.encounters.set(meta.encounterId, {
      meta: clone(meta),
      expiresAtMs: this.now() + ttlS * 1000,
    });
    return true;
  }

  async getEncounter(encounterId: string, nowMs: number): Promise<EncounterMeta | null> {
    const item = this.encounters.get(encounterId);
    if (item === undefined || item.expiresAtMs <= nowMs) return null;
    return clone(item.meta);
  }

  async updateEncounter(encounterId: string, patch: EncounterPatch): Promise<boolean> {
    const item = this.encounters.get(encounterId);
    if (item === undefined) return false;
    item.meta = { ...item.meta, ...clone(patch) };
    return true;
  }

  async listEncounters(
    deviceId: string,
    limit: number,
    cursor: string | null,
    nowMs: number,
  ): Promise<EncounterPage> {
    const after = cursor === null ? null : decodeCursor(cursor);
    const sorted = [...this.encounters.values()]
      .filter((item) => item.meta.deviceId === deviceId && item.expiresAtMs > nowMs)
      .map((item) => item.meta)
      .sort(compareNewestFirst);
    const rest =
      after === null ? sorted : sorted.filter((meta) => compareNewestFirst(after, meta) < 0);
    const items = rest.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor =
      rest.length > items.length && last !== undefined
        ? encodeCursor({ startedAt: last.startedAt, encounterId: last.encounterId })
        : null;
    return { items: clone(items), nextCursor };
  }

  // Events ---------------------------------------------------------------------------------

  async appendEvent(encounterId: string, envelope: Envelope, ttlS: number): Promise<void> {
    const sk = `EVT#${envelope.ts}#${envelope.id}`;
    let partition = this.events.get(encounterId);
    if (partition === undefined) {
      partition = new Map();
      this.events.set(encounterId, partition);
    }
    partition.set(sk, {
      sk,
      envelope: clone(envelope),
      expiresAtMs: this.now() + ttlS * 1000,
    });
  }

  async listEvents(encounterId: string): Promise<Envelope[]> {
    const nowMs = this.now();
    const partition = this.events.get(encounterId);
    if (partition === undefined) return [];
    return [...partition.values()]
      .filter((event) => event.expiresAtMs > nowMs)
      .sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0))
      .map((event) => clone(event.envelope));
  }

  // Device status --------------------------------------------------------------------------

  async getDeviceStatus(deviceId: string): Promise<DeviceStatusRecord | null> {
    const record = this.statuses.get(deviceId);
    return record === undefined ? null : clone(record);
  }

  async putStatusReport(
    deviceId: string,
    data: StatusReportData,
    receivedAtMs: number,
  ): Promise<void> {
    const previous = this.statuses.get(deviceId);
    this.statuses.set(deviceId, {
      deviceId,
      status: clone(data),
      lastReportAtMs: receivedAtMs,
      lastOfflineAtMs: previous?.lastOfflineAtMs ?? null,
    });
  }

  async markOffline(deviceId: string, receivedAtMs: number): Promise<void> {
    const previous = this.statuses.get(deviceId);
    this.statuses.set(deviceId, {
      deviceId,
      status: previous?.status ?? null,
      lastReportAtMs: previous?.lastReportAtMs ?? null,
      lastOfflineAtMs: receivedAtMs,
    });
  }

  // Family members -------------------------------------------------------------------------

  async listMembers(): Promise<FamilyMember[]> {
    return clone([...this.members.values()]);
  }

  async getMember(memberId: string): Promise<FamilyMember | null> {
    const member = this.members.get(memberId);
    return member === undefined ? null : clone(member);
  }

  async putMember(member: FamilyMember): Promise<void> {
    this.members.set(member.memberId, clone(member));
  }

  async deleteMember(memberId: string): Promise<boolean> {
    return this.members.delete(memberId);
  }

  // Samples --------------------------------------------------------------------------------

  async getSampleManifest(): Promise<SampleEntry[]> {
    return clone(this.samples);
  }

  async getSampleImage(sampleId: string): Promise<Uint8Array | null> {
    if (!this.samples.some((entry) => entry.id === sampleId)) return null;
    const bytes = this.sampleImages.get(sampleId);
    return bytes === undefined ? null : bytes.slice();
  }
}

// ---------------------------------------------------------------------------------------------
// FakeStateStore
// ---------------------------------------------------------------------------------------------

type NotifySlot = { lastNotifiedAtMs: number; lastEncounterId: string; expiresAtMs: number };

const DAY_MS = 24 * 60 * 60 * 1000;

export type FakeStateStoreOptions = {
  now?: Clock;
  /**
   * When set, the notify-slot transaction also checks and sets `notified` on the encounter meta
   * of this repository, as the DynamoDB transaction does. Without it the store keeps its own
   * per-encounter flag.
   */
  repository?: FakeRepository;
};

export class FakeStateStore implements StateStore {
  private readonly now: Clock;
  private readonly repository: FakeRepository | undefined;
  /** key to expiry (epoch ms). */
  private readonly claims = new Map<string, number>();
  private readonly counters = new Map<string, { count: number; expiresAtMs: number }>();
  private readonly slots = new Map<string, NotifySlot>();
  /** Slot value before each successful claim, so a release restores it. */
  private readonly previousSlots = new Map<string, NotifySlot | null>();
  private readonly notifiedEncounters = new Set<string>();

  constructor(options: FakeStateStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.repository = options.repository;
  }

  /** `attribute_not_exists(pk)` with TTL: an expired claim counts as absent. */
  async claim(key: string, ttlS: number): Promise<boolean> {
    const nowMs = this.now();
    const expiresAtMs = this.claims.get(key);
    if (expiresAtMs !== undefined && expiresAtMs > nowMs) return false;
    this.claims.set(key, nowMs + ttlS * 1000);
    return true;
  }

  /** Drop the claim so the key can be claimed again. */
  async releaseClaim(key: string): Promise<void> {
    this.claims.delete(key);
  }

  /**
   * One atomic step (JavaScript is single-threaded and there is no await inside): the encounter
   * must not be notified yet, and the device slot must be absent, expired or older than the window.
   */
  async claimNotifySlot(
    deviceId: string,
    encounterId: string,
    nowMs: number,
    windowMs: number,
  ): Promise<boolean> {
    if (this.encounterNotified(encounterId)) return false;
    const slot = this.liveSlot(deviceId);
    if (slot !== null && !(slot.lastNotifiedAtMs <= nowMs - windowMs)) return false;
    this.previousSlots.set(`${deviceId}#${encounterId}`, slot === null ? null : { ...slot });
    this.slots.set(deviceId, {
      lastNotifiedAtMs: nowMs,
      lastEncounterId: encounterId,
      expiresAtMs: this.now() + DAY_MS,
    });
    this.setEncounterNotified(encounterId, true);
    return true;
  }

  /** Give the slot back only when this encounter still owns it. */
  async releaseNotifySlot(deviceId: string, encounterId: string): Promise<void> {
    const slot = this.slots.get(deviceId);
    if (slot === undefined || slot.lastEncounterId !== encounterId) return;
    const previousKey = `${deviceId}#${encounterId}`;
    const previous = this.previousSlots.get(previousKey) ?? null;
    this.previousSlots.delete(previousKey);
    if (previous === null) this.slots.delete(deviceId);
    else this.slots.set(deviceId, previous);
    this.setEncounterNotified(encounterId, false);
  }

  async lastNotifiedAtMs(deviceId: string): Promise<number | null> {
    return this.liveSlot(deviceId)?.lastNotifiedAtMs ?? null;
  }

  /** `ADD count 1` with `attribute_not_exists(count) OR count < :limit`. */
  async incrementCounter(
    key: string,
    limit: number,
    ttlS: number,
  ): Promise<{ allowed: boolean; count: number }> {
    const nowMs = this.now();
    const existing = this.counters.get(key);
    const live = existing !== undefined && existing.expiresAtMs > nowMs ? existing : undefined;
    if (live !== undefined && !(live.count < limit)) {
      return { allowed: false, count: live.count };
    }
    const count = (live?.count ?? 0) + 1;
    // The TTL is set when the counter is created and not extended by later increments.
    this.counters.set(key, { count, expiresAtMs: live?.expiresAtMs ?? nowMs + ttlS * 1000 });
    return { allowed: true, count };
  }

  /** `ADD count -1`, never below 0. */
  async releaseCounter(key: string): Promise<void> {
    const existing = this.counters.get(key);
    if (existing === undefined || existing.expiresAtMs <= this.now()) return;
    existing.count = Math.max(0, existing.count - 1);
  }

  /** Test helper: the current counter value, 0 when absent or expired. */
  counterValue(key: string): number {
    const existing = this.counters.get(key);
    return existing !== undefined && existing.expiresAtMs > this.now() ? existing.count : 0;
  }

  private liveSlot(deviceId: string): NotifySlot | null {
    const slot = this.slots.get(deviceId);
    return slot !== undefined && slot.expiresAtMs > this.now() ? slot : null;
  }

  private encounterNotified(encounterId: string): boolean {
    return this.notifiedEncounters.has(encounterId) || this.repository?.isNotified(encounterId) === true;
  }

  private setEncounterNotified(encounterId: string, notified: boolean): void {
    if (notified) this.notifiedEncounters.add(encounterId);
    else this.notifiedEncounters.delete(encounterId);
    this.repository?.setNotified(encounterId, notified);
  }
}
