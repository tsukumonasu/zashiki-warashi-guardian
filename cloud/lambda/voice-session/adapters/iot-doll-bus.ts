/**
 * `DollBus` for the voice Lambdas: IoT Core data plane, QoS 1, topic `warashi/<deviceId>/commands`.
 *
 * It is the existing `createIotBus` of `cloud-judgement` (QoS 1 set explicitly, 2 s timeout, no
 * retry), so there is one publisher implementation to keep correct. `DeviceBus` and `DollBus` have
 * the same shape.
 */
import { createIotBus, type IotBusOptions } from "../../_shared/adapters/iot-bus.js";
import type { DollBus } from "../../_shared/voice/ports.js";

export function createDollBus(options: IotBusOptions = {}): DollBus {
  return createIotBus(options);
}
