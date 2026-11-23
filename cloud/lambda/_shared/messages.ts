/**
 * Schema_Codec: decode and encode the wire messages of `docs/schema.md`.
 *
 * Mirrors `device/warashi_agent/messages.py`. `docs/schema.md` is the contract; change it first,
 * then the registry below. Pure module: no AWS imports, no clock, no randomness (time and ids are
 * passed in by the caller).
 *
 * Decode order (R24.2 to R24.5):
 *   1. size, UTF-8, JSON, non-finite numbers      -> malformed
 *   2. `v` not an integer >= 1                    -> malformed
 *   3. `v` an integer > 1                         -> ignored (unsupported_version)
 *   4. other envelope fields                      -> malformed
 *   5. undefined `type`                           -> ignored (unknown_type)
 *   6. `data` fields                              -> malformed
 *
 * Problem texts name the rule and the field path, never a value, so a malformed message cannot
 * leak its content into a log line.
 *
 * Known difference from the device: JSON.parse cannot tell `1.0` from `1`, so an integer field
 * written as `1.0` is accepted here and rejected by the Python decoder.
 */

export const SCHEMA_VERSION = 1;
export const MAX_INBOUND_BYTES = 131_072;

/** `error.reported.message` is cut to this many code points on encode. */
const ERROR_MESSAGE_MAX_CODE_POINTS = 200;

export type Envelope<T extends string = string, D = unknown> = {
  v: 1;
  id: string;
  ts: string;
  deviceId: string;
  encounterId: string | null;
  type: T;
  data: D;
};

export type DecodeResult =
  | { kind: "valid"; message: Envelope }
  | { kind: "ignored"; reason: "unsupported_version" | "unknown_type" }
  | { kind: "malformed"; reason: string };

export type FaceBox = { left: number; top: number; width: number; height: number };

export type CommandData = {
  "judgement.result": {
    snapshotId: string;
    verdict: "family" | "stranger" | "no_face" | "uncertain";
    confidence: number;
    face: FaceBox | null;
  };
  speak: {
    lineId: string | null;
    audioUrl: string | null;
    ja: string;
    en: string;
    /** Typed by the family (remote-actions R3). Honoured only with `audioUrl`. Omitted means false. */
    remote?: boolean;
  };
  gaze: { panDeg: number; tiltDeg: number };
  lantern: { level: number; fadeMs: number };
  "mode.set": { mode: "guard" | "sleep" | "remote" };
  "conversation.start": {
    sessionId: string;
    token: string;
    maxSeconds: number;
    silenceSeconds: number;
    source: "family_verdict" | "manual";
  };
  "conversation.end": { sessionId: string; reason: ConversationEndReason };
  /** `purpose` is optional (default "look"); "photo" wakes a sleeping doll for one picture (R2). */
  "snapshot.request": { requestId: string; purpose?: "look" | "photo" };
};
export type ConversationEndReason =
  | "silence"
  | "limit"
  | "stranger"
  | "user"
  | "manual"
  | "language"
  | "unsafe_output"
  | "error"
  | "no_client"
  | "offline";
export type CommandType = keyof CommandData;

export type TopicKind = "events" | "commands" | "status";

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

type FieldKind = "str" | "int" | "number" | "bool" | "enum" | "face";

type FieldSpec = {
  name: string;
  kind: FieldKind;
  nullable?: boolean;
  allowed?: readonly string[];
  /** false only for error.reported refId: a missing field decodes as null. */
  required?: boolean;
  maxCodePoints?: number;
  /** A string must match this pattern (ids of the voice session, S4 to S6). */
  pattern?: RegExp;
  /** A string must have 1..maxLength code points (the `token` rule). */
  maxLength?: number;
  /** Finite integers outside the range are valid and clamped on decode. */
  clampRange?: readonly [number, number];
  /** Encode leaves the field out when it is null (optional field with a null default). */
  omitWhenNull?: boolean;
};

type TypeSpec = {
  fields: readonly FieldSpec[];
  /** Cross-field rule; returns a problem text or null. */
  rule?: (data: Record<string, unknown>) => string | null;
};

