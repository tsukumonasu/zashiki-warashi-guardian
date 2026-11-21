/**
 * Voice session channel frames (docs/schema.md, "Voice session channels").
 *
 * Pure module: no AWS imports, no clock. `decodeIn` and `encodeOut` are total; they never throw.
 * A frame with an unknown `t`, a wrong type, or a bad `pcm` is `malformed`, never valid.
 */

import type { ConversationEndReason, Envelope } from "../messages.js";

export type LookVerdict = "family" | "stranger" | "no_face" | "uncertain";
export type EndReason = ConversationEndReason;

export type InFrame =
  | { t: "hello"; client: "device" | "browser"; v: 1 }
  | { t: "audio"; seq: number; pcm: string }
  | { t: "look.result"; requestId: string; verdict: LookVerdict }
  | { t: "bye"; reason: "user" | "silence" | "limit" | "error" };

export type OutFrame =
  | { t: "audio"; seq: number; pcm: string }
  | { t: "interrupt" }
  | { t: "command"; envelope: Envelope };

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

function bad(reason: string): FrameResult<InFrame> {
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

export function decodeIn(raw: string): FrameResult<InFrame> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return bad("not JSON");
  }
  if (!isRecord(value)) return bad("frame is not an object");
  switch (value.t) {
    case "hello":
      if (value.client !== "device" && value.client !== "browser") return bad("bad client");
      if (value.v !== 1) return bad("bad v");
      return { kind: "valid", frame: { t: "hello", client: value.client, v: 1 } };
    case "audio": {
      const seq = value.seq;
      if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return bad("bad seq");
      const err = checkPcm(value.pcm);
      if (err !== null) return bad(err);
      return { kind: "valid", frame: { t: "audio", seq, pcm: value.pcm as string } };
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
      return {
        kind: "valid",
        frame: { t: "bye", reason: value.reason as "user" | "silence" | "limit" | "error" },
      };
    default:
      return bad("unknown or missing t");
  }
}

/** Serializes an outgoing frame. Total: a value JSON cannot encode becomes `{}`, which receivers ignore (no `t`). */
export function encodeOut(f: OutFrame | TextFrame): string {
  try {
    const s = JSON.stringify(f);
    return typeof s === "string" ? s : "{}";
  } catch {
    return "{}";
  }
}
