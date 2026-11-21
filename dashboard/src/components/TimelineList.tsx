import { COPY } from "../content/copy";
import type { Encounter, SimEncounter } from "../simulation/types";

export type TimelineEntry = Encounter | SimEncounter;

export interface TimelineListProps {
  /** Heading text; the list is labelled by it. */
  heading: string;
  items: readonly TimelineEntry[];
  /** Shown instead of the list when it is empty. */
  emptyText: string;
  onOpen: (entry: TimelineEntry) => void;
  /** Id of the entry whose detail is open, if any. */
  openId?: string | null;
  /** When set, a "Show older" button is shown. */
  onShowOlder?: (() => void) | null;
  loadingOlder?: boolean;
}

/** Label for the verdict of an entry. A reaction without a verdict was made offline. */
export function verdictLabel(e: TimelineEntry): string {
  if (e.verdict !== null) return COPY.verdicts[e.verdict];
  return e.reaction?.offline === true ? COPY.verdicts.offline : "—";
}

function formatTime(ts: string): string {
  // ISO strings from the cloud and the engine are UTC; show them as is, without Date.
  return ts.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/** One list of encounters under its own heading (Requirement 10.5). Pure presentation. */
export function TimelineList(props: TimelineListProps) {
  const { heading, items, emptyText, onOpen, openId, onShowOlder, loadingOlder } = props;
  const headingId = `tl-${heading.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <section className="timeline-list" aria-labelledby={headingId}>
      <h2 id={headingId}>{heading}</h2>
      {items.length === 0 ? (
        <p>{emptyText}</p>
      ) : (
        <ul>
          {items.map((e) => (
            <li key={e.encounterId}>
              <button
                type="button"
                aria-expanded={openId === e.encounterId}
                onClick={() => onOpen(e)}
              >
                <time dateTime={e.startedAt}>{formatTime(e.startedAt)}</time>{" "}
                <span>{verdictLabel(e)}</span>
                {"mode" in e && e.mode === "live" ? <span> · {COPY.timeline.liveCloudLabel}</span> : null}
                {"line" in e && e.line !== null ? (
                  <span>
                    {" "}
                    · <span lang="ja">{e.line.ja}</span> / <span lang="en">{e.line.en}</span>
                  </span>
                ) : null}
                {e.notified ? (
                  <span>
                    {" "}
                    · {COPY.timeline.familyNotified}
                    {"mode" in e ? ` ${COPY.timeline.familyNotifiedNote}` : ""}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {onShowOlder ? (
        <button type="button" onClick={onShowOlder} disabled={loadingOlder === true}>
          {COPY.timeline.showOlder}
        </button>
      ) : null}
    </section>
  );
}
