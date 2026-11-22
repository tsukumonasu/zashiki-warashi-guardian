/**
 * App shell: header (role label, navigation, Mute_Control, Privacy_Indicator), hash routes,
 * sign-in and sign-out, 401 and 403 handling, offline banner, config failure behaviour.
 *
 * The header sits outside the ErrorBoundary, so a crash in a page never hides the Mute_Control
 * or the Privacy_Indicator (Requirements 8.3, 13.4, 19.5). The House page stays mounted on
 * every route (hidden when not shown) so a running scenario and the simulated Timeline survive
 * navigation.
 *
 * Language: the shell owns the choice (stored, else the browser language), calls `setLanguage`
 * before rendering and re-renders on a switch, so every page reads `COPY` in the new language.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountMenu } from "./components/AccountMenu";
import { ControlPanel } from "./components/ControlPanel";
import { DevicePanel } from "./components/DevicePanel";
import { InfoTip } from "./components/InfoTip";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PrivacyIndicator } from "./components/PrivacyIndicator";
import { TalkPanel } from "./components/TalkPanel";
import { COPY, setLanguage, type Lang } from "./content/copy";
import { browserLanguages, detectLanguage, readStoredLanguage, storeLanguage } from "./content/language";
import { DEVICE_ID, useDeviceStatus } from "./hooks/useDeviceStatus";
import { createApiClient, type ApiClient, type ApiResult, type VoiceInfo } from "./lib/api";
import { createAudioPlayer } from "./lib/audio";
import { createSession, type Session, type SignInResult } from "./lib/auth";
import { hrefFor, navigate, watchRoute, type Route } from "./lib/router";
import { capabilities, type Role } from "./lib/roles";
import { loadSettings, type Settings, type SettingsResult } from "./lib/settings";
import { FamilyPage } from "./pages/Family";
import { Help } from "./pages/Help";
import { House } from "./pages/House";
import { Landing } from "./pages/Landing";
import { Timeline } from "./pages/Timeline";
import type { SimEncounter } from "./simulation/types";

/** Built at render time so the labels follow the language switch. */
function navItems(): { route: Route; label: string }[] {
  return [
    { route: "/house", label: COPY.shell.nav.house },
    { route: "/timeline", label: COPY.shell.nav.timeline },
    { route: "/family", label: COPY.shell.nav.family },
    { route: "/help", label: COPY.shell.nav.help },
  ];
}

/** The language to start with. Also applies it, so the first render is already translated. */
function initialLanguage(): Lang {
  const lang = detectLanguage(readStoredLanguage(), browserLanguages());
  setLanguage(lang);
  return lang;
}

const API_METHODS = [
  "me",
  "samples",
  "encounters",
  "encounter",
  "deviceStatus",
  "simulate",
  "command",
  "faces",
  "faceUpload",
  "faceRegister",
  "faceDelete",
  "startConversation",
  "endConversation",
] as const;

/** Wraps every API method so a 401 or 403 reaches the shell (Requirements 11.5, 11.6). */
function withAuthHandling(
  raw: ApiClient,
  onUnauthorized: () => void,
  onForbidden: () => void,
): ApiClient {
  const wrapped: Record<string, unknown> = {};
  for (const key of API_METHODS) {
    const method = raw[key] as (...args: unknown[]) => Promise<ApiResult<unknown>>;
    wrapped[key] = async (...args: unknown[]) => {
      const result = await method.apply(raw, args);
      if (!result.ok) {
        if (result.error.code === "unauthorized") onUnauthorized();
        else if (result.error.code === "forbidden") onForbidden();
      }
      return result;
    };
  }
  return wrapped as unknown as ApiClient;
}

/** The tab's own storage, or undefined when the browser blocks it. */
function browserStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

