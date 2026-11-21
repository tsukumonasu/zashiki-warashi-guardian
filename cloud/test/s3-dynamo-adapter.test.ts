/**
 * Tests for the S3 and DynamoDB adapters (cloud-judgement task 16.4).
 *
 * Request and error shapes were checked against the AWS documentation:
 * - https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/understanding-ddb-log-entries.html
 *   (a cancelled TransactWriteItems fails with TransactionCanceledException and per-item reasons
 *   such as "[ConditionalCheckFailed, None]")
 * - https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_CancellationReason.html
 *   (CancellationReasons[].Code is a string and optional)
 * - https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html
 *   (conflicts and validation errors also cancel a transaction, so they are not "condition failed")
 * - https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.UpdateExpressions.html
 *   (one UpdateExpression may hold SET and ADD clauses; if_not_exists in SET)
 * - PutObject / DeleteObject / GetObject: S3 stores a PutObject whole or not at all; a missing
 *   key in GetObject raises NoSuchKey; presigning is local and needs no request.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  NOTIFY_SLOT_TTL_S,
  createRepository,
  createStateStore,
} from "../lambda/_shared/adapters/dynamo.js";
import {
  createSampleSource,
  createSnapshotStore,
  SIGN_TTL_S,
} from "../lambda/_shared/adapters/s3.js";

const awsError = (name: string, extra: object = {}) => Object.assign(new Error(name), { name, ...extra });

// ---------------------------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------------------------

describe("S3 snapshot store", () => {
  const s3 = new S3Client({
    region: "ap-northeast-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  const mock = mockClient(s3);
  beforeEach(() => mock.reset());
  const store = () => createSnapshotStore({ client: s3, bucket: "test-bucket" });
  const key = "snapshots/warashi-01/20261120/snap-1.jpg";

  it("puts the JPEG with its content type", async () => {
    mock.on(PutObjectCommand).resolves({});
    const jpeg = new Uint8Array([1, 2, 3]);
    await store().put(key, jpeg);
    const input = mock.commandCalls(PutObjectCommand)[0]?.args[0].input;
    expect(input).toMatchObject({ Bucket: "test-bucket", Key: key, ContentType: "image/jpeg", Body: jpeg });
    expect(mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it("deletes best-effort and rethrows the original error when the put fails", async () => {
    const original = awsError("RequestTimeout");
    mock.on(PutObjectCommand).rejects(original);
    mock.on(DeleteObjectCommand).rejects(awsError("InternalError"));
    await expect(store().put(key, new Uint8Array([1]))).rejects.toBe(original);
    expect(mock.commandCalls(DeleteObjectCommand)[0]?.args[0].input).toMatchObject({ Key: key });
  });

  it.each(["other/x.jpg", "snapshots/../x.jpg", "snapshots//x.jpg", "snapshots/"])(
    "refuses key %s",
    async (bad) => {
      await expect(store().put(bad, new Uint8Array([1]))).rejects.toBeInstanceOf(RangeError);
      await expect(store().signGet(bad, 60)).rejects.toBeInstanceOf(RangeError);
      expect(mock.calls()).toHaveLength(0);
    },
  );

  it("signs a GET URL with the requested lifetime", async () => {
    const url = new URL(await store().signGet(key, 120));
    expect(url.pathname).toContain(key);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(mock.calls()).toHaveLength(0);
  });

  it.each([0, -1, 1.5, SIGN_TTL_S + 1, Number.NaN])("rejects signing lifetime %s", async (ttl) => {
    await expect(store().signGet(key, ttl)).rejects.toBeInstanceOf(RangeError);
  });

  it("requires a bucket", () => {
    delete process.env.WARASHI_BUCKET_NAME;
    expect(() => createSnapshotStore({ client: s3 })).toThrow(/WARASHI_BUCKET_NAME/);
  });
});

describe("S3 sample source", () => {
  const s3 = new S3Client({ region: "ap-northeast-1" });
  const mock = mockClient(s3);
  beforeEach(() => mock.reset());
  const body = (text: string) => ({ transformToByteArray: async () => new TextEncoder().encode(text) });
  const source = () => createSampleSource({ client: s3, bucket: "test-bucket" });

  it("keeps valid manifest entries only", async () => {
    const manifest = JSON.stringify([
      { id: "a_1", label: "family" },
      { id: "Bad Id", label: "family" },
      { id: "b", label: "nope" },
    ]);
    mock.on(GetObjectCommand, { Key: "samples/manifest.json" }).resolves({ Body: body(manifest) as never });
    expect(await source().getSampleManifest()).toEqual([{ id: "a_1", label: "family" }]);
  });

  it("returns an empty manifest and no image for a missing object", async () => {
    mock.on(GetObjectCommand).rejects(awsError("NoSuchKey"));
    expect(await source().getSampleManifest()).toEqual([]);
    expect(await source().getSampleImage("a_1")).toBeNull();
  });

  it("surfaces other errors", async () => {
    mock.on(GetObjectCommand).rejects(awsError("AccessDenied"));
    await expect(source().getSampleManifest()).rejects.toThrow("AccessDenied");
  });

  it("does not read an image that is not in the manifest", async () => {
    mock
      .on(GetObjectCommand, { Key: "samples/manifest.json" })
      .resolves({ Body: body(JSON.stringify([{ id: "a", label: "family" }])) as never });
    expect(await source().getSampleImage("b")).toBeNull();
    expect(mock.commandCalls(GetObjectCommand)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// DynamoDB
// ---------------------------------------------------------------------------------------------

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

describe("DynamoDB state store", () => {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));
  const mock = mockClient(doc);
  beforeEach(() => mock.reset());
  const store = () => createStateStore({ client: doc, tableName: "t", now: () => NOW_MS });
  const conditional = () => awsError("ConditionalCheckFailedException");

  it("claim writes a conditional item with a ttl and returns true", async () => {
    mock.on(PutCommand).resolves({});
    expect(await store().claim("MSG#abc", 600)).toBe(true);
    const input = mock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(input?.TableName).toBe("t");
    expect(input?.Item).toMatchObject({ pk: "MSG#abc", sk: "DEDUP", ttl: NOW_S + 600 });
    expect(input?.ConditionExpression).toBe("attribute_not_exists(pk) OR #ttl <= :nowS");
    expect(input?.ExpressionAttributeValues).toEqual({ ":nowS": NOW_S });
  });

  it("claim conflict means 'not first'; other errors are surfaced", async () => {
    mock.on(PutCommand).rejectsOnce(conditional()).rejectsOnce(awsError("ProvisionedThroughputExceededException"));
    expect(await store().claim("MSG#abc", 600)).toBe(false);
    await expect(store().claim("MSG#abc", 600)).rejects.toThrow("ProvisionedThroughputExceededException");
  });

  it("claimNotifySlot sends one transaction with two conditional updates", async () => {
    mock.on(TransactWriteCommand).resolves({});
    expect(await store().claimNotifySlot("warashi-01", "enc-1", NOW_MS, 300_000)).toBe(true);
    const items = mock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]?.Update?.Key).toEqual({ pk: "ENC#enc-1", sk: "META" });
    expect(items[0]?.Update?.ConditionExpression).toContain("attribute_exists(pk)");
    expect(items[1]?.Update?.Key).toEqual({ pk: "NOTIFY#warashi-01", sk: "LAST" });
    expect(items[1]?.Update?.ExpressionAttributeValues).toMatchObject({
      ":nowMs": NOW_MS,
      ":cutoff": NOW_MS - 300_000,
      ":ttl": NOW_S + NOTIFY_SLOT_TTL_S,
    });
  });

  it("maps a condition-only cancellation to false", async () => {
    const reasons = [{ Code: "ConditionalCheckFailed" }, { Code: "None" }];
    mock.on(TransactWriteCommand).rejects(awsError("TransactionCanceledException", { CancellationReasons: reasons }));
    expect(await store().claimNotifySlot("d", "e", NOW_MS, 1)).toBe(false);
  });

  it.each([
    [[{ Code: "ConditionalCheckFailed" }, { Code: "TransactionConflict" }]],
    [[{ Code: "ThrottlingError" }, { Code: "None" }]],
    [[{ Code: "None" }, { Code: "None" }]],
    [undefined],
  ])("surfaces a cancellation that is not condition-only (%j)", async (reasons) => {
    mock.on(TransactWriteCommand).rejects(awsError("TransactionCanceledException", { CancellationReasons: reasons }));
    await expect(store().claimNotifySlot("d", "e", NOW_MS, 1)).rejects.toThrow("TransactionCanceledException");
  });

  it("incrementCounter uses ADD with the limit condition and a ttl set once", async () => {
    mock.on(UpdateCommand).resolves({ Attributes: { count: 3 } });
    expect(await store().incrementCounter("RATE#x#1", 5, 3600)).toEqual({ allowed: true, count: 3 });
    const input = mock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.Key).toEqual({ pk: "RATE#x#1", sk: "COUNT" });
    expect(input?.UpdateExpression).toBe("ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)");
    expect(input?.ConditionExpression).toBe("attribute_not_exists(#count) OR #count < :limit");
    expect(input?.ExpressionAttributeValues).toEqual({ ":one": 1, ":limit": 5, ":ttl": NOW_S + 3600 });
  });

  it("incrementCounter reports the limit when the condition fails and surfaces other errors", async () => {
    mock.on(UpdateCommand).rejectsOnce(conditional()).rejectsOnce(awsError("InternalServerError"));
    expect(await store().incrementCounter("k", 5, 60)).toEqual({ allowed: false, count: 5 });
    await expect(store().incrementCounter("k", 5, 60)).rejects.toThrow("InternalServerError");
  });

  it("releaseCounter decrements only above zero and ignores a failed condition", async () => {
    mock.on(UpdateCommand).rejects(conditional());
    await store().releaseCounter("k");
    const input = mock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.UpdateExpression).toBe("ADD #count :minusOne");
    expect(input?.ConditionExpression).toBe("attribute_exists(pk) AND #count > :zero");
  });
});

describe("DynamoDB repository", () => {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-northeast-1" }));
  const mock = mockClient(doc);
  beforeEach(() => mock.reset());
  const samples = { getSampleManifest: async () => [], getSampleImage: async () => null };
  const repo = () => createRepository({ client: doc, tableName: "t", now: () => NOW_MS, samples });
  const meta = {
    encounterId: "enc-1",
    deviceId: "warashi-01",
    startedAt: "2026-11-20T12:00:00.000Z",
    endedAt: null,
    state: null,
    verdict: null,
    confidence: null,
    reaction: null,
    notified: false,
    snapshotKey: null,
    errorCount: 0,
  };

  it("createEncounterIfAbsent writes GSI keys and a ttl, and maps a conflict to false", async () => {
    mock.on(PutCommand).resolvesOnce({}).rejectsOnce(awsError("ConditionalCheckFailedException"));
    expect(await repo().createEncounterIfAbsent(meta, 7200)).toBe(true);
    const input = mock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(input?.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(input?.Item).toMatchObject({
      pk: "ENC#enc-1",
      sk: "META",
      gsi1pk: "DEV#warashi-01",
      gsi1sk: meta.startedAt,
      ttl: NOW_S + 7200,
    });
    expect(input?.Item).not.toHaveProperty("encounterId");
    expect(await repo().createEncounterIfAbsent(meta, 7200)).toBe(false);
  });

  it("updateEncounter requires the item to exist", async () => {
    mock.on(UpdateCommand).rejects(awsError("ConditionalCheckFailedException"));
    expect(await repo().updateEncounter("enc-1", { notified: true })).toBe(false);
    expect(mock.commandCalls(UpdateCommand)[0]?.args[0].input.ConditionExpression).toBe("attribute_exists(pk)");
  });

  it("listEncounters queries GSI1 newest first and hides the extra item behind a cursor", async () => {
    const item = (n: number) => ({
      pk: `ENC#e${n}`,
      sk: "META",
      deviceId: "warashi-01",
      startedAt: `2026-11-20T12:00:0${n}.000Z`,
    });
    mock.on(QueryCommand).resolves({ Items: [item(3), item(2), item(1)] });
    const page = await repo().listEncounters("warashi-01", 2, null, NOW_MS);
    const input = mock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input).toMatchObject({ IndexName: "GSI1", ScanIndexForward: false, Limit: 3 });
    expect(input?.ExpressionAttributeValues).toEqual({ ":p": "DEV#warashi-01", ":nowS": NOW_S });
    expect(page.items.map((i) => i.encounterId)).toEqual(["e3", "e2"]);
    expect(page.nextCursor).not.toBeNull();

    mock.reset();
    mock.on(QueryCommand).resolves({ Items: [item(1)] });
    expect((await repo().listEncounters("warashi-01", 2, null, NOW_MS)).nextCursor).toBeNull();
  });

  it("listEncounters rejects a cursor for another device", async () => {
    const cursor = Buffer.from(JSON.stringify({ e: "e", d: "other", s: "x" })).toString("base64url");
    await expect(repo().listEncounters("warashi-01", 2, cursor, NOW_MS)).rejects.toThrow("invalid cursor");
    await expect(repo().listEncounters("warashi-01", 2, "!!", NOW_MS)).rejects.toThrow("invalid cursor");
  });

  it("appendEvent stores a ttl and refuses image data", async () => {
    mock.on(PutCommand).resolves({});
    const envelope = {
      v: 1,
      id: "m1",
      ts: "2026-11-20T12:00:00.000Z",
      deviceId: "warashi-01",
      encounterId: "enc-1",
      type: "state.changed",
      data: {},
    };
    await repo().appendEvent("enc-1", envelope as never, 100);
    expect(mock.commandCalls(PutCommand)[0]?.args[0].input.Item).toMatchObject({
      pk: "ENC#enc-1",
      sk: "EVT#2026-11-20T12:00:00.000Z#m1",
      ttl: NOW_S + 100,
    });
    await expect(
      repo().appendEvent("enc-1", { ...envelope, data: { jpegBase64: "AAAA" } } as never, 100),
    ).rejects.toBeInstanceOf(RangeError);
    expect(mock.commandCalls(PutCommand)).toHaveLength(1);
  });
});
