/**
 * Pure notification policy for stranger visits. No AWS imports: the Judge reads the stored
 * state, asks `shouldNotify`, claims the notify slot in a transaction and only then sends the
 * message that `buildStrangerNotification` returns.
 *
 * Why two checks: one message per encounter keeps a long visit from flooding the family, and
 * a per-device window keeps repeated visits close together from doing the same.
 */

import type { Verdict } from "./verdict.js";

export type NotifyInput = {
  verdict: Verdict;
  encounterAlreadyNotified: boolean;
  /** Time of the device's last notification, or null when it never notified. */
  lastNotifiedAtMs: number | null;
  nowMs: number;
  windowMs: number;
};

export type NotifyDecision = {
  notify: boolean;
  reason: "not_stranger" | "encounter_done" | "within_window" | "clock_skew" | "send";
};

/** Decide whether a verdict should send a notification. The first matching rule wins. */
export function shouldNotify(i: NotifyInput): NotifyDecision {
  if (i.verdict !== "stranger") return { notify: false, reason: "not_stranger" };
  if (i.encounterAlreadyNotified) return { notify: false, reason: "encounter_done" };
  if (i.lastNotifiedAtMs === null) return { notify: true, reason: "send" };
  // A clock earlier than the last notification cannot be compared with the window.
  if (i.nowMs < i.lastNotifiedAtMs) return { notify: false, reason: "clock_skew" };
  if (i.nowMs - i.lastNotifiedAtMs < i.windowMs) return { notify: false, reason: "within_window" };
  return { notify: true, reason: "send" };
}

// SNS Publish: a subject must be "less than 100 characters" (API_Publish), so at most 99.
const MAX_SUBJECT_LENGTH = 99;
const SUBJECT_PREFIX = "Zashiki-Warashi: stranger at ";

/**
 * Build the e-mail text. It holds only the device label, the UTC time and the dashboard URL:
 * no image, no link to an image, no face data and no name.
 */
export function buildStrangerNotification(ctx: {
  deviceLabel: string;
  atIso: string;
  dashboardUrl: string;
}): { subject: string; body: string } {
  // Collapse control characters (including newlines) so a label cannot break the subject line.
  const label = ctx.deviceLabel.replace(/\s+/g, " ").trim();
  const subject = (SUBJECT_PREFIX + label).slice(0, MAX_SUBJECT_LENGTH).trimEnd();
  const body = [
    "An unknown person was seen by your doll.",
    "",
    `Doll: ${label}`,
    `Time (UTC): ${ctx.atIso}`,
    `Dashboard: ${ctx.dashboardUrl}`,
  ].join("\n");
  return { subject, body };
}
