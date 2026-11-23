import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient, DeviceStatusResponse } from "../lib/api";
import type { StatusFetch } from "../simulation/indicator";

export const DEVICE_ID = "warashi-01";
export const POLL_INTERVAL_MS = 30_000;
/** When to ask again after a command, so the page shows the doll's new state soon. */
export const REFRESH_AFTER_MS: readonly number[] = [1500, 4000, 8000];

export interface UseDeviceStatusOptions {
  api: ApiClient;
  /** True when the user is signed in with a role that may read the status (Requirement 13.1). */
  enabled: boolean;
  /** Repeats `fn` every `ms`; returns a function that stops it. Injected for fake timers. */
  setRepeating?: (fn: () => void, ms: number) => () => void;
  /** Whether the page is visible. Injected for tests. */
  isVisible?: () => boolean;
}

export interface DeviceStatus {
  /** What the Privacy_Indicator needs (Requirements 13.5 to 13.8). */
  statusFetch: StatusFetch;
  /** The last successful response, kept after a failed poll; null before the first success. */
  response: DeviceStatusResponse | null;
  /** True when the latest poll failed, so the page can say the data may be old. */
  loadFailed: boolean;
  /** Asks again shortly, for example after a command changed the doll's state. */
  refresh: () => void;
}

const defaultRepeating = (fn: () => void, ms: number): (() => void) => {
  const id = window.setInterval(fn, ms);
  return () => window.clearInterval(id);
};

const defaultVisible = (): boolean => document.visibilityState === "visible";

/**
 * Polls `GET /device/status` for the real doll: once when the view opens, then every 30 s
 * while the page is visible (Requirement 13.1). Does nothing while `enabled` is false.
 * A failed call reports `failed`, so the indicator says "unknown" and never "off". The last good
 * response stays in `response`: a failed read is not proof that the doll is out of reach.
 */
export function useDeviceStatus(options: UseDeviceStatusOptions): DeviceStatus {
  const { api, enabled } = options;
  const setRepeating = options.setRepeating ?? defaultRepeating;
  const isVisible = options.isVisible ?? defaultVisible;
  const [state, setState] = useState<Omit<DeviceStatus, "refresh">>({
    statusFetch: { kind: "none" },
    response: null,
    loadFailed: false,
  });
  // The poll of the running effect, so refresh() never polls for a disabled or unmounted view.
  const pollRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) {
      setState({ statusFetch: { kind: "none" }, response: null, loadFailed: false });
      return;
    }
    let cancelled = false;
    let inFlight = false;

    const poll = (): void => {
      if (inFlight) return;
      inFlight = true;
      void api.deviceStatus(DEVICE_ID).then((result) => {
        inFlight = false;
        if (cancelled) return;
        if (result.ok) {
          const r = result.value;
          setState({
            statusFetch: { kind: "ok", online: r.online, status: r.status },
            response: r,
            loadFailed: false,
          });
        } else {
          setState((previous) => ({ ...previous, statusFetch: { kind: "failed" }, loadFailed: true }));
        }
      });
    };

    pollRef.current = poll;
    poll();
    const stop = setRepeating(() => {
      if (isVisible()) poll();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      pollRef.current = () => {};
      stop();
    };
  }, [api, enabled, setRepeating, isVisible]);

  const refresh = useCallback(() => {
    for (const ms of REFRESH_AFTER_MS) window.setTimeout(() => pollRef.current(), ms);
  }, []);

  return { ...state, refresh };
}
