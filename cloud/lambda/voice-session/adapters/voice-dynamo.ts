/**
 * DynamoDB adapters of the voice feature, all on the single table `warashi` (design, "DynamoDB
 * items"). Same key layout as `FakeVoiceStore` and the `judge` look store:
 *
 * | Item | pk | sk | TTL |
 * |---|---|---|---|
 * | Session | `VOICE#<sessionId>` | `META` | 2 days |
 * | Lock | `VOICELOCK#<key>` | `LOCK` | 1 hour |
 * | Counter | the full counter key `RATE#voice#<scope>#<day>` | `COUNT` | 2 days (argument) |
 * | Look result | `LOOK#<requestId>` | `RESULT` | 10 minutes (written by `judge`) |
 * | Health flag | `VOICE#HEALTH` | `STATE` | 2 days |
 *
 * DynamoDB TTL deletion is late, so every read that matters checks `expiresAt` itself. The session
 * item is written from a closed list of fields: no audio, text or token can reach the table.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { isOnline } from "../../api-read/api-read-core.js";
import type { Verdict } from "../../_shared/verdict.js";
import type { LookVerdict } from "../../_shared/voice/frames.js";
import type { LookItem, SessionPhase, SessionRecord, VoiceStore } from "../../_shared/voice/ports.js";
import type { HealthState, HealthStore } from "../../voice-start/voice-start-core.js";

/** Lifetimes in seconds. */
export const SESSION_TTL_S = 2 * 86_400;
export const LOCK_TTL_S = 3_600;
export const HEALTH_TTL_S = 2 * 86_400;

export interface VoiceDynamoOptions {
  readonly client?: DynamoDBDocumentClient;
  readonly tableName?: string;
  /** Epoch milliseconds; injected for tests. */
  readonly now?: () => number;
}

type Item = Record<string, unknown>;

let defaultClient: DynamoDBDocumentClient | undefined;

function resolve(options: VoiceDynamoOptions): {
  client: DynamoDBDocumentClient;
  table: string;
  now: () => number;
} {
  const table = options.tableName ?? process.env["WARASHI_TABLE_NAME"];
  if (table === undefined || table === "") throw new Error("WARASHI_TABLE_NAME is not set");
  defaultClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return { client: options.client ?? defaultClient, table, now: options.now ?? Date.now };
}

function isConditionFailed(err: unknown): boolean {
  return err instanceof Error && err.name === "ConditionalCheckFailedException";
}

const epochS = (ms: number): number => Math.floor(ms / 1000);

const PHASES: readonly SessionPhase[] = ["starting", "live", "ending", "ended"];
const LOOK_VERDICTS: readonly LookVerdict[] = ["family", "stranger", "no_face", "uncertain"];

function toSession(item: Item): SessionRecord | null {
  const phase = item["phase"] as SessionPhase;
  if (typeof item["sessionId"] !== "string" || !PHASES.includes(phase)) return null;
  return {
    sessionId: item["sessionId"],
    deviceId: item["deviceId"] as string,
    client: item["client"] as SessionRecord["client"],
    target: item["target"] as SessionRecord["target"],
    ownerSub: (item["ownerSub"] ?? null) as string | null,
    role: item["role"] as SessionRecord["role"],
    phase,
    startedAt: item["startedAt"] as number,
    expiresAt: item["expiresAt"] as number,
    clientTokenHash: item["clientTokenHash"] as string,
    observerTokenHash: (item["observerTokenHash"] ?? null) as string | null,
    endReason: (item["endReason"] ?? null) as SessionRecord["endReason"],
    endedAt: (item["endedAt"] ?? null) as number | null,
    endRequested: item["endRequested"] === true,
  };
}

