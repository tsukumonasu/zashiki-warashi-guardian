/**
 * `api-read` Lambda entry point: `GET /me`, `/samples`, `/encounters`, `/encounters/{id}`,
 * `/device/status`. Thin glue only; every decision is in `api-read-core.ts`.
 *
 * Environment variables (set by the CDK stack, never secrets):
 *   WARASHI_TABLE_NAME, WARASHI_BUCKET_NAME, WARASHI_SIGNER_FUNCTION_NAME  (read by the adapters)
 *   WARASHI_WEB_ORIGIN               dashboard origin for CORS
 *   WARASHI_CONSENT_NOTICE_VERSION   consent notice version shown by `GET /me`, default "1"
 *   WARASHI_*                        tunable settings, see `_shared/config.ts`
 *
 * This function has no permission on `snapshots/*`: pictures are signed by the internal
 * `snapshot-signer` function (R14.10). The bucket is read only for `samples/manifest.json`, so the
 * stack task (19.6) grants `s3:GetObject` on `samples/*` and nothing else.
 */

import { createRepository } from "../_shared/adapters/dynamo.js";
import { createSampleSource } from "../_shared/adapters/s3.js";
import { createSnapshotUrlSigner } from "../_shared/adapters/signer.js";
import {
  createApiHandler,
  ok,
  readConsentVersion,
  readWebOrigin,
  type RouteContext,
  type RouteResult,
} from "../_shared/api-glue.js";
import { createPhotoReader } from "../_shared/adapters/photos.js";
import { loadConfig } from "../_shared/config.js";
import { loadVoiceConfig } from "../_shared/voice/config.js";
import { createHealthStore, createReadCounter } from "../voice-session/adapters/voice-dynamo.js";
import { meVoice } from "../voice-start/voice-start-core.js";
import { handleGetPhoto } from "./photos-core.js";
import {
  handleDeviceStatus,
  handleGetEncounter,
  handleListEncounters,
  handleMe,
  handleSamples,
  type ReadDeps,
  type ReadRequest,
} from "./api-read-core.js";

// Module scope: invalid configuration or a missing variable fails the cold start (R5.16).
const config = loadConfig(process.env);
const base = {
  repository: createRepository({ samples: createSampleSource() }),
  signer: createSnapshotUrlSigner(),
  config,
  consentNoticeVersion: readConsentVersion(process.env),
};

// The `voice` block of `GET /me` (S18) reads the voice counters and the health flag. It uses the
// same voice settings as `VoiceStack`, which `ApiStack` passes in through the environment.
const voiceDeps = {
  cfg: loadVoiceConfig(process.env),
  health: createHealthStore(),
  readCounter: createReadCounter(),
  now: Date.now,
};

const photos = createPhotoReader();
function readRequest({ request, role }: RouteContext): ReadRequest {
  return { role, query: request.query, pathParameters: request.pathParameters };
}

function deps(context: RouteContext): ReadDeps {
  return { ...base, nowMs: context.nowMs };
}

const json =
  <T>(route: (request: ReadRequest, deps: ReadDeps) => T | Promise<T>) =>
  async (context: RouteContext): Promise<RouteResult> =>
    ok(await route(readRequest(context), deps(context)));

export const handler = createApiHandler({
  allowedOrigin: readWebOrigin(process.env),
  now: Date.now,
  routes: {
    "GET /me": async (context: RouteContext): Promise<RouteResult> => {
      const me = handleMe(readRequest(context), deps(context));
      const voice = await meVoice({ sub: context.userSub, role: context.role }, voiceDeps);
      return ok({ ...me, voice });
    },
    "GET /samples": json(handleSamples),
    "GET /encounters": json(handleListEncounters),
    "GET /encounters/{id}": json(handleGetEncounter),
    "GET /device/status": json(handleDeviceStatus),
    "GET /photos/{requestId}": async (context: RouteContext): Promise<RouteResult> =>
      ok(
        await handleGetPhoto(
          { role: context.role, pathParameters: context.request.pathParameters },
          { photos, signer: base.signer, nowMs: context.nowMs },
        ),
      ),
  },
});
