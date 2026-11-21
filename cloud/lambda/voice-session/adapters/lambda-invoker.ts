/**
 * `SessionInvoker`: starts the `voice-session` Lambda asynchronously (`InvocationType: Event`).
 *
 * The payload is `SessionPayload` only: ids, limits and no token or token hash. A failed invoke
 * throws, so the caller rolls back its counter, lock and session record.
 */
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { SessionInvoker } from "../../voice-grant/voice-grant-core.js";

export type LambdaSender = Pick<LambdaClient, "send">;

let defaultClient: LambdaClient | undefined;

export function createSessionInvoker(options: { functionName: string; client?: LambdaSender }): SessionInvoker {
  if (options.functionName === "") throw new Error("voice session function name is empty");
  return {
    async invoke(payload) {
      defaultClient ??= new LambdaClient({});
      const client = options.client ?? defaultClient;
      const out = await client.send(
        new InvokeCommand({
          FunctionName: options.functionName,
          InvocationType: "Event",
          Payload: new TextEncoder().encode(JSON.stringify(payload)),
        }),
      );
      // An async invoke answers 202 when the event is queued.
      if (out.StatusCode !== 202) throw new Error(`Lambda invoke returned status ${String(out.StatusCode)}`);
    },
  };
}
