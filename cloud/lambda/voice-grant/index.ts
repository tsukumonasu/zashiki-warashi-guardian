/**
 * `voice-grant` Lambda entry point. An IoT rule delivers `conversation.requested` and
 * `conversation.ended` events as the device envelope plus `topicDeviceId` (`topic(2)`). Thin glue
 * over `voice-grant-core.ts`.
 *
 * Environment variables (set by the CDK stack, never secrets):
 *   WARASHI_TABLE_NAME                    single table (read by the adapters)
 *   WARASHI_VOICE_SESSION_FUNCTION_NAME   the `voice-session` function to start asynchronously
 *   IOT_DATA_ENDPOINT                     read by the IoT bus adapter
 *   WARASHI_*                             tunable settings, see `_shared/voice/config.ts`
 *
 * The handler throws only when a store call fails, so IoT's asynchronous retry can run the event
 * again. Every other outcome, including a dropped event, returns normally.
 */

import { randomBytes, randomUUID } from "node:crypto";

import { log } from "../_shared/safelog.js";
import { loadVoiceConfig } from "../_shared/voice/config.js";
import { hashToken } from "../voice-authorizer/authorizer-core.js";
import { createDollBus } from "../voice-session/adapters/iot-doll-bus.js";
import { createSessionInvoker } from "../voice-session/adapters/lambda-invoker.js";
import { createVoiceStore } from "../voice-session/adapters/voice-dynamo.js";
import { handleVoiceEvent, type GrantDeps, type GrantOutcome } from "./voice-grant-core.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

function buildDeps(): GrantDeps {
  return {
    store: createVoiceStore(),
    bus: createDollBus(),
    invoker: createSessionInvoker({ functionName: requiredEnv("WARASHI_VOICE_SESSION_FUNCTION_NAME") }),
    cfg: loadVoiceConfig(process.env),
    now: Date.now,
    newId: randomUUID,
    newSecret: () => randomBytes(32).toString("base64url"),
    hashToken,
  };
}

// Module scope: invalid configuration or a missing variable fails the cold start.
const deps = buildDeps();

export async function handler(event: unknown): Promise<GrantOutcome> {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    log("voice_grant_dropped", { reason: "malformed" });
    return { kind: "dropped", reason: "malformed" };
  }
  const { topicDeviceId, ...envelope } = event as Record<string, unknown>;
  if (typeof topicDeviceId !== "string" || topicDeviceId === "") {
    log("voice_grant_dropped", { reason: "topic_device_mismatch", envelopeId: envelope["id"] });
    return { kind: "dropped", reason: "topic_device_mismatch" };
  }
  return handleVoiceEvent(topicDeviceId, JSON.stringify(envelope), deps);
}
