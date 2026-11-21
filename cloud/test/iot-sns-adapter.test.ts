/**
 * Tests for the IoT Core and SNS adapters (cloud-judgement task 16.6).
 *
 * API shapes were checked against the AWS documentation:
 * - https://docs.aws.amazon.com/iot/latest/apireference/API_iotdata_Publish.html
 *   (request: `topic` required; `qos` 0 or 1, default 0; the payload is the binary body, so
 *   `qos: 1` must be set explicitly)
 * - https://docs.aws.amazon.com/iot/latest/apireference/API_DescribeEndpoint.html
 *   (the data-plane host is account specific, `iot:Data-ATS`; the client therefore gets an
 *   explicit `endpoint` taken from the environment, not a hard-coded host)
 * - https://docs.aws.amazon.com/sns/latest/api/API_Publish.html
 *   (request: `TopicArn`, `Message` required, `Subject` optional. The page says a subject is
 *   UTF-8 text without line breaks and "less than 100 characters"; `notify.ts` caps it at 99.)
 * Timeout: `client.send(command, { abortSignal })` is the SDK v3 per-call option, so the adapter
 * races the publish against an AbortController. `aws-sdk-client-mock` does not pass those
 * options to a fake, so the timeout tests use a small fake `send` instead.
 */
import { IoTDataPlaneClient, PublishCommand as IotPublishCommand } from "@aws-sdk/client-iot-data-plane";
import { PublishCommand as SnsPublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PUBLISH_TIMEOUT_MS,
  PublishTimeoutError,
  createIotBus,
} from "../lambda/_shared/adapters/iot-bus.js";
import { NOTIFY_TOPIC_ENV, createSnsNotifier } from "../lambda/_shared/adapters/sns.js";
import { decodeEnvelope } from "../lambda/_shared/messages.js";
import type { Envelope } from "../lambda/_shared/messages.js";

const envelope: Envelope = {
  v: 1,
  id: "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10",
  ts: "2026-11-20T12:34:56.789Z",
  deviceId: "warashi-01",
  encounterId: null,
  type: "mode.set",
  data: { mode: "guard" },
};

describe("IoT bus adapter", () => {
  const iotMock = mockClient(IoTDataPlaneClient);

  beforeEach(() => {
    iotMock.reset();
    iotMock.on(IotPublishCommand).resolves({});
  });

  it("publishes to warashi/<id>/commands with qos 1 and the encoded envelope", async () => {
    const bus = createIotBus({ client: new IoTDataPlaneClient({ region: "ap-northeast-1" }) });
    await bus.publish("warashi-01", envelope);

    const calls = iotMock.commandCalls(IotPublishCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]?.args[0].input;
    expect(input?.topic).toBe("warashi/warashi-01/commands");
    expect(input?.qos).toBe(1);
    expect(input?.payload).toBeInstanceOf(Uint8Array);
    const result = decodeEnvelope(new TextDecoder().decode(input?.payload as Uint8Array));
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") expect(result.message).toEqual(envelope);
  });

  it("passes an abort signal to the send call and clears it after success", async () => {
    let seen: AbortSignal | undefined;
    const client = {
      send: (_cmd: unknown, opts?: { abortSignal?: AbortSignal }) => {
        seen = opts?.abortSignal;
        return Promise.resolve({});
      },
    };
    await createIotBus({ client: client as never }).publish("warashi-01", envelope);
    expect(seen).toBeDefined();
    expect(seen?.aborted).toBe(false);
  });

  it("rejects with PublishTimeoutError when the publish does not finish in time", async () => {
    const client = {
      send: (_cmd: unknown, opts?: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts?.abortSignal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    };
    const bus = createIotBus({ client: client as never, timeoutMs: 20 });
    await expect(bus.publish("warashi-01", envelope)).rejects.toBeInstanceOf(PublishTimeoutError);
  });

  it("passes a failed publish through unchanged and does not retry", async () => {
    iotMock.reset();
    const boom = new Error("throttled");
    iotMock.on(IotPublishCommand).rejects(boom);
    const bus = createIotBus({ client: new IoTDataPlaneClient({ region: "ap-northeast-1" }) });
    await expect(bus.publish("warashi-01", envelope)).rejects.toBe(boom);
    expect(iotMock.commandCalls(IotPublishCommand)).toHaveLength(1);
  });

  it("uses a 2 second default timeout", () => {
    expect(PUBLISH_TIMEOUT_MS).toBe(2000);
  });

  it("refuses an empty device id before any publish", async () => {
    const bus = createIotBus({ client: new IoTDataPlaneClient({ region: "ap-northeast-1" }) });
    await expect(bus.publish("", envelope)).rejects.toThrow(RangeError);
    expect(iotMock.commandCalls(IotPublishCommand)).toHaveLength(0);
  });
});

describe("SNS notifier adapter", () => {
  const snsMock = mockClient(SNSClient);
  const topicArn = "arn:aws:sns:ap-northeast-1:000000000000:example-topic";
  const saved = process.env[NOTIFY_TOPIC_ENV];

  beforeEach(() => {
    snsMock.reset();
    snsMock.on(SnsPublishCommand).resolves({ MessageId: "m-1" });
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[NOTIFY_TOPIC_ENV];
    else process.env[NOTIFY_TOPIC_ENV] = saved;
  });

  it("passes subject and body through unchanged as Subject and Message", async () => {
    const notifier = createSnsNotifier({ client: new SNSClient({ region: "ap-northeast-1" }), topicArn });
    const subject = "Zashiki-Warashi: stranger at Hall";
    const body = "Line one.\nLine two with 日本語.";
    await notifier.send({ subject, body });

    const calls = snsMock.commandCalls(SnsPublishCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({ TopicArn: topicArn, Subject: subject, Message: body });
  });

  it("reads the topic from NOTIFY_TOPIC_ARN when no option is given", async () => {
    process.env[NOTIFY_TOPIC_ENV] = topicArn;
    const notifier = createSnsNotifier({ client: new SNSClient({ region: "ap-northeast-1" }) });
    await notifier.send({ subject: "s", body: "b" });
    expect(snsMock.commandCalls(SnsPublishCommand)[0]?.args[0].input.TopicArn).toBe(topicArn);
  });

  it("rejects without publishing when the topic is not configured", async () => {
    delete process.env[NOTIFY_TOPIC_ENV];
    const notifier = createSnsNotifier({ client: new SNSClient({ region: "ap-northeast-1" }) });
    await expect(notifier.send({ subject: "s", body: "b" })).rejects.toThrow(NOTIFY_TOPIC_ENV);
    expect(snsMock.commandCalls(SnsPublishCommand)).toHaveLength(0);
  });

  it("rejects when SNS fails and does not retry", async () => {
    snsMock.reset();
    const boom = new Error("denied");
    snsMock.on(SnsPublishCommand).rejects(boom);
    const notifier = createSnsNotifier({ client: new SNSClient({ region: "ap-northeast-1" }), topicArn });
    await expect(notifier.send({ subject: "s", body: "b" })).rejects.toBe(boom);
    expect(snsMock.commandCalls(SnsPublishCommand)).toHaveLength(1);
  });
});
