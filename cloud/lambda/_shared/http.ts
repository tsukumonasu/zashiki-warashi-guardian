/**
 * HTTP helpers shared by the API Lambdas: maps an API Gateway HTTP API (payload format 2.0)
 * event to a small request object, parses JSON bodies with a size limit, and builds JSON
 * responses with the error bodies, status codes and CORS rule of `docs/schema.md` ("HTTP API").
 *
 * Pure: no AWS SDK imports, no I/O, no clock. The role comes only from the token claims that
 * API Gateway verified, never from the body, the query or the headers.
 */

/** Largest request body the API accepts, in bytes (`docs/schema.md`, "Validation"). */
export const MAX_BODY_BYTES = 1_048_576;

/** Longest error message, in characters (`docs/schema.md`, "Errors"). */
export const MAX_ERROR_MESSAGE_CHARS = 200;

/** `Retry-After` is a whole number of seconds in this range (`docs/schema.md`, "Errors"). */
export const RETRY_AFTER_MIN_S = 1;
export const RETRY_AFTER_MAX_S = 86_400;

/** Error code to HTTP status, exactly as listed in `docs/schema.md`. */
export const ERROR_STATUS = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  consent_required: 409,
  face_count_invalid: 422,
  rate_limited: 429,
  internal: 500,
} as const;

export type ApiErrorCode = keyof typeof ERROR_STATUS;

/** The implemented error codes, exported so a test can compare them with `docs/schema.md`. */
export const ERROR_CODES: readonly ApiErrorCode[] = Object.keys(ERROR_STATUS) as ApiErrorCode[];

/** An error a route can throw; the handler turns it into an error response. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly retryAfterS: number | undefined;

  constructor(code: ApiErrorCode, message: string, retryAfterS?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.retryAfterS = retryAfterS;
  }
}

/** The request as the cores see it. Header names are lower case. */
export interface HttpRequest {
  /** Upper-case HTTP method. */
  method: string;
  /** Route key such as `GET /encounters/{id}`, as configured in the API (matches `RouteKey`). */
  route: string;
  /** Raw request path. */
  path: string;
  pathParameters: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Body text with base64 already decoded, or `null` when the request has no body. */
  body: string | null;
  /** Size of the body in bytes after decoding. */
  bodyBytes: number;
  /** Verified JWT claims. Empty when API Gateway passed none. */
  claims: Record<string, unknown>;
  /** The `Origin` header, or `null`. */
  origin: string | null;
}

/** The response a handler returns to API Gateway (payload format 2.0). */
export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** The parts of an API Gateway v2 event this module reads. Everything is optional on purpose. */
export interface ApiGatewayEventV2 {
  routeKey?: unknown;
  rawPath?: unknown;
  rawQueryString?: unknown;
  queryStringParameters?: unknown;
  pathParameters?: unknown;
  headers?: unknown;
  body?: unknown;
  isBase64Encoded?: unknown;
  requestContext?: {
    http?: { method?: unknown; path?: unknown };
    authorizer?: { jwt?: { claims?: unknown } };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keeps only string values, so a malformed event cannot inject other types. */
function stringMap(value: unknown, lowerCaseKeys: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[lowerCaseKeys ? key.toLowerCase() : key] = item;
  }
  return out;
}

/**
 * Maps an API Gateway HTTP API event to an `HttpRequest`. Never throws: a malformed event gives
 * empty fields, which the route table then denies. A body that is not valid base64 is kept as
 * text so `parseJsonBody` reports it as `validation_failed`.
 */
export function toHttpRequest(event: ApiGatewayEventV2): HttpRequest {
  const http = event?.requestContext?.http;
  const method = typeof http?.method === "string" ? http.method.toUpperCase() : "";
  const path =
    typeof http?.path === "string" ? http.path : typeof event?.rawPath === "string" ? event.rawPath : "";
  const route = typeof event?.routeKey === "string" ? event.routeKey : "";
  const headers = stringMap(event?.headers, true);

  let body: string | null = null;
  let bodyBytes = 0;
  if (typeof event?.body === "string") {
    if (event.isBase64Encoded === true) {
      const decoded = Buffer.from(event.body, "base64");
      bodyBytes = decoded.length;
      // Decode only within the limit; an oversize body is rejected by parseJsonBody anyway.
      body = bodyBytes <= MAX_BODY_BYTES ? decoded.toString("utf8") : "";
    } else {
      body = event.body;
      bodyBytes = Buffer.byteLength(body, "utf8");
    }
  }

  const rawClaims = event?.requestContext?.authorizer?.jwt?.claims;
  return {
    method,
    route,
    path,
    pathParameters: stringMap(event?.pathParameters, false),
    query: stringMap(event?.queryStringParameters, false),
    headers,
    body,
    bodyBytes,
    claims: isRecord(rawClaims) ? rawClaims : {},
    origin: headers["origin"] ?? null,
  };
}

/**
 * Parses the request body as a JSON object. Throws `ApiError("validation_failed")` for a body
 * over `MAX_BODY_BYTES`, malformed JSON, or JSON that is not an object. A missing or empty body
 * is an empty object, so routes with all-optional fields still work; routes check required
 * fields themselves.
 */
export function parseJsonBody(request: Pick<HttpRequest, "body" | "bodyBytes">): Record<string, unknown> {
  if (request.bodyBytes > MAX_BODY_BYTES) {
    throw new ApiError("validation_failed", "Request body is too large.");
  }
  if (request.body === null || request.body.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body);
  } catch {
    throw new ApiError("validation_failed", "Request body is not valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new ApiError("validation_failed", "Request body must be a JSON object.");
  }
  return parsed;
}

/**
 * Returns the CORS headers for a request. `Access-Control-Allow-Origin` is set only when the
 * request origin equals the configured web origin exactly; every other origin, a missing
 * origin or an unset web origin gets no CORS header at all.
 */
export function corsHeaders(requestOrigin: string | null, allowedOrigin: string | null): Record<string, string> {
  if (!requestOrigin || !allowedOrigin || requestOrigin !== allowedOrigin) return {};
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    Vary: "Origin",
  };
}

