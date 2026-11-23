/**
 * DynamoDB adapter for command refusals: one item `CMD#<id>` / `RESULT` with the device id, the
 * error code and a `ttl` (remote-feedback F2). Thin: the lifetime comes in as data. The item holds
 * no message text and no names.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { CommandRejection, CommandResultReader, CommandResultStore } from "../ports.js";

export type CommandResultAdapterOptions = { client?: DynamoDBDocumentClient; tableName?: string };

function resolve(options: CommandResultAdapterOptions): { client: DynamoDBDocumentClient; table: string } {
  const client = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const table = options.tableName ?? process.env["WARASHI_TABLE_NAME"];
  if (table === undefined || table === "") throw new Error("WARASHI_TABLE_NAME is not set");
  return { client, table };
}

const keyOf = (id: string): { pk: string; sk: string } => ({ pk: `CMD#${id}`, sk: "RESULT" });

export function createCommandResultStore(options: CommandResultAdapterOptions = {}): CommandResultStore {
  const { client, table } = resolve(options);
  return {
    async putRejection(rejection) {
      await client.send(
        new PutCommand({
          TableName: table,
          Item: { ...keyOf(rejection.id), deviceId: rejection.deviceId, code: rejection.code, ttl: rejection.ttl },
        }),
      );
    },
  };
}

export function createCommandResultReader(options: CommandResultAdapterOptions = {}): CommandResultReader {
  const { client, table } = resolve(options);
  return {
    async getRejection(id): Promise<CommandRejection | null> {
      const out = await client.send(new GetCommand({ TableName: table, Key: keyOf(id), ConsistentRead: true }));
      const item = out.Item;
      if (item === undefined) return null;
      const { deviceId, code, ttl } = item as Record<string, unknown>;
      if (typeof deviceId !== "string" || typeof code !== "string" || typeof ttl !== "number") return null;
      return { id, deviceId, code, ttl };
    },
  };
}