const STATES = [
  "sleeping",
  "waking",
  "seeking",
  "gazing",
  "greeting",
  "warning",
  "uncertain",
  "conversing",
  "cooldown",
  "remote",
] as const;
/** `status.report.mode`. */
const MODES = ["guard", "sleep"] as const;
/** `mode.set.mode`: `remote` starts remote control and is not a Mode (remote-mode M1). */
const MODE_SET_MODES = ["guard", "sleep", "remote"] as const;
const REASONS = [
  "presence",
  "arrived",
  "verdict",
  "no_face",
  "timeout",
  "offline",
  "audio_done",
  "manual",
  "cooldown_done",
  "error",
  "conversation",
  "conversation_done",
  "photo_done",
] as const;
const END_REASONS = [
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
const ERROR_CODES = [
  "unknown_type",
  "unsupported_version",
  "malformed_message",
  "wrong_device",
  "speak_rejected",
  "audio_busy",
  "command_rejected_state",
  "unknown_line",
  "voice_line_missing",
  "voice_line_invalid",
  "voice_file_missing",
  "audio_failed",
  "download_failed",
  "audio_device_missing",
  "camera_missing",
  "camera_failed",
  "snapshot_too_large",
  "internal_error",
  "adapter_failed",
  "conversation_failed",
  "microphone_failed",
] as const;

/** `sessionId` and `requestId` (S4 to S6). */
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const id64 = (name: string): FieldSpec => ({ name, kind: "str", pattern: ID_PATTERN });
const clampedInt = (name: string, min: number, max: number): FieldSpec => ({
  name,
  kind: "int",
  clampRange: [min, max],
});

const str = (name: string, nullable = false): FieldSpec => ({ name, kind: "str", nullable });
const num = (name: string): FieldSpec => ({ name, kind: "number" });
const int = (name: string): FieldSpec => ({ name, kind: "int" });
const bool = (name: string): FieldSpec => ({ name, kind: "bool" });
const enumOf = (name: string, allowed: readonly string[]): FieldSpec => ({
  name,
  kind: "enum",
  allowed,
});

const FACE_FIELDS: readonly FieldSpec[] = [num("left"), num("top"), num("width"), num("height")];

const REGISTRY: Readonly<Record<string, TypeSpec>> = Object.freeze({
  // Events (device -> cloud)
  "presence.detected": { fields: [enumOf("source", ["pir", "sound", "manual"])] },
  "snapshot.captured": {
    fields: [
      str("snapshotId"),
      int("width"),
      int("height"),
      num("panDeg"),
      num("tiltDeg"),
      str("jpegBase64"),
      {
        name: "requestId",
        kind: "str",
        nullable: true,
        required: false,
        pattern: ID_PATTERN,
        omitWhenNull: true,
      },
      {
        name: "purpose",
        kind: "enum",
        allowed: ["judge", "photo"],
        nullable: true,
        required: false,
        omitWhenNull: true,
      },
    ],
  },
  "state.changed": {
    fields: [enumOf("from", STATES), enumOf("to", STATES), enumOf("reason", REASONS)],
  },
  "reaction.performed": {
    fields: [
      enumOf("kind", ["family", "stranger", "uncertain"]),
      str("lineId", true),
      bool("offline"),
    ],
  },
  "encounter.ended": { fields: [enumOf("reason", ["cooldown", "manual", "error"])] },
  "error.reported": {
    fields: [
      enumOf("code", ERROR_CODES),
      { name: "message", kind: "str", maxCodePoints: ERROR_MESSAGE_MAX_CODE_POINTS },
      { name: "refId", kind: "str", nullable: true, required: false },
    ],
  },
  "conversation.requested": { fields: [enumOf("reason", ["family_verdict"])] },
  "conversation.ended": { fields: [id64("sessionId"), enumOf("reason", END_REASONS)] },
  // Commands (cloud -> device)
  "judgement.result": {
    fields: [
      str("snapshotId"),
      enumOf("verdict", ["family", "stranger", "no_face", "uncertain"]),
      num("confidence"),
      { name: "face", kind: "face", nullable: true },
    ],
  },
  speak: {
    fields: [
      str("lineId", true),
      str("audioUrl", true),
      str("ja"),
      str("en"),
      { name: "remote", kind: "bool", nullable: true, required: false, omitWhenNull: true },
    ],
    rule: (d) =>
      (d["lineId"] === null) === (d["audioUrl"] === null)
        ? "data: speak needs exactly one of lineId and audioUrl"
        : null,
  },
  gaze: { fields: [num("panDeg"), num("tiltDeg")] },
  lantern: { fields: [num("level"), int("fadeMs")] },
  "mode.set": { fields: [enumOf("mode", MODE_SET_MODES)] },
  "conversation.start": {
    fields: [
      id64("sessionId"),
      { name: "token", kind: "str", maxLength: 128 },
      clampedInt("maxSeconds", 30, 420),
      clampedInt("silenceSeconds", 5, 60),
      enumOf("source", ["family_verdict", "manual"]),
    ],
  },
  "conversation.end": { fields: [id64("sessionId"), enumOf("reason", END_REASONS)] },
  "snapshot.request": {
    fields: [
      id64("requestId"),
      {
        name: "purpose",
        kind: "enum",
        allowed: ["look", "photo"],
        nullable: true,
        required: false,
        omitWhenNull: true,
      },
    ],
  },
  // Status (device -> cloud)
  "status.report": {
    fields: [
      enumOf("state", STATES),
      enumOf("mode", MODES),
      num("panDeg"),
      num("tiltDeg"),
      num("lantern"),
      bool("cameraActive"),
      bool("micActive"),
      bool("motionEnabled"),
      int("uptimeSec"),
      str("agentVersion"),
    ],
  },
  "status.offline": { fields: [] },
});

/** Every wire type of docs/schema.md; used by the fixture and table tests (R24.15). */
export const MESSAGE_TYPES: readonly string[] = Object.freeze(Object.keys(REGISTRY));

function specFor(type: string): TypeSpec | undefined {
  return Object.hasOwn(REGISTRY, type) ? REGISTRY[type] : undefined;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

class InvalidError extends Error {}

const invalid = (problem: string): never => {
  throw new InvalidError(problem);
};

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (obj: Obj, key: string): boolean => Object.hasOwn(obj, key);

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** True when a number, anywhere in the parsed value, is not finite (for example 1e400). */
function containsNonFinite(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFinite);
  if (isObject(value)) return Object.values(value).some(containsNonFinite);
  return false;
}

function isIsoTimestampWithOffset(text: string): boolean {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.exec(text);
  if (m === null) return false;
  const [month, day, hour, minute, second] = [m[2], m[3], m[4], m[5], m[6]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const daysInMonth = new Date(Date.UTC(Number(m[1]), month, 0)).getUTCDate();
  return day <= daysInMonth;
}

// ---------------------------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------------------------

function decodeValue(spec: FieldSpec, value: unknown, where: string): unknown {
  switch (spec.kind) {
    case "str":
      if (typeof value === "string") {
        if (spec.pattern !== undefined && !spec.pattern.test(value)) {
          return invalid(`${where}: does not match the id rule`);
        }
        if (spec.maxLength !== undefined) {
          const length = Array.from(value).length;
          if (length < 1 || length > spec.maxLength) return invalid(`${where}: length out of range`);
        }
        return value;
      }
      break;
    case "int":
      if (typeof value === "number" && Number.isInteger(value)) {
        return spec.clampRange === undefined
          ? value
          : clamp(value, spec.clampRange[0], spec.clampRange[1]);
      }
      break;
    case "number":
      if (typeof value === "number") return value;
      break;
    case "bool":
      if (typeof value === "boolean") return value;
      break;
    case "enum":
      if (typeof value === "string") {
        if (spec.allowed?.includes(value)) return value;
        return invalid(`${where}: value outside the allowed values`);
      }
      break;
    case "face":
      if (isObject(value)) return decodeFields(FACE_FIELDS, value, where);
      break;
  }
  return invalid(`${where}: wrong type`);
}

/** Decode the defined fields of `obj`. Undefined fields are dropped (R24.6). */
function decodeFields(specs: readonly FieldSpec[], obj: Obj, path: string): Obj {
  const out: Obj = {};
  for (const spec of specs) {
    const where = `${path}.${spec.name}`;
    if (!hasOwn(obj, spec.name)) {
      if (spec.required !== false) invalid(`${where}: missing`);
      out[spec.name] = null;
      continue;
    }
    const value = obj[spec.name];
    if (value === null) {
      if (!spec.nullable) invalid(`${where}: null not allowed`);
      out[spec.name] = null;
      continue;
    }
    out[spec.name] = decodeValue(spec, value, where);
  }
  return out;
}

function requireString(obj: Obj, key: string): string {
  if (!hasOwn(obj, key)) return invalid(`${key}: missing`);
  const value = obj[key];
  if (typeof value !== "string") return invalid(`${key}: wrong type`);
  return value;
}

function decodeObject(obj: Obj): DecodeResult {
  // Steps 2 and 3: version.
  const v = obj["v"];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    return invalid("v: not an integer >= 1");
  }
  if (v > SCHEMA_VERSION) return { kind: "ignored", reason: "unsupported_version" };

  // Step 4: other envelope fields. Undefined top-level fields are dropped.
  const id = requireString(obj, "id");
  const ts = requireString(obj, "ts");
  if (!isIsoTimestampWithOffset(ts)) {
    return invalid("ts: not an ISO 8601 timestamp with a UTC offset");
  }
  const deviceId = requireString(obj, "deviceId");
  if (!hasOwn(obj, "encounterId")) return invalid("encounterId: missing");
  const encounterId = obj["encounterId"];
  if (encounterId !== null && typeof encounterId !== "string") {
    return invalid("encounterId: wrong type");
  }

  // Step 5: an unknown type is ignored without validating data.
  const type = requireString(obj, "type");
  const spec = specFor(type);
  if (spec === undefined) return { kind: "ignored", reason: "unknown_type" };

  // Step 6: data.
  const rawData = obj["data"];
  if (!isObject(rawData)) return invalid("data: missing or not an object");
  const data = decodeFields(spec.fields, rawData, "data");
  const problem = spec.rule?.(data) ?? null;
  if (problem !== null) return invalid(problem);

  return {
    kind: "valid",
    message: { v: 1, id, ts, deviceId, encounterId: encounterId as string | null, type, data },
  };
}

/** Decode one incoming message. Never throws. */
export function decodeEnvelope(raw: Uint8Array | string): DecodeResult {
  let text: string;
  if (typeof raw === "string") {
    if (LONE_SURROGATE.test(raw)) return { kind: "malformed", reason: "not valid UTF-8" };
    if (Buffer.byteLength(raw, "utf8") > MAX_INBOUND_BYTES) {
      return { kind: "malformed", reason: `message larger than ${MAX_INBOUND_BYTES} bytes` };
    }
    text = raw;
  } else if (raw instanceof Uint8Array) {
    if (raw.byteLength > MAX_INBOUND_BYTES) {
      return { kind: "malformed", reason: `message larger than ${MAX_INBOUND_BYTES} bytes` };
    }
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    } catch {
      return { kind: "malformed", reason: "not valid UTF-8" };
    }
  } else {
    return { kind: "malformed", reason: "input is not bytes or text" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "malformed", reason: "not valid JSON" };
  }
  // Step 1 still: a non-finite number anywhere wins over v > 1 and an unknown type.
  if (containsNonFinite(parsed)) return { kind: "malformed", reason: "non-finite number" };
  if (!isObject(parsed)) return { kind: "malformed", reason: "top level is not a JSON object" };

  try {
    return decodeObject(parsed);
  } catch (error) {
    if (error instanceof InvalidError) return { kind: "malformed", reason: error.message };
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------------------------

function encodeFields(specs: readonly FieldSpec[], obj: Obj, path: string): Obj {
  const out: Obj = {};
  for (const spec of specs) {
    let value = obj[spec.name];
    if (value === undefined) {
      // refId is always written for error.reported; every other undefined field is omitted.
      if (spec.required === false && spec.omitWhenNull !== true) out[spec.name] = null;
      continue;
    }
    if (value === null && spec.omitWhenNull === true) continue;
    const where = `${path}.${spec.name}`;
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new RangeError(`${where}: non-finite number`);
    }
    if (spec.kind === "face" && value !== null) {
      value = encodeFields(FACE_FIELDS, value as Obj, where);
    }
    if (spec.maxCodePoints !== undefined && typeof value === "string") {
      value = Array.from(value).slice(0, spec.maxCodePoints).join("");
    }
    out[spec.name] = value;
  }
  return out;
}

/**
 * Encode an envelope as compact JSON in schema order. Fields whose value is undefined are
 * omitted, `error.reported.message` is cut to 200 code points, and `refId` is always written.
 * Throws for an unregistered type or a non-finite number.
 */
export function encodeEnvelope(e: Envelope): string {
  const spec = specFor(e.type);
  if (spec === undefined) throw new RangeError("type: not defined by docs/schema.md");
  const data = isObject(e.data) ? e.data : {};
  const out: Obj = {
    v: e.v,
    id: e.id,
    ts: e.ts,
    deviceId: e.deviceId,
    encounterId: e.encounterId,
    type: e.type,
    data: encodeFields(spec.fields, data, "data"),
  };
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key];
  }
  return JSON.stringify(out);
}

