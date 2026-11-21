/** Service worker registration (design D11, Requirement 19.2). Failures are ignored on purpose:
 * without a worker the app works online and offline mode is simply unavailable. */

function isSecureEnough(location: Pick<Location, "protocol" | "hostname">): boolean {
  return (
    location.protocol === "https:" ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1"
  );
}

/** URLs of the files the page has loaded so far (same origin only is filtered by the worker). */
function loadedResourceUrls(): string[] {
  return performance.getEntriesByType("resource").map((entry) => entry.name);
}

async function postLoadedUrls(registration: ServiceWorkerRegistration): Promise<void> {
  const ready = await navigator.serviceWorker.ready;
  const worker = ready.active ?? registration.active;
  worker?.postMessage({ type: "cache-urls", urls: loadedResourceUrls() });
}

async function register(): Promise<void> {
  const registration = await navigator.serviceWorker.register("/sw.js");
  await postLoadedUrls(registration);
}

/** Registers `/sw.js` after the page has loaded. Never throws. */
export function registerServiceWorker(): void {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (!isSecureEnough(window.location)) return;
    const start = () => {
      register().catch(() => undefined);
    };
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
  } catch {
    // Ignored: offline mode is optional.
  }
}
