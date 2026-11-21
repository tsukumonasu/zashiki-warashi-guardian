/**
 * DynamoDB adapters for the `StateStore` and `Repository` ports (cloud-judgement design,
 * "DynamoDB single table `warashi`").
 *
 * Thin on purpose: every rule (windows, limits, TTL lengths) comes in as an argument. The
 * adapter only turns a port call into the matching conditional request and maps a failed
 * condition to the port's "no" answer. Any other error is surfaced unchanged (R4.5).
 * Image bytes never reach the table (R11.7).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import type { Envelope } from "../messages.js";
import type {
  DeviceStatusRecord,
  EncounterMeta,
  EncounterPage,
  EncounterPatch,
  FamilyMember,
  Repository,
  StateStore,
  StatusReportData,
} from "../ports.js";
import type { SampleSource } from "./s3.js";

/** Created once per Lambda container. The region comes from `AWS_REGION`. */
const defaultClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/** Environment variable that names the table (set by the CDK stack). */
export const TABLE_ENV = "WARASHI_TABLE_NAME";
export const GSI1_NAME = "GSI1";

/** The notify slot lives one day (design table). */
export const NOTIFY_SLOT_TTL_S = 86_400;

export type DynamoAdapterOptions = {
  /** Defaults to the module-level client. Tests pass a mocked one. */
  client?: DynamoDBDocumentClient;
  /** Defaults to the `WARASHI_TABLE_NAME` environment variable. */
  tableName?: string;
  /** Clock for TTL values and expiry filters. Tests pass a fixed one. */
  now?: () => number;
};

type Resolved = { client: DynamoDBDocumentClient; table: string; now: () => number };

function resolve(options: DynamoAdapterOptions): Resolved {
  const table = options.tableName ?? process.env[TABLE_ENV];
  if (table === undefined || table === "") throw new Error(`${TABLE_ENV} is not set`);
  return { client: options.client ?? defaultClient, table, now: options.now ?? Date.now };
}

type Item = Record<string, unknown>;

function errorName(err: unknown): string {
  return typeof err === "object" && err !== null && "name" in err ? String(err.name) : "";
}

function isConditionFailed(err: unknown): boolean {
  return errorName(err) === "ConditionalCheckFailedException";
}

/**
 * True when a cancelled transaction failed only on conditions. A conflict, throttle or
 * validation reason is a real error and is surfaced instead.
 */
