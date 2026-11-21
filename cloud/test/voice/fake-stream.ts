/**
 * In-memory fakes for the voice session runner: `FakeSonic`, `FakeVoiceChannel`, `FakeDollBus`.
 *
 * None of them imports the AWS SDK. They are driven by tests and record everything they receive,
 * so a test can assert event order, that every `toolUse` got a `toolResult`, which frames were
 * published and which envelopes went to the doll.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Envelope } from "../../lambda/_shared/messages.js";
import type {
  DollBus,
  SonicClient,
  SonicEvent,
  SonicStream,
  VoiceChannel,
} from "../../lambda/_shared/voice/ports.js";

// ---------------------------------------------------------------------------------------------
// Async queue: a pushable AsyncIterable that ends on `finish()` or fails on `fail()`.
// ---------------------------------------------------------------------------------------------

class AsyncQueue<T> {
  private readonly items: T[] = [];
  private waiter: (() => void) | null = null;
  private done = false;
  private failure: Error | null = null;

  push(item: T): void {
    if (this.done) return;
    this.items.push(item);
    this.wake();
  }

  finish(): void {
    this.done = true;
    this.wake();
  }

  fail(error: Error): void {
    this.failure = error;
    this.done = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async *iterate(): AsyncGenerator<T> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------------------------

const FIXTURE_DIR = fileURLToPath(new URL("../../../docs/fixtures/voice-v1/", import.meta.url));

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

/**
 * Maps one line of a scripted Bedrock stream to the parsed output event the runner sees, or `null`
 * for input events and bookkeeping events that carry no output (`sessionStart`, `contentStart`,
 * `audioInput`, `contentEnd`, ...). The fixtures hold both directions; only output is replayed.
 */
export function sonicLineToEvent(line: string): SonicEvent | null {
  const root = asObject(JSON.parse(line));
  const event = asObject(root?.["event"]);
  if (!event) return null;

  const audio = asObject(event["audioOutput"]);
  if (audio) {
    return {
      kind: "audio",
      contentId: String(audio["contentName"] ?? ""),
      pcmBase64: String(audio["content"] ?? ""),
    };
  }

  const text = asObject(event["textOutput"]);
  if (text) {
    const content = String(text["content"] ?? "");
    // Nova Sonic signals barge-in as a text output with this JSON body.
    try {
      if (asObject(JSON.parse(content))?.["interrupted"] === true) return { kind: "interrupted" };
    } catch {
      // Plain text, not JSON.
    }
    const role = text["role"] === "USER" ? "USER" : "ASSISTANT";
    const fields = asObject(text["additionalModelFields"]);
    const rawStage = fields?.["generationStage"] ?? text["generationStage"];
    const stage = rawStage === "SPECULATIVE" || rawStage === "FINAL" ? rawStage : null;
    return { kind: "text", contentId: String(text["contentName"] ?? ""), role, stage, text: content };
  }

  const tool = asObject(event["toolUse"]);
  if (tool) {
    return {
      kind: "toolUse",
      toolUseId: String(tool["toolUseId"] ?? ""),
      name: String(tool["toolName"] ?? ""),
      inputJson: String(tool["content"] ?? ""),
    };
  }

  if (asObject(event["completionEnd"])) return { kind: "completionEnd" };
  return null;
}

/** Reads `docs/fixtures/voice-v1/<name>.jsonl` and returns its output events in order. */
export function loadSonicScript(name: "sonic-session-ok" | "sonic-session-tools" | string): SonicEvent[] {
  const raw = readFileSync(`${FIXTURE_DIR}${name}.jsonl`, "utf8");
  const events: SonicEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = sonicLineToEvent(line);
    if (parsed) events.push(parsed);
  }
  return events;
}

// ---------------------------------------------------------------------------------------------
// FakeSonic
// ---------------------------------------------------------------------------------------------

export interface FakeSonicOptions {
  /** Output events to replay, in order. Default: none. */
  script?: readonly SonicEvent[];
  /**
   * `true` (default): the output stream ends after the script. `false`: it stays open until the
   * test calls `finish()` or `fail()`, or until the runner calls `close()`.
   */
  endAfterScript?: boolean;
  /** `open()` rejects with this error (Bedrock open failure). */
  openError?: Error;
}

/** One opened bidirectional stream. */
export class FakeSonicStream implements SonicStream {
  /** Every JSON string passed to `send`, in order. */
  readonly sent: string[] = [];
  closed = false;
  /** Make the next `send` calls reject. */
  sendError: Error | null = null;

