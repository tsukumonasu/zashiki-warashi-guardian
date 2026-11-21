/**
 * S3 adapters (cloud-judgement design, "S3 data bucket layout").
 *
 * `createSnapshotStore` implements the `SnapshotStore` port. `createSampleSource` reads the
 * simulation samples (`samples/manifest.json` and `samples/<sampleId>.jpg`) and is handed to the
 * DynamoDB repository, which exposes it through `Repository`. Both are thin: they call the SDK
 * and reshape the result. The key layout `snapshots/<deviceId>/<yyyymmdd>/<snapshotId>.jpg` is
 * built by the caller (R2.7); this module only refuses keys outside `snapshots/`.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { Repository, SampleEntry, SampleLabel, SnapshotStore } from "../ports.js";

/** Created once per Lambda container. The region comes from `AWS_REGION`. */
const defaultClient = new S3Client({});

/** Pre-signed URL lifetime in seconds (R11.6). */
export const SIGN_TTL_S = 300;

export const SNAPSHOT_PREFIX = "snapshots/";
export const SAMPLE_MANIFEST_KEY = "samples/manifest.json";

/** Environment variable that names the data bucket (set by the CDK stack). */
export const BUCKET_ENV = "WARASHI_BUCKET_NAME";

export type S3AdapterOptions = {
  /** Defaults to the module-level client. Tests pass a mocked one. */
  client?: S3Client;
  /** Defaults to the `WARASHI_BUCKET_NAME` environment variable. */
  bucket?: string;
};

function resolveBucket(options: S3AdapterOptions): string {
  const bucket = options.bucket ?? process.env[BUCKET_ENV];
  if (bucket === undefined || bucket === "") {
    throw new Error(`${BUCKET_ENV} is not set`);
  }
  return bucket;
}

function errorName(err: unknown): string {
  return typeof err === "object" && err !== null && "name" in err ? String(err.name) : "";
}

function isMissingObject(err: unknown): boolean {
  const name = errorName(err);
  return name === "NoSuchKey" || name === "NotFound";
}

/** Prefix of the generated simulation audio written by `api-simulate`. */
export const AUDIO_PREFIX = "audio/sim/";

/** A key must sit under `prefix` and contain no empty or dot segments. */
function assertKeyUnder(prefix: string, key: string): void {
  const segments = key.split("/");
  const ok =
    key.startsWith(prefix) &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
  if (!ok) throw new RangeError(`key: must be a plain key under ${prefix}`);
}

export function createSnapshotStore(options: S3AdapterOptions = {}): SnapshotStore {
  return createPrefixedStore(options, SNAPSHOT_PREFIX);
}

/**
 * Same behavior as the snapshot store, limited to `audio/sim/`. `api-simulate` needs this
 * because its generated MP3 is stored there, and the snapshot store refuses keys outside
 * `snapshots/`.
 */
export function createAudioStore(options: S3AdapterOptions = {}): SnapshotStore {
  return createPrefixedStore(options, AUDIO_PREFIX);
}

function createPrefixedStore(options: S3AdapterOptions, prefix: string): SnapshotStore {
  const assertSnapshotKey = (key: string): void => {
    assertKeyUnder(prefix, key);
  };
  const client = options.client ?? defaultClient;
  const bucket = resolveBucket(options);

  return {
    /**
     * One `PutObject` request, which S3 stores whole or not at all. When the call fails on the
     * client side (for example a timeout after the bytes were sent) the object might still have
     * been created, so a best-effort delete runs and its own failure is ignored (R2.8).
     */
    async put(key: string, jpeg: Uint8Array): Promise<void> {
      assertSnapshotKey(key);
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: jpeg,
            ContentType: "image/jpeg",
          }),
        );
      } catch (err) {
        try {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        } catch {
          // The original failure is the one the caller needs.
        }
        throw err;
      }
    },

    async signGet(key: string, ttlS: number): Promise<string> {
      assertSnapshotKey(key);
      if (!Number.isInteger(ttlS) || ttlS < 1 || ttlS > SIGN_TTL_S) {
        throw new RangeError(`ttlS: must be an integer from 1 to ${SIGN_TTL_S}`);
      }
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: ttlS,
      });
    },
  };
}

export const STAGING_PREFIX = "faces-staging/";

