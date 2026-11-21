/**
 * Property 7: Notify slot atomicity (cloud-judgement design, "Notification debounce").
 *
 * Concurrent `notifyOnce` calls for one encounter run against `FakeStateStore`, which applies the
 * same conditional transaction as DynamoDB, with scripted notifier failures.
 *
 * **Validates: Requirements 9.6, 9.8**
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../lambda/_shared/config.js";
import { notifyOnce, type JudgeDeps } from "../lambda/judge/judge-core.js";
import { FakeNotifier, FakeRepository, FakeStateStore } from "./fakes.js";

const NOW_MS = Date.parse("2026-11-20T12:00:00.000Z");
const DEVICE = "warashi-01";
const ENCOUNTER = "c1d2e3f4-0000-4000-8000-000000000001";

async function setup(): Promise<{ deps: JudgeDeps; notifier: FakeNotifier }> {
  const now = (): number => NOW_MS;
  const repository = new FakeRepository(now);
  await repository.createEncounterIfAbsent(
    {
      encounterId: ENCOUNTER,
      deviceId: DEVICE,
      startedAt: new Date(NOW_MS).toISOString(),
      endedAt: null,
      state: null,
      verdict: "stranger",
      confidence: 0.9,
      reaction: null,
      notified: false,
      snapshotKey: null,
      errorCount: 0,
    },
    3600,
  );
  const state = new FakeStateStore({ now, repository });
  const notifier = new FakeNotifier();
  const deps = {
    notifier,
    state,
    repository,
    config: DEFAULT_CONFIG,
    deviceLabel: () => "the doll",
    dashboardUrl: "https://dashboard.example.invalid",
    now,
  } as unknown as JudgeDeps;
  return { deps, notifier };
}

describe("notify slot atomicity", () => {
  it("Feature: cloud-judgement, Property 7: Notify slot atomicity", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 5 }), // concurrent batch sizes
        fc.integer({ min: 0, max: 8 }), // the first N sends fail; later sends succeed
        async (batches, failures) => {
          const { deps, notifier } = await setup();
          for (let i = 0; i < failures; i += 1) notifier.failNext();

          let delivered = 0;
          for (const size of batches) {
            const results = await Promise.all(
              Array.from({ length: size }, () => notifyOnce(deps, { deviceId: DEVICE, encounterId: ENCOUNTER })),
            );
            delivered += results.filter(Boolean).length;
            // R9.6: never more than one delivered message.
            expect(notifier.sent.length).toBeLessThanOrEqual(1);
          }
          // `true` means delivered. Every attempt is a failure except at most one success,
          // so nothing was sent again after a success (R9.8).
          expect(delivered).toBe(notifier.sent.length);
          expect(notifier.attempts).toBe(Math.min(notifier.attempts, failures) + notifier.sent.length);

          // A later call reaches the notifier exactly when nothing was delivered so far
          // (the failed sends released the slot), and the total stays at one message.
          const attemptsBefore = notifier.attempts;
          const probe = await notifyOnce(deps, { deviceId: DEVICE, encounterId: ENCOUNTER });
          if (delivered === 1) {
            expect(probe).toBe(false);
            expect(notifier.attempts).toBe(attemptsBefore);
          } else {
            expect(notifier.attempts).toBe(attemptsBefore + 1);
            expect(probe).toBe(attemptsBefore >= failures);
          }
          expect(notifier.sent.length).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });
});
