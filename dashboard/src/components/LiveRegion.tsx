/**
 * Polite live region (Requirement 17.5). It announces each new subtitle (Japanese, then
 * English) and each new state label once. The text is visually hidden; the visible copies
 * are not live, so nothing is read twice.
 */
import "./VirtualDoll.css";

export interface LiveRegionProps {
  stateLabel: string | null;
  subtitle: { ja: string; en: string } | null;
}

export function LiveRegion({ stateLabel, subtitle }: LiveRegionProps) {
  return (
    <>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="live-state">
        {stateLabel ?? ""}
      </div>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="live-subtitle">
        {subtitle === null ? "" : `${subtitle.ja} ${subtitle.en}`}
      </div>
    </>
  );
}
