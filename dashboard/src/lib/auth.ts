/**
 * Cognito sign-in for the dashboard (design D1, D16; Requirement 11).
 *
 * Plain `fetch` against `InitiateAuth` with `USER_PASSWORD_AUTH`. The access token and its expiry
 * live only in a closure: nothing goes to localStorage, sessionStorage, cookies, the URL or the
 * console, so a reload signs the user out (intended for a public demo). The refresh token and
 * the ID token are discarded. This module never logs.
 */

export type SignInError = "failed" | "needs_setup" | "offline";
export type SignInResult = { ok: true } | { ok: false; error: SignInError };

export interface Session {
  signIn(user: string, password: string): Promise<SignInResult>;
  /** Discards the token. The caller also clears cached real encounters. */
  signOut(): void;
  /**
   * The access token, or null when signed out or within 60 s of expiry. A near-expiry token is
   * discarded here, so the next API call behaves like a 401 (Requirement 11.5).
   */
  token(): string | null;
  /** Expiry as epoch milliseconds, or null when signed out. */
  expiresAt(): number | null;
  /** Calls `fn` whenever the signed-in state changes (sign-in, sign-out, expiry). */
  subscribe(fn: () => void): () => void;
}

export interface SessionDeps {
  region: string;
  userPoolClientId: string;
  fetch: typeof fetch;
  /** Epoch milliseconds. Injected so tests control time. */
  now: () => number;
}

/** A token this close to expiry is treated as already expired. */
export const EXPIRY_MARGIN_MS = 60_000;

const TARGET = "AWSCognitoIdentityProviderService.InitiateAuth";

export function createSession(deps: SessionDeps): Session {
  let accessToken: string | null = null;
  let expiry: number | null = null;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const fn of [...listeners]) fn();
  };

  const clear = (): boolean => {
    const had = accessToken !== null;
    accessToken = null;
    expiry = null;
    return had;
  };

  return {
    async signIn(user, password) {
      const url = `https://cognito-idp.${deps.region}.amazonaws.com/`;
      let response: Response;
      try {
        response = await deps.fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-amz-json-1.1",
            "X-Amz-Target": TARGET,
          },
          body: JSON.stringify({
            AuthFlow: "USER_PASSWORD_AUTH",
            ClientId: deps.userPoolClientId,
            AuthParameters: { USERNAME: user, PASSWORD: password },
          }),
        });
      } catch {
        return { ok: false, error: "offline" };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { ok: false, error: "failed" };
      }
      const obj = isRecord(body) ? body : {};

      // A challenge (for example NEW_PASSWORD_REQUIRED) cannot be answered here.
      if (typeof obj["ChallengeName"] === "string") {
        return { ok: false, error: "needs_setup" };
      }
      if (!response.ok) return { ok: false, error: "failed" };

      const result = obj["AuthenticationResult"];
      if (!isRecord(result)) return { ok: false, error: "failed" };
      const token = result["AccessToken"];
      const expiresIn = result["ExpiresIn"];
      if (
        typeof token !== "string" ||
        token === "" ||
        typeof expiresIn !== "number" ||
        !Number.isFinite(expiresIn) ||
        expiresIn <= 0
      ) {
        return { ok: false, error: "failed" };
      }

      // Only the access token is kept. RefreshToken and IdToken are never read.
      accessToken = token;
      expiry = deps.now() + expiresIn * 1000;
      notify();
      return { ok: true };
    },

    signOut() {
      if (clear()) notify();
    },

    token() {
      if (accessToken === null || expiry === null) return null;
      if (deps.now() >= expiry - EXPIRY_MARGIN_MS) {
        clear();
        notify();
        return null;
      }
      return accessToken;
    },

    expiresAt() {
      return expiry;
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