function isConditionCancellation(err: unknown): boolean {
  if (errorName(err) !== "TransactionCanceledException") return false;
  const reasons = (err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  if (!Array.isArray(reasons)) return false;
  const codes = reasons.map((reason) => reason.Code ?? "None");
  return (
    codes.includes("ConditionalCheckFailed") &&
    codes.every((code) => code === "ConditionalCheckFailed" || code === "None")
  );
}

function epochS(ms: number): number {
  return Math.floor(ms / 1000);
}

// ---------------------------------------------------------------------------------------------
// StateStore
// ---------------------------------------------------------------------------------------------

/** Sort key of a conditional-claim item, by the kind of its partition key. */
function claimSortKey(key: string): string {
  if (key.startsWith("MSG#")) return "DEDUP";
  if (key.startsWith("RATE#")) return "COUNT";
  return "CLAIM";
}

const encKey = (encounterId: string) => ({ pk: `ENC#${encounterId}`, sk: "META" });
const slotKey = (deviceId: string) => ({ pk: `NOTIFY#${deviceId}`, sk: "LAST" });

export function createStateStore(options: DynamoAdapterOptions = {}): StateStore {
  const { client, table, now } = resolve(options);

  /** `claimedAt` of each claim this store made, so a release deletes only its own item. */
  const ownClaims = new Map<string, number>();

  return {
    /** `attribute_not_exists(pk)`, or a claim whose TTL passed but DynamoDB has not purged yet. */
    async claim(key: string, ttlS: number): Promise<boolean> {
      const nowMs = now();
      try {
        await client.send(
          new PutCommand({
            TableName: table,
            Item: {
              pk: key,
              sk: claimSortKey(key),
              claimedAt: nowMs,
              ttl: epochS(nowMs) + ttlS,
            },
            ConditionExpression: "attribute_not_exists(pk) OR #ttl <= :nowS",
            ExpressionAttributeNames: { "#ttl": "ttl" },
            ExpressionAttributeValues: { ":nowS": epochS(nowMs) },
          }),
        );
        ownClaims.set(key, nowMs);
        return true;
      } catch (err) {
        if (isConditionFailed(err)) return false;
        throw err;
      }
    },

    /** Delete the claim item only while it still carries the `claimedAt` this store wrote. */
    async releaseClaim(key: string): Promise<void> {
      const claimedAt = ownClaims.get(key);
      if (claimedAt === undefined) return;
      ownClaims.delete(key);
      try {
        await client.send(
          new DeleteCommand({
            TableName: table,
            Key: { pk: key, sk: claimSortKey(key) },
            ConditionExpression: "claimedAt = :claimedAt",
            ExpressionAttributeValues: { ":claimedAt": claimedAt },
          }),
        );
      } catch (err) {
        if (!isConditionFailed(err)) throw err;
      }
    },

    /**
     * One transaction of two conditional updates: the encounter must exist and not be notified,
     * and the device slot must be absent, expired or older than the window. The slot also keeps
     * the values it replaces (`prevAtMs`, `prevEncounterId`) so a release can restore them.
     */
    async claimNotifySlot(
      deviceId: string,
      encounterId: string,
      nowMs: number,
      windowMs: number,
    ): Promise<boolean> {
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: table,
                  Key: encKey(encounterId),
                  UpdateExpression: "SET #notified = :true",
                  ConditionExpression:
                    "attribute_exists(pk) AND (attribute_not_exists(#notified) OR #notified = :false)",
                  ExpressionAttributeNames: { "#notified": "notified" },
                  ExpressionAttributeValues: { ":true": true, ":false": false },
                },
              },
              {
                Update: {
                  TableName: table,
                  Key: slotKey(deviceId),
                  UpdateExpression:
                    "SET #prevAt = if_not_exists(#last, :zero), " +
                    "#prevEnc = if_not_exists(#lastEnc, :empty), " +
                    "#last = :nowMs, #lastEnc = :enc, #ttl = :ttl",
                  ConditionExpression:
                    "attribute_not_exists(pk) OR #ttl <= :nowS OR #last <= :cutoff",
                  ExpressionAttributeNames: {
                    "#prevAt": "prevAtMs",
                    "#prevEnc": "prevEncounterId",
                    "#last": "lastNotifiedAtMs",
                    "#lastEnc": "lastEncounterId",
                    "#ttl": "ttl",
                  },
                  ExpressionAttributeValues: {
                    ":zero": 0,
                    ":empty": "",
                    ":nowMs": nowMs,
                    ":enc": encounterId,
                    ":ttl": epochS(now()) + NOTIFY_SLOT_TTL_S,
                    ":nowS": epochS(now()),
                    ":cutoff": nowMs - windowMs,
                  },
                },
              },
            ],
          }),
        );
        return true;
      } catch (err) {
        if (isConditionCancellation(err)) return false;
        throw err;
      }
    },

    /** Restore the slot only when this encounter still owns it, then clear `notified`. */
    async releaseNotifySlot(deviceId: string, encounterId: string): Promise<void> {
      const got = await client.send(
        new GetCommand({ TableName: table, Key: slotKey(deviceId), ConsistentRead: true }),
      );
      const slot = got.Item as Item | undefined;
      if (slot === undefined || slot.lastEncounterId !== encounterId) return;

      const prevAt = typeof slot.prevAtMs === "number" ? slot.prevAtMs : 0;
      const prevEnc = typeof slot.prevEncounterId === "string" ? slot.prevEncounterId : "";
      try {
        if (prevAt > 0) {
          await client.send(
            new UpdateCommand({
              TableName: table,
              Key: slotKey(deviceId),
              UpdateExpression:
                "SET #last = :prevAt, #lastEnc = :prevEnc, #prevAt = :zero, #prevEnc = :empty",
              ConditionExpression: "#lastEnc = :enc",
              ExpressionAttributeNames: {
                "#last": "lastNotifiedAtMs",
                "#lastEnc": "lastEncounterId",
                "#prevAt": "prevAtMs",
                "#prevEnc": "prevEncounterId",
              },
              ExpressionAttributeValues: {
                ":prevAt": prevAt,
                ":prevEnc": prevEnc,
                ":zero": 0,
                ":empty": "",
                ":enc": encounterId,
              },
            }),
          );
        } else {
          await client.send(
            new DeleteCommand({
              TableName: table,
              Key: slotKey(deviceId),
              ConditionExpression: "lastEncounterId = :enc",
              ExpressionAttributeValues: { ":enc": encounterId },
            }),
          );
        }
      } catch (err) {
        // Another caller took the slot after our read: it is theirs now.
        if (isConditionFailed(err)) return;
        throw err;
      }
      try {
        await client.send(
          new UpdateCommand({
            TableName: table,
            Key: encKey(encounterId),
            UpdateExpression: "SET #notified = :false",
            ConditionExpression: "attribute_exists(pk)",
            ExpressionAttributeNames: { "#notified": "notified" },
            ExpressionAttributeValues: { ":false": false },
          }),
        );
      } catch (err) {
        if (!isConditionFailed(err)) throw err;
      }
    },

    async lastNotifiedAtMs(deviceId: string): Promise<number | null> {
      const got = await client.send(
        new GetCommand({ TableName: table, Key: slotKey(deviceId), ConsistentRead: true }),
      );
      const slot = got.Item as Item | undefined;
      if (slot === undefined) return null;
      if (typeof slot.ttl === "number" && slot.ttl <= epochS(now())) return null;
      return typeof slot.lastNotifiedAtMs === "number" ? slot.lastNotifiedAtMs : null;
    },

    /**
     * One `ADD count 1` with `attribute_not_exists(count) OR count < :limit`. The TTL is set when
     * the counter is created and not extended. Counter keys carry their window bucket, so a
     * counter that outlived its TTL is never reused.
     */
    async incrementCounter(
      key: string,
      limit: number,
      ttlS: number,
    ): Promise<{ allowed: boolean; count: number }> {
      try {
        const out = await client.send(
          new UpdateCommand({
            TableName: table,
            Key: { pk: key, sk: "COUNT" },
            UpdateExpression: "ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)",
            ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
            ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
            ExpressionAttributeValues: {
              ":one": 1,
              ":limit": limit,
              ":ttl": epochS(now()) + ttlS,
            },
            ReturnValues: "UPDATED_NEW",
          }),
        );
        const count = out.Attributes?.count;
        return { allowed: true, count: typeof count === "number" ? count : 1 };
      } catch (err) {
        // The condition fails only when count >= limit, so the limit is the count we report.
        if (isConditionFailed(err)) return { allowed: false, count: limit };
        throw err;
      }
    },

    /** `ADD count -1`, only while the counter exists and is above zero. */
    async releaseCounter(key: string): Promise<void> {
      try {
        await client.send(
          new UpdateCommand({
            TableName: table,
            Key: { pk: key, sk: "COUNT" },
            UpdateExpression: "ADD #count :minusOne",
            ConditionExpression: "attribute_exists(pk) AND #count > :zero",
            ExpressionAttributeNames: { "#count": "count" },
            ExpressionAttributeValues: { ":minusOne": -1, ":zero": 0 },
          }),
        );
      } catch (err) {
        if (!isConditionFailed(err)) throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------------------------

/** Thrown by `listEncounters` for a cursor this adapter did not issue. The API maps it to 400. */
export class InvalidCursorError extends Error {
  constructor() {
    super("invalid cursor");
    this.name = "InvalidCursorError";
  }
}

type CursorKey = { e: string; d: string; s: string };

function encodeCursor(meta: EncounterMeta): string {
  const key: CursorKey = { e: meta.encounterId, d: meta.deviceId, s: meta.startedAt };
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, deviceId: string): CursorKey {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorKey>;
    if (
      typeof parsed.e === "string" &&
      typeof parsed.d === "string" &&
      typeof parsed.s === "string" &&
      parsed.d === deviceId
    ) {
      return { e: parsed.e, d: parsed.d, s: parsed.s };
    }
  } catch {
    // fall through
  }
  throw new InvalidCursorError();
}

function toMeta(item: Item): EncounterMeta {
  return {
    encounterId: String(item.pk).slice("ENC#".length),
    deviceId: item.deviceId as string,
    startedAt: item.startedAt as string,
    endedAt: (item.endedAt ?? null) as EncounterMeta["endedAt"],
    state: (item.state ?? null) as EncounterMeta["state"],
    verdict: (item.verdict ?? null) as EncounterMeta["verdict"],
    confidence: (item.confidence ?? null) as EncounterMeta["confidence"],
    reaction: (item.reaction ?? null) as EncounterMeta["reaction"],
    notified: item.notified === true,
    snapshotKey: (item.snapshotKey ?? null) as EncounterMeta["snapshotKey"],
    errorCount: typeof item.errorCount === "number" ? item.errorCount : 0,
  };
}

function isLiveItem(item: Item, nowS: number): boolean {
  return typeof item.ttl !== "number" || item.ttl > nowS;
}

function toMember(item: Item): FamilyMember {
  return {
    memberId: String(item.sk).slice("MEMBER#".length),
    displayName: item.displayName as string,
    faceIds: (item.faceIds ?? []) as string[],
    consentVersion: item.consentVersion as string,
    consentAt: item.consentAt as string,
    createdBy: item.createdBy as string,
  };
}

export type RepositoryOptions = DynamoAdapterOptions & {
  /** Sample manifest and images come from S3, see `createSampleSource`. */
  samples: SampleSource;
};

export function createRepository(options: RepositoryOptions): Repository {
  const { client, table, now } = resolve(options);
  const { samples } = options;

  /** Run a paged query to the end and return every item. For small partitions only. */
  async function queryAll(input: {
    KeyConditionExpression: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues: Record<string, unknown>;
    ScanIndexForward?: boolean;
  }): Promise<Item[]> {
    const items: Item[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const out = await client.send(
        new QueryCommand({
          TableName: table,
          ConsistentRead: true,
          ...input,
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        }),
      );
      items.push(...((out.Items ?? []) as Item[]));
      startKey = out.LastEvaluatedKey;
    } while (startKey !== undefined);
    return items;
  }

  return {
    // Encounters ------------------------------------------------------------------------------

    async createEncounterIfAbsent(meta: EncounterMeta, ttlS: number): Promise<boolean> {
      const { encounterId, ...fields } = meta;
      try {
        await client.send(
          new PutCommand({
            TableName: table,
            Item: {
              ...encKey(encounterId),
              ...fields,
              gsi1pk: `DEV#${meta.deviceId}`,
              gsi1sk: meta.startedAt,
              ttl: epochS(now()) + ttlS,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
        return true;
      } catch (err) {
        if (isConditionFailed(err)) return false;
        throw err;
      }
    },

    async getEncounter(encounterId: string, nowMs: number): Promise<EncounterMeta | null> {
      const got = await client.send(
        new GetCommand({ TableName: table, Key: encKey(encounterId), ConsistentRead: true }),
      );
      const item = got.Item as Item | undefined;
      if (item === undefined || !isLiveItem(item, epochS(nowMs))) return null;
      return toMeta(item);
    },

    async updateEncounter(encounterId: string, patch: EncounterPatch): Promise<boolean> {
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      if (entries.length === 0) {
        const got = await client.send(
          new GetCommand({ TableName: table, Key: encKey(encounterId), ConsistentRead: true }),
        );
        return got.Item !== undefined;
      }
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const sets = entries.map(([name, value], i) => {
        names[`#f${i}`] = name;
        values[`:v${i}`] = value;
        return `#f${i} = :v${i}`;
      });
      try {
        await client.send(
          new UpdateCommand({
            TableName: table,
            Key: encKey(encounterId),
            UpdateExpression: `SET ${sets.join(", ")}`,
            ConditionExpression: "attribute_exists(pk)",
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }),
        );
        return true;
      } catch (err) {
        if (isConditionFailed(err)) return false;
        throw err;
      }
    },

    /**
     * GSI1 query, newest first. The `ttl` filter runs after DynamoDB applies its page size, so
     * the query pages until it has `limit + 1` live items or the index ends. The extra item
     * tells whether a next page exists.
     */
    async listEncounters(
      deviceId: string,
      limit: number,
      cursor: string | null,
      nowMs: number,
    ): Promise<EncounterPage> {
      let startKey: Record<string, unknown> | undefined;
      if (cursor !== null) {
        const key = decodeCursor(cursor, deviceId);
        startKey = {
          ...encKey(key.e),
          gsi1pk: `DEV#${deviceId}`,
          gsi1sk: key.s,
        };
      }
      const found: EncounterMeta[] = [];
      do {
        const out = await client.send(
          new QueryCommand({
            TableName: table,
            IndexName: GSI1_NAME,
            KeyConditionExpression: "gsi1pk = :p",
            FilterExpression: "attribute_not_exists(#ttl) OR #ttl > :nowS",
            ExpressionAttributeNames: { "#ttl": "ttl" },
            ExpressionAttributeValues: { ":p": `DEV#${deviceId}`, ":nowS": epochS(nowMs) },
            ScanIndexForward: false,
            Limit: limit + 1,
            ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
          }),
        );
        for (const item of (out.Items ?? []) as Item[]) found.push(toMeta(item));
        startKey = out.LastEvaluatedKey;
      } while (startKey !== undefined && found.length <= limit);

      const items = found.slice(0, limit);
      const last = items[items.length - 1];
      const nextCursor = found.length > limit && last !== undefined ? encodeCursor(last) : null;
      return { items, nextCursor };
    },

    // Events ----------------------------------------------------------------------------------

    async appendEvent(encounterId: string, envelope: Envelope, ttlS: number): Promise<void> {
      const data = envelope.data;
      if (typeof data === "object" && data !== null && "jpegBase64" in data) {
        throw new RangeError("envelope: image data must be removed before it is stored");
      }
      await client.send(
        new PutCommand({
          TableName: table,
          Item: {
            pk: `ENC#${encounterId}`,
            sk: `EVT#${envelope.ts}#${envelope.id}`,
            envelope,
            ttl: epochS(now()) + ttlS,
          },
        }),
      );
    },

    async listEvents(encounterId: string): Promise<Envelope[]> {
      const items = await queryAll({
        KeyConditionExpression: "pk = :p AND begins_with(sk, :evt)",
        ExpressionAttributeValues: { ":p": `ENC#${encounterId}`, ":evt": "EVT#" },
        ScanIndexForward: true,
      });
      const nowS = epochS(now());
      return items.filter((item) => isLiveItem(item, nowS)).map((item) => item.envelope as Envelope);
    },

    // Device status ---------------------------------------------------------------------------

    async getDeviceStatus(deviceId: string): Promise<DeviceStatusRecord | null> {
      const got = await client.send(
        new GetCommand({
          TableName: table,
          Key: { pk: `DEV#${deviceId}`, sk: "STATUS" },
          ConsistentRead: true,
        }),
      );
      const item = got.Item as Item | undefined;
      if (item === undefined) return null;
      return {
        deviceId,
        status: (item.status ?? null) as StatusReportData | null,
        lastReportAtMs: typeof item.lastReportAtMs === "number" ? item.lastReportAtMs : null,
        lastOfflineAtMs: typeof item.lastOfflineAtMs === "number" ? item.lastOfflineAtMs : null,
      };
    },

    async putStatusReport(
      deviceId: string,
      data: StatusReportData,
      receivedAtMs: number,
    ): Promise<void> {
      await client.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk: `DEV#${deviceId}`, sk: "STATUS" },
          UpdateExpression: "SET #status = :status, #report = :at",
          ExpressionAttributeNames: { "#status": "status", "#report": "lastReportAtMs" },
          ExpressionAttributeValues: { ":status": data, ":at": receivedAtMs },
        }),
      );
    },

    async markOffline(deviceId: string, receivedAtMs: number): Promise<void> {
      await client.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk: `DEV#${deviceId}`, sk: "STATUS" },
          UpdateExpression: "SET #offline = :at",
          ExpressionAttributeNames: { "#offline": "lastOfflineAtMs" },
          ExpressionAttributeValues: { ":at": receivedAtMs },
        }),
      );
    },

    // Family members --------------------------------------------------------------------------

    async listMembers(): Promise<FamilyMember[]> {
      const items = await queryAll({
        KeyConditionExpression: "pk = :p AND begins_with(sk, :m)",
        ExpressionAttributeValues: { ":p": "FAMILY", ":m": "MEMBER#" },
      });
      return items.map(toMember);
    },

    async getMember(memberId: string): Promise<FamilyMember | null> {
      const got = await client.send(
        new GetCommand({
          TableName: table,
          Key: { pk: "FAMILY", sk: `MEMBER#${memberId}` },
          ConsistentRead: true,
        }),
      );
      return got.Item === undefined ? null : toMember(got.Item as Item);
    },

    async putMember(member: FamilyMember): Promise<void> {
      const { memberId, ...fields } = member;
      await client.send(
        new PutCommand({
          TableName: table,
          Item: { pk: "FAMILY", sk: `MEMBER#${memberId}`, ...fields },
        }),
      );
    },

    async deleteMember(memberId: string): Promise<boolean> {
      try {
        await client.send(
          new DeleteCommand({
            TableName: table,
            Key: { pk: "FAMILY", sk: `MEMBER#${memberId}` },
            ConditionExpression: "attribute_exists(pk)",
          }),
        );
        return true;
      } catch (err) {
        if (isConditionFailed(err)) return false;
        throw err;
      }
    },

    // Samples (S3) ----------------------------------------------------------------------------

    getSampleManifest: () => samples.getSampleManifest(),
    getSampleImage: (sampleId: string) => samples.getSampleImage(sampleId),
  };
}
