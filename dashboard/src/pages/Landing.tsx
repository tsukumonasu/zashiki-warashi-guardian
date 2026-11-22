import { COPY } from "../content/copy";

export interface LandingProps {
  /** Called inside the click handler, so it can unlock audio (Requirement 8.2). */
  onEnter: () => void;
  /** False when `/config.json` failed (Requirement 1.6). */
  cloudAvailable: boolean;
}

/** First screen: legend, title and "Enter the house". Signing in lives in the header. */
export function Landing({ onEnter, cloudAvailable }: LandingProps) {
  return (
    <section className="landing">
      <h1 className="landing__title">
        <span lang="ja" className="landing__kanji">
          {COPY.landing.titleKanji}
        </span>
        <span className="landing__reading">{COPY.landing.titleReading}</span>
        <span className="landing__translation">{COPY.landing.titleTranslation}</span>
      </h1>
      <p className="landing__legend">{COPY.landing.legend}</p>
      <div className="landing__actions">
        <button type="button" className="button button--primary button--large" onClick={onEnter}>
          {COPY.landing.enter}
        </button>
      </div>
      {!cloudAvailable && (
        <p className="landing__note" role="status">
          {COPY.landing.configUnavailable}
        </p>
      )}
    </section>
  );
}
