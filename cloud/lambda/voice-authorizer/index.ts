/**
 * `voice-authorizer` Lambda entry point: the AppSync Events Lambda authorizer. Thin glue over
 * `authorizer-core.ts`.
 *
 * Environment variables (set by the CDK stack, never secrets):
 *   WARASHI_TABLE_NAME   single table (read by the adapter)
 *
 * Fails closed: any error, including a store failure, answers "not authorized". Only the error
 * name is logged; the request holds the token, so it is never logged.
 */

import { log } from "../_shared/safelog.js";
import { createVoiceStore } from "../voice-session/adapters/voice-dynamo.js";
import { authorize, type AuthorizerRequest, type AuthorizerResponse } from "./authorizer-core.js";

// Module scope: a missing table name fails the cold start.
const store = createVoiceStore();

export async function handler(event: AuthorizerRequest): Promise<AuthorizerResponse> {
  try {
    return await authorize(event ?? {}, store, Date.now());
  } catch (err) {
    log("voice_authorizer_failed", { error: err instanceof Error ? err.name : "unknown" });
    return { isAuthorized: false, ttlOverride: 0 };
  }
}
