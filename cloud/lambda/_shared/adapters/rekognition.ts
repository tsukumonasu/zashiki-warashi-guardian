/**
 * Rekognition adapter for the `FaceSearch` port (cloud-judgement design, C2 and C3).
 *
 * Thin on purpose: it calls the SDK and reshapes the response. The verdict thresholds live in
 * `verdict.ts`. The one mapping done here is Rekognition's "no face": `SearchFacesByImage`
 * reports it as `InvalidParameterException`, which also covers other bad requests, so the
 * adapter asks `DetectFaces` to tell them apart.
 */

import {
  DeleteFacesCommand,
  DetectFacesCommand,
  IndexFacesCommand,
  RekognitionClient,
  SearchFacesByImageCommand,
} from "@aws-sdk/client-rekognition";
import type { BoundingBox } from "@aws-sdk/client-rekognition";

import type { FaceSearch } from "../ports.js";
import type { FaceBox, FaceQuality, SearchOutcome } from "../verdict.js";

/** Created once per Lambda container. The region comes from `AWS_REGION`. */
const defaultClient = new RekognitionClient({});

/** Raised when Rekognition throttles the call. The caller maps it to a failure verdict. */
export class RekognitionThrottledError extends Error {
  constructor(cause: unknown) {
    super("Rekognition throttled the request", { cause });
    this.name = "RekognitionThrottledError";
  }
}

/** `DeleteFaces` accepts at most 4096 face ids per call (aws-docs, API_DeleteFaces). */
const DELETE_FACES_CHUNK = 4096;

const THROTTLE_NAMES = new Set([
  "ThrottlingException",
  "ProvisionedThroughputExceededException",
  "LimitExceededException",
]);

function errorName(err: unknown): string {
  return typeof err === "object" && err !== null && "name" in err ? String(err.name) : "";
}

function isInvalidParameter(err: unknown): boolean {
  return errorName(err) === "InvalidParameterException";
}

/** Rethrow throttling as a typed error and everything else unchanged. */
function rethrow(err: unknown): never {
  if (THROTTLE_NAMES.has(errorName(err))) throw new RekognitionThrottledError(err);
  throw err;
}

function toBox(b: BoundingBox | undefined): FaceBox | null {
  if (
    b?.Left === undefined ||
    b.Top === undefined ||
    b.Width === undefined ||
    b.Height === undefined
  ) {
    return null;
  }
  return { left: b.Left, top: b.Top, width: b.Width, height: b.Height };
}

export function createRekognitionFaceSearch(client: RekognitionClient = defaultClient): FaceSearch {
  async function detect(
    image: Uint8Array,
  ): Promise<{ faces: number; quality: FaceQuality; box: FaceBox | null }> {
    let details;
    try {
      const out = await client.send(
        new DetectFacesCommand({ Image: { Bytes: image }, Attributes: ["ALL"] }),
      );
      details = out.FaceDetails ?? [];
    } catch (err) {
      return rethrow(err);
    }

    // The largest face is the one the doll is looking at.
    let best: { box: FaceBox; area: number; detail: (typeof details)[number] } | null = null;
    for (const detail of details) {
      const box = toBox(detail.BoundingBox);
      if (box === null) continue;
      const area = box.width * box.height;
      if (best === null || area > best.area) best = { box, area, detail };
    }
    if (best === null) return { faces: details.length, quality: null, box: null };

    const { Quality: q, Pose: pose } = best.detail;
    const quality: FaceQuality =
      q?.Sharpness !== undefined && q.Brightness !== undefined && pose?.Yaw !== undefined
        ? { sharpness: q.Sharpness, brightness: q.Brightness, yawDeg: pose.Yaw }
        : null;
    return { faces: details.length, quality, box: best.box };
  }

  async function search(
    image: Uint8Array,
    collectionId: string,
    floor: number,
  ): Promise<SearchOutcome> {
    try {
      const out = await client.send(
        new SearchFacesByImageCommand({
          CollectionId: collectionId,
          Image: { Bytes: image },
          FaceMatchThreshold: floor,
          QualityFilter: "NONE",
          MaxFaces: 1,
        }),
      );
      const box = toBox(out.SearchedFaceBoundingBox);
      if (box === null) return { kind: "no_face" };
      const best = out.FaceMatches?.[0]?.Similarity;
      return {
        kind: "face",
        box,
        faceConfidence: out.SearchedFaceConfidence ?? 0,
        bestSimilarity: best ?? null,
      };
    } catch (err) {
      if (!isInvalidParameter(err)) return rethrow(err);
      // "No face" and "bad request" share one exception: count the faces to tell them apart.
      const found = await detect(image);
      if (found.faces === 0) return { kind: "no_face" };
      throw err;
    }
  }

  async function indexFaces(
    image: Uint8Array,
    collectionId: string,
    externalImageId: string,
  ): Promise<string[]> {
    try {
      const out = await client.send(
        new IndexFacesCommand({
          CollectionId: collectionId,
          Image: { Bytes: image },
          ExternalImageId: externalImageId,
        }),
      );
      const ids: string[] = [];
      for (const record of out.FaceRecords ?? []) {
        if (record.Face?.FaceId !== undefined) ids.push(record.Face.FaceId);
      }
      return ids;
    } catch (err) {
      return rethrow(err);
    }
  }

  async function deleteFaces(collectionId: string, faceIds: readonly string[]): Promise<void> {
    // `FaceIds` needs 1 to 4096 items; delete in chunks.
    for (let i = 0; i < faceIds.length; i += DELETE_FACES_CHUNK) {
      const chunk = faceIds.slice(i, i + DELETE_FACES_CHUNK);
      try {
        const out = await client.send(new DeleteFacesCommand({ CollectionId: collectionId, FaceIds: chunk }));
        // A face that is already gone counts as deleted, so a repeated request can finish.
        const failed = (out.UnsuccessfulFaceDeletions ?? []).filter(
          (item) => !(item.Reasons ?? []).includes("FACE_NOT_FOUND"),
        );
        if (failed.length > 0) {
          throw new Error("Rekognition could not delete every face");
        }
      } catch (err) {
        return rethrow(err);
      }
    }
  }

  return { search, detect, indexFaces, deleteFaces };
}