  private readonly queue = new AsyncQueue<SonicEvent>();
  private readonly toolUseIds: string[] = [];
  private readonly answeredToolUseIds = new Set<string>();
  private pendingToolResultId: string | null = null;

  constructor(
    readonly modelId: string,
    script: readonly SonicEvent[],
    endAfterScript: boolean,
  ) {
    for (const ev of script) {
      if (ev.kind === "toolUse") this.toolUseIds.push(ev.toolUseId);
      this.queue.push(ev);
    }
    if (endAfterScript) this.queue.finish();
  }

  async send(eventJson: string): Promise<void> {
    if (this.sendError) throw this.sendError;
    this.sent.push(eventJson);
    this.trackToolResult(eventJson);
  }

  events(): AsyncIterable<SonicEvent> {
    return this.queue.iterate();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queue.finish();
  }

  /** Test control: add an output event while the stream is open. */
  push(event: SonicEvent): void {
    if (event.kind === "toolUse") this.toolUseIds.push(event.toolUseId);
    this.queue.push(event);
  }

  /** Test control: end the output stream normally. */
  finish(): void {
    this.queue.finish();
  }

  /** Test control: make the output stream throw. */
  fail(error: Error): void {
    this.queue.fail(error);
  }

  /** The names of the top-level event keys sent, in order, for example `["sessionStart", ...]`. */
  sentEventNames(): string[] {
    return this.sent.map((s) => {
      const event = asObject(asObject(JSON.parse(s))?.["event"]);
      return event ? (Object.keys(event)[0] ?? "") : "";
    });
  }

  /** Tool use ids that were delivered but have no `toolResult` yet. Empty means all answered. */
  unansweredToolUses(): string[] {
    return this.toolUseIds.filter((id) => !this.answeredToolUseIds.has(id));
  }

  /** The `toolResult` content strings that were sent for `toolUseId`. */
  toolResultsFor(toolUseId: string): string[] {
    return this.toolResults.filter((r) => r.toolUseId === toolUseId).map((r) => r.content);
  }

  private readonly toolResults: { toolUseId: string; content: string }[] = [];

  private trackToolResult(eventJson: string): void {
    let event: Json | null;
    try {
      event = asObject(asObject(JSON.parse(eventJson))?.["event"]);
    } catch {
      return;
    }
    if (!event) return;
    const start = asObject(event["contentStart"]);
    const config = asObject(start?.["toolResultInputConfiguration"]);
    if (config && typeof config["toolUseId"] === "string") this.pendingToolResultId = config["toolUseId"];
    const result = asObject(event["toolResult"]);
    if (result && this.pendingToolResultId !== null) {
      this.answeredToolUseIds.add(this.pendingToolResultId);
      this.toolResults.push({
        toolUseId: this.pendingToolResultId,
        content: String(result["content"] ?? ""),
      });
      this.pendingToolResultId = null;
    }
  }
}

/** `SonicClient` that replays a scripted stream. */
export class FakeSonic implements SonicClient {
  readonly streams: FakeSonicStream[] = [];
  readonly openedModelIds: string[] = [];

  constructor(private readonly options: FakeSonicOptions = {}) {}

  /** Builds a `FakeSonic` that replays `docs/fixtures/voice-v1/<name>.jsonl`. */
  static fromFixture(name: "sonic-session-ok" | "sonic-session-tools", options: Omit<FakeSonicOptions, "script"> = {}): FakeSonic {
    return new FakeSonic({ ...options, script: loadSonicScript(name) });
  }

  async open(modelId: string): Promise<FakeSonicStream> {
    this.openedModelIds.push(modelId);
    if (this.options.openError) throw this.options.openError;
    const stream = new FakeSonicStream(modelId, this.options.script ?? [], this.options.endAfterScript ?? true);
    this.streams.push(stream);
    return stream;
  }

  /** The most recently opened stream. Throws when none was opened. */
  get stream(): FakeSonicStream {
    const last = this.streams[this.streams.length - 1];
    if (!last) throw new Error("FakeSonic: no stream was opened");
    return last;
  }
}

// ---------------------------------------------------------------------------------------------
// FakeVoiceChannel
// ---------------------------------------------------------------------------------------------

export interface PublishedBatch {
  readonly sessionId: string;
  readonly channel: "out" | "text";
  readonly events: readonly string[];
}

