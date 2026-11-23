import { COPY } from "../content/copy";
import { capabilities, type Role } from "../lib/roles";
import { formatJst } from "../lib/time";
import type { Encounter, SchemaMessage, SimEncounter } from "../simulation/types";
import { verdictLabel } from "./TimelineList";

export interface EncounterDetailProps {
  encounter: Encounter | SimEncounter;
  role: Role;
  /** Base location of the silhouette illustrations (`illustrationBase` of config.json). */
  illustrationBase: string;
  /** Simulated encounters never have a real image. */
  simulated?: boolean;
  onClose: () => void;
}

/** Events in time order. Array sort is stable, so equal timestamps keep their log order. */
export function eventsInTimeOrder(events: readonly SchemaMessage[]): SchemaMessage[] {
  return [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

export function illustrationUrl(base: string, name: string): string {
  return `${base.replace(/\/+$/, "")}/${name}.svg`;
}

function describeEvent(m: SchemaMessage): string {
  if (m.type === "state.changed") {
    return `${m.type}: ${m.data.from} → ${m.data.to} (${m.data.reason})`;
  }
  return m.type;
}

/** Detail of one encounter (Requirements 10.7 to 10.9, 16.3, 16.4). */
export function EncounterDetail({ encounter, role, illustrationBase, simulated, onClose }: EncounterDetailProps) {
  const snapshotMode = simulated === true ? "none" : capabilities(role).snapshot;
  return (
    <article className="encounter-detail" aria-label="Encounter detail">
      <button type="button" onClick={onClose}>
        Close
      </button>
      <p>
        {verdictLabel(encounter)}
        {encounter.confidence !== null ? ` (${encounter.confidence.toFixed(2)})` : ""}
      </p>
      {"line" in encounter && encounter.line !== null ? (
        <p>
          <span lang="ja">{encounter.line.ja}</span> / <span lang="en">{encounter.line.en}</span>
        </p>
      ) : null}
      {encounter.notified ? (
        <p>
          {COPY.timeline.familyNotified}
          {simulated === true ? ` ${COPY.timeline.familyNotifiedNote}` : ""}
        </p>
      ) : null}

      {snapshotMode === "url" ? (
        encounter.snapshot !== null ? (
          <img src={encounter.snapshot.url} alt="Snapshot taken by the doll" width={160} />
        ) : (
          <p>{COPY.timeline.snapshotExpired}</p>
        )
      ) : null}
      {snapshotMode === "illustration" && encounter.illustration !== null ? (
        <img
          src={illustrationUrl(illustrationBase, encounter.illustration)}
          alt="Illustration of the visit"
          width={160}
        />
      ) : null}

      <ol aria-label="Events">
        {eventsInTimeOrder(encounter.events).map((m) => (
          <li key={m.id}>
            <time dateTime={m.ts}>{formatJst(m.ts)}</time> {describeEvent(m)}
          </li>
        ))}
      </ol>
    </article>
  );
}
