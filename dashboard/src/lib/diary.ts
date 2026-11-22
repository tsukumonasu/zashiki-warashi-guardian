import { COPY } from "../content/copy";
import type { Encounter, SimEncounter } from "../simulation/types";

export type DiaryKind = "family" | "stranger" | "strangerNotified" | "no_face" | "uncertain" | "offline" | "unknown";

/**
 * Which kind of diary note an encounter gets. Pure: it reads only the verdict, the reaction and
 * the notification flag, never a name or an image.
 */
export function diaryKind(e: Pick<Encounter | SimEncounter, "verdict" | "notified" | "reaction">): DiaryKind {
  if (e.verdict === "stranger") return e.notified ? "strangerNotified" : "stranger";
  if (e.verdict !== null) return e.verdict;
  return e.reaction?.offline === true ? "offline" : "unknown";
}

/** A small stable number from the id, so an entry keeps its wording on every render. */
function pick(id: string, count: number): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % count;
}

/** The doll's own note about one visit, in the current language. */
export function diaryComment(
  e: Pick<Encounter | SimEncounter, "encounterId" | "verdict" | "notified" | "reaction">,
): string {
  const options = COPY.diary.comments[diaryKind(e)];
  return options[pick(e.encounterId, options.length)] ?? "";
}
