/**
 * `snapshot-signer` Lambda entry point. Internal: invoked only by `api-read`, no HTTP route.
 * Thin glue; the role, key and lifetime checks are in `signer-core.ts` (R14.4, R14.10).
 *
 * Environment variables: WARASHI_BUCKET_NAME (read by the S3 adapter).
 * This is the only function with `s3:GetObject` on `snapshots/*`.
 */

import { createSnapshotStore } from "../_shared/adapters/s3.js";
import { handleSign, type SignResponse } from "./signer-core.js";

// Module scope: a missing WARASHI_BUCKET_NAME fails the cold start.
const store = createSnapshotStore();

export async function handler(event: unknown): Promise<SignResponse> {
  return handleSign(event, store);
}
