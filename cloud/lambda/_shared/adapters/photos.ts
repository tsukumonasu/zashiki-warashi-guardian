/**
 * DynamoDB adapter for the remote photo index: one item `PHOTO#<requestId>` / `META` with the
 * S3 key, the device id, the arrival time and a `ttl`. Thin: the lifetime comes in as data.
 * Image bytes never reach the table.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { PhotoReader, PhotoRecord, PhotoStore } from "../ports.js";

export type PhotoAdapterOptions = { client?: DynamoDBDocumentClient; tableName?: string };

function resolve(options: PhotoAdapterOptions): { client: DynamoDBDocumentClient; table: string } {
  const client = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const table = options.tableName ?? process.env["WARASHI_TABLE_NAME"];
  if (table === undefined || table === "") throw new Error("WARASHI_TABLE_NAME is not set");
  return { client, table };
}

const keyOf = (requestId: string): { pk: string; sk: string } => ({
  pk: `PHOTO#${requestId}`,
  sk: "META",
});

export function createPhotoStore(options: PhotoAdapterOptions = {}): PhotoStore {
  const { client, table } = resolve(options);
  return {
    async putPhoto(photo) {
      await client.send(
        new PutCommand({
          TableName: table,
          Item: {
            ...keyOf(photo.requestId),
            deviceId: photo.deviceId,
            snapshotKey: photo.snapshotKey,
            at: photo.atMs,
            ttl: photo.ttl,
          },
        }),
      );
    },
  };
}

export function createPhotoReader(options: PhotoAdapterOptions = {}): PhotoReader {
  const { client, table } = resolve(options);
  return {
    async getPhoto(requestId): Promise<PhotoRecord | null> {
      const out = await client.send(
        new GetCommand({ TableName: table, Key: keyOf(requestId), ConsistentRead: true }),
      );
      const item = out.Item;
      if (item === undefined) return null;
      const { deviceId, snapshotKey, at, ttl } = item as Record<string, unknown>;
      if (
        typeof deviceId !== "string" ||
        typeof snapshotKey !== "string" ||
        typeof at !== "number" ||
        typeof ttl !== "number"
      ) {
        return null;
      }
      return { requestId, deviceId, snapshotKey, atMs: at, ttl };
    },
  };
}
