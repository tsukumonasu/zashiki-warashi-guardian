/**
 * IoT Core data-plane adapter for the `DeviceBus` port (cloud-judgement design, C5).
 *
 * Thin on purpose: it encodes the envelope, publishes it with QoS 1 to
 * `warashi/<deviceId>/commands` and gives up after 2 seconds. It makes no decisions and does
 * not retry; the caller decides what a failed publish means. `Publish` defaults to QoS 0, so
 * `qos: 1` is always set explicitly (IoT data plane `Publish` API).
 */

import { IoTDataPlaneClient, PublishCommand } from "@aws-sdk/client-iot-data-plane";

import { encodeEnvelope } from "../messages.js";
import type { Envelope } from "../messages.js";
import { topicFor } from "../messages.js";
import type { DeviceBus } from "../ports.js";

/** Time allowed for one publish. */
export const PUBLISH_TIMEOUT_MS = 2000;

/** Environment variable that holds the account's IoT data endpoint host name. */
export const IOT_ENDPOINT_ENV = "IOT_DATA_ENDPOINT";

/** Raised when a publish does not finish within the time limit. */
export class PublishTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`IoT publish did not finish within ${timeoutMs} ms`);
    this.name = "PublishTimeoutError";
  }
}

/** The one SDK method used, so tests can pass a small fake. */
export type IotPublisher = Pick<IoTDataPlaneClient, "send">;

let defaultClient: IoTDataPlaneClient | undefined;

/** Created on first use and reused for the life of the Lambda container. */
function getDefaultClient(): IoTDataPlaneClient {
  if (defaultClient === undefined) {
    const host = process.env[IOT_ENDPOINT_ENV];
    if (host === undefined || host.length === 0) {
      throw new Error(`${IOT_ENDPOINT_ENV} is not set`);
    }
    defaultClient = new IoTDataPlaneClient({ endpoint: `https://${host}` });
  }
  return defaultClient;
}

export type IotBusOptions = {
  client?: IotPublisher;
  timeoutMs?: number;
};

export function createIotBus(options: IotBusOptions = {}): DeviceBus {
  const timeoutMs = options.timeoutMs ?? PUBLISH_TIMEOUT_MS;
  return {
    async publish(deviceId: string, envelope: Envelope): Promise<void> {
      const client = options.client ?? getDefaultClient();
      const command = new PublishCommand({
        topic: topicFor(deviceId, "commands"),
        qos: 1,
        payload: new TextEncoder().encode(encodeEnvelope(envelope)),
      });
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      try {
        await client.send(command, { abortSignal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) throw new PublishTimeoutError(timeoutMs);
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
