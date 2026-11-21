/**
 * Pure core of the AppSync Events Lambda authorizer (design, "Tokens" and "Channels and frames").
 *
 * A token is `<sessionId>.<secret>`. It is checked against the SHA-256 hashes on the session item
 * and pinned to that one session, to the channels and to the operations of its kind:
 *
 * - client token: publish `/voice/<sid>/in`; subscribe `/voice/<sid>/out` and `/voice/<sid>/text`
 * - observer token: subscribe `/voice/<sid>/text`
 *
 * `authorize` never logs and never returns the token. A store failure propagates to the handler,
 * which must answer "not authorized" (fail closed).
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type { SessionRecord } from "../_shared/voice/ports.js";

/** Same expression as the AppSync API token regex (`docs/schema.md`). */
export const TOKEN_REGEX = /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/;

/** Seconds AppSync may cache one answer. Short, so an ended session stops quickly. */
export const AUTH_TTL_SECONDS = 10;

const SESSION_ID_REGEX = /^[0-9a-f-]{36}$/;
const NAMESPACE = "voice";

/** The fields of the AppSync authorizer event that the core reads. */
export interface AuthorizerRequest {
  readonly authorizationToken?: string | null;
  readonly requestContext?: {
    readonly operation?: string | null;
    readonly channelNamespaceName?: string | null;
    readonly channel?: string | null;
  } | null;
}

export interface AuthorizerResponse {
  readonly isAuthorized: boolean;
  readonly ttlOverride: number;
}

/** The one store call the authorizer needs. */
export interface AuthorizerStore {
  getSession(sessionId: string): Promise<SessionRecord | null>;
}

const DENY: AuthorizerResponse = { isAuthorized: false, ttlOverride: 0 };

/** SHA-256 of the whole token, lowercase hex. Shared by the code that stores the hash. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests. Different lengths are simply unequal. */
function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

type TokenKind = "client" | "observer";

function tokenKind(rec: SessionRecord, tokenHash: string): TokenKind | null {
  // Evaluate both comparisons so timing does not reveal which one matched.
  const isClient = hashesEqual(tokenHash, rec.clientTokenHash);
  const isObserver = rec.observerTokenHash !== null && hashesEqual(tokenHash, rec.observerTokenHash);
  if (isClient) return "client";
  if (isObserver) return "observer";
  return null;
}

/** `/voice/<sid>/<leaf>` for the given session only. Wildcards and extra segments give `null`. */
function leafOf(channel: string, sessionId: string): "in" | "out" | "text" | null {
  const parts = channel.split("/");
  // A leading slash is allowed: "/voice/<sid>/in" splits into ["", "voice", sid, "in"].
  const segs = parts[0] === "" ? parts.slice(1) : parts;
  if (segs.length !== 3) return null;
  const [ns, sid, leaf] = segs;
  if (ns !== NAMESPACE || sid !== sessionId) return null;
  if (leaf === "in" || leaf === "out" || leaf === "text") return leaf;
  return null;
}

function allow(): AuthorizerResponse {
  return { isAuthorized: true, ttlOverride: AUTH_TTL_SECONDS };
}

export async function authorize(
  request: AuthorizerRequest,
  store: AuthorizerStore,
  nowMs: number,
): Promise<AuthorizerResponse> {
  const token = request.authorizationToken;
  if (typeof token !== "string" || !TOKEN_REGEX.test(token)) return DENY;

  const operation = request.requestContext?.operation;
  if (operation !== "EVENT_CONNECT" && operation !== "EVENT_SUBSCRIBE" && operation !== "EVENT_PUBLISH") {
    return DENY;
  }

  const sessionId = token.slice(0, token.indexOf("."));
  if (!SESSION_ID_REGEX.test(sessionId)) return DENY;

  const rec = await store.getSession(sessionId);
  if (rec === null || rec.sessionId !== sessionId) return DENY;
  if (rec.phase !== "starting" && rec.phase !== "live") return DENY;
  if (!(rec.expiresAt > nowMs)) return DENY;

  const kind = tokenKind(rec, hashToken(token));
  if (kind === null) return DENY;

  // The connection itself carries no channel; the channel rules apply to subscribe and publish.
  if (operation === "EVENT_CONNECT") return allow();

  const ctx = request.requestContext;
  if (ctx?.channelNamespaceName !== undefined && ctx?.channelNamespaceName !== null) {
    if (ctx.channelNamespaceName !== NAMESPACE) return DENY;
  }
  const channel = ctx?.channel;
  if (typeof channel !== "string") return DENY;
  const leaf = leafOf(channel, sessionId);
  if (leaf === null) return DENY;

  if (operation === "EVENT_PUBLISH") {
    return kind === "client" && leaf === "in" ? allow() : DENY;
  }
  // EVENT_SUBSCRIBE
  if (kind === "client") return leaf === "out" || leaf === "text" ? allow() : DENY;
  return leaf === "text" ? allow() : DENY;
}
