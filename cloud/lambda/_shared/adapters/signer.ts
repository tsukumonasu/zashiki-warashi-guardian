/**
 * `SnapshotUrlSigner` adapter used by `api-read`: invokes the internal `snapshot-signer`
 * function synchronously. `api-read` holds only `lambda:InvokeFunction` on that function, never
 * an S3 permission (A5, R14.4, R14.10).
 *
 * The core calls `sign` for the `family` role only, so the adapter sends the role `family`; the
 * signer re-checks it. A refusal resolves `null`; an invoke or function error throws, and the
 * core then hides the picture without hiding the encounter. Nothing here logs the key or URL.
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

import type { SnapshotUrlSigner } from "../../api-read/api-read-core.js";

/** Environment variable that names the signer function (set by the CDK stack). */
export const SIGNER_FUNCTION_ENV = "WARASHI_SIGNER_FUNCTION_NAME";

const defaultClient = new LambdaClient({});

export type SignerAdapterOptions = {
  /** Defaults to the module-level client. Tests pass a mocked one. */
  client?: LambdaClient;
  /** Defaults to the `WARASHI_SIGNER_FUNCTION_NAME` environment variable. */
  functionName?: string;
};

export function createSnapshotUrlSigner(options: SignerAdapterOptions = {}): SnapshotUrlSigner {
  const client = options.client ?? defaultClient;
  const functionName = options.functionName ?? process.env[SIGNER_FUNCTION_ENV];
  if (functionName === undefined || functionName === "") {
    throw new Error(`${SIGNER_FUNCTION_ENV} is not set`);
  }

  return {
    async sign(snapshotKey: string, ttlS: number): Promise<string | null> {
      const out = await client.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: "RequestResponse",
          Payload: new TextEncoder().encode(JSON.stringify({ role: "family", snapshotKey, ttlS })),
        }),
      );
      if (out.FunctionError !== undefined) throw new Error("snapshot-signer failed");
      if (out.Payload === undefined) return null;

      const parsed: unknown = JSON.parse(new TextDecoder().decode(out.Payload));
      if (typeof parsed !== "object" || parsed === null) return null;
      const { ok, url } = parsed as { ok?: unknown; url?: unknown };
      return ok === true && typeof url === "string" ? url : null;
    },
  };
}
