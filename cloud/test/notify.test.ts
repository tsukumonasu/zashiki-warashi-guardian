import { describe, expect, it } from "vitest";
import { buildStrangerNotification, shouldNotify, type NotifyInput } from "../lambda/_shared/notify.js";

/** Unit tests for the notification policy (cloud-judgement Requirements 9.2, 9.5, 9.9). */

const WINDOW = 600_000;
const NOW = 1_000_000_000;

function input(over: Partial<NotifyInput> = {}): NotifyInput {
  return {
    verdict: "stranger",
    encounterAlreadyNotified: false,
    lastNotifiedAtMs: null,
    nowMs: NOW,
    windowMs: WINDOW,
    ...over,
  };
}

describe("shouldNotify", () => {
  it.each(["family", "no_face", "uncertain"] as const)("does not notify for %s", (verdict) => {
    expect(shouldNotify(input({ verdict }))).toEqual({ notify: false, reason: "not_stranger" });
  });

  it("does not notify twice for one encounter", () => {
    expect(shouldNotify(input({ encounterAlreadyNotified: true }))).toEqual({
      notify: false,
      reason: "encounter_done",
    });
  });

  it("checks the verdict before the encounter flag", () => {
    const d = shouldNotify(input({ verdict: "family", encounterAlreadyNotified: true }));
    expect(d.reason).toBe("not_stranger");
  });

  it("sends when the device never notified", () => {
    expect(shouldNotify(input())).toEqual({ notify: true, reason: "send" });
  });

  it("suppresses inside the window", () => {
    const d = shouldNotify(input({ lastNotifiedAtMs: NOW - WINDOW + 1 }));
    expect(d).toEqual({ notify: false, reason: "within_window" });
  });

  it("sends exactly at the window boundary", () => {
    expect(shouldNotify(input({ lastNotifiedAtMs: NOW - WINDOW }))).toEqual({
      notify: true,
      reason: "send",
    });
  });

  it("sends after the window", () => {
    expect(shouldNotify(input({ lastNotifiedAtMs: NOW - WINDOW - 1 })).notify).toBe(true);
  });

  it("reports clock skew when now is before the last notification", () => {
    expect(shouldNotify(input({ lastNotifiedAtMs: NOW + 1 }))).toEqual({
      notify: false,
      reason: "clock_skew",
    });
  });

  it("treats equal times as inside the window, not as skew", () => {
    expect(shouldNotify(input({ lastNotifiedAtMs: NOW })).reason).toBe("within_window");
  });
});

describe("buildStrangerNotification", () => {
  const dashboardUrl = "https://dashboard.example.invalid/";
  const base = { deviceLabel: "warashi-01", atIso: "2026-11-20T12:34:56.789Z", dashboardUrl };

  it("keeps the subject within 99 characters for any label length", () => {
    for (const len of [0, 1, 50, 71, 72, 100, 500]) {
      const { subject } = buildStrangerNotification({ ...base, deviceLabel: "x".repeat(len) });
      expect(subject.length).toBeLessThanOrEqual(99);
    }
  });

  it("keeps a short subject whole", () => {
    expect(buildStrangerNotification(base).subject).toBe("Zashiki-Warashi: stranger at warashi-01");
  });

  it("strips newlines from the subject", () => {
    const { subject } = buildStrangerNotification({ ...base, deviceLabel: "a\r\nBcc: x\tb" });
    expect(subject).not.toMatch(/[\r\n\t]/);
  });

  it("contains the dashboard URL and the time, and no other URL", () => {
    const { body, subject } = buildStrangerNotification(base);
    expect(body).toContain(dashboardUrl);
    expect(body).toContain(base.atIso);
    const urls = body.match(/https?:\/\/\S+/g) ?? [];
    expect(urls).toEqual([dashboardUrl]);
    expect(subject).not.toMatch(/https?:\/\//);
  });

  it("mentions no image or face data", () => {
    const { body } = buildStrangerNotification(base);
    expect(body.toLowerCase()).not.toMatch(/snapshot|jpeg|image|face/);
  });
});
