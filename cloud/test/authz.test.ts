// Unit tests for the authorizer (R13.4, R13.5, R13.7) and the route half of R24.16.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { authorize, ROUTE_TABLE, rolesFromClaims, type Role } from "../lambda/_shared/authz.js";

const SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs/schema.md");

type Matrix = Record<Role, Set<string>>;

/** Reads the "Role matrix" table of the "HTTP API" section of docs/schema.md. */
function parseRoleMatrix(markdown: string): Matrix {
  const start = markdown.indexOf("## HTTP API");
  expect(start, "docs/schema.md has an 'HTTP API' section").toBeGreaterThanOrEqual(0);
  const section = markdown.slice(start);
  const matrix: Matrix = { family: new Set(), reviewer: new Set() };
  let inTable = false;
  for (const line of section.split("\n")) {
    if (/^\| Route \| F \| R \|/.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith("|")) break;
    const cells = line.split("|").map((c) => c.trim());
    const m = /^`([A-Z]+ \S+)`$/.exec(cells[1] ?? "");
    if (!m?.[1]) continue; // separator row
    if (cells[2] !== "no") matrix.family.add(m[1]);
    if (cells[3] !== "no") matrix.reviewer.add(m[1]);
  }
  return matrix;
}

/** Lists each route missing from, or extra in, the table compared with the matrix. */
function diffRoutes(table: Matrix, matrix: Matrix): string[] {
  const problems: string[] = [];
  for (const role of ["family", "reviewer"] as const) {
    for (const r of matrix[role]) {
      if (!table[role].has(r)) problems.push(`missing route for ${role}: ${r}`);
    }
    for (const r of table[role]) {
      if (!matrix[role].has(r)) problems.push(`extra route for ${role}: ${r}`);
    }
  }
  return problems;
}

const ALL_ROUTES = [
  "GET /me",
  "GET /samples",
  "GET /encounters",
  "GET /encounters/{id}",
  "GET /device/status",
  "POST /simulate",
  "POST /commands",
  "POST /photos",
  "GET /photos/{requestId}",
  "POST /say",
  "GET /faces",
  "POST /faces/upload",
  "POST /faces",
  "DELETE /faces/{memberId}",
  "POST /conversations",
  "GET /conversations/{sessionId}",
  "DELETE /conversations/{sessionId}",
];
const REVIEWER_DENIED = [
  "POST /commands",
  "POST /photos",
  "GET /photos/{requestId}",
  "POST /say",
  "GET /faces",
  "POST /faces/upload",
  "POST /faces",
  "DELETE /faces/{memberId}",
];

describe("rolesFromClaims (R13.4, R13.5)", () => {
  const cases: Array<[string, Record<string, unknown>, Role | null]> = [
    ["array with family", { "cognito:groups": ["family"] }, "family"],
    ["array with reviewer", { "cognito:groups": ["reviewer"] }, "reviewer"],
    ["string family", { "cognito:groups": "family" }, "family"],
    ["bracketed string with both groups", { "cognito:groups": "[family reviewer]" }, "reviewer"],
    ["bracketed string, reviewer first", { "cognito:groups": "[reviewer family]" }, "reviewer"],
    ["comma separated string", { "cognito:groups": "family,reviewer" }, "reviewer"],
    ["array with both groups", { "cognito:groups": ["family", "reviewer"] }, "reviewer"],
    ["claim absent", {}, null],
    ["empty array", { "cognito:groups": [] }, null],
    ["empty string", { "cognito:groups": "" }, null],
    ["unknown group", { "cognito:groups": ["admin"] }, null],
    ["unknown group string", { "cognito:groups": "[admin]" }, null],
    ["family-like substring", { "cognito:groups": "familyx" }, null],
    ["non-string claim", { "cognito:groups": 42 }, null],
    ["array of non-strings", { "cognito:groups": [1, null] }, null],
    ["unknown group next to family", { "cognito:groups": ["admin", "family"] }, "family"],
  ];
  it.each(cases)("%s", (_name, claims, expected) => {
    expect(rolesFromClaims(claims)).toBe(expected);
  });

  it("ignores role hints outside cognito:groups", () => {
    expect(rolesFromClaims({ role: "family", groups: ["family"] })).toBeNull();
  });
});

describe("authorize (R13.7)", () => {
  it.each(ALL_ROUTES)("family may call %s", (route) => {
    expect(authorize("family", route)).toBe("allow");
  });

  it.each(ALL_ROUTES)("reviewer on %s", (route) => {
    const expected = REVIEWER_DENIED.includes(route) ? "deny" : "allow";
    expect(authorize("reviewer", route)).toBe(expected);
  });

  it("denies every route when there is no role", () => {
    for (const route of ALL_ROUTES) expect(authorize(null, route)).toBe("deny");
  });

  it("denies a route that is not in the matrix for both roles", () => {
    for (const route of [
      "GET /unknown",
      "DELETE /encounters/{id}",
      "get /me",
      "GET /me/",
      "GET /faces/{memberId}",
      "",
    ]) {
      expect(authorize("family", route)).toBe("deny");
      expect(authorize("reviewer", route)).toBe("deny");
    }
  });

  it("denies an unexpected role value", () => {
    expect(authorize("admin" as unknown as Role, "GET /me")).toBe("deny");
  });
});

describe("route table equals the role matrix of docs/schema.md (R24.16)", () => {
  const matrix = parseRoleMatrix(readFileSync(SCHEMA_PATH, "utf8"));

  it("parses the matrix", () => {
    expect(matrix.family.size).toBe(ALL_ROUTES.length);
    expect(matrix.reviewer.size).toBe(ALL_ROUTES.length - REVIEWER_DENIED.length);
  });

  it("has no missing or extra route", () => {
    const table: Matrix = {
      family: new Set(ROUTE_TABLE.family),
      reviewer: new Set(ROUTE_TABLE.reviewer),
    };
    expect(diffRoutes(table, matrix)).toEqual([]);
  });

  it("names each missing and extra route", () => {
    const table: Matrix = {
      family: new Set([...matrix.family].filter((r) => r !== "GET /faces")),
      reviewer: new Set([...matrix.reviewer, "POST /commands"]),
    };
    expect(diffRoutes(table, matrix)).toEqual([
      "missing route for family: GET /faces",
      "extra route for reviewer: POST /commands",
    ]);
  });
});