export function createVoiceStore(options: VoiceDynamoOptions = {}): VoiceStore {
  const { client, table, now } = resolve(options);
  return {
    /** One conditional put: the lock is free, or its `expiresAt` has passed (takeover). */
    async acquireLock(key, sessionId, nowMs, expiresAtMs) {
      try {
        await client.send(
          new PutCommand({
            TableName: table,
            Item: {
              pk: `VOICELOCK#${key}`,
              sk: "LOCK",
              sessionId,
              expiresAt: expiresAtMs,
              ttl: epochS(nowMs) + LOCK_TTL_S,
            },
            ConditionExpression: "attribute_not_exists(pk) OR #expiresAt <= :now",
            ExpressionAttributeNames: { "#expiresAt": "expiresAt" },
            ExpressionAttributeValues: { ":now": nowMs },
          }),
        );
        return true;
      } catch (err) {
        if (isConditionFailed(err)) return false;
        throw err;
      }
    },

    async releaseLock(key, sessionId) {
      try {
        await client.send(
          new DeleteCommand({
            TableName: table,
            Key: { pk: `VOICELOCK#${key}`, sk: "LOCK" },
            ConditionExpression: "#sessionId = :sid",
            ExpressionAttributeNames: { "#sessionId": "sessionId" },
            ExpressionAttributeValues: { ":sid": sessionId },
          }),
        );
      } catch (err) {
        if (!isConditionFailed(err)) throw err;
      }
    },

    /** `ADD count 1` while the count is below the cap. The TTL is set once, at creation. */
    async incrementCounter(key, cap, ttlS) {
      try {
        const out = await client.send(
          new UpdateCommand({
            TableName: table,
            Key: { pk: key, sk: "COUNT" },
            UpdateExpression: "ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)",
            ConditionExpression: "attribute_not_exists(#count) OR #count < :cap",
            ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
            ExpressionAttributeValues: { ":one": 1, ":cap": cap, ":ttl": epochS(now()) + ttlS },
            ReturnValues: "UPDATED_NEW",
          }),
        );
        const count = out.Attributes?.["count"];
        return { allowed: true, count: typeof count === "number" ? count : 1 };
      } catch (err) {
        if (isConditionFailed(err)) return { allowed: false, count: cap };
        throw err;
      }
    },

    /** `ADD count -1`, only while the counter exists and is above zero. */
    async releaseCounter(key) {
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

    async putSession(rec) {
      // A closed list of fields on purpose: an extra property on `rec` never reaches the table.
      await client.send(
        new PutCommand({
          TableName: table,
          Item: {
            pk: `VOICE#${rec.sessionId}`,
            sk: "META",
            sessionId: rec.sessionId,
            deviceId: rec.deviceId,
            client: rec.client,
            target: rec.target,
            ownerSub: rec.ownerSub,
            role: rec.role,
            phase: rec.phase,
            startedAt: rec.startedAt,
            expiresAt: rec.expiresAt,
            clientTokenHash: rec.clientTokenHash,
            observerTokenHash: rec.observerTokenHash,
            endReason: rec.endReason,
            endedAt: rec.endedAt,
            endRequested: rec.endRequested,
            ttl: epochS(rec.startedAt) + SESSION_TTL_S,
          },
        }),
      );
    },

    async getSession(sessionId) {
      const got = await client.send(
        new GetCommand({
          TableName: table,
          Key: { pk: `VOICE#${sessionId}`, sk: "META" },
          ConsistentRead: true,
        }),
      );
      return got.Item === undefined ? null : toSession(got.Item as Item);
    },

    async readLook(requestId): Promise<LookItem | null> {
      const got = await client.send(
        new GetCommand({
          TableName: table,
          Key: { pk: `LOOK#${requestId}`, sk: "RESULT" },
          ConsistentRead: true,
        }),
      );
      const item = got.Item as Item | undefined;
      if (item === undefined) return null;
      const verdict = item["verdict"] as LookVerdict;
      if (!LOOK_VERDICTS.includes(verdict) || typeof item["at"] !== "number") return null;
      return { verdict, at: item["at"] };
    },

    /**
     * The newest `judgement.result` event stored for the encounter (`judge` appends the command it
     * publishes). The time is the envelope's `ts`, the cloud's own clock.
     */
    async encounterVerdict(encounterId): Promise<{ verdict: Verdict; atMs: number } | null> {
      let startKey: Record<string, unknown> | undefined;
      do {
        const out = await client.send(
          new QueryCommand({
            TableName: table,
            ConsistentRead: true,
            KeyConditionExpression: "pk = :p AND begins_with(sk, :evt)",
            ExpressionAttributeValues: { ":p": `ENC#${encounterId}`, ":evt": "EVT#" },
            ScanIndexForward: false,
            ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
          }),
        );
        for (const raw of out.Items ?? []) {
          const env = (raw as Item)["envelope"] as { type?: string; ts?: string; data?: { verdict?: Verdict } } | undefined;
          if (env?.type !== "judgement.result" || typeof env.ts !== "string") continue;
          const atMs = Date.parse(env.ts);
          const verdict = env.data?.verdict;
          if (!Number.isNaN(atMs) && verdict !== undefined) return { verdict, atMs };
        }
        startKey = out.LastEvaluatedKey;
      } while (startKey !== undefined);
      return null;
    },
  };
}

/** The `VOICE#HEALTH` item (R9.9). */
export function createHealthStore(options: VoiceDynamoOptions = {}): HealthStore {
  const { client, table, now } = resolve(options);
  const key = { pk: "VOICE#HEALTH", sk: "STATE" };
  return {
    async read(): Promise<HealthState | null> {
      const got = await client.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
      const item = got.Item as Item | undefined;
      if (item === undefined) return null;
      return {
        streak: typeof item["streak"] === "number" ? item["streak"] : 0,
        firstAtMs: typeof item["firstAtMs"] === "number" ? item["firstAtMs"] : 0,
        unhealthyUntilMs: typeof item["unhealthyUntilMs"] === "number" ? item["unhealthyUntilMs"] : 0,
      };
    },
    async write(state: HealthState): Promise<void> {
      await client.send(
        new PutCommand({
          TableName: table,
          Item: {
            ...key,
            streak: state.streak,
            firstAtMs: state.firstAtMs,
            unhealthyUntilMs: state.unhealthyUntilMs,
            ttl: epochS(now()) + HEALTH_TTL_S,
          },
        }),
      );
    },
  };
}

/** `deps.readCounter` of `voice-start`: today's count, 0 when the item does not exist. */
export function createReadCounter(options: VoiceDynamoOptions = {}): (key: string) => Promise<number> {
  const { client, table } = resolve(options);
  return async (key: string): Promise<number> => {
    const got = await client.send(
      new GetCommand({ TableName: table, Key: { pk: key, sk: "COUNT" }, ConsistentRead: true }),
    );
    const count = (got.Item as Item | undefined)?.["count"];
    return typeof count === "number" ? count : 0;
  };
}

/**
 * `deps.deviceOnline` of `voice-start`: the same rule as `GET /device/status` (`isOnline`). A failed
 * read counts as offline, like the command route.
 */
export function createDeviceOnline(
  statusIntervalS: number,
  options: VoiceDynamoOptions = {},
): (deviceId: string, nowMs: number) => Promise<boolean> {
  const { client, table } = resolve(options);
  return async (deviceId: string, nowMs: number): Promise<boolean> => {
    try {
      const got = await client.send(
        new GetCommand({
          TableName: table,
          Key: { pk: `DEV#${deviceId}`, sk: "STATUS" },
          ConsistentRead: true,
        }),
      );
      const item = got.Item as Item | undefined;
      const report = item?.["lastReportAtMs"];
      if (item === undefined || typeof report !== "number") return false;
      const offline = item["lastOfflineAtMs"];
      return isOnline(report, typeof offline === "number" ? offline : null, nowMs, statusIntervalS);
    } catch {
      return false;
    }
  };
}
