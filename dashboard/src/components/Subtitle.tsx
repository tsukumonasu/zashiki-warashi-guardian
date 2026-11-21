/**
 * Visible caption for a spoken line: Japanese first, English below (Requirement 8.1).
 *
 * Not a live region: `LiveRegion` announces the same text once, so a screen reader does not
 * hear it twice. The box keeps its height when empty so the layout does not jump.
 */
import "./VirtualDoll.css";

export interface SubtitleProps {
  subtitle: { ja: string; en: string } | null;
}

export function Subtitle({ subtitle }: SubtitleProps) {
  return (
    <div className="subtitle" data-empty={subtitle === null} data-testid="subtitle">
      {subtitle !== null && (
        <>
          <p className="subtitle__ja" lang="ja">
            {subtitle.ja}
          </p>
          <p className="subtitle__en" lang="en">
            {subtitle.en}
          </p>
        </>
      )}
    </div>
  );
}
