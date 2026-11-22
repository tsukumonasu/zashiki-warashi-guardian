// Schema_Codec: decodes and encodes the messages of docs/schema.md.
// Pure: no DOM, no clock, no network.

import {
  ERROR_CODES,
  REASONS,
  STATES,
  VERDICTS,
  CONVERSATION_END_REASONS,
  type SchemaMessage,
} from "./types";

export const MAX_MESSAGE_BYTES = 131_072;

export type MalformedRule =
  | "size"
  | "json"
  | "not_object"
  | "version_type"
  | "missing_field"
  | "wrong_type"
  | "non_finite"
  | "bad_enum"
  | "speak_source"
  | "unknown_type";

export type DecodeResult =
  | { kind: "valid"; message: SchemaMessage }
  | { kind: "malformed"; rule: MalformedRule; path: string }
  | { kind: "unsupported_version"; v: number };

type Malformed = { rule: MalformedRule; path: string };

type Kind =
  | { t: "string" }
  | { t: "stringOrNull" }
  | { t: "int" }
  | { t: "number" }
  | { t: "bool" }
  | { t: "enum"; values: readonly string[] }
  | { t: "faceOrNull" };

/** A field marked `optional` may be absent; it is then absent from the decoded message too. */
type Field = readonly [name: string, kind: Kind, optional?: true];

const S: Kind = { t: "string" };
const SN: Kind = { t: "stringOrNull" };
const I: Kind = { t: "int" };
const N: Kind = { t: "number" };
const B: Kind = { t: "bool" };
const E = (values: readonly string[]): Kind => ({ t: "enum", values });

const FACE_FIELDS = ["left", "top", "width", "height"] as const;
const MODES = ["guard", "sleep"] as const;

/** One entry per message type: the `data` fields in schema order. */
const DATA_FIELDS: Record<SchemaMessage["type"], readonly Field[]> = {
  "presence.detected": [["source", E(["pir", "sound", "manual"])]],
  "snapshot.captured": [
    ["snapshotId", S],
    ["width", I],
    ["height", I],
    ["panDeg", N],
    ["tiltDeg", N],
    ["jpegBase64", S],
    ["requestId", SN, true],
    ["purpose", E(["judge", "photo"]), true],
  ],
  "state.changed": [
    ["from", E(STATES)],
    ["to", E(STATES)],
    ["reason", E(REASONS)],
  ],
  "reaction.performed": [
    ["kind", E(["family", "stranger", "uncertain"])],
    ["lineId", SN],
    ["offline", B],
  ],
  "encounter.ended": [["reason", E(["cooldown", "manual", "error"])]],
  "error.reported": [
    ["code", E(ERROR_CODES)],
    ["message", S],
    ["refId", SN],
  ],
  "judgement.result": [
    ["snapshotId", S],
    ["verdict", E(VERDICTS)],
    ["confidence", N],
    ["face", { t: "faceOrNull" }],
  ],
  speak: [
    ["lineId", SN],
    ["audioUrl", SN],
    ["ja", S],
    ["en", S],
    ["remote", B, true],
  ],
  gaze: [
    ["panDeg", N],
    ["tiltDeg", N],
  ],
  lantern: [
    ["level", N],
    ["fadeMs", I],
  ],
  "mode.set": [["mode", E(MODES)]],
  "conversation.requested": [["reason", E(["family_verdict"])]],
  "conversation.ended": [
    ["sessionId", S],
    ["reason", E(CONVERSATION_END_REASONS)],
  ],
  "conversation.start": [
    ["sessionId", S],
    ["token", S],
    ["maxSeconds", I],
    ["silenceSeconds", I],
    ["source", E(["family_verdict", "manual"])],
  ],
  "conversation.end": [
    ["sessionId", S],
    ["reason", E(CONVERSATION_END_REASONS)],
  ],
  "snapshot.request": [
    ["requestId", S],
    ["purpose", E(["look", "photo"]), true],
  ],
  "status.report": [
    ["state", E(STATES)],
    ["mode", E(MODES)],
    ["panDeg", N],
    ["tiltDeg", N],
    ["lantern", N],
    ["cameraActive", B],
    ["micActive", B],
    ["motionEnabled", B],
    ["uptimeSec", I],
    ["agentVersion", S],
  ],
  "status.offline": [],
};

export const ALL_TYPES: readonly string[] = Object.keys(DATA_FIELDS);

type Pass = "missing" | "type" | "enum";
type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function present(obj: Obj, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, name) && obj[name] !== undefined;
}

