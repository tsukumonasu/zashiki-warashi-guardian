/**
 * `judge` Lambda entry point. Thin glue: builds the real adapters once per container, validates
 * the configuration at start (R5.16) and hands each IoT rule event to `handleSnapshot`.
 * No decisions are made here; they live in `judge-core.ts`.
 *
 * Environment variables (set by the CDK stack, never secrets):
 *   WARASHI_TABLE_NAME, WARASHI_BUCKET_NAME, IOT_DATA_ENDPOINT, NOTIFY_TOPIC_ARN  (read by the adapters)
 *   WARASHI_DASHBOARD_URL            dashboard address placed in the stranger notification (required)
 *   WARASHI_HOUSEHOLD_COLLECTION_ID  Rekognition collection, default `warashi-household`
 *   WARASHI_DEVICE_LABEL             optional label used in notifications, default is the device id
 *   WARASHI_*                        tunable settings, see `_shared/config.ts`
 *
 * The handler throws only when the claim write fails (R4.5), so the message can be redelivered.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as sleepMs } from "node:timers/promises";

import { createStateStore, createRepository } from "../_shared/adapters/dynamo.js";
import { createIotBus } from "../_shared/adapters/iot-bus.js";
import { createRekognitionFaceSearch } from "../_shared/adapters/rekognition.js";
import { createSampleSource, createSnapshotStore } from "../_shared/adapters/s3.js";
import { createSnsNotifier } from "../_shared/adapters/sns.js";
import { loadConfig } from "../_shared/config.js";
import { handleSnapshot } from "./judge-core.js";
import type { JudgeDeps, JudgeResult, SnapshotEvent } from "./judge-core.js";
import { createLookStore } from "./look-store.js";

const DEFAULT_COLLECTION_ID = "warashi-household";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

function buildDeps(): JudgeDeps {
  const config = loadConfig(process.env);
  const dashboardUrl = requiredEnv("WARASHI_DASHBOARD_URL");
  const collectionId = process.env["WARASHI_HOUSEHOLD_COLLECTION_ID"] || DEFAULT_COLLECTION_ID;
  const fixedLabel = process.env["WARASHI_DEVICE_LABEL"];

  return {
    looks: createLookStore(),
    faces: createRekognitionFaceSearch(),
    snapshots: createSnapshotStore(),
    bus: createIotBus(),
    notifier: createSnsNotifier(),
    state: createStateStore(),
    repository: createRepository({ samples: createSampleSource() }),
    config,
    collectionId,
    deviceLabel: (deviceId) => (fixedLabel ? fixedLabel : deviceId),
    dashboardUrl,
    now: Date.now,
    random: Math.random,
    newId: randomUUID,
    sleep: (ms) => sleepMs(ms),
  };
}

// Module scope: invalid configuration fails the cold start instead of every invocation.
const deps = buildDeps();

export async function handler(event: SnapshotEvent): Promise<JudgeResult> {
  return handleSnapshot(event, deps);
}
