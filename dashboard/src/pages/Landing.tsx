import { useState, type FormEvent } from "react";
import { COPY } from "../content/copy";
import type { SignInError } from "../lib/auth";

export interface LandingProps {
  /** Called inside the click handler, so it can unlock audio (Requirement 8.2). */
  onEnter: () => void;
  /** False when `/config.json` failed: Sign in is hidden (Requirement 1.6). */
  cloudAvailable: boolean;
  signedIn: boolean;
  onSignIn: (user: string, password: string) => Promise<{ ok: true } | { ok: false; error: SignInError }>;
}

const ERROR_TEXT: Record<SignInError, string> = {
  failed: COPY.signIn.failed,
  needs_setup: COPY.signIn.needsSetup,
  offline: COPY.signIn.offline,
};

/** First screen: legend, title, "Enter the house" and a separate "Sign in" (Requirement 1). */
export function Landing({ onEnter, cloudAvailable, signedIn, onSignIn }: LandingProps) {
  const [showForm, setShowForm] = useState(false);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await onSignIn(user, password);
    setBusy(false);
    // The password never stays in state after an attempt.
    setPassword("");
    if (result.ok) {
      setShowForm(false);
      setUser("");
    } else {
      setError(ERROR_TEXT[result.error]);
    }
  }

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
        <button type="button" className="button button--primary" onClick={onEnter}>
          {COPY.landing.enter}
        </button>
        {cloudAvailable && !signedIn && !showForm && (
          <button type="button" className="button" onClick={() => setShowForm(true)}>
            {COPY.landing.signIn}
          </button>
        )}
      </div>
      {!cloudAvailable && (
        <p className="landing__note" role="status">
          {COPY.landing.configUnavailable}
        </p>
      )}
      {cloudAvailable && !signedIn && showForm && (
        <form className="signin" onSubmit={(e) => void submit(e)} aria-labelledby="signin-heading">
          <h2 id="signin-heading">{COPY.signIn.heading}</h2>
          <label>
            {COPY.signIn.username}
            <input
              type="text"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={user}
              onChange={(e) => setUser(e.target.value)}
            />
          </label>
          <label>
            {COPY.signIn.password}
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error !== null && (
            <p className="signin__error" role="alert">
              {error}
            </p>
          )}
          <div className="signin__buttons">
            <button type="submit" className="button button--primary" disabled={busy}>
              {busy ? COPY.signIn.working : COPY.signIn.submit}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setShowForm(false);
                setError(null);
                setPassword("");
              }}
            >
              {COPY.signIn.cancel}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
