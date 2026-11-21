// Sample_Responses check: the bundled copies match docs/fixtures/simulate-v1/ byte for byte,
// decode with the Schema_Codec and carry no name or image data.
// Requirements 2.2, 3.6, 19.1.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeValue } from "../src/simulation/codec";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_DIR = join(ROOT, "docs", "fixtures", "simulate-v1");
const BUNDLED_DIR = join(ROOT, "dashboard", "src", "simulation", "data", "sample-responses");
const NAMES = ["family.json", "stranger.json", "no_face.json"];

/** Keys that would carry a person's name, a face id or image data. */
const FORBIDDEN_KEYS = /^(name|displayName|memberId|faceId|label|nickname|jpegBase64|image|imageBase64)$/i;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function load(dir: string, file: string): Json {
  return JSON.parse(readFileSync(join(dir, file), "utf8")) as Json;
}

function forbiddenKeys(value: Json, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(FORBIDDEN_KEYS.test(k) ? [`${path}.${k}`] : []),
      ...forbiddenKeys(v, `${path}.${k}`),
    ]);
  }
  return [];
}

function inUnit(n: unknown): boolean {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

function expectFaceBox(face: unknown): void {
  if (face === null) return;
  const box = face as Record<string, unknown>;
  for (const key of ["left", "top", "width", "height"]) expect(inUnit(box[key])).toBe(true);
  expect((box.left as number) + (box.width as number)).toBeLessThanOrEqual(1);
  expect((box.top as number) + (box.height as number)).toBeLessThanOrEqual(1);
}

describe("bundled Sample_Responses", () => {
  it("holds exactly the files of docs/fixtures/simulate-v1/", () => {
    expect(readdirSync(BUNDLED_DIR).sort()).toEqual(readdirSync(FIXTURE_DIR).sort());
    expect(readdirSync(BUNDLED_DIR).sort()).toEqual([...NAMES].sort());
  });

  describe.each(NAMES)("%s", (file) => {
    it("is identical to the docs fixture", () => {
      expect(readFileSync(join(BUNDLED_DIR, file), "utf8")).toBe(
        readFileSync(join(FIXTURE_DIR, file), "utf8"),
      );
    });

    const response = load(BUNDLED_DIR, file) as Record<string, Json>;

    it("decodes every command to valid", () => {
      const commands = response.commands as Json[];
      expect(commands.map((c) => (decodeValue(c).kind))).toEqual(commands.map(() => "valid"));
      const types = commands.map((c) => (c as Record<string, Json>).type);
      expect(types).toEqual(["judgement.result", "speak"]);
    });

    it("keeps confidence and face boxes within 0..1", () => {
      expect(inUnit(response.confidence)).toBe(true);
      expectFaceBox(response.face);
      for (const c of response.commands as Json[]) {
        const data = (c as Record<string, Json>).data as Record<string, Json>;
        if ("confidence" in data) expect(inUnit(data.confidence)).toBe(true);
        if ("face" in data) expectFaceBox(data.face);
      }
      const latency = response.latencyMs as Record<string, number>;
      expect(latency.search).toBeLessThanOrEqual(latency.total as number);
    });

    it("contains no name, face id or image data", () => {
      expect(forbiddenKeys(response)).toEqual([]);
      expect(JSON.stringify(response)).not.toMatch(/base64|data:image/i);
    });
  });
});
