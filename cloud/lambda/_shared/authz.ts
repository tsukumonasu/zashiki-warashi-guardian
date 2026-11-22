/**
 * Authorization: maps Cognito group claims to a role and checks a route against the role matrix
 * in `docs/schema.md` ("HTTP API", "Role matrix"). Pure: no AWS imports, no I/O.
 *
 * Deny by default. A missing role, an unknown route string or an unexpected claim shape all
 * give "deny" (or `null` for the role), never an exception.
 */

export type Role = "family" | "reviewer";

export type RouteKey =
  | "GET /me"
  | "GET /samples"
  | "GET /encounters"
  | "GET /encounters/{id}"
  | "GET /device/status"
  | "POST /simulate"
  | "POST /commands"
  | "POST /photos"
  | "GET /photos/{requestId}"
  | "POST /say"
  | "GET /faces"
  | "POST /faces/upload"
  | "POST /faces"
  | "DELETE /faces/{memberId}"
  | "POST /conversations"
  | "GET /conversations/{sessionId}"
  | "DELETE /conversations/{sessionId}";

/** Routes the `family` role may call: every route of the role matrix. */
const FAMILY_ROUTES: ReadonlySet<string> = new Set<RouteKey>([
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
]);

/** Routes the `reviewer` role may call: read-only routes and the simulation. No doll control, no faces. */
const REVIEWER_ROUTES: ReadonlySet<string> = new Set<RouteKey>([
  "GET /me",
  "GET /samples",
  "GET /encounters",
  "GET /encounters/{id}",
  "GET /device/status",
  "POST /simulate",
  // Role rules (reviewer only when `reviewerVoiceEnabled`, owner-only reads) live in voice-start-core.
  "POST /conversations",
  "GET /conversations/{sessionId}",
  "DELETE /conversations/{sessionId}",
]);

/** The route table, exported so tests can compare it with the role matrix. */
export const ROUTE_TABLE: Readonly<Record<Role, ReadonlySet<string>>> = {
  family: FAMILY_ROUTES,
  reviewer: REVIEWER_ROUTES,
};

/**
 * Turns the `cognito:groups` claim into a list of group names. Accepts an array of strings or a
 * string such as `"family"`, `"[family reviewer]"` or `"family,reviewer"`, because API Gateway
 * may pass an array claim to the Lambda as a string. Anything else gives an empty list.
 */
function parseGroups(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((g): g is string => typeof g === "string");
  }
  if (typeof value === "string") {
    return value.split(/[\s,[\]"']+/).filter((g) => g.length > 0);
  }
  return [];
}

/** Returns the role for the claims. `reviewer` wins when both groups are present (least privilege). */
export function rolesFromClaims(claims: Record<string, unknown>): Role | null {
  const groups = parseGroups(claims?.["cognito:groups"]);
  if (groups.includes("reviewer")) return "reviewer";
  if (groups.includes("family")) return "family";
  return null;
}

/** Allows a route only when the role's set contains that exact string. Unknown routes are denied. */
export function authorize(role: Role | null, route: string): "allow" | "deny" {
  if (role !== "family" && role !== "reviewer") return "deny";
  return ROUTE_TABLE[role].has(route) ? "allow" : "deny";
}
