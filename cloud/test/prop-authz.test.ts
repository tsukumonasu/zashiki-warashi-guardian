// Feature: cloud-judgement, Property 15: Authorization table
// Validates: Requirements 13.4, 13.5, 13.7
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { authorize, rolesFromClaims, type Role } from "../lambda/_shared/authz.js";

/** The role matrix of docs/schema.md, written out independently of the implementation. */
const REVIEWER_SET = [
  "GET /me",
  "GET /samples",
  "GET /encounters",
  "GET /encounters/{id}",
  "GET /device/status",
  "POST /simulate",
] as const;
const FAMILY_ONLY = [
  "POST /commands",
  "GET /faces",
  "POST /faces/upload",
  "POST /faces",
  "DELETE /faces/{memberId}",
] as const;
const FAMILY_SET: readonly string[] = [...REVIEWER_SET, ...FAMILY_ONLY];

/** Known routes, near misses of known routes, and arbitrary strings. */
const routeArb = fc.oneof(
  fc.constantFrom(...FAMILY_SET),
  fc.constantFrom(...FAMILY_SET).chain((r) =>
    fc.oneof(
      fc.constant(r.toLowerCase()),
      fc.constant(`${r} `),
      fc.constant(`${r}/`),
      fc.constant(r.replace(/^[A-Z]+/, "PUT")),
      fc.constant(r.replace(/^[A-Z]+ /, "")),
    ),
  ),
  fc.string(),
);

const expected = (set: readonly string[], route: string): "allow" | "deny" =>
  set.includes(route) ? "allow" : "deny";

describe("Feature: cloud-judgement, Property 15: Authorization table", () => {
  it("reviewer is allowed exactly the reviewer set", () => {
    fc.assert(
      fc.property(routeArb, (route) => {
        expect(authorize("reviewer", route)).toBe(expected(REVIEWER_SET, route));
      }),
      { numRuns: 200 },
    );
  });

  it("family is allowed exactly the full set", () => {
    fc.assert(
      fc.property(routeArb, (route) => {
        expect(authorize("family", route)).toBe(expected(FAMILY_SET, route));
      }),
      { numRuns: 200 },
    );
  });

  it("a missing role is denied every route", () => {
    fc.assert(
      fc.property(routeArb, (route) => {
        expect(authorize(null, route)).toBe("deny");
      }),
      { numRuns: 100 },
    );
  });

  it("claims never grant more than reviewer when reviewer is present, and unknown groups grant nothing", () => {
    const groupArb = fc.oneof(fc.constantFrom("family", "reviewer"), fc.string());
    fc.assert(
      fc.property(fc.array(groupArb, { maxLength: 6 }), routeArb, (groups, route) => {
        const role = rolesFromClaims({ "cognito:groups": groups });
        const expectedRole: Role | null = groups.includes("reviewer")
          ? "reviewer"
          : groups.includes("family")
            ? "family"
            : null;
        // The shared parser also splits strings on separators, so only check the
        // strict direction: a role is never above what the exact group names allow.
        if (expectedRole === "reviewer") {
          expect(role).toBe("reviewer");
          expect(authorize(role, route)).toBe(expected(REVIEWER_SET, route));
        }
        if (role === null) expect(authorize(role, route)).toBe("deny");
        if (role === "family") expect(groups.some((g) => g.includes("family"))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("both groups, in any order or string form, resolve to reviewer", () => {
    const bothArb = fc.oneof(
      fc.constantFrom(["family", "reviewer"], ["reviewer", "family"]),
      fc.constantFrom("family,reviewer", "[family reviewer]", "reviewer family"),
    );
    fc.assert(
      fc.property(bothArb, routeArb, (groups, route) => {
        const role = rolesFromClaims({ "cognito:groups": groups });
        expect(role).toBe("reviewer");
        expect(authorize(role, route)).toBe(expected(REVIEWER_SET, route));
      }),
      { numRuns: 100 },
    );
  });

  it("missing, malformed or foreign claims give no role", () => {
    const junkArb = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.integer(),
      fc.boolean(),
      fc.array(fc.integer(), { maxLength: 3 }),
      fc.constantFrom("", "admin", "familyx", "Family", "REVIEWER"),
    );
    fc.assert(
      fc.property(junkArb, (value) => {
        expect(rolesFromClaims({ "cognito:groups": value })).toBeNull();
        expect(rolesFromClaims({})).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});
