/**
 * Handler tests with mocked AWS clients (cloud-judgement task 17.4).
 *
 * Each Lambda entry point runs end to end: the real handler, the real core and the real adapters,
 * with `aws-sdk-client-mock` standing in for the SDK clients. The handlers build their adapters
 * at module scope from environment variables, so every test sets the environment first, resets
 * the module registry and imports the handler afresh. No test touches the network; the global
 * guard in `test/setup.ts` fails any attempt.
 *
 * Requirements: 4.5, 5.16, 13.3, 13.6, 14.5, 15.12, 17.2.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { IoTDataPlaneClient, PublishCommand as IotPublishCommand } from "@aws-sdk/client-iot-data-plane";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import {
  DeleteFacesCommand,
  DetectFacesCommand,
  IndexFacesCommand,
  RekognitionClient,
  SearchFacesByImageCommand,
} from "@aws-sdk/client-rekognition";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PublishCommand as SnsPublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiGatewayEventV2, HttpResponse } from "../lambda/_shared/http.js";

// ---------------------------------------------------------------------------------------------
// Mocks and environment
// ---------------------------------------------------------------------------------------------

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);
const rek = mockClient(RekognitionClient);
const iot = mockClient(IoTDataPlaneClient);
const sns = mockClient(SNSClient);
const lambda = mockClient(LambdaClient);
const bedrock = mockClient(BedrockRuntimeClient);
const polly = mockClient(PollyClient);
/** The few methods the tests use on every mock, so the differently typed mocks fit one array. */
type AnyMock = {
  reset(): unknown;
  resetHistory(): unknown;
  onAnyCommand(): { resolves(value: unknown): unknown };
  calls(): readonly unknown[];
};
const allMocks: AnyMock[] = [ddb, s3, rek, iot, sns, lambda, bedrock, polly] as unknown as AnyMock[];

const totalCalls = (): number => allMocks.reduce((sum, mock) => sum + mock.calls().length, 0);

const BASE_ENV: Record<string, string> = {
  AWS_REGION: "ap-northeast-1",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  WARASHI_TABLE_NAME: "test-table",
  WARASHI_BUCKET_NAME: "test-bucket",
  IOT_DATA_ENDPOINT: "iot.example.invalid",
  NOTIFY_TOPIC_ARN: "test-topic",
  WARASHI_DASHBOARD_URL: "https://dashboard.example.invalid",
  WARASHI_SIGNER_FUNCTION_NAME: "test-signer",
  WARASHI_BEDROCK_MODEL_ID: "test-model",
  WARASHI_WEB_ORIGIN: "https://dashboard.example.invalid",
};

const touchedKeys = new Set<string>();
const savedEnv = new Map<string, string | undefined>();

