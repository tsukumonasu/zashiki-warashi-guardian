import { COPY } from "../content/copy";
import { indicatorView, type StatusFetch } from "../simulation/indicator";

export interface PrivacyIndicatorProps {
  statusFetch: StatusFetch;
}

/**
 * Header indicator of the real doll's camera and microphone (Requirements 13.4 to 13.9).
 * Always shows a text label together with a symbol, never colour alone. The pure view decides
 * what to show; the label comes from `COPY`, so it follows the language switch.
 */
export function PrivacyIndicator({ statusFetch }: PrivacyIndicatorProps) {
  const view = indicatorView(statusFetch);

  if (view.kind === "active") {
    return (
      <div className="privacy-indicator privacy-active" role="status" data-kind="active">
        {view.parts.map((part) => (
          <span key={part} className="privacy-part">
            <span aria-hidden="true" className="privacy-symbol">
              {part === "Camera on" ? "◉" : "●"}
            </span>{" "}
            {part === "Camera on" ? COPY.privacy.cameraOn : COPY.privacy.microphoneOn}
          </span>
        ))}
      </div>
    );
  }

  const symbol = view.kind === "off" ? "○" : view.kind === "unknown" ? "?" : "◇";
  return (
    <div className={`privacy-indicator privacy-${view.kind}`} role="status" data-kind={view.kind}>
      <span aria-hidden="true" className="privacy-symbol">
        {symbol}
      </span>{" "}
      {COPY.privacy[view.kind]}
    </div>
  );
}
