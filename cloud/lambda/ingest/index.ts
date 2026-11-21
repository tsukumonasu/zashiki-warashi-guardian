/**
 * Lambda entry point of `ingest` (cloud-judgement design, Lambda table; Requirements 4.5, 10.10).
 *
 * Thin wiring only: the adapters are built once at module scope and `handleIngest` makes every
 * decision. `IngestWriteError` is not caught, so the invocation fails and Lambda's asynchronous
 * retry can deliver the message again.
 */

import { createRepository, createStateStore } from "../_shared/adapters/dynamo.js";
import type { SampleSource } from "../_shared/adapters/s3.js";
import { handleIngest } from "./ingest-core.js";
import type { IngestResult } from "./ingest-core.js";

/**
 * Ingest never reads samples and has no S3 permission (design, Lambda table), so the sample
 * source refuses every call instead of reaching for a bucket.
 */
const noSamples: SampleSource = {
  getSampleManifest: () => Promise.reject(new Error("samples are not available to ingest")),
  getSampleImage: () => Promise.reject(new Error("samples are not available to ingest")),
};

// Built at module scope: a missing WARASHI_TABLE_NAME fails the cold start.
const deps = {
  repo: createRepository({ samples: noSamples }),
  state: createStateStore(),
  nowMs: () => Date.now(),
};

export async function handler(event: unknown): Promise<IngestResult> {
  return handleIngest(event, deps);
}
