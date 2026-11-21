// Network guard for `make test` (R26.2, R26.3).
//
// Why: the suite must pass with no AWS account and no MQTT broker. If a test (or code under
// test) opens an outbound connection, it must fail loudly and name the host, instead of
// hanging or silently reaching AWS. Loopback and unix sockets stay allowed so tests can run
// a local server.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "::"]);

/** Attempted connections that were blocked since the last `takeViolations()`. */
const violations: string[] = [];

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return LOOPBACK_HOSTS.has(h) || h.startsWith("127.") || h.startsWith("::ffff:127.");
}

function describeTarget(host: string, port?: unknown): string {
  return port === undefined || port === null ? host : `${host}:${String(port)}`;
}

function blockedError(target: string): Error {
  return new Error(
    `Blocked outbound network connection to ${target}. ` +
      "make test must not use the network; use a fake, or put the test behind describeIntegration.",
  );
}

function record(target: string): Error {
  violations.push(target);
  return blockedError(target);
}

/** Returns and clears the blocked attempts. Used by the afterEach hook and by the guard tests. */
export function takeViolations(): string[] {
  return violations.splice(0, violations.length);
}

function hostFromRequestArgs(args: unknown[]): { host: string; port?: unknown } {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) {
    const url = new URL(first.toString());
    return { host: url.hostname, port: url.port || undefined };
  }
  const opts = (first ?? {}) as { hostname?: string; host?: string; port?: unknown };
  return { host: opts.hostname ?? opts.host ?? "localhost", port: opts.port };
}

function hostFromConnectArgs(args: unknown[]): { host?: string; port?: unknown } {
  // net.connect() passes its already normalized arguments as one array: [options, callback].
  if (Array.isArray(args[0])) return hostFromConnectArgs(args[0] as unknown[]);
  const first = args[0];
  if (typeof first === "number" || typeof first === "string") {
    // connect(port, host?) is TCP; connect(path) is a unix socket and is allowed.
    return typeof first === "number"
      ? { host: typeof args[1] === "string" ? args[1] : "localhost", port: first }
      : {};
  }
  const opts = (first ?? {}) as { host?: string; port?: unknown; path?: string };
  if (opts.path !== undefined && opts.port === undefined) return {};
  return { host: opts.host ?? "localhost", port: opts.port };
}

let installed = false;

/** Patches `net`, `tls`, `http` and `https` once per worker. Safe to call repeatedly. */
export function installNetworkGuard(): void {
  if (installed) return;
  installed = true;

  // http, https and tls all end in net.Socket#connect, so this is the catch-all.
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const { host, port } = hostFromConnectArgs(args);
    if (host !== undefined && !isLoopbackHost(host)) throw record(describeTarget(host, port));
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  // Fail early (and with the host) before an agent or request object is built.
  for (const mod of [http, https]) {
    for (const name of ["request", "get"] as const) {
      const original = mod[name] as (...a: unknown[]) => unknown;
      (mod as unknown as Record<string, unknown>)[name] = function (...args: unknown[]) {
        const { host, port } = hostFromRequestArgs(args);
        if (!isLoopbackHost(host)) throw record(describeTarget(host, port));
        return original.apply(mod, args);
      };
    }
  }

  const originalTlsConnect = tls.connect as (...a: unknown[]) => tls.TLSSocket;
  (tls as unknown as Record<string, unknown>).connect = function (...args: unknown[]) {
    const { host, port } = hostFromConnectArgs(args);
    if (host !== undefined && !isLoopbackHost(host)) throw record(describeTarget(host, port));
    return originalTlsConnect.apply(tls, args);
  };
}
