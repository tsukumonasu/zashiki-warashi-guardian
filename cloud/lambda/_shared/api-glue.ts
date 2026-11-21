/**
 * Shared glue of the API Lambdas (`api-read`, `api-simulate`, `api-admin`): API Gateway v2 event
 * to response. Pure: no AWS imports. Each handler passes its route table; this module does
 * `toHttpRequest` -> `rolesFromClaims` -> `authorize` -> route -> response.
 *
 * `authorize` runs before any route logic, so a `401` or `403` has no side effect and the route
 * function is never called. Routes throw `ApiError`; any other error becomes `500 internal`
 * with a fixed message and is logged by name only (never the message, which could hold data).
 *
 * Requirements: 13.1, 13.3, 13.6, 13.7, 13.8, 15.12, 17.1, 17.2.
 */

import { authorize, rolesFromClaims, type Role } from "./authz.js";
import {
  errorResponse,
  jsonResponse,
  noContentResponse,
  toErrorResponse,
  toHttpRequest,
  type ApiGatewayEventV2,
  type HttpRequest,
  type HttpResponse,
  type ResponseContext,
} from "./http.js";
import { log } from "./safelog.js";

/** What a route returns: a JSON body with a status, or `null` for `204 No Content`. */
export type RouteResult = { status: number; body: unknown } | null;

/** Everything a route needs about the verified caller. */
export interface RouteContext {
  request: HttpRequest;
  role: Role;
  /** Cognito `sub` claim, a non-empty string. */
  userSub: string;
  nowMs: number;
}

export type RouteFn = (context: RouteContext) => Promise<RouteResult>;

export interface ApiHandlerOptions {
  /** Route key such as `GET /me` to its function. Routes missing here are denied by `authorize`. */
  routes: Readonly<Record<string, RouteFn>>;
  /** The dashboard origin for CORS, or `null` when unset (no CORS header is then sent). */
  allowedOrigin: string | null;
  now: () => number;
}

/** Environment variable with the dashboard origin allowed by CORS (set by the CDK stack). */
export const WEB_ORIGIN_ENV = "WARASHI_WEB_ORIGIN";

/** Environment variable with the version of the face-registration consent notice. */
export const CONSENT_VERSION_ENV = "WARASHI_CONSENT_NOTICE_VERSION";
export const DEFAULT_CONSENT_VERSION = "1";

export function readWebOrigin(env: Readonly<Record<string, string | undefined>>): string | null {
  const value = env[WEB_ORIGIN_ENV];
  return value === undefined || value === "" ? null : value;
}

export function readConsentVersion(env: Readonly<Record<string, string | undefined>>): string {
  const value = env[CONSENT_VERSION_ENV];
  return value === undefined || value === "" ? DEFAULT_CONSENT_VERSION : value;
}

/** Shorthand for a `200` JSON result. */
export function ok(body: unknown): RouteResult {
  return { status: 200, body };
}

/** Builds the Lambda handler function for one route table. */
export function createApiHandler(options: ApiHandlerOptions): (event: ApiGatewayEventV2) => Promise<HttpResponse> {
  return async (event) => {
    const request = toHttpRequest(event);
    const response: ResponseContext = { requestOrigin: request.origin, allowedOrigin: options.allowedOrigin };

    // Claims come from the JWT authorizer. Without a subject there is no signed-in user.
    const sub = request.claims["sub"];
    if (typeof sub !== "string" || sub === "") {
      return errorResponse("unauthorized", "Sign in is required.", response);
    }
    const role = rolesFromClaims(request.claims);
    const route = options.routes[request.route];
    if (role === null || route === undefined || authorize(role, request.route) !== "allow") {
      return errorResponse("forbidden", "Not allowed.", response);
    }

    try {
      const result = await route({ request, role, userSub: sub, nowMs: options.now() });
      return result === null ? noContentResponse(response) : jsonResponse(result.status, result.body, response);
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      // Expected client errors are not logged; unexpected ones are, by error name only.
      if (name !== "ApiError") log("api.error", { route: request.route, errorName: name });
      return toErrorResponse(error, response);
    }
  };
}
