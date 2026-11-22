import { useEffect, useRef, useState, type FormEvent } from "react";
import { COPY } from "../content/copy";
import type { SignInError, SignInResult } from "../lib/auth";
import type { Role } from "../lib/roles";

export interface AccountMenuProps {
  role: Role;
  /** False when `/config.json` failed: sign-in cannot work (Requirement 1.6). */
  cloudAvailable: boolean;
  /** True while a stored session is being restored after a reload. */
  checking: boolean;
  onSignIn: (user: string, password: string) => Promise<SignInResult>;
  onSignOut: () => void;
}

/** Read at call time, so the text follows the language switch. */
function errorText(error: SignInError): string {
  const map: Record<SignInError, string> = {
    failed: COPY.signIn.failed,
    needs_setup: COPY.signIn.needsSetup,
    offline: COPY.signIn.offline,
  };
  return map[error];
}

/**
 * The one place for signing in and out, at the right end of the header. Its button reflects the
 * state: checking the stored session, signed out ("Sign in"), or signed in (role and a menu with
 * "Sign out"). The form opens in a popover on the same page, so signing in never changes route.
 */
export function AccountMenu({ role, cloudAvailable, checking, onSignIn, onSignOut }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<SignInError | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const signedIn = role !== "visitor";

  // Close on Escape and on a click outside.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

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
      setOpen(false);
      setUser("");
    } else {
      setError(result.error);
    }
  }

  if (checking) {
    return (
      <div className="account">
        <span className="account__checking" role="status">
          {COPY.signIn.checking}
        </span>
      </div>
    );
  }

  if (!cloudAvailable && !signedIn) {
    return (
      <div className="account">
        <button type="button" className="button" disabled title={COPY.landing.configUnavailable}>
          {COPY.landing.signIn}
        </button>
      </div>
    );
  }

  return (
    <div className="account" ref={rootRef}>
      <button
        type="button"
        className={signedIn ? "button account__button account__button--in" : "button button--primary account__button"}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-role={role}
        onClick={() => setOpen((v) => !v)}
      >
        {signedIn ? (
          <>
            <span className="account__dot" aria-hidden="true" />
            {COPY.roles[role]}
          </>
        ) : (
          COPY.landing.signIn
        )}
      </button>
      {open && (
        <div className="account__panel" role="dialog" aria-label={signedIn ? COPY.roles[role] : COPY.signIn.heading}>
          {signedIn ? (
            <>
              <p className="account__status">
                {COPY.signIn.signedInAs} <strong>{COPY.roles[role]}</strong>
              </p>
              <button
                type="button"
                className="button"
                onClick={() => {
                  setOpen(false);
                  onSignOut();
                }}
              >
                {COPY.roles.signOut}
              </button>
            </>
          ) : (
            <form className="signin" onSubmit={(e) => void submit(e)}>
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
                  autoFocus
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
                  {errorText(error)}
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
                    setOpen(false);
                    setError(null);
                    setPassword("");
                  }}
                >
                  {COPY.signIn.cancel}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