/** Sets `values` on top of the base environment; `undefined` removes a variable. */
function applyEnv(overrides: Record<string, string | undefined> = {}): void {
  const merged: Record<string, string | undefined> = { ...BASE_ENV, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (!touchedKeys.has(key)) {
      touchedKeys.add(key);
      savedEnv.set(key, process.env[key]);
    }
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

type Env = Record<string, string | undefined>;

async function loadJudge(env: Env = {}) {
  applyEnv(env);
  vi.resetModules();
  return (await import("../lambda/judge/index.js")).handler;
}
async function loadIngest(env: Env = {}) {
  applyEnv(env);
  vi.resetModules();
  return (await import("../lambda/ingest/index.js")).handler;
}
async function loadApiRead(env: Env = {}) {
  applyEnv(env);
  vi.resetModules();
  return (await import("../lambda/api-read/index.js")).handler;
}
async function loadApiSimulate(env: Env = {}) {
  applyEnv(env);
  vi.resetModules();
  return (await import("../lambda/api-simulate/index.js")).handler;
}
async function loadApiAdmin(env: Env = {}) {
  applyEnv(env);
  vi.resetModules();
  return (await import("../lambda/api-admin/index.js")).handler;
}
async function loadSigner(env: Env = {}) {
  applyEnv(env);
  vi.resetModules();
  return (await import("../lambda/snapshot-signer/index.js")).handler;
}

const awsError = (name: string) => Object.assign(new Error(name), { name });
const conditionFailed = () => awsError("ConditionalCheckFailedException");

/** The shape the SDK returns for an S3 body: only `transformToByteArray` is used. */
const body = (bytes: Uint8Array | string) =>
  ({
    transformToByteArray: async () => (typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes),
  }) as never;

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

beforeEach(() => {
  for (const mock of allMocks) {
    mock.reset();
    mock.onAnyCommand().resolves({});
  }
  // The handlers log through console.log; keep the test output quiet.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  applyEnv();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  touchedKeys.clear();
  savedEnv.clear();
});

// ---------------------------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------------------------

type ApiOptions = {
  /** `null` removes the `sub` claim (an unauthenticated call). */
  sub?: string | null;
  /** Cognito groups; `null` gives a token without the claim. */
  groups?: string[] | null;
  body?: unknown;
  query?: Record<string, string>;
  pathParameters?: Record<string, string>;
  origin?: string;
};

function apiEvent(route: string, options: ApiOptions = {}): ApiGatewayEventV2 {
  const [method = "GET", path = "/"] = route.split(" ");
  const claims: Record<string, unknown> = {};
  if (options.sub !== null) claims["sub"] = options.sub ?? "user-1";
  if (options.groups !== null) claims["cognito:groups"] = options.groups ?? ["family"];
  return {
    routeKey: route,
    rawPath: path,
    requestContext: { http: { method, path }, authorizer: { jwt: { claims } } },
    headers: options.origin === undefined ? {} : { origin: options.origin },
    queryStringParameters: options.query,
    pathParameters: options.pathParameters,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    isBase64Encoded: false,
  };
}

type Json = Record<string, unknown>;
/** A parsed response body. Loosely typed on purpose: the tests probe nested fields by name. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
const parse = (response: HttpResponse): Loose => JSON.parse(response.body);
const errorCode = (response: HttpResponse): unknown => parse(response)["error"]?.code;

type ApiHandler = (event: ApiGatewayEventV2) => Promise<HttpResponse>;

/** Every API handler answers 401 without a subject and 403 without a role, with no AWS call. */
function describeAuthGate(name: string, load: () => Promise<ApiHandler>, route: string, options: ApiOptions = {}) {
  describe(`${name}: authentication gate`, () => {
    it("answers 401 without a signed-in user and calls no AWS service", async () => {
      const handler = await load();
      const response = await handler(apiEvent(route, { ...options, sub: null }));
      expect(response.statusCode).toBe(401);
      expect(errorCode(response)).toBe("unauthorized");
      expect(totalCalls()).toBe(0);
    });

    it("answers 403 for a token without a known group and calls no AWS service", async () => {
      const handler = await load();
      for (const groups of [null, [], ["other"]]) {
        const response = await handler(apiEvent(route, { ...options, groups }));
        expect(response.statusCode).toBe(403);
        expect(errorCode(response)).toBe("forbidden");
      }
      expect(totalCalls()).toBe(0);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------------------------

describe("judge handler", () => {
  const DEVICE = "warashi-01";
  const ENCOUNTER = "c1d2e3f4-0000-4000-8000-000000000001";
  const BOX = { Left: 0.3, Top: 0.2, Width: 0.3, Height: 0.4 };

  function snapshotEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const jpeg = Buffer.from(new Uint8Array(1000).fill(1).map((v, i) => (i === 0 ? 0xff : i === 1 ? 0xd8 : i === 2 ? 0xff : v)));
    return {
      v: 1,
      id: "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10",
      ts: "2026-11-20T12:34:56.789Z",
      deviceId: DEVICE,
      encounterId: ENCOUNTER,
      type: "snapshot.captured",
      data: {
        snapshotId: "snap-1",
        width: 640,
        height: 480,
        panDeg: 0,
        tiltDeg: 0,
        jpegBase64: jpeg.toString("base64"),
      },
      topicDeviceId: DEVICE,
      ...overrides,
    };
  }

  function publishedCommand(): Json {
    const calls = iot.commandCalls(IotPublishCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.qos).toBe(1);
    expect(input.topic).toBe(`warashi/${DEVICE}/commands`);
    return JSON.parse(new TextDecoder().decode(input.payload as Uint8Array)) as Json;
  }

  it("judges a family member: claims, stores, publishes, records, sends no notification", async () => {
    rek.on(SearchFacesByImageCommand).resolves({
      SearchedFaceBoundingBox: BOX,
      SearchedFaceConfidence: 99.9,
      FaceMatches: [{ Similarity: 98 }],
    });
    const handler = await loadJudge();

    const result = await handler(snapshotEvent());

    expect(result).toEqual({ outcome: "judged", verdict: "family", published: true, stored: true, notified: false });
    const claim = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect(claim.Item).toMatchObject({ pk: "SNAP#snap-1" });
    const puts = s3.commandCalls(PutObjectCommand);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.args[0].input.Key).toBe(`snapshots/${DEVICE}/20261120/snap-1.jpg`);
    const command = publishedCommand();
    expect(command).toMatchObject({ type: "judgement.result", deviceId: DEVICE, encounterId: ENCOUNTER });
    expect(command["data"]).toMatchObject({ snapshotId: "snap-1", verdict: "family" });
    expect(sns.commandCalls(SnsPublishCommand)).toHaveLength(0);
  });

  it("judges a stranger and sends exactly one notification", async () => {
    rek.on(SearchFacesByImageCommand).resolves({
      SearchedFaceBoundingBox: BOX,
      SearchedFaceConfidence: 99.9,
      FaceMatches: [],
    });
    rek.on(DetectFacesCommand).resolves({
      FaceDetails: [{ BoundingBox: BOX, Quality: { Sharpness: 80, Brightness: 120 }, Pose: { Yaw: 5 } }],
    });
    ddb.on(GetCommand).callsFake((input: { Key: { pk: string } }) =>
      input.Key.pk.startsWith("ENC#")
        ? { Item: { pk: input.Key.pk, sk: "META", deviceId: DEVICE, startedAt: "2026-11-20T12:34:56.789Z", notified: false } }
        : {},
    );
    const handler = await loadJudge();

    const result = await handler(snapshotEvent());

    expect(result).toMatchObject({ outcome: "judged", verdict: "stranger", published: true, notified: true });
    expect(publishedCommand()["data"]).toMatchObject({ verdict: "stranger" });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
    const notices = sns.commandCalls(SnsPublishCommand);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.args[0].input.TopicArn).toBe("test-topic");
  });

  it("treats a redelivered snapshot as a duplicate and does nothing else", async () => {
    ddb.on(PutCommand).rejects(conditionFailed());
    const handler = await loadJudge();

    const result = await handler(snapshotEvent());

    expect(result).toEqual({ outcome: "duplicate" });
    expect(rek.calls()).toHaveLength(0);
    expect(s3.calls()).toHaveLength(0);
    expect(iot.calls()).toHaveLength(0);
    expect(sns.calls()).toHaveLength(0);
  });

  it("throws when the claim write fails, so the message can be redelivered (R4.5)", async () => {
    ddb.on(PutCommand).rejects(awsError("ProvisionedThroughputExceededException"));
    const handler = await loadJudge();

    await expect(handler(snapshotEvent())).rejects.toMatchObject({ name: "ProvisionedThroughputExceededException" });
    expect(rek.calls()).toHaveLength(0);
    expect(iot.calls()).toHaveLength(0);
  });

  it("ignores a message whose deviceId differs from the topic, with no side effect", async () => {
    const handler = await loadJudge();

    const result = await handler(snapshotEvent({ topicDeviceId: "warashi-02" }));

    expect(result).toEqual({ outcome: "ignored", reason: "security_mismatch" });
    expect(totalCalls()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------------------------

describe("ingest handler", () => {
  const DEVICE = "warashi-01";
  const ENCOUNTER = "c1d2e3f4-0000-4000-8000-000000000001";

  const envelope = (type: string, data: unknown, extra: Record<string, unknown> = {}) => ({
    v: 1,
    id: "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a03",
    ts: "2026-11-20T12:34:56.789Z",
    deviceId: DEVICE,
    encounterId: ENCOUNTER,
    type,
    data,
    topicDeviceId: DEVICE,
    ...extra,
  });

  it("stores a state change and updates the encounter", async () => {
    const handler = await loadIngest();

    const result = await handler(envelope("state.changed", { from: "sleeping", to: "waking", reason: "presence" }));

    expect(result).toEqual({ outcome: "event_stored" });
    const keys = ddb.commandCalls(PutCommand).map((call) => String(call.args[0].input.Item?.["pk"]));
    expect(keys).toContain("MSG#0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a03");
    expect(keys.filter((key) => key === `ENC#${ENCOUNTER}`).length).toBeGreaterThanOrEqual(2);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  it("stores a snapshot event without the image and with hasImage", async () => {
    const handler = await loadIngest();

    const result = await handler(
      envelope("snapshot.captured", {
        snapshotId: "snap-1",
        width: 640,
        height: 480,
        panDeg: 0,
        tiltDeg: 0,
        jpegBase64: "/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==",
      }),
    );

    expect(result).toEqual({ outcome: "event_stored" });
    const event = ddb
      .commandCalls(PutCommand)
      .map((call) => call.args[0].input.Item)
      .find((item) => String(item?.["sk"]).startsWith("EVT#"));
    expect(event).toBeDefined();
    const data = (event as { envelope: { data: Record<string, unknown> } }).envelope.data;
    expect(data["hasImage"]).toBe(true);
    expect(data).not.toHaveProperty("jpegBase64");
    expect(JSON.stringify(ddb.calls().map((call) => call.args[0].input))).not.toContain("/9j/");
  });

  it("stores a status report with the arrival time", async () => {
    const handler = await loadIngest();

    const result = await handler(
      envelope(
        "status.report",
        {
          state: "sleeping",
          mode: "guard",
          panDeg: 0,
          tiltDeg: 0,
          lantern: 0,
          cameraActive: false,
          micActive: false,
          motionEnabled: false,
          uptimeSec: 3600,
          agentVersion: "0.1.0",
        },
        { encounterId: null },
      ),
    );

    expect(result).toEqual({ outcome: "status_stored" });
    const update = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(update.Key).toEqual({ pk: `DEV#${DEVICE}`, sk: "STATUS" });
    expect(update.ExpressionAttributeValues?.[":at"]).toEqual(expect.any(Number));
  });

  it("drops a duplicate message without storing anything", async () => {
    ddb.on(PutCommand).rejects(conditionFailed());
    const handler = await loadIngest();

    const result = await handler(envelope("state.changed", { from: "sleeping", to: "waking", reason: "presence" }));

    expect(result).toEqual({ outcome: "duplicate" });
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("drops a message whose deviceId differs from the topic", async () => {
    const handler = await loadIngest();

    const result = await handler(envelope("state.changed", { from: "sleeping", to: "waking", reason: "presence" }, { topicDeviceId: "warashi-02" }));

    expect(result).toEqual({ outcome: "mismatch" });
    expect(totalCalls()).toBe(0);
  });

  it("throws on a table write failure and releases the claim, so the message can be redelivered", async () => {
    ddb.on(QueryCommand).rejects(awsError("InternalServerError"));
    const handler = await loadIngest();

    await expect(
      handler(envelope("state.changed", { from: "sleeping", to: "waking", reason: "presence" })),
    ).rejects.toMatchObject({ name: "IngestWriteError" });
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// api-read
// ---------------------------------------------------------------------------------------------

describe("api-read handler", () => {
  const SIGNED = "https://signed.example.invalid/snap";
  const KEY = "snapshots/warashi-01/20261120/snap-1.jpg";
  const encounterItem = {
    pk: "ENC#enc-1",
    sk: "META",
    deviceId: "warashi-01",
    startedAt: "2026-11-20T12:34:56.789Z",
    endedAt: null,
    state: "cooldown",
    verdict: "family",
    confidence: 0.97,
    notified: false,
    snapshotKey: KEY,
  };

  const signerReplies = () =>
    lambda.on(InvokeCommand).resolves({
      StatusCode: 200,
      Payload: new TextEncoder().encode(JSON.stringify({ ok: true, url: SIGNED })) as never,
    });

  describeAuthGate("api-read", () => loadApiRead(), "GET /me");

  it("denies a route that is not in its table, even for family", async () => {
    const handler = await loadApiRead();
    const response = await handler(apiEvent("POST /commands", { body: {} }));
    expect(response.statusCode).toBe(403);
    expect(totalCalls()).toBe(0);
  });

  it("GET /me gives each role its own limits and sets CORS for the dashboard origin only", async () => {
    const handler = await loadApiRead({ WARASHI_FAMILY_SIMULATE_PER_HOUR: "7", WARASHI_REVIEWER_SIMULATE_PER_HOUR: "2" });

    const family = await handler(apiEvent("GET /me", { origin: "https://dashboard.example.invalid" }));
    expect(family.statusCode).toBe(200);
    expect(parse(family)).toMatchObject({ role: "family", consentNoticeVersion: "1", limits: { simulatePerHour: 7 } });
    expect(family.headers["Access-Control-Allow-Origin"]).toBe("https://dashboard.example.invalid");

    const reviewer = await handler(apiEvent("GET /me", { groups: ["reviewer"], origin: "https://evil.example.invalid" }));
    expect(parse(reviewer)).toMatchObject({ role: "reviewer", limits: { simulatePerHour: 2 } });
    expect(reviewer.headers).not.toHaveProperty("Access-Control-Allow-Origin");
  });

  it("GET /samples returns ids and labels from the manifest", async () => {
    s3.on(GetObjectCommand, { Key: "samples/manifest.json" }).resolves({
      Body: body(JSON.stringify([{ id: "s1", label: "family" }, { id: "bad id", label: "family" }])),
    });
    const handler = await loadApiRead();

    const response = await handler(apiEvent("GET /samples", { groups: ["reviewer"] }));

    expect(response.statusCode).toBe(200);
    expect(parse(response)).toEqual({ samples: [{ sampleId: "s1", label: "family" }] });
  });

  it("GET /encounters gives family a signed snapshot URL and reviewer an illustration without the signer", async () => {
    ddb.on(QueryCommand).resolves({ Items: [encounterItem] });
    signerReplies();
    const handler = await loadApiRead();

    const family = await handler(apiEvent("GET /encounters"));
    expect(family.statusCode).toBe(200);
    expect(parse(family)["items"][0]).toMatchObject({ encounterId: "enc-1", snapshot: { url: SIGNED }, illustration: null });
    expect(lambda.commandCalls(InvokeCommand)).toHaveLength(1);

    lambda.resetHistory();
    const reviewer = await handler(apiEvent("GET /encounters", { groups: ["reviewer"] }));
    expect(reviewer.statusCode).toBe(200);
    const item = parse(reviewer)["items"][0];
    expect(item).toMatchObject({ encounterId: "enc-1", snapshot: null, illustration: "silhouette-family" });
    expect(reviewer.body).not.toContain(KEY);
    expect(reviewer.body).not.toContain(SIGNED);
    expect(lambda.calls()).toHaveLength(0);
  });

  it("GET /encounters hides the picture but keeps the encounter when signing fails", async () => {
    ddb.on(QueryCommand).resolves({ Items: [encounterItem] });
    lambda.on(InvokeCommand).rejects(awsError("ServiceException"));
    const handler = await loadApiRead();

    const response = await handler(apiEvent("GET /encounters"));

    expect(response.statusCode).toBe(200);
    expect(parse(response)["items"][0]).toMatchObject({ encounterId: "enc-1", snapshot: null });
  });

  it("GET /encounters answers 400 for a bad limit or cursor and reads nothing", async () => {
    const handler = await loadApiRead();
    for (const query of [{ limit: "0" }, { limit: "51" }, { limit: "abc" }, { cursor: "not valid!" }] as Record<string, string>[]) {
      const response = await handler(apiEvent("GET /encounters", { query }));
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe("validation_failed");
    }
    // A well-formed cursor that this API never issued is also a 400.
    const unissued = await handler(apiEvent("GET /encounters", { query: { cursor: "abc" } }));
    expect(unissued.statusCode).toBe(400);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("GET /encounters/{id} returns the record with its events, 404 for an unknown id", async () => {
    ddb.on(GetCommand).resolves({ Item: encounterItem });
    ddb.on(QueryCommand).resolves({ Items: [] });
    signerReplies();
    const handler = await loadApiRead();

    const found = await handler(apiEvent("GET /encounters/{id}", { pathParameters: { id: "enc-1" } }));
    expect(found.statusCode).toBe(200);
    expect(parse(found)).toMatchObject({ encounterId: "enc-1", events: [], snapshot: { url: SIGNED } });

    ddb.on(GetCommand).resolves({});
    const missing = await handler(apiEvent("GET /encounters/{id}", { pathParameters: { id: "enc-2" } }));
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing)).toBe("not_found");
  });

  it("hides real encounters from the reviewer when the owner sets reviewerRealEncounters to hidden", async () => {
    ddb.on(GetCommand).resolves({ Item: encounterItem });
    const handler = await loadApiRead({ WARASHI_REVIEWER_REAL_ENCOUNTERS: "hidden" });

    const list = await handler(apiEvent("GET /encounters", { groups: ["reviewer"] }));
    expect(parse(list)).toEqual({ items: [], nextCursor: null });
    const one = await handler(apiEvent("GET /encounters/{id}", { groups: ["reviewer"], pathParameters: { id: "enc-1" } }));
    expect(one.statusCode).toBe(404);
    expect(ddb.calls()).toHaveLength(0);
  });

  it("GET /device/status reports online for a fresh report, 400 for a bad deviceId", async () => {
    ddb.on(GetCommand).resolves({ Item: { status: { state: "sleeping", mode: "guard" }, lastReportAtMs: Date.now() } });
    const handler = await loadApiRead();

    const ok = await handler(apiEvent("GET /device/status", { query: { deviceId: "warashi-01" } }));
    expect(ok.statusCode).toBe(200);
    expect(parse(ok)).toMatchObject({ deviceId: "warashi-01", online: true, status: { state: "sleeping" } });

    const bad = await handler(apiEvent("GET /device/status", { query: { deviceId: "../x" } }));
    expect(bad.statusCode).toBe(400);
  });

  it("answers 500 internal with a fixed message when a table read fails", async () => {
    ddb.on(QueryCommand).rejects(new Error("secret table detail"));
    const handler = await loadApiRead();

    const response = await handler(apiEvent("GET /encounters"));

    expect(response.statusCode).toBe(500);
    expect(errorCode(response)).toBe("internal");
    expect(response.body).not.toContain("secret table detail");
  });
});

// ---------------------------------------------------------------------------------------------
// api-simulate
// ---------------------------------------------------------------------------------------------

describe("api-simulate handler", () => {
  const BOX = { Left: 0.3, Top: 0.2, Width: 0.3, Height: 0.4 };

  function samplesExist(): void {
    s3.on(GetObjectCommand).callsFake((input: { Key: string }) => {
      if (input.Key === "samples/manifest.json") return { Body: body(JSON.stringify([{ id: "s1", label: "family" }])) };
      if (input.Key === "samples/s1.jpg") return { Body: body(JPEG) };
      throw awsError("NoSuchKey");
    });
  }
  function familyFace(): void {
    rek.on(SearchFacesByImageCommand).resolves({
      SearchedFaceBoundingBox: BOX,
      SearchedFaceConfidence: 99.9,
      FaceMatches: [{ Similarity: 98 }],
    });
  }

  describeAuthGate("api-simulate", () => loadApiSimulate(), "POST /simulate", { body: { sampleId: "s1" } });

  it("runs the verdict path on a sample and returns the commands without publishing or storing", async () => {
    samplesExist();
    familyFace();
    const handler = await loadApiSimulate();

    for (const groups of [["reviewer"], ["family"]]) {
      const response = await handler(apiEvent("POST /simulate", { groups, body: { sampleId: "s1" } }));
      expect(response.statusCode).toBe(200);
      const result = parse(response);
      expect(result).toMatchObject({ sampleId: "s1", verdict: "family" });
      expect((result["commands"] as { type: string }[]).map((c) => c.type)).toEqual(["judgement.result", "speak"]);
      expect(result["commands"][0]).toMatchObject({ deviceId: "warashi-sim", encounterId: null });
      expect(result["speech"]).toMatchObject({ generated: false, mp3Url: null });
      expect(result["latencyMs"].search).toBeLessThanOrEqual(result["latencyMs"].total);
    }
    expect(iot.calls()).toHaveLength(0);
    expect(sns.calls()).toHaveLength(0);
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    // Only the demo collection is searched.
    expect(rek.commandCalls(SearchFacesByImageCommand)[0]!.args[0].input.CollectionId).toBe("warashi-demo");
  });

  it("generates speech, stores the MP3 under audio/sim/ and returns a pre-signed URL", async () => {
    samplesExist();
    familyFace();
    bedrock.on(InvokeModelCommand).resolves({
      body: new TextEncoder().encode(
        JSON.stringify({ output: { message: { content: [{ text: '{"ja":"おかえりなさい。","en":"Welcome back."}' }] } } }),
      ) as never,
    });
    polly.on(SynthesizeSpeechCommand).resolves({ AudioStream: body(new Uint8Array([1, 2, 3])) });
    const handler = await loadApiSimulate();

    const response = await handler(apiEvent("POST /simulate", { body: { sampleId: "s1", generate: true } }));

    expect(response.statusCode).toBe(200);
    const speech = parse(response)["speech"];
    expect(speech).toMatchObject({ generated: true, ja: "おかえりなさい。", en: "Welcome back." });
    expect(String(speech.mp3Url)).toContain("/audio/sim/");
    expect(String(speech.mp3Url)).toContain("X-Amz-Expires=300");
    const put = s3.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(String(put.Key)).toMatch(/^audio\/sim\/.+\.mp3$/);
  });

  it("falls back to a cached line when Bedrock fails", async () => {
    samplesExist();
    familyFace();
    bedrock.on(InvokeModelCommand).rejects(awsError("ThrottlingException"));
    const handler = await loadApiSimulate();

    const response = await handler(apiEvent("POST /simulate", { body: { sampleId: "s1", generate: true } }));

    expect(response.statusCode).toBe(200);
    expect(parse(response)["speech"]).toMatchObject({ generated: false, mp3Url: null });
  });

  it("answers 400 for a missing, malformed or unknown sampleId and a non-boolean generate", async () => {
    samplesExist();
    const handler = await loadApiSimulate();
    for (const bodyValue of [{}, { sampleId: "Bad Id" }, { sampleId: "nope" }, { sampleId: "s1", generate: "yes" }]) {
      const response = await handler(apiEvent("POST /simulate", { body: bodyValue }));
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe("validation_failed");
    }
    expect(rek.calls()).toHaveLength(0);
  });

  it("answers 400 for malformed JSON", async () => {
    const handler = await loadApiSimulate();
    const event = apiEvent("POST /simulate");
    event.body = "{not json";
    const response = await handler(event);
    expect(response.statusCode).toBe(400);
    expect(totalCalls()).toBe(0);
  });

  it("answers 429 with Retry-After when a counter is full, before any search", async () => {
    samplesExist();
    ddb.on(UpdateCommand).rejects(conditionFailed());
    const handler = await loadApiSimulate();

    const response = await handler(apiEvent("POST /simulate", { groups: ["reviewer"], body: { sampleId: "s1" } }));

    expect(response.statusCode).toBe(429);
    expect(errorCode(response)).toBe("rate_limited");
    const retryAfter = Number(response.headers["Retry-After"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(86_400);
    expect(rek.calls()).toHaveLength(0);
    expect(polly.calls()).toHaveLength(0);
  });

  it("answers 500 without a partial result when the search fails", async () => {
    samplesExist();
    rek.on(SearchFacesByImageCommand).rejects(awsError("AccessDeniedException"));
    const handler = await loadApiSimulate();

    const response = await handler(apiEvent("POST /simulate", { body: { sampleId: "s1" } }));

    expect(response.statusCode).toBe(500);
    expect(parse(response)).toEqual({ error: { code: "internal", message: "Simulation failed." } });
  });
});

// ---------------------------------------------------------------------------------------------
// api-admin
// ---------------------------------------------------------------------------------------------

describe("api-admin handler", () => {
  const MEMBER_ID = "11111111-1111-4111-8111-111111111111";
  const STAGING_KEY = "faces-staging/abc123";
  const consent = { noticeVersion: "1", accepted: true };
  const registerBody = (extra: Record<string, unknown> = {}) => ({
    stagingKey: STAGING_KEY,
    displayName: "Test Member",
    consent,
    ...extra,
  });

  describeAuthGate("api-admin", () => loadApiAdmin(), "POST /commands", {
    body: { deviceId: "warashi-01", command: { type: "mode.set", data: { mode: "guard" } } },
  });

  describe("POST /commands", () => {
    it("clamps a gaze command, publishes it once with QoS 1 and answers 202", async () => {
      const handler = await loadApiAdmin();

      const response = await handler(
        apiEvent("POST /commands", {
          body: { deviceId: "warashi-01", command: { type: "gaze", data: { panDeg: 100, tiltDeg: -100 } } },
        }),
      );

      expect(response.statusCode).toBe(202);
      expect(parse(response)).toMatchObject({ deviceOnline: false });
      const calls = iot.commandCalls(IotPublishCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0].input;
      expect(input.qos).toBe(1);
      expect(input.topic).toBe("warashi/warashi-01/commands");
      const sent = JSON.parse(new TextDecoder().decode(input.payload as Uint8Array)) as Json;
      expect(sent).toMatchObject({ type: "gaze", encounterId: null, data: { panDeg: 60, tiltDeg: -30 } });
      expect(sent["id"]).toBe(parse(response)["id"]);
    });

    it("answers 403 to the reviewer and publishes nothing", async () => {
      const handler = await loadApiAdmin();
      const response = await handler(
        apiEvent("POST /commands", {
          groups: ["reviewer"],
          body: { deviceId: "warashi-01", command: { type: "mode.set", data: { mode: "sleep" } } },
        }),
      );
      expect(response.statusCode).toBe(403);
      expect(totalCalls()).toBe(0);
    });

    it("answers 400 for invalid commands and publishes nothing", async () => {
      const handler = await loadApiAdmin();
      const bad: unknown[] = [
        { deviceId: "bad id!", command: { type: "gaze", data: { panDeg: 0, tiltDeg: 0 } } },
        { deviceId: "warashi-01", command: { type: "reboot", data: {} } },
        { deviceId: "warashi-01", command: { type: "gaze", data: { panDeg: "x", tiltDeg: 0 } } },
        { deviceId: "warashi-01", command: { type: "mode.set", data: { mode: "dance" } } },
        { deviceId: "warashi-01", command: { type: "speak", data: { lineId: "no_such_line" } } },
        { deviceId: "warashi-01", command: { type: "speak", data: { lineId: "greeting_family", audioUrl: "https://x.example.invalid/a.wav" } } },
      ];
      for (const value of bad) {
        const response = await handler(apiEvent("POST /commands", { body: value }));
        expect(response.statusCode).toBe(400);
        expect(errorCode(response)).toBe("validation_failed");
      }
      expect(iot.calls()).toHaveLength(0);
    });

    it("answers 500 with a generic message when the publish fails", async () => {
      iot.on(IotPublishCommand).rejects(new Error("endpoint detail"));
      const handler = await loadApiAdmin();

      const response = await handler(
        apiEvent("POST /commands", {
          body: { deviceId: "warashi-01", command: { type: "lantern", data: { level: 0.5, fadeMs: 500 } } },
        }),
      );

      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("endpoint detail");
    });
  });

  describe("GET /faces", () => {
    it("lists members without face ids", async () => {
      ddb.on(QueryCommand).resolves({
        Items: [
          {
            pk: "FAMILY",
            sk: `MEMBER#${MEMBER_ID}`,
            displayName: "Test Member",
            faceIds: ["face-secret-1", "face-secret-2"],
            consentVersion: "1",
            consentAt: "2026-11-20T00:00:00.000Z",
            createdBy: "user-1",
          },
        ],
      });
      const handler = await loadApiAdmin();

      const response = await handler(apiEvent("GET /faces"));

      expect(response.statusCode).toBe(200);
      expect(parse(response)["members"]).toEqual([
        { memberId: MEMBER_ID, displayName: "Test Member", createdAt: "2026-11-20T00:00:00.000Z", consentVersion: "1", faceCount: 2 },
      ]);
      expect(response.body).not.toContain("face-secret");
    });

    it("answers 403 to the reviewer on every /faces route and touches nothing", async () => {
      const handler = await loadApiAdmin();
      const routes: [string, ApiOptions][] = [
        ["GET /faces", {}],
        ["POST /faces/upload", {}],
        ["POST /faces", { body: registerBody() }],
        ["DELETE /faces/{memberId}", { pathParameters: { memberId: MEMBER_ID } }],
      ];
      for (const [route, options] of routes) {
        const response = await handler(apiEvent(route, { ...options, groups: ["reviewer"] }));
        expect(response.statusCode).toBe(403);
      }
      expect(totalCalls()).toBe(0);
    });
  });

  describe("POST /faces/upload", () => {
    it("returns a pre-signed POST for a staging key", async () => {
      const handler = await loadApiAdmin();

      const response = await handler(apiEvent("POST /faces/upload"));

      expect(response.statusCode).toBe(200);
      const result = parse(response);
      expect(result["stagingKey"]).toMatch(/^faces-staging\/[A-Za-z0-9_-]+$/);
      expect(result["expiresInS"]).toBe(300);
      expect(typeof result["url"]).toBe("string");
      expect(result["fields"]).toMatchObject({ key: result["stagingKey"] });
    });
  });

  describe("POST /faces", () => {
    function photoStaged(): void {
      s3.on(GetObjectCommand).resolves({ Body: body(JPEG) });
    }

    it("registers one face, stores the member with an opaque id and deletes the staged photo", async () => {
      photoStaged();
      rek.on(IndexFacesCommand).resolves({ FaceRecords: [{ Face: { FaceId: "face-secret-1" } }] });
      const handler = await loadApiAdmin();

      const response = await handler(apiEvent("POST /faces", { body: registerBody() }));

      expect(response.statusCode).toBe(201);
      const result = parse(response);
      expect(result["faceCount"]).toBe(1);
      expect(response.body).not.toContain("face-secret");
      const index = rek.commandCalls(IndexFacesCommand)[0]!.args[0].input;
      expect(index.ExternalImageId).toBe(result["memberId"]);
      const member = ddb.commandCalls(PutCommand)[0]!.args[0].input.Item;
      expect(member).toMatchObject({ pk: "FAMILY", displayName: "Test Member", createdBy: "user-1", faceIds: ["face-secret-1"] });
      expect(s3.commandCalls(DeleteObjectCommand)[0]!.args[0].input.Key).toBe(STAGING_KEY);
    });

    it("answers 409 when the consent does not match the notice and indexes nothing", async () => {
      photoStaged();
      const handler = await loadApiAdmin();

      const response = await handler(apiEvent("POST /faces", { body: registerBody({ consent: { noticeVersion: "0", accepted: true } }) }));

      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe("consent_required");
      expect(rek.calls()).toHaveLength(0);
      expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    });

    it("answers 400 for a bad name, a bad staging key or a missing photo", async () => {
      s3.on(GetObjectCommand).rejects(awsError("NoSuchKey"));
      const handler = await loadApiAdmin();
      for (const value of [
        registerBody({ displayName: "" }),
        registerBody({ displayName: "x".repeat(41) }),
        registerBody({ stagingKey: "faces-staging/../x" }),
        registerBody(),
      ]) {
        const response = await handler(apiEvent("POST /faces", { body: value }));
        expect(response.statusCode).toBe(400);
      }
      expect(rek.calls()).toHaveLength(0);
    });

    it("answers 422 for a photo with two faces and removes the faces it indexed", async () => {
      photoStaged();
      rek.on(IndexFacesCommand).resolves({ FaceRecords: [{ Face: { FaceId: "f1" } }, { Face: { FaceId: "f2" } }] });
      const handler = await loadApiAdmin();

      const response = await handler(apiEvent("POST /faces", { body: registerBody() }));

      expect(response.statusCode).toBe(422);
      expect(errorCode(response)).toBe("face_count_invalid");
      expect(rek.commandCalls(DeleteFacesCommand)[0]!.args[0].input.FaceIds).toEqual(["f1", "f2"]);
      expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
      expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    });

    it("answers 404 for an unknown memberId and still deletes the staged photo", async () => {
      photoStaged();
      ddb.on(GetCommand).resolves({});
      const handler = await loadApiAdmin();

      const response = await handler(apiEvent("POST /faces", { body: registerBody({ memberId: MEMBER_ID }) }));

      expect(response.statusCode).toBe(404);
      expect(rek.calls()).toHaveLength(0);
      expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    });

    it("adds a photo to an existing member and keeps the name", async () => {
      photoStaged();
      rek.on(IndexFacesCommand).resolves({ FaceRecords: [{ Face: { FaceId: "f2" } }] });
      ddb.on(GetCommand).resolves({
        Item: { pk: "FAMILY", sk: `MEMBER#${MEMBER_ID}`, displayName: "Kept Name", faceIds: ["f1"], consentVersion: "1", consentAt: "2026-11-20T00:00:00.000Z", createdBy: "user-0" },
      });
      const handler = await loadApiAdmin();

      const response = await handler(apiEvent("POST /faces", { body: registerBody({ memberId: MEMBER_ID, displayName: "Ignored" }) }));

      expect(response.statusCode).toBe(201);
      expect(parse(response)).toEqual({ memberId: MEMBER_ID, faceCount: 2 });
      expect(ddb.commandCalls(PutCommand)[0]!.args[0].input.Item).toMatchObject({ displayName: "Kept Name", faceIds: ["f1", "f2"] });
    });
  });

  describe("DELETE /faces/{memberId}", () => {
    const memberItem = {
      pk: "FAMILY",
      sk: `MEMBER#${MEMBER_ID}`,
      displayName: "Test Member",
      faceIds: ["f1"],
      consentVersion: "1",
      consentAt: "2026-11-20T00:00:00.000Z",
      createdBy: "user-1",
    };

    it("deletes the face vectors and the record and answers 204", async () => {
      ddb.on(GetCommand).resolves({ Item: memberItem });
      const handler = await loadApiAdmin();

      const response = await handler(apiEvent("DELETE /faces/{memberId}", { pathParameters: { memberId: MEMBER_ID } }));

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      expect(rek.commandCalls(DeleteFacesCommand)[0]!.args[0].input.FaceIds).toEqual(["f1"]);
      expect(ddb.commandCalls(DeleteCommand)).toHaveLength(1);
    });

    it("answers 404 for an unknown member", async () => {
      ddb.on(GetCommand).resolves({});
      const handler = await loadApiAdmin();

      const response = await handler(apiEvent("DELETE /faces/{memberId}", { pathParameters: { memberId: MEMBER_ID } }));

      expect(response.statusCode).toBe(404);
      expect(rek.calls()).toHaveLength(0);
    });

    it("answers 500 and keeps the record when Rekognition cannot delete the faces", async () => {
      ddb.on(GetCommand).resolves({ Item: memberItem });
      rek.on(DeleteFacesCommand).rejects(awsError("InternalServerError"));
      const handler = await loadApiAdmin();

      const response = await handler(apiEvent("DELETE /faces/{memberId}", { pathParameters: { memberId: MEMBER_ID } }));

      expect(response.statusCode).toBe(500);
      expect(ddb.commandCalls(DeleteCommand)).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// snapshot-signer
// ---------------------------------------------------------------------------------------------

describe("snapshot-signer handler", () => {
  const KEY = "snapshots/warashi-01/20261120/snap-1.jpg";

  it("signs a URL for the family role with the requested lifetime, without calling S3", async () => {
    const handler = await loadSigner();

    const result = await handler({ role: "family", snapshotKey: KEY, ttlS: 300 });

    expect(result).toMatchObject({ ok: true });
    const url = (result as { url: string }).url;
    expect(url).toContain(KEY);
    expect(url).toContain("X-Amz-Expires=300");
    expect(s3.calls()).toHaveLength(0);
  });

  it("refuses every role except family, before it looks at the key", async () => {
    const handler = await loadSigner();
    for (const role of ["reviewer", "admin", undefined]) {
      expect(await handler({ role, snapshotKey: KEY, ttlS: 300 })).toEqual({ ok: false, code: "forbidden" });
    }
  });

  it("refuses keys outside snapshots/, traversal keys and bad lifetimes", async () => {
    const handler = await loadSigner();
    const invalid = { ok: false, code: "invalid_request" };
    expect(await handler({ role: "family", snapshotKey: "faces-staging/x", ttlS: 300 })).toEqual(invalid);
    expect(await handler({ role: "family", snapshotKey: "snapshots/../secret", ttlS: 300 })).toEqual(invalid);
    expect(await handler({ role: "family", snapshotKey: KEY, ttlS: 301 })).toEqual(invalid);
    expect(await handler({ role: "family", snapshotKey: KEY, ttlS: 0 })).toEqual(invalid);
    expect(await handler(null)).toEqual({ ok: false, code: "forbidden" });
  });
});

// ---------------------------------------------------------------------------------------------
// Invalid configuration is refused at start (R5.16)
// ---------------------------------------------------------------------------------------------

describe("invalid configuration is refused at start", () => {
  const loaders: [string, (env: Env) => Promise<unknown>][] = [
    ["judge", loadJudge],
    ["api-read", loadApiRead],
    ["api-simulate", loadApiSimulate],
    ["api-admin", loadApiAdmin],
  ];

  it.each(loaders)("%s refuses thresholds that break searchFloor <= strangerMax <= familyMin", async (_name, load) => {
    await expect(load({ WARASHI_SEARCH_FLOOR: "95" })).rejects.toThrow(/searchFloor/);
    await expect(load({ WARASHI_STRANGER_MAX: "95", WARASHI_FAMILY_MIN: "90" })).rejects.toThrow(/strangerMax/);
  });

  it.each(loaders)("%s refuses a setting that is not a number", async (_name, load) => {
    await expect(load({ WARASHI_NOTIFY_WINDOW_MS: "soon" })).rejects.toThrow(/notifyWindowMs/);
  });

  it("judge refuses a missing dashboard URL", async () => {
    await expect(loadJudge({ WARASHI_DASHBOARD_URL: undefined })).rejects.toThrow(/WARASHI_DASHBOARD_URL/);
  });

  it("api-simulate refuses a missing Bedrock model id", async () => {
    await expect(loadApiSimulate({ WARASHI_BEDROCK_MODEL_ID: undefined })).rejects.toThrow(/WARASHI_BEDROCK_MODEL_ID/);
  });

  it("api-read refuses a missing signer function name", async () => {
    await expect(loadApiRead({ WARASHI_SIGNER_FUNCTION_NAME: undefined })).rejects.toThrow(/WARASHI_SIGNER_FUNCTION_NAME/);
  });

  it("ingest, the API handlers and the signer refuse a missing table or bucket", async () => {
    await expect(loadIngest({ WARASHI_TABLE_NAME: undefined })).rejects.toThrow(/WARASHI_TABLE_NAME/);
    await expect(loadApiRead({ WARASHI_TABLE_NAME: undefined })).rejects.toThrow(/WARASHI_TABLE_NAME/);
    await expect(loadSigner({ WARASHI_BUCKET_NAME: undefined })).rejects.toThrow(/WARASHI_BUCKET_NAME/);
  });
});