// ---------------------------------------------------------------------------------------------
// makeCommand and topicFor
// ---------------------------------------------------------------------------------------------

function finite(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${where}: not a finite number`);
  }
  return value;
}

function checkId(value: unknown, where: string): void {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new RangeError(`${where}: does not match the id rule`);
  }
}

function clampCommand(type: CommandType, data: CommandData[CommandType]): unknown {
  switch (type) {
    case "lantern": {
      const d = data as CommandData["lantern"];
      return {
        level: clamp(finite(d.level, "lantern.level"), 0, 1),
        fadeMs: Math.round(clamp(finite(d.fadeMs, "lantern.fadeMs"), 0, 10_000)),
      };
    }
    case "gaze": {
      const d = data as CommandData["gaze"];
      return { panDeg: finite(d.panDeg, "gaze.panDeg"), tiltDeg: finite(d.tiltDeg, "gaze.tiltDeg") };
    }
    case "judgement.result": {
      const d = data as CommandData["judgement.result"];
      const face =
        d.face === null
          ? null
          : {
              left: clamp(finite(d.face.left, "face.left"), 0, 1),
              top: clamp(finite(d.face.top, "face.top"), 0, 1),
              width: clamp(finite(d.face.width, "face.width"), 0, 1),
              height: clamp(finite(d.face.height, "face.height"), 0, 1),
            };
      return {
        snapshotId: d.snapshotId,
        verdict: d.verdict,
        confidence: finite(d.confidence, "judgement.result.confidence"),
        face,
      };
    }
    case "speak": {
      const d = data as CommandData["speak"];
      if ((d.lineId === null) === (d.audioUrl === null)) {
        throw new RangeError("speak needs exactly one of lineId and audioUrl");
      }
      return {
        lineId: d.lineId,
        audioUrl: d.audioUrl,
        ja: d.ja,
        en: d.en,
        ...(d.remote === true ? { remote: true } : {}),
      };
    }
    case "mode.set":
      return { mode: (data as CommandData["mode.set"]).mode };
    case "conversation.start": {
      const d = data as CommandData["conversation.start"];
      checkId(d.sessionId, "conversation.start.sessionId");
      if (typeof d.token !== "string" || Array.from(d.token).length < 1 || Array.from(d.token).length > 128) {
        throw new RangeError("conversation.start.token: length out of range");
      }
      return {
        sessionId: d.sessionId,
        token: d.token,
        maxSeconds: Math.round(clamp(finite(d.maxSeconds, "conversation.start.maxSeconds"), 30, 420)),
        silenceSeconds: Math.round(
          clamp(finite(d.silenceSeconds, "conversation.start.silenceSeconds"), 5, 60),
        ),
        source: d.source,
      };
    }
    case "conversation.end": {
      const d = data as CommandData["conversation.end"];
      checkId(d.sessionId, "conversation.end.sessionId");
      return { sessionId: d.sessionId, reason: d.reason };
    }
    case "snapshot.request": {
      const d = data as CommandData["snapshot.request"];
      checkId(d.requestId, "snapshot.request.requestId");
      return {
        requestId: d.requestId,
        ...(d.purpose === "photo" ? { purpose: "photo" as const } : {}),
      };
    }
  }
}

const COMMAND_TYPES: readonly string[] = [
  "judgement.result",
  "speak",
  "gaze",
  "lantern",
  "mode.set",
  "conversation.start",
  "conversation.end",
  "snapshot.request",
];

/**
 * Build a command envelope, clamping ranges as the device does (R24.9). Throws a `RangeError`
 * for a non-finite number (R24.10) or an unknown command type. The caller supplies the id and
 * the time.
 */
export function makeCommand<T extends CommandType>(
  type: T,
  data: CommandData[T],
  ctx: { id: string; now: Date; deviceId: string; encounterId: string | null },
): Envelope<T, CommandData[T]> {
  if (!COMMAND_TYPES.includes(type)) {
    throw new RangeError("type: not a command type");
  }
  return {
    v: 1,
    id: ctx.id,
    ts: ctx.now.toISOString(),
    deviceId: ctx.deviceId,
    encounterId: ctx.encounterId,
    type,
    data: clampCommand(type, data) as CommandData[T],
  };
}

const TOPIC_KINDS: readonly string[] = ["events", "commands", "status"];

/** `warashi/<deviceId>/<kind>`. Throws for an unknown kind or an empty device id (R24.11, R24.12). */
export function topicFor(deviceId: string, kind: TopicKind): string {
  if (typeof deviceId !== "string" || deviceId.length === 0) {
    throw new RangeError("deviceId: must not be empty");
  }
  if (!TOPIC_KINDS.includes(kind)) throw new RangeError("kind: must be events, commands or status");
  return `warashi/${deviceId}/${kind}`;
}
