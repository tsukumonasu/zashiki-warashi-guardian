// Fixture check: docs/fixtures/schema-v1/ against docs/schema.md and the Schema_Codec.
// Requirements 4.7, 4.8, 20.5.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeText, encode } from "../src/simulation/codec";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_DIR = join(ROOT, "docs", "fixtures", "schema-v1");
const SCHEMA_FILE = join(ROOT, "docs", "schema.md");

/** Headings of docs/schema.md whose tables list message types in the first column. */
const TYPE_SECTIONS = [
  "## Events (device → cloud)",
  "## Commands (cloud → device)",
  "## Status (device → cloud)",
];

/** Reads the first-column type names from the tables of the three type sections. */
function schemaTypes(): string[] {
  const lines = readFileSync(SCHEMA_FILE, "utf8").split("\n");
  const types: string[] = [];
  for (const heading of TYPE_SECTIONS) {
    const start = lines.findIndex((l) => l.trim() === heading);
    if (start < 0) throw new Error(`docs/schema.md has no section "${heading}"`);
    for (let i = start + 1; i < lines.length && !(lines[i] ?? "").startsWith("#"); i++) {
      const m = /^\|\s*`([a-z]+(?:\.[a-z]+)*)`\s*\|/.exec(lines[i] ?? "");
      const name = m?.[1];
      if (name && name !== "type") types.push(name); // "type" is the column header
    }
  }
  return types;
}

/** Sorts object keys recursively so key order is ignored in comparisons. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

const dirExists = existsSync(FIXTURE_DIR);
const files = dirExists ? readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).sort() : [];
const types = schemaTypes();

function fixtureText(file: string): string {
  return readFileSync(join(FIXTURE_DIR, file), "utf8");
}

function fixtureType(file: string): string | null {
  try {
    const parsed: unknown = JSON.parse(fixtureText(file));
    const t = (parsed as { type?: unknown } | null)?.type;
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}

describe("schema-v1 fixtures", () => {
  it("the fixture directory exists and docs/schema.md lists types", () => {
    expect(dirExists, `missing directory ${FIXTURE_DIR}`).toBe(true);
    expect(types.length, "no types parsed from docs/schema.md").toBeGreaterThan(0);
  });

  it("every type in docs/schema.md has a fixture", () => {
    const present = new Set(files.map((f) => fixtureType(f)));
    const missing = types.filter((t) => !present.has(t));
    expect(missing, `types without a fixture: ${missing.join(", ")}`).toEqual([]);
  });

  it("every fixture file has a type in docs/schema.md", () => {
    const known = new Set(types);
    const orphans = files.filter((f) => {
      const t = fixtureType(f);
      return t === null || !known.has(t);
    });
    expect(orphans, `fixtures without a type in docs/schema.md: ${orphans.join(", ")}`).toEqual([]);
  });

  for (const file of files) {
    it(`${file} is named after its type`, () => {
      expect(fixtureType(file), `${file}: type does not match the file name`).toBe(
        file.replace(/\.json$/, ""),
      );
    });

    it(`${file} decodes to valid and re-encodes to an equal value`, () => {
      const text = fixtureText(file);
      const result = decodeText(text);
      if (result.kind !== "valid") {
        throw new Error(`${file}: decoded as ${JSON.stringify(result)}`);
      }
      expect(
        canonical(JSON.parse(encode(result.message))),
        `${file}: re-encoded value differs`,
      ).toEqual(canonical(JSON.parse(text)));
    });
  }
});
