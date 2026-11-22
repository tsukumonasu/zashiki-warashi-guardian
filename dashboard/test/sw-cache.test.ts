/**
 * Caching rules of `public/sw.js`. The worker is plain JavaScript, so it runs here in a `vm`
 * context with fake `caches`, `fetch` and events.
 *
 * Regression: the page used to be served cache first, which kept every browser that had visited
 * once on the old build (for example without the language switch) after a deployment.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(__dirname, "..", "public", "sw.js"), "utf8");
const ORIGIN = "https://warashi.example";

class FakeResponse {
  constructor(readonly body: string, readonly ok = true) {}
  clone(): FakeResponse {
    return new FakeResponse(this.body, this.ok);
  }
}

function keyOf(req: unknown): string {
  if (typeof req === "string") return new URL(req, ORIGIN).pathname;
  return new URL((req as { url: string }).url).pathname;
}

function makeWorker(options: { online: boolean; network: Record<string, string> }) {
  const stores = new Map<string, Map<string, FakeResponse>>();
  const open = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      match: async (req: unknown) => store.get(keyOf(req)),
      put: async (req: unknown, res: FakeResponse) => void store.set(keyOf(req), res),
    };
  };
  const fetched: string[] = [];
  const listeners: Record<string, (event: unknown) => void> = {};
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: unknown) => void) => (listeners[type] = fn),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  const context = {
    self,
    URL,
    caches: {
      open: async (name: string) => open(name),
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
    },
    fetch: async (req: unknown) => {
      const path = keyOf(req);
      fetched.push(path);
      if (!options.online) throw new Error("offline");
      return new FakeResponse(options.network[path] ?? "missing", path in options.network);
    },
  };
  runInNewContext(SOURCE, context);

  async function request(path: string, mode: "navigate" | "no-cors" = "no-cors"): Promise<string> {
    let answer: Promise<FakeResponse> | undefined;
    listeners["fetch"]!({ request: { method: "GET", url: `${ORIGIN}${path}`, mode }, respondWith: (p: Promise<FakeResponse>) => (answer = p) });
    return (await answer!).body;
  }
  return { request, stores, fetched, listeners, options, open };
}

describe("sw.js caching", () => {
  it("loads the page from the network while online, so a new build shows at once", async () => {
    const w = makeWorker({ online: true, network: { "/": "build-1" } });
    // Install pre-caches "/" (build 1), as in a real first visit.
    let installed: Promise<unknown> | undefined;
    w.listeners["install"]!({ waitUntil: (p: Promise<unknown>) => (installed = p) });
    await installed;
    w.options.network["/"] = "build-2"; // a deployment
    expect(await w.request("/", "navigate")).toBe("build-2");
  });

  it("serves the cached page when offline", async () => {
    const w = makeWorker({ online: true, network: { "/": "build-1" } });
    await w.request("/", "navigate");
    w.options.online = false;
    expect(await w.request("/", "navigate")).toBe("build-1");
    expect(await w.request("/?from=bookmark", "navigate")).toBe("build-1");
  });

  it("keeps hashed build files cache first", async () => {
    const w = makeWorker({ online: true, network: { "/assets/index-abc.js": "bundle" } });
    const cache = await w.open("warashi-dashboard-v2");
    await cache.put("/assets/index-abc.js", new FakeResponse("cached bundle"));
    expect(await w.request("/assets/index-abc.js")).toBe("cached bundle");
    expect(w.fetched).not.toContain("/assets/index-abc.js");
  });

  it("deletes the old v1 cache, which held a cache-first page", async () => {
    const w = makeWorker({ online: true, network: {} });
    await w.open("warashi-dashboard-v1");
    let done: Promise<unknown> | undefined;
    w.listeners["activate"]!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect([...w.stores.keys()]).not.toContain("warashi-dashboard-v1");
  });
});
