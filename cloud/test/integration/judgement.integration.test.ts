/**
 * Judgement integration test and latency harness (task 24.1; R6.7, R26.5, R27.4).
 *
 * Opt-in: skipped, not failed, unless WARASHI_AWS_INTEGRATION=1. It never runs in `make test`.
 * Run it on purpose against a deployed stack, and run only this folder, because the global
 * network guard is off in that mode:
 *
 *   WARASHI_AWS_INTEGRATION=1 WARASHI_IT_IOT_ENDPOINT=... (see below) \
 *     npx vitest --run test/integration
 *
 * What it does: connects to AWS IoT Core as a test device (its own certificate), subscribes to
 * `warashi/<id>/commands`, publishes a `snapshot.captured` event, waits for the matching
 * `judgement.result`, checks it against the contract, and measures the round trip. It runs
 * `WARASHI_IT_ROUNDS` rounds (default 20, at least 20) on the family path and on the stranger
 * path, then prints p50 and p95 against the R6.7 targets (3 s and 4 s).
 *
 * Environment (all values come from the owner; nothing is stored in the repository):
 *   WARASHI_IT_IOT_ENDPOINT   IoT data endpoint host (stack output `IotEndpoint`)
 *   WARASHI_IT_DEVICE_ID      id of a TEST thing, never the real doll: the same MQTT client id is
 *                             used, so a second connection would disconnect the real doll
 *   WARASHI_IT_CERT / _KEY / _CA   paths of the test device certificate, key and Amazon Root CA
 *   WARASHI_IT_FAMILY_JPEG    path of a JPEG (at most 90,000 bytes) with a registered family face
 *   WARASHI_IT_STRANGER_JPEG  path of a JPEG (at most 90,000 bytes) with a face that is not registered
 *   Optional, for the claim check (R27.4):
 *   WARASHI_IT_API_URL, WARASHI_IT_FAMILY_TOKEN, WARASHI_IT_REVIEWER_TOKEN
 *
 * Every stranger round may send a stranger notification (at most one per encounter), so use a
 * test device id whose notifications you accept, or lower the rounds only after the first run.
 *
 * Measured values are printed and written to `cloud/.integration-out/` (git-ignored). They hold no
 * account id or host name. The owner copies the numbers into `design.md` (owner step O6).
 *
 * Not testable here, so a documented owner step instead: the first `npx cdk deploy --all` confirms
 * that `AWS::Budgets::Budget` is accepted in a stack in `ap-northeast-1` (owner steps O5 and O6).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { decodeEnvelope, encodeEnvelope, topicFor } from "../../lambda/_shared/messages.js";
import type { Envelope } from "../../lambda/_shared/messages.js";
import { describeIntegration } from "../integration.js";
import { describeGroupsClaim, jwtPayload, summarize } from "./latency.js";
import type { PathSummary } from "./latency.js";
import { MqttLite } from "./mqtt-lite.js";

const MIN_ROUNDS = 20;
const VERDICT_WAIT_MS = 8_000; // the doll's verdict_timeout_s
const MAX_JPEG_BYTES = 90_000; // device-side cap of docs/schema.md

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} (see the header of this file).`);
  return value;
}

type Judgement = { snapshotId: string; verdict: string; confidence: number; face: unknown };

interface Round {
  elapsedMs: number;
  envelope: Envelope;
  judgement: Judgement;
}

describeIntegration("judgement round trip against a deployed stack (needs WARASHI_AWS_INTEGRATION=1)", () => {
  const rounds = Math.max(MIN_ROUNDS, Number(process.env.WARASHI_IT_ROUNDS ?? MIN_ROUNDS) || MIN_ROUNDS);
  const summaries: PathSummary[] = [];
  const notes: Record<string, unknown> = {};
  let deviceId = "";
  let client: MqttLite;
  const pending = new Map<string, (r: { envelope: Envelope; at: number }) => void>();

  beforeAll(async () => {
    deviceId = requireEnv("WARASHI_IT_DEVICE_ID");
    client = new MqttLite({
      host: requireEnv("WARASHI_IT_IOT_ENDPOINT"),
      clientId: deviceId,
      cert: readFileSync(requireEnv("WARASHI_IT_CERT")),
      key: readFileSync(requireEnv("WARASHI_IT_KEY")),
      ca: readFileSync(requireEnv("WARASHI_IT_CA")),
    });
    await client.connect();
    client.onMessage((topic, payload, at) => {
      if (topic !== topicFor(deviceId, "commands")) return;
      const decoded = decodeEnvelope(payload);
      if (decoded.kind !== "valid" || decoded.message.type !== "judgement.result") return;
      const snapshotId = (decoded.message.data as { snapshotId?: string }).snapshotId;
      if (snapshotId) pending.get(snapshotId)?.({ envelope: decoded.message, at });
    });
    await client.subscribe(topicFor(deviceId, "commands"));
  });

  afterAll(() => {
    client?.close();
    const outDir = path.resolve(import.meta.dirname, "../../.integration-out");
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(outDir, `judgement-latency-${stamp}.json`);
    const report = { measuredAt: new Date().toISOString(), rounds, summaries, notes };
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`Latency report (git-ignored): ${file}\n${JSON.stringify(report, null, 2)}`);
  });

  async function runRound(jpegBase64: string): Promise<Round> {
    const snapshotId = randomUUID();
    const event: Envelope = {
      v: 1,
      id: randomUUID(),
      ts: new Date().toISOString(),
      deviceId,
      encounterId: randomUUID(),
      type: "snapshot.captured",
      data: { snapshotId, width: 640, height: 480, panDeg: 0, tiltDeg: 0, jpegBase64 },
    };
    const result = new Promise<{ envelope: Envelope; at: number }>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(snapshotId);
        reject(new Error(`No judgement.result within ${VERDICT_WAIT_MS} ms for ${snapshotId}`));
      }, VERDICT_WAIT_MS);
      pending.set(snapshotId, (r) => {
        clearTimeout(timer);
        pending.delete(snapshotId);
        resolve(r);
      });
    });
    const started = performance.now();
    await client.publish(topicFor(deviceId, "events"), encodeEnvelope(event));
    const { envelope, at } = await result;
    return { elapsedMs: at - started, envelope, judgement: envelope.data as Judgement };
  }

  function assertContract(round: Round, expectedVerdict: string, expectedSnapshotId?: string): void {
    const { envelope, judgement } = round;
    expect(envelope.v).toBe(1);
    expect(envelope.type).toBe("judgement.result");
    expect(envelope.deviceId).toBe(deviceId);
    if (expectedSnapshotId) expect(judgement.snapshotId).toBe(expectedSnapshotId);
    expect(judgement.verdict).toBe(expectedVerdict);
    expect(judgement.confidence).toBeGreaterThanOrEqual(0);
    expect(judgement.confidence).toBeLessThanOrEqual(1);
    // Privacy: only the documented fields, never a name.
    expect(Object.keys(judgement).sort()).toEqual(["confidence", "face", "snapshotId", "verdict"]);
    const face = judgement.face as Record<string, number> | null;
    expect(face).not.toBeNull();
    for (const k of ["left", "top", "width", "height"]) {
      expect(face?.[k]).toBeGreaterThanOrEqual(0);
      expect(face?.[k]).toBeLessThanOrEqual(1);
    }
  }

  async function measure(which: "family" | "stranger", jpegEnv: string): Promise<void> {
    const jpeg = readFileSync(requireEnv(jpegEnv));
    expect(jpeg.length).toBeLessThanOrEqual(MAX_JPEG_BYTES);
    const jpegBase64 = jpeg.toString("base64");
    const samples: number[] = [];
    for (let i = 0; i < rounds; i++) {
      const round = await runRound(jpegBase64);
      assertContract(round, which);
      samples.push(round.elapsedMs);
    }
    const summary = summarize(which, samples);
    summaries.push(summary);
    notes[`${which}FirstRoundMs`] = Math.round(samples[0]); // usually a cold start
    console.log(
      `${which}: ${summary.rounds} rounds, p50 ${summary.p50Ms.toFixed(0)} ms, p95 ${summary.p95Ms.toFixed(0)} ms, ` +
        `target p95 ${summary.targetP95Ms} ms, ${summary.withinTarget ? "within" : "OVER"} target`,
    );
    // The targets are goals measured on a real account, so a miss is reported, not asserted
    // (the design says to record the value and adjust the budget, not to fail a deploy).
    expect(summary.rounds).toBeGreaterThanOrEqual(MIN_ROUNDS);
  }

  it("family path: contract and latency (R6.7, target p95 3 s)", { timeout: rounds * 10_000 }, async () => {
    await measure("family", "WARASHI_IT_FAMILY_JPEG");
  });

  it("stranger path: contract and latency (R6.7, target p95 4 s)", { timeout: rounds * 10_000 }, async () => {
    await measure("stranger", "WARASHI_IT_STRANGER_JPEG");
  });

  it.skipIf(!process.env.WARASHI_IT_API_URL || !process.env.WARASHI_IT_FAMILY_TOKEN || !process.env.WARASHI_IT_REVIEWER_TOKEN)(
    "cognito:groups claim: token shape and resolved role (R27.4)",
    async () => {
      const api = requireEnv("WARASHI_IT_API_URL").replace(/\/$/, "");
      const cases = [
        ["family", requireEnv("WARASHI_IT_FAMILY_TOKEN")],
        ["reviewer", requireEnv("WARASHI_IT_REVIEWER_TOKEN")],
      ] as const;
      const shapes: Record<string, string> = {};
      for (const [role, token] of cases) {
        shapes[`${role}TokenGroupsClaim`] = describeGroupsClaim(jwtPayload(token)["cognito:groups"]);
        const res = await fetch(`${api}/me`, { headers: { Authorization: `Bearer ${token}` } });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { role: string }).role).toBe(role);
      }
      // The form that reaches the Lambda (array or string) is not visible from outside; the
      // owner reads it from the API access log, see the owner steps in tasks.md.
      notes.claimShapes = shapes;
      console.log(`cognito:groups in the issued tokens: ${JSON.stringify(shapes)}`);
    },
  );
});
