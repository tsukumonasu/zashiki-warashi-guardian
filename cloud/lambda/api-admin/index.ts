/**
 * `api-admin` Lambda entry point (family only): `POST /commands` and the `/faces` routes.
 * Thin glue; every decision is in `commands-core.ts` and `faces-core.ts`.
 *
 * Environment variables (set by the CDK stack, never secrets):
 *   WARASHI_TABLE_NAME, WARASHI_BUCKET_NAME, IOT_DATA_ENDPOINT  (read by the adapters)
 *   WARASHI_WEB_ORIGIN               dashboard origin for CORS
 *   WARASHI_CONSENT_NOTICE_VERSION   consent notice version, default "1"
 *   WARASHI_HOUSEHOLD_COLLECTION_ID  Rekognition collection, default `warashi-household`
 *   WARASHI_*                        tunable settings, see `_shared/config.ts`
 *
 * Stack task (19.6): R16.1 requires the answer to `POST /commands` within 3 seconds, so this
 * function's timeout must be at most 3 seconds for that route, or the route must be served by a
 * separate function with a 3 second timeout. The IoT publish already stops after 2 seconds.
 */

import { randomUUID } from "node:crypto";

import { createRepository, createStateStore } from "../_shared/adapters/dynamo.js";
import { createIotBus } from "../_shared/adapters/iot-bus.js";
import { createRekognitionFaceSearch } from "../_shared/adapters/rekognition.js";
import { createFaceStaging, createSampleSource } from "../_shared/adapters/s3.js";
import {
  createApiHandler,
  ok,
  readConsentVersion,
  readWebOrigin,
  type RouteContext,
  type RouteResult,
} from "../_shared/api-glue.js";
import { loadConfig } from "../_shared/config.js";
import { parseJsonBody } from "../_shared/http.js";
import type { VoiceLine } from "../_shared/lines.js";
import voiceLines from "../_shared/voice-lines.json" with { type: "json" };
import { handlePostCommand } from "./commands-core.js";
import { handlePostPhoto } from "./photos-core.js";
import {
  handleDeleteFace,
  handleFaceUpload,
  handleListFaces,
  handleRegisterFace,
  type FacesDeps,
  type FacesRequest,
} from "./faces-core.js";

const DEFAULT_COLLECTION_ID = "warashi-household";

// Module scope: invalid configuration or a missing variable fails the cold start (R5.16).
const config = loadConfig(process.env);
const repository = createRepository({ samples: createSampleSource() });
const bus = createIotBus();
const state = createStateStore();
const faces = createRekognitionFaceSearch();
const staging = createFaceStaging();
const collectionId = process.env["WARASHI_HOUSEHOLD_COLLECTION_ID"] || DEFAULT_COLLECTION_ID;
const consentNoticeVersion = readConsentVersion(process.env);
const lines = voiceLines as VoiceLine[];

async function postCommand({ request, role, nowMs }: RouteContext): Promise<RouteResult> {
  const body = parseJsonBody(request);
  // R16.10: a 202 with the command id.
  return {
    status: 202,
    body: await handlePostCommand({ role, body }, { bus, repository, config, lines, newId: randomUUID, nowMs }),
  };
}

async function postPhoto({ request, role, userSub, nowMs }: RouteContext): Promise<RouteResult> {
  const body = parseJsonBody(request);
  return {
    status: 202,
    body: await handlePostPhoto(
      { role, userSub, body },
      { bus, repository, state, config, newId: randomUUID, nowMs },
    ),
  };
}
function facesRequest({ request, role, userSub }: RouteContext, withBody: boolean): FacesRequest {
  return {
    role,
    userId: userSub,
    body: withBody ? parseJsonBody(request) : {},
    pathParameters: request.pathParameters,
  };
}

function facesDeps({ nowMs }: RouteContext): FacesDeps {
  return { repository, faces, staging, collectionId, consentNoticeVersion, nowMs, newId: randomUUID };
}

export const handler = createApiHandler({
  allowedOrigin: readWebOrigin(process.env),
  now: Date.now,
  routes: {
    "POST /commands": postCommand,
    "POST /photos": postPhoto,
    "GET /faces": async (c) => ok(await handleListFaces(facesRequest(c, false), facesDeps(c))),
    "POST /faces/upload": async (c) => ok(await handleFaceUpload(facesRequest(c, false), facesDeps(c))),
    "POST /faces": async (c) => ({ status: 201, body: await handleRegisterFace(facesRequest(c, true), facesDeps(c)) }),
    "DELETE /faces/{memberId}": async (c) => {
      await handleDeleteFace(facesRequest(c, false), facesDeps(c));
      return null;
    },
  },
});
