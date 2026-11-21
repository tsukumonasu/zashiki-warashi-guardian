// Feature: dashboard-simulation, Property 5: State changes are consistent and follow the schema
// **Validates: Requirements 3.5, 5.6, 5.7**

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { initialState, step } from "../../src/simulation/engine";
import type { Input, SimState } from "../../src/simulation/types";
import { arbInput, arbPlan, arbSeed, arbTickGap, drive } from "../helpers";

const SCHEMA_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "schema.md");
const ALL_STATES = [
  "sleeping",
  "waking",
  "seeking",
  "gazing",
  "greeting",
  "warning",
  "uncertain",
  "conversing",
  "cooldown",
];

const ticked = (cell: string): string[] => [...cell.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);

/** Builds the allowed "from>to>reason" set from the "Reason mapping" table of docs/schema.md. */
function allowedTriples(): Set<string> {
  const lines = readFileSync(SCHEMA_FILE, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith("#### Reason mapping"));
  const allowed = new Set<string>();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#{1,4} /.test(line)) break;
    if (!line.startsWith("|") || line.startsWith("|---")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 3 || cells[0] === "From → To") continue;
    const [fromCell, toCell] = cells[0]!.split("→").map((s) => s.trim());
    if (!fromCell || !toCell) continue;
    const excluded = /other than/.test(fromCell) ? ticked(fromCell) : null;
    const froms = excluded ? ALL_STATES.filter((s) => !excluded.includes(s)) : ticked(fromCell);
    const reasons = ticked(cells[2]!);
    for (const f of froms) for (const t of ticked(toCell)) for (const r of reasons) allowed.add(`${f}>${t}>${r}`);
  }
  return allowed;
}

const ALLOWED = allowedTriples();

interface Change {
  from: string;
  to: string;
  reason: string;
}

function changesOf(messages: readonly unknown[]): Change[] {
  return (messages as { type: string; data: Change }[])
    .filter((m) => m.type === "state.changed")
    .map((m) => m.data);
}

/** Checks the changes of one step against the state before and after it. */
function checkStep(before: SimState, after: SimState, messages: readonly unknown[]): void {
  const changes = changesOf(messages);
  if (changes.length === 0) {
    expect(after.deviceState).toBe(before.deviceState);
    return;
  }
  expect(changes[0]!.from).toBe(before.deviceState);
  for (let i = 1; i < changes.length; i++) expect(changes[i]!.from).toBe(changes[i - 1]!.to);
  expect(changes[changes.length - 1]!.to).toBe(after.deviceState);
  for (const c of changes) {
    expect(c.from).not.toBe(c.to);
    expect(ALLOWED.has(`${c.from}>${c.to}>${c.reason}`), `${c.from} -> ${c.to} (${c.reason})`).toBe(true);
  }
}

describe("Feature: dashboard-simulation, Property 5: State changes are consistent and follow the schema", () => {
  it("parses a non-empty reason mapping from docs/schema.md", () => {
    expect(ALLOWED.size).toBeGreaterThan(20);
    expect(ALLOWED.has("sleeping>waking>presence")).toBe(true);
  });

  it("random input sequences keep every state.changed consistent and allowed", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(arbInput, fc.integer({ min: 0, max: 2000 })), { maxLength: 40 }), (steps) => {
        let state = initialState();
        let now = 0;
        for (const [input, gap] of steps) {
          now += gap;
          const result = step(state, input as Input, now);
          const messages = result.outputs.flatMap((o) => (o.kind === "message" ? [o.envelope] : []));
          checkStep(state, result.state, messages);
          state = result.state;
        }
      }),
      { numRuns: 200 },
    );
  });

  it("complete scenario runs keep every state.changed consistent and allowed", () => {
    fc.assert(
      fc.property(arbPlan, arbSeed, arbTickGap, (plan, seed, gap) => {
        const result = drive(plan, seed, gap);
        // Messages are flattened over the run, so check the chain from the initial state to the last one.
        const last = result.states[result.states.length - 1]!;
        const changes = changesOf(result.messages);
        let current = "sleeping";
        for (const c of changes) {
          expect(c.from).toBe(current);
          expect(ALLOWED.has(`${c.from}>${c.to}>${c.reason}`), `${c.from} -> ${c.to} (${c.reason})`).toBe(true);
          current = c.to;
        }
        expect(current).toBe(last.deviceState);
      }),
      { numRuns: 100 },
    );
  });
});
