import { useCallback, useEffect, useRef, useState } from "react";
import { COPY } from "../content/copy";
import { EncounterDetail } from "../components/EncounterDetail";
import { TimelineList, type TimelineEntry } from "../components/TimelineList";
import { Locked } from "../components/Locked";
import type { ApiClient } from "../lib/api";
import { capabilities, type Role } from "../lib/roles";
import type { Encounter, SimEncounter } from "../simulation/types";

export const PAGE_SIZE = 20;

export interface TimelineProps {
  api: ApiClient;
  role: Role;
  illustrationBase: string;
  /** Simulated encounters from the scenario runner, already ordered newest first. */
  simulated: readonly SimEncounter[];
}

type RealState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; items: Encounter[]; nextCursor: string | null };

type Open =
  | { kind: "sim"; entry: SimEncounter }
  | { kind: "real"; id: string; state: "loading" | "failed" | "hidden" | Encounter };

/** Timeline page: simulated and real visits under separate headings (Requirement 10). */
export function Timeline({ api, role, illustrationBase, simulated }: TimelineProps) {
  const canSeeReal = capabilities(role).realTimeline;
  const [real, setReal] = useState<RealState>({ status: "loading" });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [open, setOpen] = useState<Open | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadFirst = useCallback(async () => {
    setReal({ status: "loading" });
    const r = await api.encounters(PAGE_SIZE);
    if (!mounted.current) return;
    setReal(
      r.ok
        ? { status: "ready", items: r.value.items, nextCursor: r.value.nextCursor }
        : { status: "failed" },
    );
  }, [api]);

  useEffect(() => {
    if (canSeeReal) void loadFirst();
  }, [canSeeReal, loadFirst]);

  async function showOlder(): Promise<void> {
    if (real.status !== "ready" || real.nextCursor === null) return;
    setLoadingOlder(true);
    const r = await api.encounters(PAGE_SIZE, real.nextCursor);
    if (!mounted.current) return;
    setLoadingOlder(false);
    if (r.ok) {
      setReal({
        status: "ready",
        items: [...real.items, ...r.value.items],
        nextCursor: r.value.nextCursor,
      });
    } else {
      setReal({ status: "failed" });
    }
  }

  async function openReal(id: string): Promise<void> {
    setOpen({ kind: "real", id, state: "loading" });
    const r = await api.encounter(id);
    if (!mounted.current) return;
    if (r.ok) setOpen({ kind: "real", id, state: r.value });
    else setOpen({ kind: "real", id, state: r.error.code === "not_found" && role === "reviewer" ? "hidden" : "failed" });
  }

  function onOpenSim(entry: TimelineEntry): void {
    setOpen({ kind: "sim", entry: entry as SimEncounter });
  }

  const realBody = () => {
    if (!canSeeReal) return <p>{COPY.locked.visitor}</p>;
    if (real.status === "loading") return <p role="status">Loading…</p>;
    if (real.status === "failed") {
      return (
        <div role="alert">
          <p>{COPY.timeline.loadFailed}</p>
          <button type="button" onClick={() => void loadFirst()}>
            {COPY.timeline.tryAgain}
          </button>
        </div>
      );
    }
    // The cloud answers a reviewer with an empty list when the owner hides real visits (docs/schema.md).
    const emptyText = role === "reviewer" ? COPY.timeline.hiddenFromGuests : COPY.timeline.empty;
    return (
      <TimelineList
        heading={COPY.timeline.realHeading}
        items={real.items}
        emptyText={emptyText}
        openId={open?.kind === "real" ? open.id : null}
        onOpen={(e) => void openReal(e.encounterId)}
        onShowOlder={real.nextCursor !== null ? () => void showOlder() : null}
        loadingOlder={loadingOlder}
      />
    );
  };

  return (
    <main className="timeline-page">
      <TimelineList
        heading={COPY.timeline.simulatedHeading}
        items={simulated}
        emptyText={COPY.timeline.empty}
        openId={open?.kind === "sim" ? open.entry.encounterId : null}
        onOpen={onOpenSim}
      />

      {canSeeReal ? (
        realBody()
      ) : (
        <section aria-label={COPY.timeline.realHeading}>
          <h2>{COPY.timeline.realHeading}</h2>
          <Locked label={COPY.timeline.realHeading} explanation={COPY.locked.visitor} />
        </section>
      )}

      {open?.kind === "sim" ? (
        <EncounterDetail
          encounter={open.entry}
          role={role}
          illustrationBase={illustrationBase}
          simulated
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open?.kind === "real" ? (
        open.state === "loading" ? (
          <p role="status">Loading…</p>
        ) : open.state === "hidden" ? (
          <p>{COPY.timeline.hiddenFromGuests}</p>
        ) : open.state === "failed" ? (
          <div role="alert">
            <p>{COPY.timeline.loadFailed}</p>
            <button type="button" onClick={() => void openReal(open.id)}>
              {COPY.timeline.tryAgain}
            </button>
          </div>
        ) : (
          <EncounterDetail
            encounter={open.state}
            role={role}
            illustrationBase={illustrationBase}
            onClose={() => setOpen(null)}
          />
        )
      ) : null}
    </main>
  );
}
