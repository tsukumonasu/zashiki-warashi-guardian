/**
 * `voice-start` Lambda entry point: `POST /conversations`, `GET /conversations/{sessionId}` and
 * `DELETE /conversations/{sessionId}`. Thin glue over `voice-start-core.ts`; the shared API glue
 * checks the Cognito claims and the role matrix first, and the core applies the finer rules
 * (reviewer only with `reviewerVoiceEnabled`, owner-only reads and deletes).
 *
 * Environment variables (set by the CDK stack, never secrets):
 *   WARASHI_TABLE_NAME                    single table (read by the adapters)
 *   WARASHI_VOICE_SESSION_FUNCTION_NAME   the `voice-session` function to start asynchronously
 *   WARASHI_VOICE_HTTP_HOST               AppSync Events HTTP host
 *   WARASHI_VOICE_REALTIME_HOST           AppSync Events real-time host
 *   IOT_DATA_ENDPOINT                     read by the IoT bus adapter
 *   WARASHI_WEB_ORIGIN                    dashboard origin for CORS
 *   WARASHI_*                             tunable settings, see `_shared/config.ts` and `_shared/voice/config.ts`
 *
 * Tokens are returned to the caller in the response body only; nothing here logs a body.
 */

import { randomBytes, randomUUID } from "node:crypto";

import {
  createApiHandler,
  readWebOrigin,
  type RouteContext,
  type RouteFn,
  type RouteResult,
} from "../_shared/api-glue.js";
import { loadConfig } from "../_shared/config.js";
import { ApiError, parseJsonBody, type ApiErrorCode } from "../_shared/http.js";
import { loadVoiceConfig } from "../_shared/voice/config.js";
import { createDollBus } from "../voice-session/adapters/iot-doll-bus.js";
import { createSessionInvoker } from "../voice-session/adapters/lambda-invoker.js";
import {
  createDeviceOnline,
  createHealthStore,
  createReadCounter,
  createVoiceStore,
} from "../voice-session/adapters/voice-dynamo.js";
import {
  deleteConversation,
  getConversation,
  startConversation,
  type Caller,
  type HttpResult,
  type StartDeps,
} from "./voice-start-core.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

function buildDeps(): StartDeps {
  const cloud = loadConfig(process.env);
  return {
    store: createVoiceStore(),
    bus: createDollBus(),
    invoker: createSessionInvoker({ functionName: requiredEnv("WARASHI_VOICE_SESSION_FUNCTION_NAME") }),
    health: createHealthStore(),
    cfg: loadVoiceConfig(process.env),
    readCounter: createReadCounter(),
    deviceOnline: createDeviceOnline(cloud.statusIntervalS),
    hosts: { http: requiredEnv("WARASHI_VOICE_HTTP_HOST"), realtime: requiredEnv("WARASHI_VOICE_REALTIME_HOST") },
    now: Date.now,
    newId: randomUUID,
    newSecret: () => randomBytes(32).toString("base64url"),
  };
}

// Module scope: invalid configuration or a missing variable fails the cold start.
const deps = buildDeps();

/** Turns the core's result into a route result; an error body becomes an `ApiError`. */
function toRouteResult(result: HttpResult): RouteResult {
  if (result.status >= 400) {
    const error = (result.body as { error: { code: ApiErrorCode; message: string } }).error;
    throw new ApiError(error.code, error.message, result.retryAfterS);
  }
  return result.status === 204 ? null : { status: result.status, body: result.body };
}

const caller = ({ role, userSub }: RouteContext): Caller => ({ sub: userSub, role });

const routes: Record<string, RouteFn> = {
  "POST /conversations": async (ctx) =>
    toRouteResult(await startConversation(caller(ctx), parseJsonBody(ctx.request), deps)),
  "GET /conversations/{sessionId}": async (ctx) =>
    toRouteResult(await getConversation(caller(ctx), ctx.request.pathParameters["sessionId"] ?? "", deps)),
  "DELETE /conversations/{sessionId}": async (ctx) =>
    toRouteResult(await deleteConversation(caller(ctx), ctx.request.pathParameters["sessionId"] ?? "", deps)),
};

export const handler = createApiHandler({ routes, allowedOrigin: readWebOrigin(process.env), now: Date.now });