export function App() {
  const [lang, setLang] = useState<Lang>(initialLanguage);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const toggleLanguage = (): void => {
    const next: Lang = lang === "en" ? "ja" : "en";
    setLanguage(next); // before the state change, so the re-render reads the new text
    storeLanguage(next);
    setLang(next);
  };

  const [settingsResult, setSettingsResult] = useState<SettingsResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((r) => {
      if (!cancelled) setSettingsResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const settings: Settings | null = settingsResult?.status === "ok" ? settingsResult.settings : null;
  const cloudAvailable = settings !== null;

  const [route, setRoute] = useState<Route>("/");
  useEffect(() => watchRoute(setRoute), []);

  const online = useOnline();
  const player = useMemo(() => createAudioPlayer(), []);
  const [muted, setMuted] = useState(false);

  const [role, setRole] = useState<Role>("visitor");
  const [voice, setVoice] = useState<VoiceInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const roleRef = useRef<Role>("visitor");
  roleRef.current = role;
  const manualSignOut = useRef(false);
  /** Bumped on sign-out so pages holding cached real encounters are rebuilt empty. */
  const [sessionKey, setSessionKey] = useState(0);
  const [simulated, setSimulated] = useState<readonly SimEncounter[]>([]);

  const session: Session | null = useMemo(
    () =>
      settings === null
        ? null
        : createSession({
            region: settings.region,
            userPoolClientId: settings.userPoolClientId,
            fetch: (...args) => fetch(...args),
            now: () => Date.now(),
            storage: browserStorage(),
            setTimer: (fn, ms) => {
              const id = window.setTimeout(fn, ms);
              return () => window.clearTimeout(id);
            },
          }),
    [settings],
  );

  const discardSession = useCallback((message: string | null) => {
    session?.signOut();
    setRole("visitor");
    setVoice(null);
    setSessionKey((k) => k + 1);
    setNotice(message);
  }, [session]);

  // A session that ends by itself (expiry) behaves like a 401.
  useEffect(() => {
    if (session === null) return;
    return session.subscribe(() => {
      if (session.expiresAt() === null && roleRef.current !== "visitor" && !manualSignOut.current) {
        // The access token ran out. Try the stored refresh token before giving up.
        void session.restore().then((outcome) => {
          if (outcome === "restored" || roleRef.current === "visitor") return;
          setRole("visitor");
          setVoice(null);
          setSessionKey((k) => k + 1);
          setNotice(COPY.roles.signedOutAgain);
        });
      }
    });
  }, [session]);

  const api: ApiClient = useMemo(() => {
    const raw = createApiClient({
      baseUrl: settings?.apiUrl ?? "https://cloud-unavailable.invalid",
      getToken: () => session?.token() ?? null,
      fetch: (...args) => fetch(...args),
      setTimer: (fn, ms) => {
        const id = window.setTimeout(fn, ms);
        return () => window.clearTimeout(id);
      },
    });
    return withAuthHandling(
      raw,
      () => {
        if (roleRef.current !== "visitor") discardSession(COPY.roles.signedOutAgain);
      },
      () => {
        if (roleRef.current !== "visitor") {
          setNotice(COPY.roles.forbidden);
          navigate("/house");
        }
      },
    );
  }, [settings, session, discardSession]);

  const signIn = useCallback(
    async (user: string, password: string): Promise<SignInResult> => {
      if (session === null) return { ok: false, error: "failed" };
      const result = await session.signIn(user, password);
      if (!result.ok) return result;
      const me = await api.me();
      if (!me.ok) {
        manualSignOut.current = true;
        session.signOut();
        manualSignOut.current = false;
        return { ok: false, error: "failed" };
      }
      setNotice(null);
      setRole(me.value.role);
      setVoice(me.value.voice ?? null);
      return { ok: true };
    },
    [session, api],
  );

  const signOut = useCallback(() => {
    manualSignOut.current = true;
    discardSession(null);
    manualSignOut.current = false;
  }, [discardSession]);

  // After a reload, sign in again from the refresh token kept in this tab.
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    if (session === null) {
      setChecking(settingsResult === null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const outcome = await session.restore();
      if (outcome === "restored") {
        const me = await api.me();
        if (!cancelled && me.ok) {
          setRole(me.value.role);
          setVoice(me.value.voice ?? null);
        }
      }
      if (!cancelled) setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
    // `api` is rebuilt with the session; restoring once per session is intended.
  }, [session]);

  // A sleeping tab can miss the refresh timer; check again when it becomes visible.
  useEffect(() => {
    if (session === null) return;
    const onVisible = (): void => {
      if (document.visibilityState !== "visible" || roleRef.current === "visitor") return;
      const at = session.expiresAt();
      if (at === null || at - Date.now() < 3 * 60_000) void session.restore();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [session]);

  const toggleMute = (): void => {
    player.setMuted(!player.muted);
    setMuted(player.muted);
  };

  const enterHouse = (): void => {
    player.unlock();
    navigate("/house");
  };

  const deviceStatus = useDeviceStatus({ api, enabled: capabilities(role).deviceStatus });
  const settingsKnown = settingsResult !== null;

  return (
    <div className="app">
      <a className="skip-link" href="#content" onClick={() => document.getElementById("content")?.focus()}>
        {COPY.shell.skipToContent}
      </a>
      <header className="app-header">
        <a className="app-header__brand" href={hrefFor("/")} aria-label={COPY.landing.titleReading}>
          <span lang="ja" className="app-header__mark" aria-hidden="true">
            童
          </span>
          <span className="app-header__name">{COPY.landing.titleReading}</span>
        </a>
        <nav aria-label="Pages" className="app-header__nav">
          {navItems().map((item) => (
            <a
              key={item.route}
              href={hrefFor(item.route)}
              aria-current={route === item.route ? "page" : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="app-header__tools">
          <button
            type="button"
            className="button"
            lang={lang === "en" ? "ja" : "en"}
            aria-label={COPY.shell.languageToggleLabel}
            onClick={toggleLanguage}
          >
            {COPY.shell.languageToggle}
          </button>
          <button type="button" className="button" aria-pressed={muted} onClick={toggleMute}>
            {muted ? COPY.shell.unmute : COPY.shell.mute}
          </button>
          <PrivacyIndicator statusFetch={deviceStatus.statusFetch} />
          <AccountMenu
            role={role}
            cloudAvailable={cloudAvailable}
            checking={checking}
            onSignIn={signIn}
            onSignOut={signOut}
          />
        </div>
      </header>

      {!online && (
        <p className="banner banner--offline" role="status">
          {COPY.shell.offlineBanner}
        </p>
      )}
      {notice !== null && (
        <p className="banner banner--notice" role="alert">
          {notice}
        </p>
      )}
      {settingsKnown && !cloudAvailable && (
        <p className="banner" role="status">
          {COPY.landing.configUnavailable}
        </p>
      )}

      <div id="content" tabIndex={-1} className="app-content">
        <ErrorBoundary>
          {route === "/" && (
            <Landing onEnter={enterHouse} cloudAvailable={cloudAvailable} />
          )}
          <div hidden={route !== "/house"}>
            <House
              player={player}
              api={cloudAvailable ? api : undefined}
              online={online}
              role={cloudAvailable ? role : "visitor"}
              onEncounters={setSimulated}
            />
            <section className="real-doll" aria-labelledby="real-doll-heading">
              <h2 id="real-doll-heading">
                {COPY.shell.realDollHeading}
                <InfoTip text={COPY.tips.realDoll} />
              </h2>
              <fieldset className="real-doll__group" disabled={!online}>
                <DevicePanel role={role} response={deviceStatus.response} />
                <ControlPanel api={api} role={role} deviceId={DEVICE_ID} />
              </fieldset>
            </section>
            {cloudAvailable && (
              <TalkPanel api={api} role={role} deviceId={DEVICE_ID} voice={voice} online={online} />
            )}
          </div>
          {route === "/timeline" && (
            <main className="page">
              <Timeline
                key={sessionKey}
                api={api}
                role={role}
                illustrationBase={settings?.illustrationBase ?? "/illustrations"}
                simulated={simulated}
              />
            </main>
          )}
          {route === "/family" && (
            <main className="page">
              <FamilyPage key={sessionKey} api={api} role={role} online={online} />
            </main>
          )}
          {route === "/help" && <Help />}
        </ErrorBoundary>
      </div>
    </div>
  );
}