function numberProblem(value: unknown, path: string, integer: boolean): Malformed | null {
  if (typeof value !== "number") return { rule: "wrong_type", path };
  if (!Number.isFinite(value)) return { rule: "non_finite", path };
  if (integer && !Number.isInteger(value)) return { rule: "wrong_type", path };
  return null;
}

function checkKind(kind: Kind, value: unknown, path: string, pass: Pass): Malformed | null {
  if (pass === "missing") {
    if (kind.t === "faceOrNull" && isObject(value)) {
      for (const f of FACE_FIELDS) {
        if (!present(value, f)) return { rule: "missing_field", path: `${path}.${f}` };
      }
    }
    return null;
  }
  if (pass === "enum") {
    if (kind.t === "enum" && typeof value === "string" && !kind.values.includes(value)) {
      return { rule: "bad_enum", path };
    }
    return null;
  }
  switch (kind.t) {
    case "string":
      return typeof value === "string" ? null : { rule: "wrong_type", path };
    case "stringOrNull":
      return value === null || typeof value === "string" ? null : { rule: "wrong_type", path };
    case "int":
      return numberProblem(value, path, true);
    case "number":
      return numberProblem(value, path, false);
    case "bool":
      return typeof value === "boolean" ? null : { rule: "wrong_type", path };
    case "enum":
      return typeof value === "string" ? null : { rule: "wrong_type", path };
    case "faceOrNull": {
      if (value === null) return null;
      if (!isObject(value)) return { rule: "wrong_type", path };
      for (const f of FACE_FIELDS) {
        const p = numberProblem(value[f], `${path}.${f}`, false);
        if (p) return p;
      }
      return null;
    }
  }
}

function checkPass(fields: readonly Field[], data: Obj, pass: Pass): Malformed | null {
  for (const [name, kind, optional] of fields) {
    const path = `data.${name}`;
    if (optional && !present(data, name)) continue;
    if (pass === "missing" && !present(data, name)) return { rule: "missing_field", path };
    const problem = checkKind(kind, data[name], path, pass);
    if (problem) return problem;
  }
  return null;
}

/** Copies only the fields the schema defines, so extra and undefined fields are dropped. */
function pickData(fields: readonly Field[], data: Obj): Obj {
  const out: Obj = {};
  for (const [name, kind, optional] of fields) {
    const value = data[name];
    if (optional && !present(data, name)) continue;
    if (kind.t === "faceOrNull" && isObject(value)) {
      out[name] = {
        left: value.left,
        top: value.top,
        width: value.width,
        height: value.height,
      };
    } else {
      out[name] = value;
    }
  }
  return out;
}

const ENVELOPE_FIELDS = ["v", "id", "ts", "deviceId", "encounterId", "type", "data"] as const;

export function decodeValue(value: unknown): DecodeResult {
  const bad = (rule: MalformedRule, path: string): DecodeResult => ({
    kind: "malformed",
    rule,
    path,
  });

  if (!isObject(value)) return bad("not_object", "");

  const v = value.v;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return bad("version_type", "v");
  if (v > 1) return { kind: "unsupported_version", v };

  for (const name of ENVELOPE_FIELDS) {
    if (!present(value, name)) return bad("missing_field", name);
  }
  for (const name of ["id", "ts", "deviceId", "type"] as const) {
    if (typeof value[name] !== "string") return bad("wrong_type", name);
  }
  if (value.encounterId !== null && typeof value.encounterId !== "string") {
    return bad("wrong_type", "encounterId");
  }
  if (!isObject(value.data)) return bad("wrong_type", "data");

  const type = value.type as string;
  if (!Object.prototype.hasOwnProperty.call(DATA_FIELDS, type)) return bad("unknown_type", "type");
  const fields = DATA_FIELDS[type as SchemaMessage["type"]];
  const data = value.data;

  for (const pass of ["missing", "type", "enum"] as const) {
    const problem = checkPass(fields, data, pass);
    if (problem) return bad(problem.rule, problem.path);
  }

  if (type === "speak") {
    const hasLine = data.lineId !== null;
    const hasUrl = data.audioUrl !== null;
    if (hasLine === hasUrl) return bad("speak_source", "data");
  }

  const message = {
    v: 1,
    id: value.id,
    ts: value.ts,
    deviceId: value.deviceId,
    encounterId: value.encounterId,
    type,
    data: pickData(fields, data),
  } as SchemaMessage;
  return { kind: "valid", message };
}

export function decodeText(text: string): DecodeResult {
  if (new TextEncoder().encode(text).length > MAX_MESSAGE_BYTES) {
    return { kind: "malformed", rule: "size", path: "" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "malformed", rule: "json", path: "" };
  }
  return decodeValue(parsed);
}

export function encode(message: SchemaMessage): string {
  return JSON.stringify(message);
}
