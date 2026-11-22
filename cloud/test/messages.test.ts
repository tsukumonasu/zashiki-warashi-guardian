// Unit tests for the Schema_Codec (R24.2 to R24.5, R24.9 to R24.12, R24.15).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeEnvelope,
  encodeEnvelope,
  MAX_INBOUND_BYTES,
  MESSAGE_TYPES,
  makeCommand,
  topicFor,
  type TopicKind,
} from "../lambda/_shared/messages.js";

const REPO = path.resolve(import.meta.dirname, "../..");
const FIXTURE_DIR = path.join(REPO, "docs/fixtures/schema-v1");
const SCHEMA_MD = path.join(REPO, "docs/schema.md");

const fixtureFiles = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
const readFixture = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(FIXTURE_DIR, file), "utf8")) as Record<string, unknown>;

/** Build a message from the `speak` fixture with overrides on the top level or in `data`. */
function speakWith(
  top: Record<string, unknown> = {},
  data: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = readFixture("speak.json");
  return { ...base, ...top, data: { ...(base["data"] as object), ...data } };
}

const decode = (value: unknown) => decodeEnvelope(JSON.stringify(value));

describe("fixtures (R24.1, R24.15)", () => {
  it.each(fixtureFiles)("%s decodes to valid and re-encodes to the same JSON", (file) => {
    const fixture = readFixture(file);
    const result = decode(fixture);
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(JSON.parse(encodeEnvelope(result.message))).toEqual(fixture);
  });

  it("has one fixture for every type in docs/schema.md and no fixture without a type", () => {
    const md = readFileSync(SCHEMA_MD, "utf8");
    const start = md.indexOf("## Events (device → cloud)");
    const end = md.indexOf("## Device-internal events");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const documented = new Set<string>();
    for (const line of md.slice(start, end).split("\n")) {
      // Type rows have a data column that starts with `{`; reason and error code rows do not.
      const m = /^\| `([a-z]+(?:\.[a-z]+)?)` \| `\{/.exec(line);
      if (m?.[1] !== undefined) documented.add(m[1]);
    }
    const fixtureTypes = new Set(fixtureFiles.map((f) => f.replace(/\.json$/, "")));
    const codecTypes = new Set(MESSAGE_TYPES);

    const missingFixture = [...documented].filter((t) => !fixtureTypes.has(t));
    const extraFixture = [...fixtureTypes].filter((t) => !documented.has(t));
    const missingInCodec = [...documented].filter((t) => !codecTypes.has(t));
    const extraInCodec = [...codecTypes].filter((t) => !documented.has(t));

    expect({ missingFixture }).toEqual({ missingFixture: [] });
    expect({ extraFixture }).toEqual({ extraFixture: [] });
    expect({ missingInCodec }).toEqual({ missingInCodec: [] });
    expect({ extraInCodec }).toEqual({ extraInCodec: [] });
    expect(documented.size).toBe(18);
  });

  it("each fixture file carries the type named by its file name", () => {
    for (const file of fixtureFiles) {
      expect({ file, type: readFixture(file)["type"] }).toEqual({
        file,
        type: file.replace(/\.json$/, ""),
      });
    }
  });
});

describe("version and type rules (R24.2 to R24.5)", () => {
  it.each([0, 1.5, "1", true, null, -1])("v = %j is malformed", (v) => {
    expect(decode(speakWith({ v })).kind).toBe("malformed");
  });

  it("a missing v is malformed", () => {
    const message = speakWith();
    delete message["v"];
    expect(decode(message).kind).toBe("malformed");
  });

  it.each([2, 7])("v = %d is ignored as unsupported_version", (v) => {
    expect(decode(speakWith({ v }))).toEqual({ kind: "ignored", reason: "unsupported_version" });
  });

  it("an unknown type is ignored as unknown_type", () => {
    expect(decode(speakWith({ type: "dance.now" }))).toEqual({
      kind: "ignored",
      reason: "unknown_type",
    });
  });

  it("an inherited property name is not a known type", () => {
    expect(decode(speakWith({ type: "constructor" }))).toEqual({
      kind: "ignored",
      reason: "unknown_type",
    });
  });

  it("unsupported_version wins over unknown_type", () => {
    expect(decode(speakWith({ v: 2, type: "dance.now" }))).toEqual({
      kind: "ignored",
      reason: "unsupported_version",
    });
  });

  it("a bad v wins over an unknown type and over v > 1 elsewhere", () => {
    expect(decode(speakWith({ v: 0, type: "dance.now" })).kind).toBe("malformed");
    expect(decode(speakWith({ v: "2", type: "dance.now" })).kind).toBe("malformed");
  });

  it("broken JSON, UTF-8 or non-finite numbers win over v > 1", () => {
    expect(decodeEnvelope('{"v": 2,').kind).toBe("malformed");
    expect(decodeEnvelope(new Uint8Array([0x7b, 0xff, 0x7d])).kind).toBe("malformed");
    expect(decodeEnvelope('{"v": 2, "type": "x", "data": {"n": 1e400}}').kind).toBe("malformed");
  });

  it("an unknown type is ignored even when its data is junk", () => {
    expect(decode(speakWith({ type: "dance.now", data: 5 })).kind).toBe("ignored");
  });

  it("a known type with a bad field is malformed", () => {
    expect(decode(speakWith({}, { ja: 5 })).kind).toBe("malformed");
    expect(decode(speakWith({ deviceId: undefined })).kind).toBe("malformed");
    expect(decode(speakWith({ ts: "yesterday" })).kind).toBe("malformed");
  });

  it("a value outside an enumeration is malformed", () => {
    const mode = { ...readFixture("mode.set.json"), data: { mode: "party" } };
    expect(decode(mode).kind).toBe("malformed");
  });

  it("drops undefined data fields (R24.6)", () => {
    const result = decode(speakWith({}, { name: "Hanako" }));
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(Object.keys(result.message.data as object).sort()).toEqual([
        "audioUrl",
        "en",
        "ja",
        "lineId",
        "remote",
      ]);
    }
  });
});

describe("size limit (R24.4)", () => {
  /** Pad a valid message with whitespace until it is exactly `bytes` long. */
  const padded = (bytes: number): string => {
    const json = JSON.stringify(speakWith());
    return json + " ".repeat(bytes - Buffer.byteLength(json));
  };

  it("accepts exactly 131,072 bytes and rejects one more", () => {
    expect(MAX_INBOUND_BYTES).toBe(131_072);
    expect(decodeEnvelope(padded(131_072)).kind).toBe("valid");
    expect(decodeEnvelope(padded(131_073)).kind).toBe("malformed");
  });

  it("applies the same limit to bytes", () => {
    expect(decodeEnvelope(Buffer.from(padded(131_072))).kind).toBe("valid");
    expect(decodeEnvelope(Buffer.from(padded(131_073))).kind).toBe("malformed");
  });

  it("counts bytes, not characters", () => {
    const json = JSON.stringify(speakWith());
    // Each Japanese space is 3 bytes in UTF-8 but is not JSON whitespace; use a string field.
    const big = JSON.stringify(speakWith({}, { ja: "あ".repeat(43_700) }));
    expect(big.length).toBeLessThan(MAX_INBOUND_BYTES);
    expect(Buffer.byteLength(big)).toBeGreaterThan(MAX_INBOUND_BYTES);
    expect(decodeEnvelope(big).kind).toBe("malformed");
    expect(decodeEnvelope(json).kind).toBe("valid");
  });
});

describe("speak needs exactly one of lineId and audioUrl (R24.4)", () => {
  it("accepts lineId only and audioUrl only", () => {
    expect(decode(speakWith({}, { lineId: "a", audioUrl: null })).kind).toBe("valid");
    expect(decode(speakWith({}, { lineId: null, audioUrl: "https://example.invalid/a.wav" })).kind).toBe(
      "valid",
    );
  });

  it("rejects both and neither", () => {
    expect(decode(speakWith({}, { lineId: "a", audioUrl: "https://example.invalid/a.wav" })).kind).toBe(
      "malformed",
    );
    expect(decode(speakWith({}, { lineId: null, audioUrl: null })).kind).toBe("malformed");
  });
});

describe("makeCommand (R24.9, R24.10)", () => {
  const ctx = {
    id: "id-1",
    now: new Date("2026-11-20T12:34:56.789Z"),
    deviceId: "warashi-01",
    encounterId: null,
  };

  it("fills the envelope from the context", () => {
    const cmd = makeCommand("mode.set", { mode: "sleep" }, ctx);
    expect(cmd).toEqual({
      v: 1,
      id: "id-1",
      ts: "2026-11-20T12:34:56.789Z",
      deviceId: "warashi-01",
      encounterId: null,
      type: "mode.set",
      data: { mode: "sleep" },
    });
  });

  it("clamps lantern level and fade time", () => {
    expect(makeCommand("lantern", { level: 2, fadeMs: 99_999 }, ctx).data).toEqual({
      level: 1,
      fadeMs: 10_000,
    });
    expect(makeCommand("lantern", { level: -3, fadeMs: -5 }, ctx).data).toEqual({
      level: 0,
      fadeMs: 0,
    });
  });

  it("clamps every face box field to 0..1", () => {
    const cmd = makeCommand(
      "judgement.result",
      {
        snapshotId: "s",
        verdict: "stranger",
        confidence: 0.9,
        face: { left: -1, top: 2, width: 0.5, height: 7 },
      },
      ctx,
    );
    expect(cmd.data.face).toEqual({ left: 0, top: 1, width: 0.5, height: 1 });
  });

  it("keeps a null face and gaze angles unchanged", () => {
    const j = makeCommand(
      "judgement.result",
      { snapshotId: "s", verdict: "no_face", confidence: 1, face: null },
      ctx,
    );
    expect(j.data.face).toBeNull();
    expect(makeCommand("gaze", { panDeg: 500, tiltDeg: -500 }, ctx).data).toEqual({
      panDeg: 500,
      tiltDeg: -500,
    });
  });

  it("builds output that decodes to valid", () => {
    const cmd = makeCommand("lantern", { level: 0.5, fadeMs: 800 }, ctx);
    expect(decodeEnvelope(encodeEnvelope(cmd)).kind).toBe("valid");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects %s in lantern, gaze and face box fields",
    (bad) => {
      expect(() => makeCommand("lantern", { level: bad, fadeMs: 1 }, ctx)).toThrow(RangeError);
      expect(() => makeCommand("lantern", { level: 1, fadeMs: bad }, ctx)).toThrow(RangeError);
      expect(() => makeCommand("gaze", { panDeg: bad, tiltDeg: 0 }, ctx)).toThrow(RangeError);
      expect(() => makeCommand("gaze", { panDeg: 0, tiltDeg: bad }, ctx)).toThrow(RangeError);
      for (const key of ["left", "top", "width", "height"] as const) {
        const face = { left: 0, top: 0, width: 0.1, height: 0.1, [key]: bad };
        expect(() =>
          makeCommand(
            "judgement.result",
            { snapshotId: "s", verdict: "family", confidence: 1, face },
            ctx,
          ),
        ).toThrow(RangeError);
      }
    },
  );

  it("rejects speak with both or neither of lineId and audioUrl", () => {
    expect(() =>
      makeCommand("speak", { lineId: "a", audioUrl: "https://x.invalid/a.wav", ja: "", en: "" }, ctx),
    ).toThrow(RangeError);
    expect(() => makeCommand("speak", { lineId: null, audioUrl: null, ja: "", en: "" }, ctx)).toThrow(
      RangeError,
    );
  });

  it("rejects a type that is not a command", () => {
    expect(() =>
      makeCommand("presence.detected" as never, { source: "pir" } as never, ctx),
    ).toThrow(RangeError);
  });
});

describe("voice conversation types (R16.1, R16.3)", () => {
  const ID64 = "a".repeat(64);
  const withData = (file: string, data: Record<string, unknown>): Record<string, unknown> => {
    const base = readFixture(file);
    return { ...base, data: { ...(base["data"] as object), ...data } };
  };
  const dataOf = (value: unknown): Record<string, unknown> => {
    const result = decode(value);
    expect(result.kind).toBe("valid");
    return result.kind === "valid" ? (result.message.data as Record<string, unknown>) : {};
  };

  it("snapshot.captured requestId is optional and defaults to null", () => {
    const plain = readFixture("snapshot.captured.json") as { data: Record<string, unknown> };
    delete plain.data["requestId"];
    delete plain.data["purpose"];
    expect(dataOf(plain)["requestId"]).toBeNull();
    expect(dataOf(plain)["purpose"]).toBeNull();
    const withId = withData("snapshot.captured.json", { requestId: "req-1" });
    expect(dataOf(withId)["requestId"]).toBe("req-1");
    const decoded = decode(withId);
    if (decoded.kind !== "valid") throw new Error("expected valid");
    const encoded = JSON.parse(encodeEnvelope(decoded.message)) as { data: { requestId: string } };
    expect(encoded.data.requestId).toBe("req-1");
  });

  it.each(["", "a b", "a_b", "あ", "a".repeat(65)])("rejects the id %j", (bad) => {
    expect(decode(withData("snapshot.request.json", { requestId: bad })).kind).toBe("malformed");
    expect(decode(withData("conversation.end.json", { sessionId: bad })).kind).toBe("malformed");
    expect(decode(withData("snapshot.captured.json", { requestId: bad })).kind).toBe("malformed");
  });

  it("accepts a 64-character id", () => {
    expect(decode(withData("snapshot.request.json", { requestId: ID64 })).kind).toBe("valid");
  });

  it("checks the token length 1..128", () => {
    expect(decode(withData("conversation.start.json", { token: "" })).kind).toBe("malformed");
    expect(decode(withData("conversation.start.json", { token: "t".repeat(129) })).kind).toBe(
      "malformed",
    );
    expect(decode(withData("conversation.start.json", { token: "t".repeat(128) })).kind).toBe(
      "valid",
    );
  });

  it.each([
    [0, 30],
    [29, 30],
    [1000, 420],
  ])("clamps maxSeconds %d to %d", (given, expected) => {
    expect(dataOf(withData("conversation.start.json", { maxSeconds: given }))["maxSeconds"]).toBe(
      expected,
    );
  });

  it.each([
    [-3, 5],
    [4, 5],
    [61, 60],
  ])("clamps silenceSeconds %d to %d", (given, expected) => {
    expect(
      dataOf(withData("conversation.start.json", { silenceSeconds: given }))["silenceSeconds"],
    ).toBe(expected);
  });

  it("rejects a non-integer or non-finite duration and a bad enumeration value", () => {
    expect(decode(withData("conversation.start.json", { maxSeconds: 1.5 })).kind).toBe("malformed");
    expect(decode(withData("conversation.start.json", { maxSeconds: "9" })).kind).toBe("malformed");
    expect(
      decodeEnvelope(JSON.stringify(readFixture("conversation.start.json")).replace("180", "1e400"))
        .kind,
    ).toBe("malformed");
    expect(decode(withData("conversation.start.json", { source: "other" })).kind).toBe("malformed");
    expect(decode(withData("conversation.end.json", { reason: "bored" })).kind).toBe("malformed");
    expect(decode(withData("conversation.ended.json", { reason: "bored" })).kind).toBe("malformed");
    expect(decode(withData("conversation.requested.json", { reason: "x" })).kind).toBe("malformed");
  });

  it("accepts every ConversationEndReason", () => {
    for (const reason of [
      "silence", "limit", "stranger", "user", "manual",
      "language", "unsafe_output", "error", "no_client", "offline",
    ]) {
      expect(decode(withData("conversation.ended.json", { reason })).kind).toBe("valid");
    }
  });

  it("accepts the new state.changed reasons, the conversing state and the new error codes", () => {
    for (const reason of ["conversation", "conversation_done"]) {
      expect(
        decode(withData("state.changed.json", { from: "greeting", to: "conversing", reason })).kind,
      ).toBe("valid");
    }
    for (const code of ["conversation_failed", "microphone_failed"]) {
      expect(decode(withData("error.reported.json", { code })).kind).toBe("valid");
    }
  });

  it("makeCommand clamps and validates the new commands", () => {
    const ctx = { id: "i", now: new Date("2026-11-20T12:34:56.789Z"), deviceId: "d", encounterId: null };
    const start = makeCommand(
      "conversation.start",
      { sessionId: "s-1", token: "tok", maxSeconds: 9999, silenceSeconds: 1, source: "manual" },
      ctx,
    );
    expect(start.data).toMatchObject({ maxSeconds: 420, silenceSeconds: 5 });
    expect(decodeEnvelope(encodeEnvelope(start)).kind).toBe("valid");
    expect(
      decodeEnvelope(
        encodeEnvelope(makeCommand("conversation.end", { sessionId: "s-1", reason: "user" }, ctx)),
      ).kind,
    ).toBe("valid");
    expect(
      decodeEnvelope(encodeEnvelope(makeCommand("snapshot.request", { requestId: "r-1" }, ctx))).kind,
    ).toBe("valid");
    expect(() => makeCommand("snapshot.request", { requestId: "bad id" }, ctx)).toThrow(RangeError);
    expect(() =>
      makeCommand(
        "conversation.start",
        { sessionId: "s", token: "", maxSeconds: 60, silenceSeconds: 10, source: "manual" },
        ctx,
      ),
    ).toThrow(RangeError);
    expect(() =>
      makeCommand(
        "conversation.start",
        { sessionId: "s", token: "t", maxSeconds: Number.NaN, silenceSeconds: 10, source: "manual" },
        ctx,
      ),
    ).toThrow(RangeError);
  });
});

describe("topicFor (R24.11, R24.12)", () => {
  it.each(["events", "commands", "status"] as const)("returns warashi/<id>/%s", (kind) => {
    expect(topicFor("warashi-01", kind)).toBe(`warashi/warashi-01/${kind}`);
  });

  it("rejects an unknown kind", () => {
    expect(() => topicFor("warashi-01", "other" as TopicKind)).toThrow(RangeError);
    expect(() => topicFor("warashi-01", "" as TopicKind)).toThrow(RangeError);
  });

  it("rejects an empty device id", () => {
    expect(() => topicFor("", "events")).toThrow(RangeError);
  });
});