/** Longest common prefix of the allowed content types (`image/jpeg`, `image/png` give `image/`). */
function commonPrefix(values: readonly string[]): string {
  const [first = "", ...rest] = values;
  let length = first.length;
  for (const value of rest) {
    let i = 0;
    while (i < length && i < value.length && value[i] === first[i]) i += 1;
    length = i;
  }
  return first.slice(0, length);
}

/**
 * Face-registration staging area (`faces-staging/`), used by `api-admin` (R17.3, R17.8).
 * The structural type matches `FaceStaging` in `faces-core.ts`; it is declared here so this
 * adapter does not import a handler module.
 */
export type FaceStagingAdapter = {
  createUpload(options: {
    key: string;
    contentTypes: readonly string[];
    minBytes: number;
    maxBytes: number;
    ttlS: number;
  }): Promise<{ url: string; fields: Record<string, string> }>;
  read(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
};

function assertStagingKey(key: string): void {
  const rest = key.slice(STAGING_PREFIX.length);
  if (!key.startsWith(STAGING_PREFIX) || rest === "" || rest.includes("/") || rest.includes(".")) {
    throw new RangeError("key: must be a plain key under faces-staging/");
  }
}

export function createFaceStaging(options: S3AdapterOptions = {}): FaceStagingAdapter {
  const client = options.client ?? defaultClient;
  const bucket = resolveBucket(options);

  return {
    /**
     * A pre-signed POST whose policy limits the size (`content-length-range`) and the content
     * type. A POST policy has no "one of" condition, so several types are limited to their
     * common prefix (`image/`); Rekognition rejects anything that is not a JPEG or PNG.
     */
    async createUpload(upload) {
      assertStagingKey(upload.key);
      const [only] = upload.contentTypes;
      const contentTypeCondition: ["eq" | "starts-with", string, string] =
        upload.contentTypes.length === 1 && only !== undefined
          ? ["eq", "$Content-Type", only]
          : ["starts-with", "$Content-Type", commonPrefix(upload.contentTypes)];
      const { url, fields } = await createPresignedPost(client, {
        Bucket: bucket,
        Key: upload.key,
        Expires: upload.ttlS,
        Conditions: [["content-length-range", upload.minBytes, upload.maxBytes], contentTypeCondition],
      });
      return { url, fields };
    },

    async read(key: string): Promise<Uint8Array | null> {
      assertStagingKey(key);
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (out.Body === undefined) return null;
        return await out.Body.transformToByteArray();
      } catch (err) {
        if (isMissingObject(err)) return null;
        throw err;
      }
    },

    async delete(key: string): Promise<void> {
      assertStagingKey(key);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

const SAMPLE_LABELS: ReadonlySet<string> = new Set<SampleLabel>([
  "family",
  "stranger",
  "no_face",
  "uncertain",
]);
const SAMPLE_ID = /^[a-z0-9_-]{1,64}$/;

function parseManifest(text: string): SampleEntry[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) return [];
  const entries: SampleEntry[] = [];
  for (const raw of parsed as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const { id, label } = raw as { id?: unknown; label?: unknown };
    if (typeof id !== "string" || !SAMPLE_ID.test(id)) continue;
    if (typeof label !== "string" || !SAMPLE_LABELS.has(label)) continue;
    entries.push({ id, label: label as SampleLabel });
  }
  return entries;
}

export type SampleSource = Pick<Repository, "getSampleManifest" | "getSampleImage">;

export function createSampleSource(options: S3AdapterOptions = {}): SampleSource {
  const client = options.client ?? defaultClient;
  const bucket = resolveBucket(options);

  async function readObject(key: string): Promise<Uint8Array | null> {
    try {
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (out.Body === undefined) return null;
      return await out.Body.transformToByteArray();
    } catch (err) {
      if (isMissingObject(err)) return null;
      throw err;
    }
  }

  async function getSampleManifest(): Promise<SampleEntry[]> {
    const bytes = await readObject(SAMPLE_MANIFEST_KEY);
    if (bytes === null) return [];
    return parseManifest(new TextDecoder().decode(bytes));
  }

  return {
    getSampleManifest,
    async getSampleImage(sampleId: string): Promise<Uint8Array | null> {
      const manifest = await getSampleManifest();
      if (!manifest.some((entry) => entry.id === sampleId)) return null;
      return readObject(`samples/${sampleId}.jpg`);
    },
  };
}
