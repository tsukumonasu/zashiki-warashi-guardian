/**
 * Session runner of one voice conversation (design "Session Lambda").
 *
 * `runSession` owns the I/O of a session: it reads frames from the client, relays audio between the
 * client and Nova Sonic, dispatches tool calls and drives the pure reducer `stepSession`. It makes
 * no decision of its own about the lifecycle; every end goes through the reducer, which returns the
 * effects that this module executes.
 *
 * Why one mailbox: frames, Sonic events, 250 ms ticks and tool results all arrive concurrently.
 * They are queued and handled one at a time, so the session state has a single writer.
 *
 * Never stores or logs audio, text or tokens: the store only gets the session record (a closed set
 * of keys), and logs go through `logVoice`, which drops speech and token fields.
 */

import type { Envelope } from "../_shared/messages.js";
import { makeCommand } from "../_shared/messages.js";
import { lockKey } from "../_shared/voice/caps.js";
import type { VoiceConfig } from "../_shared/voice/config.js";
import {
  decodeIn,
  encodeOut,
  type EndReason,
  type InFrame,
  type LookVerdict,
  type OutFrame,
  type TextFrame,
} from "../_shared/voice/frames.js";
import { isUnsafeAssistantText } from "../_shared/voice/language.js";
import { logVoice } from "../_shared/voice/log.js";
import type {
  DollBus,
  SonicClient,
  SonicEvent,
  SonicStream,
  VoiceChannel,
  VoiceStore,
} from "../_shared/voice/ports.js";
import { buildSystemPrompt } from "../_shared/voice/prompt.js";
import { makeReorder } from "../_shared/voice/reorder.js";
import {
  initialSession,
  stepSession,
  type Effect,
  type SessionEvent,
  type SessionState,
} from "../_shared/voice/session.js";
import {
  sonicAudioContentStart,
  sonicAudioInput,
  sonicShutdownEvents,
  sonicStartEvents,
  sonicToolResult,
  type SonicIds,
} from "../_shared/voice/sonic-events.js";
import {
  lookResultForModel,
  toolResultsFor,
  toolToCommand,
  TOOL_SPECS,
  type ToolOutcome,
} from "../_shared/voice/tools.js";

/** What the start handlers pass to the session Lambda. Token hashes stay in the session record. */
export interface SessionPayload {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly client: "device" | "browser";
  readonly target: "real" | "virtual";
  /** `null` for a doll-started session. */
  readonly ownerSub: string | null;
  readonly maxSeconds: number;
  readonly silenceSeconds: number;
}

export interface SessionDeps {
  readonly cfg: VoiceConfig;
  readonly sonic: SonicClient;
  readonly channel: VoiceChannel;
  readonly store: VoiceStore;
  readonly bus: DollBus;
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** A fresh UUID. */
  readonly newId: () => string;
  /** Waits `ms`; default is `setTimeout`. Used by the look polling. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Tick period, default 250. */
  readonly tickMs?: number;
}

/** Frames that fail to decode before the session ends with `error` (R8.8). */
export const MAX_MALFORMED_FRAMES = 50;
const LOOK_POLL_MS = 250;
const DEFAULT_TICK_MS = 250;

type LookOutcome = LookVerdict | "timeout";

type Msg =
  | { src: "frame"; raw: string }
  | { src: "inEnd" }
  | { src: "tick" }
  | { src: "opened" }
  | { src: "openFailed" }
  | { src: "sonic"; ev: SonicEvent }
  | { src: "sonicEnd" }
  | { src: "sendFailed" }
  | { src: "tool"; toolUseId: string | null; result: object | null; verdict: LookOutcome | null };

