/**
 * Ports of the voice session handlers (design, "Ports used by handlers").
 *
 * Types only, no AWS imports. Every port is faked in tests. `VoiceStore` has no method that stores
 * audio, text or a token: `SessionRecord` holds token hashes and metadata only, so the type itself
 * keeps speech out of the database (property P8).
 */

import type { Envelope } from "../messages.js";
import type { Verdict } from "../verdict.js";
import type { EndReason, LookVerdict } from "./frames.js";

/** A parsed Nova Sonic output event. Payload fields stay in transit; nothing here is stored. */
export type SonicEvent =
  | { kind: "audio"; contentId: string; pcmBase64: string }
  | {
      kind: "text";
      contentId: string;
      role: "USER" | "ASSISTANT";
      /** `SPECULATIVE` or `FINAL` (the generation stage), `null` when absent. */
      stage: "SPECULATIVE" | "FINAL" | null;
      text: string;
    }
  | { kind: "toolUse"; toolUseId: string; name: string; inputJson: string }
  | { kind: "interrupted" }
  | { kind: "completionEnd" }
  | { kind: "error"; code: string };

/** Bedrock bidirectional stream. */
export interface SonicStream {
  send(eventJson: string): Promise<void>;
  /** Parsed output events. */
  events(): AsyncIterable<SonicEvent>;
  close(): Promise<void>;
}

export interface SonicClient {
  open(modelId: string): Promise<SonicStream>;
}

/** AppSync Events from the Lambda side. Each string is one stringified JSON frame. */
export interface VoiceChannel {
  subscribeIn(sessionId: string): AsyncIterable<string>;
  publish(sessionId: string, channel: "out" | "text", events: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

export type SessionPhase = "starting" | "live" | "ending" | "ended";

/**
 * The session item (`VOICE#<sessionId>` / `META`). Closed set of keys: no audio, transcript, model
 * text or token. Tokens exist here only as SHA-256 hashes.
 */
export interface SessionRecord {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly client: "device" | "browser";
  readonly target: "real" | "virtual";
  /** `null` for a doll-started session. */
  readonly ownerSub: string | null;
  readonly role: "family" | "reviewer" | "device";
  readonly phase: SessionPhase;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly clientTokenHash: string;
  /** `null` for the doll. */
  readonly observerTokenHash: string | null;
  readonly endReason: EndReason | null;
  readonly endedAt: number | null;
  readonly endRequested: boolean;
}

/** The look result item (`LOOK#<requestId>` / `RESULT`). */
export interface LookItem {
  readonly verdict: LookVerdict;
  readonly at: number;
}

/** DynamoDB. */
export interface VoiceStore {
  /**
   * One conditional put: succeeds when no lock exists for `key` or its `expiresAt` is at or before
   * `nowMs`. Returns `false` when another session holds an unexpired lock.
   */
  acquireLock(key: string, sessionId: string, nowMs: number, expiresAtMs: number): Promise<boolean>;
  /** Deletes the lock only while `sessionId` still owns it. Safe to call twice. */
  releaseLock(key: string, sessionId: string): Promise<void>;
  /**
   * `ADD count 1` while the count is below `cap`. A refusal does not change the counter.
   * `ttlS` is set when the counter is created.
   */
  incrementCounter(key: string, cap: number, ttlS: number): Promise<{ allowed: boolean; count: number }>;
  /** Undo one successful increment, never below 0. */
  releaseCounter(key: string): Promise<void>;
  putSession(rec: SessionRecord): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  readLook(requestId: string): Promise<LookItem | null>;
  encounterVerdict(encounterId: string): Promise<{ verdict: Verdict; atMs: number } | null>;
}

/** IoT data plane, QoS 1. */
export interface DollBus {
  publish(deviceId: string, envelope: Envelope): Promise<void>;
}