/** Per-response context: the request origin and the configured web origin. */
export interface ResponseContext {
  requestOrigin: string | null;
  allowedOrigin: string | null;
}

/** Builds a JSON response with CORS headers when the origin is allowed. */
export function jsonResponse(
  statusCode: number,
  body: unknown,
  context: ResponseContext,
  extraHeaders: Record<string, string> = {},
): HttpResponse {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(context.requestOrigin, context.allowedOrigin),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

/** A 204 response without a body (for example `DELETE /faces/{memberId}`). */
export function noContentResponse(context: ResponseContext): HttpResponse {
  return {
    statusCode: 204,
    headers: { ...corsHeaders(context.requestOrigin, context.allowedOrigin) },
    body: "",
  };
}

/**
 * Cleans an error message for the wire: removes URLs (they may be pre-signed), collapses
 * whitespace, and cuts the text to `MAX_ERROR_MESSAGE_CHARS` characters without splitting a
 * surrogate pair.
 */
export function safeMessage(message: string): string {
  const cleaned = message.replace(/https?:\/\/\S+/gi, "[url]").replace(/\s+/g, " ").trim();
  const chars = Array.from(cleaned);
  return chars.length <= MAX_ERROR_MESSAGE_CHARS ? cleaned : chars.slice(0, MAX_ERROR_MESSAGE_CHARS).join("");
}

/** Turns any number into a whole `Retry-After` from 1 to 86,400 seconds. */
export function clampRetryAfter(seconds: number): number {
  if (!Number.isFinite(seconds)) return RETRY_AFTER_MAX_S;
  return Math.min(RETRY_AFTER_MAX_S, Math.max(RETRY_AFTER_MIN_S, Math.ceil(seconds)));
}

/**
 * Builds the error response `{ "error": { "code", "message" } }`. `Retry-After` is added only
 * for `rate_limited`.
 */
export function errorResponse(
  code: ApiErrorCode,
  message: string,
  context: ResponseContext,
  retryAfterS?: number,
): HttpResponse {
  const extra: Record<string, string> = {};
  if (code === "rate_limited") extra["Retry-After"] = String(clampRetryAfter(retryAfterS ?? RETRY_AFTER_MIN_S));
  return jsonResponse(
    ERROR_STATUS[code],
    { error: { code, message: safeMessage(message) } },
    context,
    extra,
  );
}

/**
 * Maps a thrown value to an error response. An `ApiError` keeps its code and message; anything
 * else becomes `500 internal` with a fixed message, so internal details and secrets never
 * reach the client.
 */
export function toErrorResponse(error: unknown, context: ResponseContext): HttpResponse {
  if (error instanceof ApiError) {
    return errorResponse(error.code, error.message, context, error.retryAfterS);
  }
  return errorResponse("internal", "Internal error.", context);
}
