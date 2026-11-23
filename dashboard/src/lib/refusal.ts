import { COPY } from "../content/copy";
import type { ApiClient } from "./api";

/** Time between two checks for a refusal, and how long to keep checking (remote-feedback F2). */
export const REFUSAL_POLL_MS = 1500;
/** A doll on a weak Wi-Fi link can take several seconds to answer, so wait longer than that. */
export const REFUSAL_WAIT_MS = 15_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Asks `GET /commands/{id}` until the doll's refusal arrives or `waitMs` passes.
 *
 * Resolves the doll's error code, or `null` when no refusal came: the doll sends nothing for an
 * accepted command, so silence means accepted. A failed check counts as silence, because the
 * command itself was already sent and the user only loses the extra explanation.
 * `stillWanted` lets the caller stop early (unmounted, or a newer request started).
 */
export async function watchRefusal(
  api: ApiClient,
  id: string,
  stillWanted: () => boolean,
  pollMs = REFUSAL_POLL_MS,
  waitMs = REFUSAL_WAIT_MS,
): Promise<string | null> {
  const deadline = Date.now() + waitMs;
  while (stillWanted() && Date.now() < deadline) {
    await sleep(pollMs);
    if (!stillWanted()) return null;
    const result = await api.commandResult(id);
    if (result.ok && result.value.status === "rejected") return result.value.code;
  }
  return null;
}

/** Plain-language reason for a refusal code from `docs/schema.md`, "`error.reported` codes". */
export function refusalMessage(code: string): string {
  const r = COPY.refusal;
  switch (code) {
    case "command_rejected_state":
      return r.state;
    case "speak_rejected":
      return r.speakRejected;
    case "audio_busy":
      return r.audioBusy;
    case "unknown_line":
      return r.unknownLine;
    default:
      return r.other(code);
  }
}
