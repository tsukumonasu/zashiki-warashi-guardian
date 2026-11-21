/**
 * Voice session channel frames (docs/schema.md, "Voice session channels").
 *
 * Dashboard copy of `cloud/lambda/_shared/voice/frames.ts`: `decodeIn` and `encodeOut` behave the
 * same, and both are checked against the golden frames in `docs/fixtures/voice-v1/`. The browser
 * is the audio client, so it also encodes `in` frames and decodes `out` and `text` frames.
 * Pure and total: nothing here throws. A frame with a wrong type, a bad `pcm` or an unknown `t`
 * is `malformed`, never valid.
 */

import type { SchemaMessage } from "../simulation/types";

export type LookVerdict = "family" | "stranger" | "no_face" | "uncertain";

export const END_REASONS = [
  "silence",
  "limit",
  "stranger",
  "user",
  "manual",
  "language",
  "unsafe_output",
  "error",
  "no_client",
  "offline",
] as const;
export type EndReason = (typeof END_REASONS)[number];

export type ByeReason = "user" | "silence" | "limit" | "error";

export type InFrame =
  | { t: "hello"; client: "device" | "browser"; v: 1 }
  | { t: "audio"; seq: number; pcm: string }
  | { t: "look.result"; requestId: string; verdict: LookVerdict }
  | { t: "bye"; reason: ByeReason };

export type OutFrame =
  | { t: "audio"; seq: number; pcm: string }
  | { t: "interrupt" }
  | { t: "command"; envelope: SchemaMessage };

export type TextFrame =
  | { t: "state"; state: "waiting" | "live" | "ending" }
  | { t: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  | { t: "end"; reason: EndReason };

export type FrameResult<F> = { kind: "valid"; frame: F } | { kind: "malformed"; reason: string };

/** Largest decoded `pcm` payload: 400 ms of 24 kHz S16LE mono. */
export const MAX_PCM_BYTES = 12_800;

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const VERDICTS: readonly string[] = ["family", "stranger", "no_face", "uncertain"];
const BYE_REASONS: readonly string[] = ["user", "silence", "limit", "error"];
const TEXT_STATES: readonly string[] = ["waiting", "live", "ending"];

function bad<F>(reason: string): FrameResult<F> {
  return { kind: "malformed", reason };
}

/** Decoded byte length of a valid Base64 string, or null when the string is not valid Base64. */
function base64Length(s: string): number | null {
  if (!BASE64_RE.test(s)) return null;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return (s.length / 4) * 3 - pad;
}

/** Returns an error text, or null when `pcm` is valid. */
function checkPcm(pcm: unknown): string | null {
  if (typeof pcm !== "string") return "pcm must be a string";
  const n = base64Length(pcm);
  if (n === null) return "pcm is not valid Base64";
  if (n % 2 !== 0) return "pcm has an odd length";
  if (n > MAX_PCM_BYTES) return "pcm is too large";
  return null;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function checkSeq(seq: unknown): seq is number {
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0;
}

export function decodeIn(raw: string): FrameResult<InFrame> {
  const value = parseObject(raw);
  if (value === null) return bad("not a JSON object");
  switch (value.t) {
    case "hello":
      if (value.client !== "device" && value.client !== "browser") return bad("bad client");
      if (value.v !== 1) return bad("bad v");
      return { kind: "valid", frame: { t: "hello", client: value.client, v: 1 } };
    case "audio": {
      if (!checkSeq(value.seq)) return bad("bad seq");
      const err = checkPcm(value.pcm);
      if (err !== null) return bad(err);
      return { kind: "valid", frame: { t: "audio", seq: value.seq, pcm: value.pcm as string } };
    }
    case "look.result":
      if (typeof value.requestId !== "string" || !ID_RE.test(value.requestId)) {
        return bad("bad requestId");
      }
      if (typeof value.verdict !== "string" || !VERDICTS.includes(value.verdict)) {
        return bad("bad verdict");
      }
      return {
        kind: "valid",
        frame: { t: "look.result", requestId: value.requestId, verdict: value.verdict as LookVerdict },
      };
    case "bye":
      if (typeof value.reason !== "string" || !BYE_REASONS.includes(value.reason)) {
        return bad("bad reason");
      }
      return { kind: "valid", frame: { t: "bye", reason: value.reason as ByeReason } };
    default:
      return bad("unknown or missing t");
  }
}

/** Decodes a frame from the `out` channel (session to client). */
export function decodeOut(raw: string): FrameResult<OutFrame> {
  const value = parseObject(raw);
  if (value === null) return bad("not a JSON object");
  switch (value.t) {
    case "audio": {
      if (!checkSeq(value.seq)) return bad("bad seq");
      const err = checkPcm(value.pcm);
      if (err !== null) return bad(err);
      return { kind: "valid", frame: { t: "audio", seq: value.seq, pcm: value.pcm as string } };
    }
    case "interrupt":
      return { kind: "valid", frame: { t: "interrupt" } };
    case "command": {
      const e = value.envelope;
      if (!isRecord(e) || e.v !== 1 || typeof e.type !== "string" || typeof e.id !== "string") {
        return bad("bad envelope");
      }
      return { kind: "valid", frame: { t: "command", envelope: e as unknown as SchemaMessage } };
    }
    default:
      return bad("unknown or missing t");
  }
}

/** Decodes a frame from the `text` channel (session to client and observer). */
export function decodeText(raw: string): FrameResult<TextFrame> {
  const value = parseObject(raw);
  if (value === null) return bad("not a JSON object");
  switch (value.t) {
    case "state":
      if (typeof value.state !== "string" || !TEXT_STATES.includes(value.state)) {
        return bad("bad state");
      }
      return {
        kind: "valid",
        frame: { t: "state", state: value.state as "waiting" | "live" | "ending" },
      };
    case "transcript":
      if (value.role !== "user" && value.role !== "assistant") return bad("bad role");
      if (typeof value.text !== "string") return bad("bad text");
      if (typeof value.final !== "boolean") return bad("bad final");
      return {
        kind: "valid",
        frame: { t: "transcript", role: value.role, text: value.text, final: value.final },
      };
    case "end":
      if (typeof value.reason !== "string" || !(END_REASONS as readonly string[]).includes(value.reason)) {
        return bad("bad reason");
      }
      return { kind: "valid", frame: { t: "end", reason: value.reason as EndReason } };
    default:
      return bad("unknown or missing t");
  }
}

function stringify(f: unknown): string {
  try {
    const s = JSON.stringify(f);
    return typeof s === "string" ? s : "{}";
  } catch {
    return "{}";
  }
}

/** Serializes a session-side frame. Total: a value JSON cannot encode becomes `{}` (no `t`, ignored). */
export function encodeOut(f: OutFrame | TextFrame): string {
  return stringify(f);
}

/** Serializes a client-side frame for the `in` channel. Total, like `encodeOut`. */
export function encodeIn(f: InFrame): string {
  return stringify(f);
}
