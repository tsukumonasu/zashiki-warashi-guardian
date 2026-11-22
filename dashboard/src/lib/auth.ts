/**
 * Cognito sign-in for the dashboard (design D1, D16; Requirement 11).
 *
 * Plain `fetch` against `InitiateAuth` with `USER_PASSWORD_AUTH`. The access token and its expiry
 * live only in a closure. So that a page reload does not sign the user out, the refresh token is
 * kept in `sessionStorage` (the tab's own storage: it survives a reload, is gone when the tab
 * closes, and is never shared with other tabs). On start, `restore()` trades it for a new access
 * token, and a timer refreshes the access token before it expires. The ID token is discarded and
 * nothing goes to localStorage, cookies, the URL or the console. This module never logs.
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
  /**
   * Signs in again from the stored refresh token, if there is one. `none` means nothing was
   * stored or the token was refused (it is then deleted). `offline` keeps it for a later try.
   */
  restore(): Promise<"restored" | "none" | "offline">;
  /** Calls `fn` whenever the signed-in state changes (sign-in, sign-out, expiry). */
  subscribe(fn: () => void): () => void;
}

export interface SessionDeps {
  region: string;
  userPoolClientId: string;
  fetch: typeof fetch;
  /** Epoch milliseconds. Injected so tests control time. */
  now: () => number;
  /** Where the refresh token is kept. Omit it to keep nothing (tests, no storage available). */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** Schedules the silent refresh. Omit it to disable the timer. Returns a cancel function. */
  setTimer?: (fn: () => void, ms: number) => () => void;
}
/** The storage key of the refresh token. */
export const REFRESH_KEY = "warashi.refresh";
/** The access token is renewed this long before it expires. */
const REFRESH_LEAD_MS = 120_000;

/** A token this close to expiry is treated as already expired. */
export const EXPIRY_MARGIN_MS = 60_000;

const TARGET = "AWSCognitoIdentityProviderService.InitiateAuth";
type AuthParameters = Record<string, string>;

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

  let cancelTimer: (() => void) | null = null;
  const stored = (): string | null => {
    try {
      return deps.storage?.getItem(REFRESH_KEY) ?? null;
    } catch {
      return null;
    }
  };
  const store = (value: string | null): void => {
    try {
      if (value === null) deps.storage?.removeItem(REFRESH_KEY);
      else deps.storage?.setItem(REFRESH_KEY, value);
    } catch {
      // Storage can be blocked (private mode); the session then lasts until reload.
    }
  };
  const forget = (): boolean => {
    cancelTimer?.();
    cancelTimer = null;
    store(null);
    return clear();
  };

  /** One InitiateAuth call. Applies the result and returns it. */
  async function authenticate(
    flow: "USER_PASSWORD_AUTH" | "REFRESH_TOKEN_AUTH",
    params: AuthParameters,
  ): Promise<SignInResult> {
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
          AuthFlow: flow,
          ClientId: deps.userPoolClientId,
          AuthParameters: params,
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
    accessToken = token;
    expiry = deps.now() + expiresIn * 1000;
    // Only a refresh token is kept; a refresh response has none unless Cognito rotates it.
    const refresh = result["RefreshToken"];
    if (typeof refresh === "string" && refresh !== "") store(refresh);
    scheduleRefresh(expiresIn * 1000);
    notify();
    return { ok: true };
  }

  function scheduleRefresh(expiresInMs: number): void {
    cancelTimer?.();
    cancelTimer = null;
    if (!deps.setTimer) return;
    const wait = Math.max(expiresInMs - REFRESH_LEAD_MS, 10_000);
    cancelTimer = deps.setTimer(() => {
      void refreshNow().then((outcome) => {
        // A network failure is retried; a refused token ends the session.
        if (outcome === "offline") scheduleRefresh(REFRESH_LEAD_MS + 30_000);
      });
    }, wait);
  }

  async function refreshNow(): Promise<"restored" | "none" | "offline"> {
    const refresh = stored();
    if (refresh === null) return "none";
    const result = await authenticate("REFRESH_TOKEN_AUTH", { REFRESH_TOKEN: refresh });
    if (result.ok) return "restored";
    if (result.error === "offline") return "offline";
    if (forget()) notify();
    return "none";
  }

  return {
    signIn(user, password) {
      return authenticate("USER_PASSWORD_AUTH", { USERNAME: user, PASSWORD: password });
    },
    restore: refreshNow,
    signOut() {
      const had = forget();
      if (had) notify();
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
