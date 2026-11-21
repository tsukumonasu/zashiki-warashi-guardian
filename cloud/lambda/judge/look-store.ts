/**
 * DynamoDB adapter for `LookStore`: one item `LOOK#<requestId>` / `RESULT` with `verdict`, `at`
 * and a `ttl` in epoch seconds. Thin: the lifetime comes in as an argument.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

import type { LookStore } from "./judge-core.js";

export function createLookStore(
  options: { client?: DynamoDBDocumentClient; tableName?: string } = {},
): LookStore {
  const client = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const table = options.tableName ?? process.env["WARASHI_TABLE_NAME"];
  if (table === undefined || table === "") throw new Error("WARASHI_TABLE_NAME is not set");
  return {
    async putLook(requestId, verdict, atMs, ttlS) {
      await client.send(
        new PutCommand({
          TableName: table,
          Item: {
            pk: `LOOK#${requestId}`,
            sk: "RESULT",
            verdict,
            at: atMs,
            ttl: Math.floor(atMs / 1000) + ttlS,
          },
        }),
      );
    },
  };
}
