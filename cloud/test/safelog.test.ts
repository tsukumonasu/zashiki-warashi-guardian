// Unit tests for the safe logger (R8.6, R25.1).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { log, REDACTED, setLogSink, type LogSink } from "../lambda/_shared/safelog.js";

// Fixtures are synthetic: no real image, URL or name.
const JPEG_BASE64 = "/9j/4AAQSkZJRgABAQEASABIAAD" + "A".repeat(40);
const SIGNED_URL =
  "https://bucket.example.invalid/key.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc123";
const DISPLAY_NAME = "Fixture-Display-Name";
const FACE_ID = "11111111-2222-4333-8444-555555555555";

let lines: string[] = [];
let previous: LogSink;

beforeEach(() => {
  lines = [];
  previous = setLogSink((line) => {
    lines.push(line);
  });
});

afterEach(() => {
  setLogSink(previous);
});

function output(): string {
  return lines.join("\n");
}

describe("safe logger", () => {
  it("never outputs a JPEG signature string, a pre-signed URL or a display name", () => {
    log("fixture", {
      jpegBase64: JPEG_BASE64,
      note: JPEG_BASE64,
      url: SIGNED_URL,
      nested: { displayName: DISPLAY_NAME, list: [SIGNED_URL, JPEG_BASE64] },
    });
    const text = output();
    expect(text).not.toContain("/9j/");
    expect(text).not.toContain("X-Amz-Signature");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain(DISPLAY_NAME);
    expect(text).toContain(REDACTED);
  });

  it("masks sensitive keys regardless of case", () => {
    log("fixture", { DisplayName: DISPLAY_NAME, JPEGBASE64: "x", FaceIds: [FACE_ID] });
    expect(output()).not.toContain(DISPLAY_NAME);
    expect(output()).not.toContain(FACE_ID);
  });

  it("never logs a face id together with a display name", () => {
    log("fixture", {
      memberId: "member-1",
      faceId: FACE_ID,
      faceIds: [FACE_ID],
      displayName: DISPLAY_NAME,
      nested: { faceIds: [FACE_ID], displayName: DISPLAY_NAME },
    });
    const text = output();
    expect(text.includes(FACE_ID) && text.includes(DISPLAY_NAME)).toBe(false);
    expect(text).not.toContain(FACE_ID);
    expect(text).not.toContain(DISPLAY_NAME);
  });

  it("masks binary values, data URLs and error messages containing signed URLs", () => {
    log("fixture", {
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      dataUrl: "data:image/jpeg;base64,AAAA",
      err: new Error(`failed ${SIGNED_URL}`),
    });
    const text = output();
    expect(text).not.toContain("X-Amz-Signature");
    expect(text).not.toContain("data:image");
    expect(text).not.toContain("255");
  });

  it("keeps ids and counts unchanged and writes one JSON line with the event", () => {
    log("encounter.stored", { encounterId: "enc-1", count: 3, ok: true });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      encounterId: "enc-1",
      count: 3,
      ok: true,
      event: "encounter.stored",
    });
  });

  it("truncates long ordinary strings and survives circular fields", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    log("fixture", { long: "a b ".repeat(300), circular });
    expect(lines).toHaveLength(1);
    expect(output()).toContain("[truncated]");
  });

  it("setLogSink returns the previous sink", () => {
    const other: LogSink = () => undefined;
    const current = setLogSink(other);
    expect(setLogSink(current)).toBe(other);
  });
});
