/**
 * In-memory `VoiceStore` with the semantics of the DynamoDB design:
 *
 * - `acquireLock`: conditional put, succeeds when the lock is absent or its `expiresAt <= nowMs`
 *   (takeover). TTL deletion is housekeeping only and is not modelled.
 * - `releaseLock`: deletes only while the given session owns the lock.
 * - `incrementCounter`: `ADD 1` with `attribute_not_exists OR count < cap`; the TTL is set once
 *   at creation; an expired counter starts again from 0.
 * - `releaseCounter`: `ADD -1`, never below 0.
 *
 * The clock is settable (`setNow`, `advance`) and is used for counter expiry. Locks use the
 * `nowMs` argument, as the real store does.
 */

import type { Verdict } from "../../lambda/_shared/verdict.js";
import type { LookItem, SessionRecord, VoiceStore } from "../../lambda/_shared/voice/ports.js";

export class FakeVoiceStore implements VoiceStore {
  private nowMs: number;
  private readonly locks = new Map<string, { sessionId: string; expiresAtMs: number }>();
  private readonly counters = new Map<string, { count: number; expiresAtMs: number }>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly looks = new Map<string, LookItem>();
  private readonly verdicts = new Map<string, { verdict: Verdict; atMs: number }>();
  /** Every record `putSession` received, in order (for privacy checks). */
  readonly putSessionCalls: SessionRecord[] = [];

  constructor(startMs = 0) {
    this.nowMs = startMs;
  }

  // ---- clock ----
  now(): number {
    return this.nowMs;
  }
  setNow(ms: number): void {
    this.nowMs = ms;
  }
  advance(ms: number): void {
    this.nowMs += ms;
  }

  // ---- lock ----
  async acquireLock(
    key: string,
    sessionId: string,
    nowMs: number,
    expiresAtMs: number,
  ): Promise<boolean> {
    const existing = this.locks.get(key);
    if (existing !== undefined && existing.expiresAtMs > nowMs) return false;
    this.locks.set(key, { sessionId, expiresAtMs });
    return true;
  }

  async releaseLock(key: string, sessionId: string): Promise<void> {
    if (this.locks.get(key)?.sessionId === sessionId) this.locks.delete(key);
  }

  /** Test helper: the session that holds an unexpired lock at `atMs` (default: the clock). */
  lockOwner(key: string, atMs: number = this.nowMs): string | null {
    const lock = this.locks.get(key);
    return lock !== undefined && lock.expiresAtMs > atMs ? lock.sessionId : null;
  }

  // ---- counters ----
  async incrementCounter(
    key: string,
    cap: number,
    ttlS: number,
  ): Promise<{ allowed: boolean; count: number }> {
    const existing = this.counters.get(key);
    const live = existing !== undefined && existing.expiresAtMs > this.nowMs ? existing : undefined;
    if (live !== undefined && !(live.count < cap)) return { allowed: false, count: live.count };
    const count = (live?.count ?? 0) + 1;
    this.counters.set(key, { count, expiresAtMs: live?.expiresAtMs ?? this.nowMs + ttlS * 1000 });
    return { allowed: true, count };
  }

  async releaseCounter(key: string): Promise<void> {
    const existing = this.counters.get(key);
    if (existing === undefined || existing.expiresAtMs <= this.nowMs) return;
    existing.count = Math.max(0, existing.count - 1);
  }

  /** Test helper: the current counter value, 0 when absent or expired. */
  counterValue(key: string): number {
    const existing = this.counters.get(key);
    return existing !== undefined && existing.expiresAtMs > this.nowMs ? existing.count : 0;
  }

  // ---- sessions, looks, verdicts ----
  async putSession(rec: SessionRecord): Promise<void> {
    const copy = { ...rec };
    this.putSessionCalls.push(copy);
    this.sessions.set(rec.sessionId, copy);
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const rec = this.sessions.get(sessionId);
    return rec === undefined ? null : { ...rec };
  }

  async readLook(requestId: string): Promise<LookItem | null> {
    return this.looks.get(requestId) ?? null;
  }

  async encounterVerdict(encounterId: string): Promise<{ verdict: Verdict; atMs: number } | null> {
    return this.verdicts.get(encounterId) ?? null;
  }

  /** Test helper: seed a look result. */
  seedLook(requestId: string, item: LookItem): void {
    this.looks.set(requestId, item);
  }

  /** Test helper: seed the stored verdict of an encounter. */
  seedVerdict(encounterId: string, verdict: Verdict, atMs: number): void {
    this.verdicts.set(encounterId, { verdict, atMs });
  }
}
