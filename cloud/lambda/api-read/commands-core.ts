/**
 * Pure core of `GET /commands/{id}` (remote-feedback F2, `docs/schema.md`, "HTTP API").
 *
 * Family only. `rejected` with the doll's error code once ingest recorded an `error.reported` whose
 * `refId` is this id; `pending` otherwise. The doll sends nothing for an accepted command, so the
 * dashboard asks for a few seconds and then treats `pending` as accepted. An unknown, expired or
 * foreign id is `pending`, so the answer reveals nothing. No AWS imports. Time is injected.
 */
import type { Role } from "../_shared/authz.js";
import { ApiError } from "../_shared/http.js";
import type { CommandResultReader } from "../_shared/ports.js";
import { isLive } from "../_shared/ttl.js";

const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export interface CommandResultRead {
  role: Role;
  pathParameters: Readonly<Record<string, string>>;
}

export interface CommandResultDeps {
  results: CommandResultReader;
  nowMs: number;
}

export type CommandResult = { status: "pending" } | { status: "rejected"; code: string };

export async function handleGetCommandResult(
  request: CommandResultRead,
  deps: CommandResultDeps,
): Promise<CommandResult> {
  if (request.role !== "family") throw new ApiError("forbidden", "Not allowed.");
  const id = request.pathParameters["id"];
  if (id === undefined || !ID_PATTERN.test(id)) {
    throw new ApiError("validation_failed", "id is not valid.");
  }
  const rejection = await deps.results.getRejection(id);
  if (rejection === null || !isLive({ ttl: rejection.ttl }, Math.floor(deps.nowMs / 1000))) {
    return { status: "pending" };
  }
  return { status: "rejected", code: rejection.code };
}