/** Unbounded FIFO with an async `next()`. */
class Mailbox<T> {
  private readonly items: T[] = [];
  private waiter: ((item: T) => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      w(item);
    } else {
      this.items.push(item);
    }
  }

  next(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise<T>((resolve) => {
      this.waiter = resolve;
    });
  }

  close(): void {
    this.closed = true;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

/**
 * Runs one session to its end. Always ends with cleanup: the Sonic stream is closed, one `end`
 * frame is attempted, a doll session gets `conversation.end`, the lock is released and the session
 * record is updated.
 */
export async function runSession(payload: SessionPayload, deps: SessionDeps): Promise<void> {
  const { sessionId, deviceId } = payload;
  const cfg: VoiceConfig = {
    ...deps.cfg,
    maxSeconds: clamp(payload.maxSeconds, 30, 420),
    silenceSeconds: clamp(payload.silenceSeconds, 5, 60),
  };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const mailbox = new Mailbox<Msg>();
  const reorder = makeReorder(cfg.reorderWindow);

  let state: SessionState = initialSession(deps.now());

  // Stream bookkeeping.
  let stream: SonicStream | null = null;
  let streamExpected = false;
  let streamReady = false;
  let pumpEnded = false;
  let closeRequested = false;
  let shutdownStarted = false;
  let closing: Promise<void> = Promise.resolve();
  let openPromise: Promise<void> = Promise.resolve();
  let sendFailed = false;
  let sendChain: Promise<void> = Promise.resolve();
  let publishChain: Promise<void> = Promise.resolve();
  const ids: SonicIds = { promptName: deps.newId(), audioContentName: deps.newId() };
  let toolContentCounter = 0;
  let outSeq = 0;
  let malformed = 0;
  let streamClosedFed = false;

  // Tool bookkeeping: tool use ids the model still waits for, and look results from the client.
  const pending = new Set<string>();
  const lookFrames = new Map<string, LookVerdict>();
  let looksInFlight = 0;

  // ---- publishing ----

  /** Publishes in order. A failed publish is logged and dropped, never retried. */
  function publish(channel: "out" | "text", frame: OutFrame | TextFrame): void {
    const encoded = encodeOut(frame);
    publishChain = publishChain
      .then(() => deps.channel.publish(sessionId, channel, [encoded]))
      .catch((err: unknown) => {
        logVoice("publish_dropped", sessionId, { channel, frame: frame.t, error: errorName(err) });
      });
  }

  // ---- Sonic input ----

  function sendSonic(events: readonly string[]): void {
    sendChain = sendChain.then(async () => {
      if (sendFailed || stream === null) return;
      try {
        for (const e of events) await stream.send(e);
      } catch (err) {
        sendFailed = true;
        logVoice("sonic_send_failed", sessionId, { error: errorName(err) });
        mailbox.push({ src: "sendFailed" });
      }
    });
  }

  function sendToolResult(toolUseId: string, result: object): void {
    toolContentCounter += 1;
    sendSonic(
      sonicToolResult({
        promptName: ids.promptName,
        contentName: `${ids.promptName}-tool-${toolContentCounter}`,
        toolUseId,
        result,
      }),
    );
  }

  /** Answers every open tool use, then sends the shutdown events and closes the stream, once. */
  function tryShutdown(): void {
    if (!closeRequested || stream === null || shutdownStarted) return;
    shutdownStarted = true;
    const open = toolResultsFor([...pending], new Map(), "session_ending");
    pending.clear();
    for (const r of open) sendToolResult(r.toolUseId, r.result);
    sendSonic(sonicShutdownEvents(ids));
    const s = stream;
    closing = sendChain.then(async () => {
      try {
        await s.close();
      } catch (err) {
        logVoice("sonic_close_failed", sessionId, { error: errorName(err) });
      }
    });
  }

  function startOpen(): void {
    streamExpected = true;
    openPromise = (async () => {
      let opened: SonicStream | null = null;
      try {
        opened = await deps.sonic.open(cfg.voiceModelId);
        const start = sonicStartEvents({
          ...ids,
          voice: cfg,
          systemContentName: deps.newId(),
          systemPrompt: buildSystemPrompt(),
          tools: TOOL_SPECS,
        });
        for (const e of [...start, sonicAudioContentStart(ids)]) await opened.send(e);
        stream = opened;
        mailbox.push({ src: "opened" });
        tryShutdown(); // the session may have ended while Bedrock was opening
      } catch (err) {
        logVoice("sonic_open_failed", sessionId, { error: errorName(err) });
        if (opened) {
          try {
            await opened.close();
          } catch {
            // Best effort: the session is ending with `error` anyway.
          }
        }
        streamExpected = false;
        mailbox.push({ src: "openFailed" });
      }
    })();
  }

  function startPump(s: SonicStream): void {
    void (async () => {
      try {
        for await (const ev of s.events()) mailbox.push({ src: "sonic", ev });
      } catch (err) {
        logVoice("sonic_stream_failed", sessionId, { error: errorName(err) });
      }
      pumpEnded = true;
      mailbox.push({ src: "sonicEnd" });
    })();
  }

  function startInPump(): void {
    void (async () => {
      try {
        for await (const raw of deps.channel.subscribeIn(sessionId)) mailbox.push({ src: "frame", raw });
      } catch (err) {
        logVoice("in_subscription_failed", sessionId, { error: errorName(err) });
      }
      mailbox.push({ src: "inEnd" });
    })();
  }

  // ---- doll commands and looks ----

  /** Sends an envelope to the real doll over MQTT, or to the virtual doll as a `command` frame. */
  async function deliver(envelope: Envelope): Promise<boolean> {
    if (payload.target === "virtual") {
      publish("out", { t: "command", envelope });
      return true;
    }
    try {
      await deps.bus.publish(deviceId, envelope);
      return true;
    } catch (err) {
      logVoice("doll_publish_failed", sessionId, { type: envelope.type, error: errorName(err) });
      return false;
    }
  }

  /** Waits for the verdict of a look: the store for a real doll, a `look.result` frame otherwise. */
  async function awaitLook(requestId: string): Promise<LookOutcome> {
    const deadline = deps.now() + cfg.lookTimeoutSeconds * 1000;
    for (;;) {
      if (state.phase !== "live") return "timeout"; // discarded by the caller anyway
      if (payload.target === "virtual") {
        const v = lookFrames.get(requestId);
        if (v !== undefined) return v;
      } else {
        const item = await deps.store.readLook(requestId);
        if (item !== null) return item.verdict;
      }
      if (deps.now() >= deadline) return "timeout";
      await sleep(LOOK_POLL_MS);
    }
  }

  function startLook(requestId: string, envelope: Envelope, toolUseId: string | null): void {
    looksInFlight += 1;
    void (async () => {
      let verdict: LookOutcome = "timeout";
      try {
        if (await deliver(envelope)) verdict = await awaitLook(requestId);
      } catch (err) {
        logVoice("look_failed", sessionId, { error: errorName(err) });
      }
      looksInFlight -= 1;
      lookFrames.delete(requestId);
      mailbox.push({
        src: "tool",
        toolUseId,
        // A silent re-check has no model-visible result.
        result: toolUseId === null ? null : lookResultForModel(verdict),
        verdict,
      });
    })();
  }

  function startRecheck(): void {
    if (looksInFlight > 0) return;
    const requestId = deps.newId();
    try {
      const envelope = makeCommand("snapshot.request", { requestId }, {
        id: deps.newId(),
        now: new Date(deps.now()),
        deviceId,
        encounterId: null,
      });
      startLook(requestId, envelope, null);
    } catch (err) {
      logVoice("recheck_failed", sessionId, { error: errorName(err) });
    }
  }

  /** Starts the tool call. Returns `true` when the dispatcher accepted it (not an error result). */
  function dispatchTool(toolUseId: string, name: string, inputJson: string): boolean {
    const outcome: ToolOutcome = toolToCommand(
      name,
      inputJson,
      {
        nowMs: deps.now(),
        toolCalls: state.toolCalls,
        looks: state.looks,
        gazeCommands: state.gazeCommands,
        lastGazeAtMs: state.lastGazeAtMs,
        dollReachable: true, // no status port yet: a sleeping doll answers command_rejected_state
        deviceId,
        newId: deps.newId,
      },
      cfg,
    );
    pending.add(toolUseId);
    if (outcome.kind === "error") {
      mailbox.push({ src: "tool", toolUseId, result: outcome.result, verdict: null });
      return false;
    }
    if (outcome.kind === "look") {
      startLook(outcome.requestId, outcome.envelope, toolUseId);
      return true;
    }
    void (async () => {
      let ok = true;
      for (const envelope of outcome.envelopes) ok = (await deliver(envelope)) && ok;
      mailbox.push({
        src: "tool",
        toolUseId,
        result: ok ? outcome.result : { ok: false, error: "doll_unavailable" },
        verdict: null,
      });
    })();
    return true;
  }

  // ---- reducer and effects ----

  async function runEffect(effect: Effect): Promise<void> {
    try {
      switch (effect.type) {
        case "openStream":
          startOpen();
          return;
        case "requestRecheck":
          startRecheck();
          return;
        case "interruptAudio":
          publish("out", { t: "interrupt" });
          return;
        case "publishState":
          publish("text", { t: "state", state: effect.state });
          return;
        case "closeStream":
          closeRequested = true;
          streamReady = false;
          tryShutdown();
          return;
        case "publishEnd":
          publish("text", { t: "end", reason: effect.reason });
          await publishChain;
          return;
        case "notifyDevice":
          // Only a doll-started session has a doll that waits for the end.
          if (payload.client !== "device") return;
          await deps.bus.publish(
            deviceId,
            makeCommand("conversation.end", { sessionId, reason: effect.reason }, {
              id: deps.newId(),
              now: new Date(deps.now()),
              deviceId,
              encounterId: null,
            }),
          );
          return;
        case "releaseLock":
          await deps.store.releaseLock(lockKey(payload.target, deviceId, payload.ownerSub), sessionId);
          return;
        case "recordSession": {
          const rec = await deps.store.getSession(sessionId);
          if (rec === null) return;
          await deps.store.putSession({
            ...rec,
            phase: "ended",
            endReason: effect.reason,
            endedAt: deps.now(),
          });
          return;
        }
      }
    } catch (err) {
      // Cleanup must continue: one failed effect never blocks the next.
      logVoice("effect_failed", sessionId, { effect: effect.type, error: errorName(err) });
    }
  }

  async function drive(event: SessionEvent): Promise<void> {
    const result = stepSession(state, event, deps.now(), cfg);
    state = result.state;
    for (const effect of result.effects) await runEffect(effect);
  }

  /** Reads the phase without TypeScript's narrowing from earlier checks (state changes in `drive`). */
  function currentPhase(): SessionState["phase"] {
    return state.phase;
  }

  // ---- event handlers ----

  async function onFrame(raw: string): Promise<void> {
    const decoded = decodeIn(raw);
    if (decoded.kind === "malformed") {
      malformed += 1;
      if (malformed >= MAX_MALFORMED_FRAMES) {
        logVoice("too_many_malformed_frames", sessionId, { count: malformed });
        await drive({ t: "endRequest", reason: "error" });
      }
      return;
    }
    const frame: InFrame = decoded.frame;
    switch (frame.t) {
      case "hello":
        await drive({ t: "hello" });
        return;
      case "audio":
        // Hot path: bypasses the reducer. Frames before the stream is ready are dropped.
        for (const chunk of reorder.push(frame.seq, frame.pcm)) {
          if (streamReady) sendSonic([sonicAudioInput(ids, chunk.pcm)]);
        }
        return;
      case "look.result":
        lookFrames.set(frame.requestId, frame.verdict);
        return;
      case "bye":
        await drive({ t: "endRequest", reason: frame.reason });
        return;
    }
  }

  async function onSonic(ev: SonicEvent): Promise<void> {
    switch (ev.kind) {
      case "audio":
        outSeq += 1;
        publish("out", { t: "audio", seq: outSeq, pcm: ev.pcmBase64 });
        await drive({ t: "activity" });
        return;
      case "interrupted":
        publish("out", { t: "interrupt" });
        return;
      case "completionEnd":
        return;
      case "error":
        logVoice("sonic_error", sessionId, { code: ev.code });
        await drive({ t: "endRequest", reason: "error" });
        return;
      case "toolUse": {
        if (state.phase !== "live") return;
        const accepted = dispatchTool(ev.toolUseId, ev.name, ev.inputJson);
        // The reducer counts the call only when the dispatcher accepted it (tools.ts).
        await drive(accepted ? { t: "toolUse", id: ev.toolUseId, name: ev.name } : { t: "activity" });
        return;
      }
      case "text": {
        if (ev.role === "USER") {
          publish("text", { t: "transcript", role: "user", text: ev.text, final: ev.stage !== "SPECULATIVE" });
          await drive({ t: "activity" });
          return;
        }
        if (isUnsafeAssistantText(ev.text, cfg.blockedWords) && ev.stage === "SPECULATIVE") {
          // The reducer sees only final turns; a blocked word in a preview still stops the audio.
          publish("out", { t: "interrupt" });
          await drive({ t: "endRequest", reason: "unsafe_output" });
          return;
        }
        if (ev.stage === "SPECULATIVE") {
          publish("text", { t: "transcript", role: "assistant", text: ev.text, final: false });
          return;
        }
        if (!isUnsafeAssistantText(ev.text, cfg.blockedWords)) {
          publish("text", { t: "transcript", role: "assistant", text: ev.text, final: true });
        }
        await drive({ t: "assistantText", text: ev.text });
        return;
      }
    }
  }

  async function onTool(m: Extract<Msg, { src: "tool" }>): Promise<void> {
    if (m.toolUseId !== null) {
      // Not pending: the shutdown already answered it, or the result is stale. Discard.
      if (!pending.has(m.toolUseId) || state.phase !== "live") return;
      pending.delete(m.toolUseId);
      sendToolResult(m.toolUseId, m.result ?? { ok: false, error: "not_available" });
    }
    if (m.toolUseId !== null) await drive({ t: "toolDone", id: m.toolUseId });
    // A late result is discarded by the reducer once the phase is `ending` or `ended`.
    if (m.verdict !== null && m.verdict !== "timeout") {
      await drive({ t: "verdict", verdict: m.verdict, silent: m.toolUseId === null });
    }
  }

  async function handle(m: Msg): Promise<void> {
    switch (m.src) {
      case "frame":
        await onFrame(m.raw);
        return;
      case "inEnd":
        await drive({ t: "endRequest", reason: "error" });
        return;
      case "tick":
        await drive({ t: "tick" });
        return;
      case "opened":
        if (stream !== null) startPump(stream);
        if (state.phase === "starting") {
          await drive({ t: "streamOpened" });
          streamReady = currentPhase() === "live";
        }
        return;
      case "openFailed":
        await drive({ t: "endRequest", reason: "error" });
        return;
      case "sonic":
        await onSonic(m.ev);
        return;
      case "sonicEnd":
        if (state.phase === "starting" || state.phase === "live") await drive({ t: "streamClosed", ok: false });
        return;
      case "sendFailed":
        await drive({ t: "endRequest", reason: "error" });
        return;
      case "tool":
        await onTool(m);
        return;
    }
  }

  // ---- main ----

  const ticker = setInterval(() => mailbox.push({ src: "tick" }), deps.tickMs ?? DEFAULT_TICK_MS);
  try {
    logVoice("session_start", sessionId, { client: payload.client, target: payload.target });
    startInPump();
    publish("text", { t: "state", state: "waiting" });

    while (state.phase !== "ended") {
      const msg = await mailbox.next();
      await handle(msg);
      if (state.phase === "ending" && !streamClosedFed && (!streamExpected || pumpEnded)) {
        streamClosedFed = true;
        await drive({ t: "streamClosed", ok: true });
      }
    }
  } catch (err) {
    logVoice("session_error", sessionId, { error: errorName(err) });
    try {
      await drive({ t: "endRequest", reason: "error" });
    } catch (inner) {
      logVoice("session_error_end_failed", sessionId, { error: errorName(inner) });
    }
  } finally {
    clearInterval(ticker);
    mailbox.close();
    try {
      // Guarantee the stream is closed, even when Bedrock was still opening.
      closeRequested = true;
      await openPromise;
      tryShutdown();
      await closing;
      // Guarantee the ended transition and its effects (one `end` frame, notify, lock, record).
      if (state.phase === "starting" || state.phase === "live") await drive({ t: "endRequest", reason: "error" });
      if (state.phase === "ending") await drive({ t: "streamClosed", ok: true });
    } catch (err) {
      logVoice("cleanup_failed", sessionId, { error: errorName(err) });
    }
    try {
      await publishChain;
      await deps.channel.close();
    } catch (err) {
      logVoice("channel_close_failed", sessionId, { error: errorName(err) });
    }
    const reason: EndReason | null = state.endReason;
    logVoice("session_end", sessionId, { reason, missedAudioFrames: reorder.missed(), malformed });
  }
}
