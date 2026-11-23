import { COPY } from "../content/copy";
import { diaryComment } from "../lib/diary";
import { formatJst } from "../lib/time";
import { InfoTip } from "./InfoTip";
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
  /** Optional explanation shown behind an "i" button next to the heading. */
  tip?: string;
}

/** Label for the verdict of an entry. A reaction without a verdict was made offline. */
export function verdictLabel(e: TimelineEntry): string {
  if (e.verdict !== null) return COPY.verdicts[e.verdict];
  return e.reaction?.offline === true ? COPY.verdicts.offline : "—";
}


/** One table of encounters under its own heading (Requirement 10.5). Pure presentation. */
export function TimelineList(props: TimelineListProps) {
  const { heading, items, emptyText, onOpen, openId, onShowOlder, loadingOlder, tip } = props;
  const headingId = `tl-${heading.replace(/\W+/g, "-").toLowerCase()}`;
  const cols = COPY.timeline.columns;
  return (
    <section className="timeline-list" aria-labelledby={headingId}>
      <h2 id={headingId}>
        {heading}
        {tip ? <InfoTip text={tip} /> : null}
      </h2>
      {items.length === 0 ? (
        <p>{emptyText}</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{cols.time}</th>
                <th scope="col">
                  {cols.verdict}
                  <InfoTip text={COPY.tips.verdict} />
                </th>
                <th scope="col">{cols.diary}</th>
                <th scope="col">{cols.notes}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.encounterId} aria-selected={openId === e.encounterId}>
                  <td>
                    <button
                      type="button"
                      className="data-table__open"
                      aria-expanded={openId === e.encounterId}
                      onClick={() => onOpen(e)}
                    >
                      <time dateTime={e.startedAt}>{formatJst(e.startedAt)}</time>
                    </button>
                  </td>
                  <td>
                    <span className="verdict-chip" data-verdict={e.verdict ?? "none"}>
                      {verdictLabel(e)}
                    </span>
                  </td>
                  <td className="diary-note">{diaryComment(e)}</td>
                  <td>
                    {"mode" in e && e.mode === "live" ? <span>{COPY.timeline.liveCloudLabel} </span> : null}
                    {"line" in e && e.line !== null ? (
                      <span>
                        <span lang="ja">{e.line.ja}</span> / <span lang="en">{e.line.en}</span>{" "}
                      </span>
                    ) : null}
                    {e.notified ? (
                      <span>
                        {COPY.timeline.familyNotified}
                        {"mode" in e ? ` ${COPY.timeline.familyNotifiedNote}` : ""}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {onShowOlder ? (
        <button type="button" className="button" onClick={onShowOlder} disabled={loadingOlder === true}>
          {COPY.timeline.showOlder}
        </button>
      ) : null}
    </section>
  );
}
