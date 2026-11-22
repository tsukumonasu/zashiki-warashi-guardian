/**
 * Adapter tests of the voice feature (task 12.2): AppSync Events channel, DynamoDB store, DollBus,
 * session invoker and the Sonic client. AWS clients are mocked with aws-sdk-client-mock; the
 * WebSocket is a fake factory plus one small local server for the Node.js global `WebSocket`.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { IoTDataPlaneClient, PublishCommand } from "@aws-sdk/client-iot-data-plane";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";

import { createDollBus } from "../../lambda/voice-session/adapters/iot-doll-bus.js";
import { createSessionInvoker } from "../../lambda/voice-session/adapters/lambda-invoker.js";
import {
  SUBPROTOCOL,
  batches,
  connectProtocols,
  createAppSyncChannel,
  signEventRequest,
  type WebSocketLike,
} from "../../lambda/voice-session/adapters/appsync-events.js";
import { createSonicClient, createSonicParser } from "../../lambda/voice-session/adapters/sonic.js";
import {
  HEALTH_TTL_S,
  LOCK_TTL_S,
  SESSION_TTL_S,
  createDeviceOnline,
  createHealthStore,
  createReadCounter,
  createVoiceStore,
} from "../../lambda/voice-session/adapters/voice-dynamo.js";
import type { SessionPayload } from "../../lambda/voice-session/session-runner.js";

// One mock of the document client for the whole file: a second `mockClient` on the same class would replace it.
const ddb = mockClient(DynamoDBDocumentClient);

const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "tok" };
const HOST = "abc.appsync-api.ap-northeast-1.amazonaws.com";
const RT_HOST = "abc.appsync-realtime-api.ap-northeast-1.amazonaws.com";

describe("appsync-events", () => {
  it("signs with SigV4 and keeps the security token", async () => {
    const h = await signEventRequest(
      { httpHost: HOST, region: "ap-northeast-1", credentials: CREDS },
      "{}",
      new Date("2026-01-02T03:04:05Z"),
    );
    expect(h["x-amz-date"]).toBe("20260102T030405Z");
    expect(h["Authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260102\/ap-northeast-1\/appsync\/aws4_request/);
    expect(h["X-Amz-Security-Token"]).toBe("tok");
    expect(h["host"]).toBe(HOST);
  });

  it("builds the subprotocol list with a decodable header- value", async () => {
    const h = await signEventRequest({ httpHost: HOST, region: "ap-northeast-1", credentials: CREDS }, "{}");
    const [first, second] = connectProtocols(h);
    expect(first).toBe(SUBPROTOCOL);
    expect(second).toMatch(/^header-[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(second!.slice(7), "base64url").toString("utf8"))).toEqual(h);
  });

  it("splits events into batches of at most 5", () => {
    expect(batches([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]).map((b) => b.length)).toEqual([5, 5, 1]);
    expect(batches([])).toEqual([]);
  });

  it("publishes in batches of 5 and spaces requests at least 100 ms apart", async () => {
    let clock = 1_000;
    const sleeps: number[] = [];
    const bodies: { channel: string; events: string[] }[] = [];
    const channel = createAppSyncChannel({
      httpHost: HOST,
      realtimeHost: RT_HOST,
      region: "ap-northeast-1",
      credentials: CREDS,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string) as { channel: string; events: string[] });
        expect((init.headers as Record<string, string>)["Authorization"]).toBeTruthy();
        return new Response(JSON.stringify({ failed: [], successful: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await channel.publish("sid", "out", ["a", "b", "c", "d", "e", "f", "g"]);
    expect(bodies.map((b) => b.events.length)).toEqual([5, 2]);
    expect(bodies[0]!.channel).toBe("/voice/sid/out");
    expect(sleeps).toEqual([100]);
  });

  it("throws a short error for a failed status or rejected events, and after close", async () => {
    const make = (res: Response) =>
      createAppSyncChannel({
        httpHost: HOST,
        realtimeHost: RT_HOST,
        region: "ap-northeast-1",
        credentials: CREDS,
        sleep: async () => undefined,
        fetchImpl: (async () => res) as unknown as typeof fetch,
      });
    await expect(make(new Response("secret echo", { status: 403 })).publish("s", "text", ["x"])).rejects.toThrow(
      /status 403$/,
    );
    await expect(
      make(new Response(JSON.stringify({ failed: [{}] }), { status: 200 })).publish("s", "text", ["x"]),
    ).rejects.toThrow("AppSync rejected some events");
    const ch = make(new Response("{}", { status: 200 }));
    await ch.close();
    await expect(ch.publish("s", "text", ["x"])).rejects.toThrow("closed");
  });

  it("subscribes to /in: connection_init, subscribe with authorization, yields data, ends on close", async () => {
    const sent: Record<string, unknown>[] = [];
    let protocols: string[] = [];
    let url = "";
    const listeners: Record<string, ((ev: { data?: unknown }) => void)[]> = {};
    const fire = (type: string, ev: { data?: unknown } = {}): void => listeners[type]?.forEach((l) => l(ev));
    const ws: WebSocketLike = {
      send: (d) => sent.push(JSON.parse(d) as Record<string, unknown>),
      close: () => fire("close"),
      addEventListener: ((type: string, l: (ev: { data?: unknown }) => void) => {
        (listeners[type] ??= []).push(l);
      }) as WebSocketLike["addEventListener"],
    };
    const channel = createAppSyncChannel({
      httpHost: HOST,
      realtimeHost: RT_HOST,
      region: "ap-northeast-1",
      credentials: CREDS,
      webSocketFactory: (u, p) => {
        url = u;
        protocols = p;
        return ws;
      },
    });
    const it = channel.subscribeIn("sid-1")[Symbol.asyncIterator]();
    const first = it.next();
    await new Promise((r) => setTimeout(r, 20));
    expect(url).toBe(`wss://${RT_HOST}/event/realtime`);
    expect(protocols[0]).toBe("aws-appsync-event-ws");
    expect(protocols[1]).toMatch(/^header-/);
    fire("open");
    expect(sent[0]).toEqual({ type: "connection_init" });
    fire("message", { data: JSON.stringify({ type: "connection_ack", connectionTimeoutMs: 300000 }) });
    await new Promise((r) => setTimeout(r, 20));
    const sub = sent[1] as { type: string; channel: string; id: string; authorization: Record<string, string> };
    expect(sub.type).toBe("subscribe");
    expect(sub.channel).toBe("/voice/sid-1/in");
    expect(sub.authorization["Authorization"]).toMatch(/^AWS4-HMAC-SHA256/);
    fire("message", { data: JSON.stringify({ type: "data", id: "other", event: "no" }) });
    fire("message", { data: JSON.stringify({ type: "data", id: sub.id, event: '{"t":"bye"}' }) });
    expect((await first).value).toBe('{"t":"bye"}');
    fire("close");
    expect((await it.next()).done).toBe(true);
  });

  it("fails the subscription on subscribe_error", async () => {
    const listeners: Record<string, ((ev: { data?: unknown }) => void)[]> = {};
    const ws: WebSocketLike = {
      send: () => undefined,
      close: () => undefined,
      addEventListener: ((t: string, l: (ev: { data?: unknown }) => void) => {
        (listeners[t] ??= []).push(l);
      }) as WebSocketLike["addEventListener"],
    };
    const channel = createAppSyncChannel({
      httpHost: HOST,
      realtimeHost: RT_HOST,
      region: "ap-northeast-1",
      credentials: CREDS,
      webSocketFactory: () => ws,
    });
    const next = channel.subscribeIn("s")[Symbol.asyncIterator]().next();
    await new Promise((r) => setTimeout(r, 20));
    listeners["message"]!.forEach((l) => l({ data: JSON.stringify({ type: "subscribe_error", errors: ["x"] }) }));
    await expect(next).rejects.toThrow("AppSync subscribe_error");
  });

  it("Node.js global WebSocket accepts the long header- subprotocol value", async () => {
    const h = await signEventRequest(
      { httpHost: HOST, region: "ap-northeast-1", credentials: { ...CREDS, sessionToken: "T".repeat(1200) } },
      "{}",
    );
    const protocols = connectProtocols(h);
    expect(protocols[1]!.length).toBeGreaterThan(1500);

    let requested = "";
    const server = createServer();
    server.on("upgrade", (req, socket) => {
      requested = String(req.headers["sec-websocket-protocol"]);
      const accept = createHash("sha1")
        .update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${SUBPROTOCOL}\r\n\r\n`,
      );
      socket.write(Buffer.from([0x88, 0x00])); // close frame
      socket.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const outcome = await new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/event/realtime`, protocols);
        ws.addEventListener("open", () => resolve(`open:${ws.protocol}`));
        ws.addEventListener("error", () => resolve("error"));
      });
      expect(outcome).toBe(`open:${SUBPROTOCOL}`);
      expect(requested).toBe(protocols.join(", "));
    } finally {
      server.close();
    }
  });
});

describe("voice-dynamo", () => {
  afterEach(() => ddb.reset());
  const store = () =>
    createVoiceStore({
      client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      tableName: "t",
      now: () => 10_000_000,
    });
  const condFail = Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" });

  it("acquireLock: conditional put with 1 hour TTL, false when taken", async () => {
    ddb.on(PutCommand).resolvesOnce({}).rejectsOnce(condFail);
    expect(await store().acquireLock("doll#d1", "s1", 5_000_000, 5_600_000)).toBe(true);
    const input = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect(input.Item).toMatchObject({ pk: "VOICELOCK#doll#d1", sk: "LOCK", sessionId: "s1", ttl: 5000 + LOCK_TTL_S });
    expect(input.ConditionExpression).toBe("attribute_not_exists(pk) OR #expiresAt <= :now");
    expect(input.ExpressionAttributeValues).toEqual({ ":now": 5_000_000 });
    expect(await store().acquireLock("doll#d1", "s2", 5_000_000, 5_600_000)).toBe(false);
  });

  it("acquireLock rethrows other errors", async () => {
    ddb.on(PutCommand).rejects(new Error("boom"));
    await expect(store().acquireLock("k", "s", 1, 2)).rejects.toThrow("boom");
  });

  it("releaseLock deletes only the owner's lock and swallows a failed condition", async () => {
    ddb.on(DeleteCommand).rejects(condFail);
    await store().releaseLock("k", "s1");
    const input = ddb.commandCalls(DeleteCommand)[0]!.args[0].input;
    expect(input.Key).toEqual({ pk: "VOICELOCK#k", sk: "LOCK" });
    expect(input.ConditionExpression).toBe("#sessionId = :sid");
    expect(input.ExpressionAttributeValues).toEqual({ ":sid": "s1" });
  });

  it("incrementCounter: ADD with cap condition and TTL set once; denies at the cap", async () => {
    ddb.on(UpdateCommand).resolvesOnce({ Attributes: { count: 3 } }).rejectsOnce(condFail);
    expect(await store().incrementCounter("RATE#voice#all#d", 5, 172_800)).toEqual({ allowed: true, count: 3 });
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.UpdateExpression).toBe("ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)");
    expect(input.ConditionExpression).toBe("attribute_not_exists(#count) OR #count < :cap");
    expect(input.ExpressionAttributeValues).toEqual({ ":one": 1, ":cap": 5, ":ttl": 10_000 + 172_800 });
    expect(await store().incrementCounter("RATE#voice#all#d", 5, 172_800)).toEqual({ allowed: false, count: 5 });
  });

  it("releaseCounter only decrements an existing positive counter", async () => {
    ddb.on(UpdateCommand).rejects(condFail);
    await store().releaseCounter("RATE#x");
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ExpressionAttributeValues).toEqual({ ":minusOne": -1, ":zero": 0 });
    expect(input.ConditionExpression).toBe("attribute_exists(pk) AND #count > :zero");
  });

  it("putSession writes a closed field list with a 2 day TTL and no token", async () => {
    ddb.on(PutCommand).resolves({});
    await store().putSession({
      sessionId: "s1",
      deviceId: "d",
      client: "device",
      target: "real",
      ownerSub: null,
      role: "family",
      phase: "starting",
      startedAt: 3_000_000,
      expiresAt: 3_600_000,
      clientTokenHash: "h",
      observerTokenHash: null,
      endReason: null,
      endedAt: null,
      endRequested: false,
      token: "SECRET",
      audio: "AAAA",
    } as never);
    const item = ddb.commandCalls(PutCommand)[0]!.args[0].input.Item!;
    expect(item["ttl"]).toBe(3000 + SESSION_TTL_S);
    expect(item["pk"]).toBe("VOICE#s1");
    expect(JSON.stringify(item)).not.toContain("SECRET");
    expect(item).not.toHaveProperty("audio");
  });

  it("getSession is a consistent read and maps null for a missing or invalid item", async () => {
    ddb.on(GetCommand).resolvesOnce({}).resolvesOnce({ Item: { sessionId: "s", phase: "weird" } });
    expect(await store().getSession("s")).toBeNull();
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input).toMatchObject({
      Key: { pk: "VOICE#s", sk: "META" },
      ConsistentRead: true,
    });
    expect(await store().getSession("s")).toBeNull();
  });

  it("readLook reads LOOK#<id> and validates the verdict", async () => {
    ddb.on(GetCommand).resolvesOnce({ Item: { verdict: "family", at: 7 } }).resolvesOnce({ Item: { verdict: "x", at: 7 } });
    expect(await store().readLook("r1")).toEqual({ verdict: "family", at: 7 });
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input.Key).toEqual({ pk: "LOOK#r1", sk: "RESULT" });
    expect(await store().readLook("r1")).toBeNull();
  });
});

describe("voice-dynamo: verdict, health, counter and device status", () => {
  afterEach(() => ddb.reset());
  const doc = () => DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const opts = () => ({ client: doc(), tableName: "t", now: () => 10_000_000 });
  const judged = (ts: string, verdict: string) => ({ envelope: { type: "judgement.result", ts, data: { verdict } } });

  it("encounterVerdict queries ENC#<id> newest first and returns the first judgement.result", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        { envelope: { type: "reaction.performed", ts: "2026-11-20T12:00:05.000Z", data: {} } },
        judged("2026-11-20T12:00:02.000Z", "family"),
        judged("2026-11-20T12:00:01.000Z", "stranger"),
      ],
    });
    const out = await createVoiceStore(opts()).encounterVerdict("e1");
    expect(out).toEqual({ verdict: "family", atMs: Date.parse("2026-11-20T12:00:02.000Z") });
    const input = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input).toMatchObject({
      TableName: "t",
      ConsistentRead: true,
      ScanIndexForward: false,
      KeyConditionExpression: "pk = :p AND begins_with(sk, :evt)",
      ExpressionAttributeValues: { ":p": "ENC#e1", ":evt": "EVT#" },
    });
  });

  it("encounterVerdict pages, skips bad timestamps and returns null when none is found", async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [judged("not a date", "family")], LastEvaluatedKey: { pk: "k" } })
      .resolvesOnce({ Items: [{}, { envelope: { type: "judgement.result", ts: "2026-11-20T12:00:00.000Z", data: {} } }] });
    expect(await createVoiceStore(opts()).encounterVerdict("e1")).toBeNull();
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(2);
    expect(ddb.commandCalls(QueryCommand)[1]!.args[0].input.ExclusiveStartKey).toEqual({ pk: "k" });
  });

  it("health store reads VOICE#HEALTH with defaults and writes it with a 2 day TTL", async () => {
    ddb.on(GetCommand).resolvesOnce({}).resolvesOnce({ Item: { streak: 2, firstAtMs: 5, unhealthyUntilMs: "x" } });
    ddb.on(PutCommand).resolves({});
    const health = createHealthStore(opts());
    expect(await health.read()).toBeNull();
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input).toMatchObject({
      Key: { pk: "VOICE#HEALTH", sk: "STATE" },
      ConsistentRead: true,
    });
    expect(await health.read()).toEqual({ streak: 2, firstAtMs: 5, unhealthyUntilMs: 0 });

    await health.write({ streak: 3, firstAtMs: 7, unhealthyUntilMs: 9 });
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input.Item).toEqual({
      pk: "VOICE#HEALTH",
      sk: "STATE",
      streak: 3,
      firstAtMs: 7,
      unhealthyUntilMs: 9,
      ttl: 10_000 + HEALTH_TTL_S,
    });
  });

  it("createReadCounter returns the count, or 0 when the item or the number is missing", async () => {
    ddb
      .on(GetCommand)
      .resolvesOnce({ Item: { count: 4 } })
      .resolvesOnce({})
      .resolvesOnce({ Item: { count: "4" } });
    const read = createReadCounter(opts());
    expect(await read("RATE#voice#all#d")).toBe(4);
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input).toMatchObject({
      Key: { pk: "RATE#voice#all#d", sk: "COUNT" },
      ConsistentRead: true,
    });
    expect(await read("k")).toBe(0);
    expect(await read("k")).toBe(0);
  });

  it("createDeviceOnline applies the 3 x interval rule and the offline mark", async () => {
    const now = 1_000_000;
    const item = (report: unknown, offline?: unknown) => ({ Item: { lastReportAtMs: report, lastOfflineAtMs: offline } });
    ddb
      .on(GetCommand)
      .resolvesOnce(item(now - 180_000)) // exactly 3 x 60 s: online
      .resolvesOnce(item(now - 180_001)) // one millisecond too old
      .resolvesOnce(item(now - 1000, now)) // offline mark after the report
      .resolvesOnce(item(now - 1000, now - 5000)) // report after the offline mark
      .resolvesOnce({}) // no status item
      .resolvesOnce(item("x")); // report is not a number
    const online = createDeviceOnline(60, opts());
    expect(await online("warashi-01", now)).toBe(true);
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input).toMatchObject({
      Key: { pk: "DEV#warashi-01", sk: "STATUS" },
      ConsistentRead: true,
    });
    expect(await online("warashi-01", now)).toBe(false);
    expect(await online("warashi-01", now)).toBe(false);
    expect(await online("warashi-01", now)).toBe(true);
    expect(await online("warashi-01", now)).toBe(false);
    expect(await online("warashi-01", now)).toBe(false);
  });

  it("createDeviceOnline counts a failed read as offline", async () => {
    ddb.on(GetCommand).rejects(new Error("down"));
    expect(await createDeviceOnline(60, opts())("warashi-01", 1)).toBe(false);
  });
});

describe("iot-doll-bus", () => {
  const iot = mockClient(IoTDataPlaneClient);
  afterEach(() => iot.reset());

  it("publishes to warashi/<id>/commands with qos 1", async () => {
    iot.on(PublishCommand).resolves({});
    const bus = createDollBus({ client: new IoTDataPlaneClient({ endpoint: "https://example.invalid" }) });
    await bus.publish("warashi-01", {
      v: 1,
      id: "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10",
      ts: "2026-11-20T12:34:56.789Z",
      deviceId: "warashi-01",
      encounterId: null,
      type: "conversation.end",
      data: { sessionId: "s1", reason: "user" },
    });
    const input = iot.commandCalls(PublishCommand)[0]!.args[0].input;
    expect(input.qos).toBe(1);
    expect(input.topic).toBe("warashi/warashi-01/commands");
  });
});

describe("lambda-invoker", () => {
  const lambda = mockClient(LambdaClient);
  afterEach(() => lambda.reset());
  const payload = { sessionId: "s1" } as unknown as SessionPayload;

  it("invokes asynchronously with the payload only", async () => {
    lambda.on(InvokeCommand).resolves({ StatusCode: 202 });
    const inv = createSessionInvoker({ functionName: "fn", client: new LambdaClient({}) });
    await inv.invoke(payload);
    const input = lambda.commandCalls(InvokeCommand)[0]!.args[0].input;
    expect(input.InvocationType).toBe("Event");
    expect(input.FunctionName).toBe("fn");
    expect(JSON.parse(new TextDecoder().decode(input.Payload as Uint8Array))).toEqual({ sessionId: "s1" });
  });

  it("throws on a non-202 status and on an empty function name", async () => {
    lambda.on(InvokeCommand).resolves({ StatusCode: 200 });
    await expect(createSessionInvoker({ functionName: "fn", client: new LambdaClient({}) }).invoke(payload)).rejects.toThrow(
      "status 200",
    );
    expect(() => createSessionInvoker({ functionName: "" })).toThrow();
  });
});

describe("sonic", () => {
  it("parser maps audio, text with contentStart metadata, interrupt, toolUse and completionEnd", () => {
    const p = createSonicParser();
    const j = (event: unknown): string => JSON.stringify({ event });
    expect(
      p.parse(
        j({ contentStart: { contentId: "c1", role: "ASSISTANT", additionalModelFields: '{"generationStage":"FINAL"}' } }),
      ),
    ).toBeNull();
    expect(p.parse(j({ textOutput: { contentId: "c1", content: "hi" } }))).toEqual({
      kind: "text",
      contentId: "c1",
      role: "ASSISTANT",
      stage: "FINAL",
      text: "hi",
    });
    expect(p.parse(j({ textOutput: { contentId: "c1", content: '{ "interrupted" : true }' } }))).toEqual({
      kind: "interrupted",
    });
    expect(p.parse(j({ audioOutput: { contentId: "c2", content: "AAAA" } }))).toEqual({
      kind: "audio",
      contentId: "c2",
      pcmBase64: "AAAA",
    });
    expect(p.parse(j({ toolUse: { toolUseId: "t", toolName: "look", content: "{}" } }))).toEqual({
      kind: "toolUse",
      toolUseId: "t",
      name: "look",
      inputJson: "{}",
    });
    expect(p.parse(j({ completionEnd: {} }))).toEqual({ kind: "completionEnd" });
    expect(p.parse("not json")).toBeNull();
    expect(p.parse(j({ textOutput: { contentId: "unknown", content: "x" } }))).toBeNull();
  });

  const bedrock = mockClient(BedrockRuntimeClient);
  afterEach(() => bedrock.reset());

  it("open sends the model id, streams events, turns exceptions into error events", async () => {
    const enc = new TextEncoder();
    async function* body(): AsyncGenerator<Record<string, unknown>> {
      yield { chunk: { bytes: enc.encode(JSON.stringify({ event: { completionEnd: {} } })) } };
      yield { throttlingException: { message: "secret detail" } };
    }
    bedrock.on(InvokeModelWithBidirectionalStreamCommand).resolves({ body: body() as never });
    const stream = await createSonicClient({ client: new BedrockRuntimeClient({}) }).open("model-x");
    expect(bedrock.commandCalls(InvokeModelWithBidirectionalStreamCommand)[0]!.args[0].input.modelId).toBe("model-x");
    const seen = [];
    for await (const ev of stream.events()) seen.push(ev);
    expect(seen).toEqual([{ kind: "completionEnd" }, { kind: "error", code: "throttlingException" }]);
    await stream.close();
    await expect(stream.send("{}")).rejects.toThrow("closed");
  });

  it("returns from open before Bedrock answers, so the first input events can be sent (no deadlock)", async () => {
    // Like the real service: the response arrives only after the first input event was read.
    let firstInput: string | null = null;
    const client = {
      async send(command: InvokeModelWithBidirectionalStreamCommand) {
        const body = command.input.body as AsyncIterable<{ chunk?: { bytes?: Uint8Array } }>;
        for await (const part of body) {
          firstInput = new TextDecoder().decode(part.chunk?.bytes);
          break;
        }
        async function* out() {
          yield { chunk: { bytes: new TextEncoder().encode('{"event":{"completionEnd":{}}}') } };
        }
        return { body: out() };
      },
    };
    const stream = await createSonicClient({ client: client as never }).open("model-x");
    await stream.send('{"event":{"sessionStart":{}}}');
    const seen = [];
    for await (const ev of stream.events()) seen.push(ev);
    expect(firstInput).toBe('{"event":{"sessionStart":{}}}');
    expect(seen).toEqual([{ kind: "completionEnd" }]);
  });

  it("reports a failed stream call as an error event", async () => {
    const failure = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
    const client = { send: () => Promise.reject(failure) };
    const stream = await createSonicClient({ client: client as never }).open("model-x");
    const seen = [];
    for await (const ev of stream.events()) seen.push(ev);
    expect(seen).toEqual([{ kind: "error", code: "AccessDeniedException" }]);
  });
});