/** In-memory `in`, `out` and `text` bus. Frames are stringified JSON, as on AppSync Events. */
export class FakeVoiceChannel implements VoiceChannel {
  /** Every successful `publish` call, in order. */
  readonly batches: PublishedBatch[] = [];
  closed = false;
  /** Number of upcoming `publish` calls that reject (a lost interrupt, for example). */
  failPublishes = 0;
  /** `subscribeIn` rejects with this error when set. */
  subscribeError: Error | null = null;

  private readonly inQueues = new Map<string, AsyncQueue<string>>();

  private queueFor(sessionId: string): AsyncQueue<string> {
    let q = this.inQueues.get(sessionId);
    if (!q) {
      q = new AsyncQueue<string>();
      this.inQueues.set(sessionId, q);
    }
    return q;
  }

  subscribeIn(sessionId: string): AsyncIterable<string> {
    if (this.subscribeError) throw this.subscribeError;
    return this.queueFor(sessionId).iterate();
  }

  async publish(sessionId: string, channel: "out" | "text", events: readonly string[]): Promise<void> {
    if (this.failPublishes > 0) {
      this.failPublishes -= 1;
      throw new Error("FakeVoiceChannel: publish failed");
    }
    this.batches.push({ sessionId, channel, events: [...events] });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const q of this.inQueues.values()) q.finish();
  }

  // ---- injection (client to session) ----

  /** Delivers one `in` frame. Objects are stringified. */
  injectIn(sessionId: string, frame: string | object): void {
    this.queueFor(sessionId).push(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  /** Delivers the same frame twice in a row. */
  injectDuplicate(sessionId: string, frame: string | object): void {
    this.injectIn(sessionId, frame);
    this.injectIn(sessionId, frame);
  }

  /** Delivers `frames` permuted by `order` (indexes into `frames`), for out-of-order tests. */
  injectInOrder(sessionId: string, frames: readonly (string | object)[], order: readonly number[]): void {
    for (const index of order) {
      const frame = frames[index];
      if (frame !== undefined) this.injectIn(sessionId, frame);
    }
  }

  /** Delivers text that is not a valid frame: not JSON, wrong shape or an unknown `t`. */
  injectMalformed(sessionId: string, kind: "not-json" | "not-object" | "no-type" | "bad-pcm" = "not-json"): void {
    const raw = {
      "not-json": "{not json",
      "not-object": "[1,2,3]",
      "no-type": JSON.stringify({ seq: 1 }),
      "bad-pcm": JSON.stringify({ t: "audio", seq: 1, pcm: "!!!not base64!!!" }),
    }[kind];
    this.injectIn(sessionId, raw);
  }

  /** Ends the `in` subscription, as when the client disconnects. */
  endIn(sessionId: string): void {
    this.queueFor(sessionId).finish();
  }

  // ---- inspection (session to client) ----

  /** Parsed frames published on `channel` for `sessionId`, in order. */
  frames(sessionId: string, channel: "out" | "text"): Record<string, unknown>[] {
    return this.batches
      .filter((b) => b.sessionId === sessionId && b.channel === channel)
      .flatMap((b) => b.events)
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  /** The `t` values published on `channel`, in order. */
  frameTypes(sessionId: string, channel: "out" | "text"): string[] {
    return this.frames(sessionId, channel).map((f) => String(f["t"]));
  }
}

// ---------------------------------------------------------------------------------------------
// FakeDollBus
// ---------------------------------------------------------------------------------------------

export interface DollPublish {
  readonly topic: string;
  readonly qos: 1;
  readonly deviceId: string;
  readonly envelope: Envelope;
}

/** Records every publish to the doll: topic `warashi/<deviceId>/commands`, QoS 1, the envelope. */
export class FakeDollBus implements DollBus {
  readonly published: DollPublish[] = [];
  /** Number of upcoming `publish` calls that reject. */
  failPublishes = 0;

  async publish(deviceId: string, envelope: Envelope): Promise<void> {
    if (this.failPublishes > 0) {
      this.failPublishes -= 1;
      throw new Error("FakeDollBus: publish failed");
    }
    this.published.push({ topic: `warashi/${deviceId}/commands`, qos: 1, deviceId, envelope });
  }

  /** Envelope `type` values published so far, in order. */
  types(): string[] {
    return this.published.map((p) => p.envelope.type);
  }
}
