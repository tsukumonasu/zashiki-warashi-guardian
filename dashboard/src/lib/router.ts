// Minimal hash router: #/, #/house, #/timeline, #/family, #/help. No react-router.

export type Route = "/" | "/house" | "/timeline" | "/family" | "/help";

const ROUTES: readonly Route[] = ["/", "/house", "/timeline", "/family", "/help"];

/** Maps a location hash to a route; anything unknown falls back to "/". */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "").split("?")[0]?.replace(/(.)\/$/, "$1") || "/";
  return (ROUTES as readonly string[]).includes(path) ? (path as Route) : "/";
}

export function hrefFor(route: Route): string {
  return `#${route}`;
}

/** Calls `fn` with the current route now and on every hash change. Returns an unsubscribe function. */
export function watchRoute(
  fn: (route: Route) => void,
  win: Pick<Window, "location" | "addEventListener" | "removeEventListener"> = window,
): () => void {
  const emit = () => fn(parseHash(win.location.hash));
  win.addEventListener("hashchange", emit);
  emit();
  return () => win.removeEventListener("hashchange", emit);
}

export function navigate(route: Route, win: Pick<Window, "location"> = window): void {
  win.location.hash = hrefFor(route);
}
