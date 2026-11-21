// Unit tests for the shared HTTP helpers (R13.9, R13.10, R13.11) and the error half of R24.16.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ApiError,
  ERROR_CODES,
  ERROR_STATUS,
  MAX_BODY_BYTES,
  MAX_ERROR_MESSAGE_CHARS,
  clampRetryAfter,
  corsHeaders,
  errorResponse,
  jsonResponse,
  noContentResponse,
  parseJsonBody,
  safeMessage,
  toErrorResponse,
  toHttpRequest,
  type ApiErrorCode,
  type ResponseContext,
} from "../lambda/_shared/http.js";

const SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs/schema.md");
const ORIGIN = "https://dashboard.example.invalid";
const ctx: ResponseContext = { requestOrigin: ORIGIN, allowedOrigin: ORIGIN };

/** Reads the `code` (status) pairs of the "Errors" bullet in docs/schema.md. */
function parseSchemaErrors(markdown: string): Map<string, number> {
  const start = markdown.indexOf("- **Errors.**");
  expect(start, "docs/schema.md has an 'Errors' bullet").toBeGreaterThanOrEqual(0);
  const rest = markdown.slice(start + 3);
  const end = rest.indexOf("\n- **");
  const bullet = end < 0 ? rest : rest.slice(0, end);
  const codes = new Map<string, number>();
  for (const m of bullet.matchAll(/`([a-z_]+)` \((\d{3})/g)) codes.set(m[1] as string, Number(m[2]));
  return codes;
}

/** Lists each code missing from, or extra in, the implementation compared with the document. */
function diffErrors(implemented: Map<string, number>, documented: Map<string, number>): string[] {
  const problems: string[] = [];
  for (const [code, status] of documented) {
    if (!implemented.has(code)) problems.push(`missing error code: ${code}`);
    else if (implemented.get(code) !== status) problems.push(`wrong status for ${code}`);
  }
  for (const code of implemented.keys()) {
    if (!documented.has(code)) problems.push(`extra error code: ${code}`);
  }
  return problems;
}

describe("error codes equal docs/schema.md (R24.16, error half)", () => {
  const documented = parseSchemaErrors(readFileSync(SCHEMA_PATH, "utf8"));
  const implemented = new Map<string, number>(Object.entries(ERROR_STATUS));

  it("matches the documented list exactly", () => {
    expect(documented.size).toBe(8);
    expect(diffErrors(implemented, documented)).toEqual([]);
    expect([...ERROR_CODES].sort()).toEqual([...documented.keys()].sort());
  });

  it("names a missing and an extra code", () => {
    const fewer = new Map(implemented);
    fewer.delete("internal");
    fewer.set("teapot", 418);
    expect(diffErrors(fewer, documented)).toEqual(["missing error code: internal", "extra error code: teapot"]);
  });
});

describe("errorResponse", () => {
  it.each(Object.entries(ERROR_STATUS) as [ApiErrorCode, number][])("%s gives status %i", (code, status) => {
    const res = errorResponse(code, "Something happened.", ctx);
    expect(res.statusCode).toBe(status);
    expect(JSON.parse(res.body)).toEqual({ error: { code, message: "Something happened." } });
    expect(res.headers["Content-Type"]).toContain("application/json");
  });

  it("adds Retry-After only for rate_limited, as a whole number from 1 to 86,400", () => {
    expect(errorResponse("rate_limited", "Slow down.", ctx, 12.2).headers["Retry-After"]).toBe("13");
    expect(errorResponse("rate_limited", "Slow down.", ctx).headers["Retry-After"]).toBe("1");
    expect(errorResponse("internal", "x", ctx, 5).headers["Retry-After"]).toBeUndefined();
  });

  it("clamps Retry-After", () => {
    expect(clampRetryAfter(0)).toBe(1);
    expect(clampRetryAfter(-5)).toBe(1);
    expect(clampRetryAfter(1e9)).toBe(86_400);
    expect(clampRetryAfter(Number.NaN)).toBe(86_400);
    expect(clampRetryAfter(Infinity)).toBe(86_400);
  });
});

describe("safeMessage (R13.10)", () => {
  it("cuts long messages to 200 characters", () => {
    expect(Array.from(safeMessage("a".repeat(500)))).toHaveLength(MAX_ERROR_MESSAGE_CHARS);
    expect(safeMessage("a".repeat(200))).toHaveLength(200);
  });

  it("does not split a surrogate pair", () => {
    const out = safeMessage("😀".repeat(300));
    expect(Array.from(out)).toHaveLength(200);
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("removes URLs and collapses whitespace", () => {
    const out = safeMessage("Failed  to read\n https://bucket.example.invalid/key?X-Amz-Signature=abc now");
    expect(out).toBe("Failed to read [url] now");
    expect(out).not.toContain("Signature");
  });

  it("truncates the message inside an error response", () => {
    const body = JSON.parse(errorResponse("validation_failed", "x".repeat(1000), ctx).body);
    expect(body.error.message).toHaveLength(200);
  });
});

describe("toErrorResponse", () => {
  it("keeps the code, message and retry time of an ApiError", () => {
    const res = toErrorResponse(new ApiError("rate_limited", "Too many.", 30), ctx);
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBe("30");
    expect(JSON.parse(res.body).error).toEqual({ code: "rate_limited", message: "Too many." });
  });

  it("hides the details of any other error", () => {
    const res = toErrorResponse(new Error("secret table arn:aws:dynamodb"), ctx);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("secret");
    expect(JSON.parse(res.body).error.code).toBe("internal");
    expect(toErrorResponse("boom", ctx).statusCode).toBe(500);
  });
});

describe("parseJsonBody (R13.9)", () => {
  const req = (body: string | null, bodyBytes = body === null ? 0 : Buffer.byteLength(body)) => ({ body, bodyBytes });

  it("parses an object", () => {
    expect(parseJsonBody(req('{"a":1}'))).toEqual({ a: 1 });
  });

  it("treats a missing or blank body as an empty object", () => {
    expect(parseJsonBody(req(null))).toEqual({});
    expect(parseJsonBody(req("  \n"))).toEqual({});
  });

  it.each(["{not json", "[1,2]", "null", "42", '"text"'])("rejects %s with validation_failed", (text) => {
    expect(() => parseJsonBody(req(text))).toThrowError(ApiError);
    try {
      parseJsonBody(req(text));
    } catch (e) {
      expect((e as ApiError).code).toBe("validation_failed");
    }
  });

  it("accepts exactly the size limit and rejects one byte more", () => {
    expect(parseJsonBody(req("{}", MAX_BODY_BYTES))).toEqual({});
    expect(() => parseJsonBody(req("{}", MAX_BODY_BYTES + 1))).toThrowError(/too large/);
  });
});

describe("toHttpRequest", () => {
  it("maps an API Gateway v2 event", () => {
    const r = toHttpRequest({
      routeKey: "GET /encounters/{id}",
      rawPath: "/encounters/abc",
      headers: { Origin: ORIGIN, Authorization: "Bearer t" },
      pathParameters: { id: "abc" },
      queryStringParameters: { limit: "5", bad: 7 },
      requestContext: {
        http: { method: "get", path: "/encounters/abc" },
        authorizer: { jwt: { claims: { "cognito:groups": ["family"] } } },
      },
    });
    expect(r).toMatchObject({
      method: "GET",
      route: "GET /encounters/{id}",
      path: "/encounters/abc",
      pathParameters: { id: "abc" },
      query: { limit: "5" },
      origin: ORIGIN,
      body: null,
      bodyBytes: 0,
      claims: { "cognito:groups": ["family"] },
    });
    expect(r.headers["authorization"]).toBe("Bearer t");
  });

  it("never throws on a malformed event", () => {
    const r = toHttpRequest({ routeKey: 5, headers: "x", requestContext: { authorizer: { jwt: { claims: [] } } } });
    expect(r).toMatchObject({ method: "", route: "", path: "", claims: {}, origin: null });
    expect(() => toHttpRequest(undefined as never)).not.toThrow();
  });

  it("decodes a base64 body and counts bytes after decoding", () => {
    const text = '{"name":"é"}';
    const r = toHttpRequest({ body: Buffer.from(text).toString("base64"), isBase64Encoded: true });
    expect(r.body).toBe(text);
    expect(r.bodyBytes).toBe(Buffer.byteLength(text));
  });

  it("reports an oversize body by its size", () => {
    const big = "a".repeat(MAX_BODY_BYTES + 1);
    const r = toHttpRequest({ body: big });
    expect(r.bodyBytes).toBe(MAX_BODY_BYTES + 1);
    expect(() => parseJsonBody(r)).toThrowError(ApiError);
    const b64 = toHttpRequest({ body: Buffer.from(big).toString("base64"), isBase64Encoded: true });
    expect(b64.bodyBytes).toBe(MAX_BODY_BYTES + 1);
    expect(() => parseJsonBody(b64)).toThrowError(ApiError);
  });
});

describe("CORS (R13.11)", () => {
  it("allows only the exact configured origin", () => {
    const h = corsHeaders(ORIGIN, ORIGIN);
    expect(h["Access-Control-Allow-Origin"]).toBe(ORIGIN);
    expect(h["Vary"]).toBe("Origin");
  });

  it.each([
    ["another origin", "https://evil.example.invalid", ORIGIN],
    ["a prefix of the origin", ORIGIN + ".evil", ORIGIN],
    ["no request origin", null, ORIGIN],
    ["no configured origin", ORIGIN, null],
    ["an empty configured origin", ORIGIN, ""],
  ])("sets no CORS header for %s", (_name, requestOrigin, allowedOrigin) => {
    expect(corsHeaders(requestOrigin, allowedOrigin)).toEqual({});
  });

  it("applies to success, error and 204 responses, and denies others", () => {
    const denied: ResponseContext = { requestOrigin: "https://evil.example.invalid", allowedOrigin: ORIGIN };
    for (const res of [
      jsonResponse(200, {}, ctx),
      errorResponse("forbidden", "No.", ctx),
      noContentResponse(ctx),
    ]) {
      expect(res.headers["Access-Control-Allow-Origin"]).toBe(ORIGIN);
    }
    for (const res of [
      jsonResponse(200, {}, denied),
      errorResponse("forbidden", "No.", denied),
      noContentResponse(denied),
    ]) {
      expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    }
    expect(noContentResponse(ctx)).toMatchObject({ statusCode: 204, body: "" });
  });
});
