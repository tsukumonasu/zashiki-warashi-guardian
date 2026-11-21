# Implementation Plan: voice-conversation

## Overview

This plan builds the P1 voice feature across all three parts: the cloud (`/cloud`, TypeScript, CDK v2,
vitest, fast-check), the doll (`/device`, Python 3.13, `python3-websockets`, pytest, Hypothesis) and
the dashboard (`/dashboard`, React, vitest, jsdom, fast-check). It follows the approved
`requirements.md` and `design.md` in this folder and the task style of
`.kiro/specs/cloud-judgement/tasks.md` and `.kiro/specs/device-core-loop/tasks.md`. The design uses
TypeScript and Python (pseudocode blocks only illustrate algorithms), so no language question is open.

Order of work:

1. Verify the items `design.md` lists as unverified and record the results (AppSync Events in
   `ap-northeast-1`, channel ordering, Nova 2.5 Sonic voices and Japanese, pricing, GenU license).
2. Contract first: change `docs/schema.md` (S1 to S20), create the golden fixtures, then extend the
   Python and TypeScript codecs.
3. Cloud pure cores, each followed by its tests: config, frames and reorder, session reducer, caps and
   lock, tool dispatcher, prompt, language check, Sonic event builder. Checkpoint.
4. Cloud ports, fakes, session runner, handlers (`voice-start`, `voice-grant`, `voice-authorizer`,
   `voice-session`), the `judge` change, adapters. Checkpoint.
5. CDK `VoiceStack`, the CSP and route changes, template tests.
6. Device: config, state machine `conversing` phase, audio and frame modules, the recorded-audio
   fakes, the asyncio client, the adapter, wiring. Dashboard: frames, audio, `VoiceClient`,
   `TalkPanel`, simulation reducer. Checkpoint.
7. Owner scripts, opt-in integration tests, documentation, `docs/third-party.md`, `docs/kiro-usage.md`,
   the repository scan. Final checkpoint.

Rules for every task:

- **Contract first.** `docs/schema.md` is changed before any producer or consumer (task 2.1). The
  version `v` stays 1 (R16.2).
- **Pure core, hardware-free and AWS-free tests.** Every AWS, WebSocket, microphone and speaker
  dependency sits behind a port with a fake. `make test` needs no Raspberry Pi, no AWS account, no
  microphone and no credentials. CI uses the **recorded-audio fakes** of task 16.5 (tone bursts
  generated at test time, no real voice committed).
- **Property-based tests are required tasks.** Each of the 11 Correctness Properties of `design.md`
  has its own property sub-task below (P6 and P7 have one sub-task per language). None is optional.
  Each runs at least 100 iterations (fast-check `numRuns >= 100`, Hypothesis `max_examples >= 100`)
  and carries the tag `Feature: voice-conversation, Property <n>: <title>`, so a failure reports the
  tag and the shrunk counterexample.
- **Persona marker-phrase list (R9.2), decided.** The list lives in one JSON file,
  `docs/fixtures/voice-v1/persona-markers.json`: one entry per persona rule with its `rule` name, the
  `marker` phrase that the prompt sentence must contain, and the `source` heading in `persona.md`.
  *Reason:* every suite already reads `docs/fixtures/voice-v1/`, the file needs no parser beyond JSON,
  and it sits next to the golden frames instead of inside a test. `buildSystemPrompt()` is checked
  against it in task 8.4 and the file is created in task 2.3.
- **Small dependencies.** The only new dependency on the Pi is `python3-websockets` from `apt`
  (laptop tests use `websockets` as a dev dependency). The cloud adds only what the design's
  "Dependencies" section lists. Each new folder gets one line in `structure.md` (task 21.3).
- **No secrets in git.** No token, host name, account id, certificate or recorded voice enters the
  repository. Use `*.example` files, CDK context and generated test audio.
- **Owner steps do not block automated tasks.** They are listed after the task list and are not
  checkboxes. Every automated task passes with fakes.
- **Off by default.** `voiceEnabled = false` and `conversation_enabled = false` until the owner turns
  them on. P0 reliability is never traded for this feature.

## Tasks

- [x] 1. Verify and record the unverified items of `design.md` (first implementation task)
  - [x] 1.1 Verify AppSync Events in `ap-northeast-1`, the CDK construct and the IAM actions
    - Use the `aws-docs` MCP server (`search_documentation`, `read_documentation`) for:
      - Whether AWS AppSync Events (the Event API, real-time endpoint
        `appsync-realtime-api`) is offered in `ap-northeast-1`, from the AppSync endpoints and quotas
        page. If Tokyo is missing, name the nearest supported Region, change the Region table and
        the CDK app layout in `design.md`, and stop and ask the owner before any other task starts.
      - The IAM action and resource ARN form for `bedrock:InvokeModelWithBidirectionalStream` and
        for `amazon.nova-2-5-sonic` in the Service Authorization Reference.
      - Whether the Lambda authorizer `ttlOverride` applies to `EVENT_PUBLISH` caching, and the
        exact request and response fields of the authorizer.
    - Add `cloud/test/voice/cdk-constants.test.ts` asserting that the installed `aws-cdk-lib` exports
      an AppSync Events API construct (`aws-appsync` `EventApi` or the L1 `CfnApi`), and names the
      construct that is offered if the first is missing. Record the installed version.
    - _Requirements: 4.3, 4.8, 15.6_
  - [x] 1.2 Verify Nova 2.5 Sonic voices, Japanese support, model facts and pricing
    - Read the Nova 2.5 Sonic voices page (the design read only the Nova 2 page) and record which
      voices exist, whether `tiffany` and `matthew` are polyglot there, and every statement about
      Japanese. Read the Tokyo price per minute or per token of Nova 2.5 Sonic from the Bedrock
      pricing page. Re-check the model ID, the 8-minute limit and the 20-session quota.
    - Record the result with value, date (UTC `YYYY-MM-DD`) and URL. Where only a deployed account can
      answer, mark the item "pending owner measurement" with the task that measures it
      (Japanese quality, latency, price per session: task 20.1 and owner step O3).
    - _Requirements: 3.10, 10.7, 15.6_
  - [x] 1.3 Read the GenU and Nova samples licenses
    - Read `LICENSE` of `aws-samples/generative-ai-use-cases` and of `aws-samples/amazon-nova-samples`
      at the commits that the design cites, and record repository, commit, license name and URL in
      `design.md` (V18). The design copies no code; if a later task adapts any file, it keeps the
      header notice and adds a row to `docs/third-party.md` (task 21.2).
    - _Requirements: 15.6_
  - [x] 1.4 Record the verification results and the pending measurements in `design.md`
    - Replace each "unverified" mark in "Verified AWS facts" with the value, date and URL, or with
      "pending owner measurement" and the task that measures it. Items: Japanese quality, AppSync
      Events in Tokyo, message ordering inside one channel (measured by task 19.2), CDK construct,
      Node.js 24 `WebSocket` subprotocol array (task 12.1 test), `python3-websockets` on armhf
      (owner step O8b), latency, price, GenU license. Update the Region table.
    - _Requirements: 15.6_

- [x] 2. Contract and golden fixtures (contract first)
  - [x] 2.1 Apply the changes S1 to S20 to `docs/schema.md` before any code
    - Edit `docs/schema.md` only. Apply every row of the design section "docs/schema.md Changes" with
      its reason next to it: new events `conversation.requested` and `conversation.ended`,
      `snapshot.captured.requestId`, new commands `conversation.start` (token is a secret, never
      logged or published by the device), `conversation.end` and `snapshot.request`, the
      `ConversationEndReason` enumeration, the new `state.changed` reasons `conversation` and
      `conversation_done` and the reason mapping rows, `micActive` semantics, `speak` rejected in
      `conversing`, the error codes `conversation_failed` and `microphone_failed`, the new section
      "Voice session channels" (namespace, three channels, token rules, every frame), the privacy
      sentence, the role matrix rows, the `POST` / `GET` / `DELETE /conversations` routes, `GET /me`
      `voice`, and the error codes `session_active` and `voice_unavailable`.
    - Add the new device-internal events (`ConversationFinished`) to the device-internal table.
      State in the document that `docs/fixtures/voice-v1/` holds one golden frame per frame type and
      direction. `v` stays 1.
    - _Requirements: 16.1, 16.2_
  - [x] 2.2 Create the new golden messages in `docs/fixtures/schema-v1/`
    - One JSON file each: `conversation.requested.json`, `conversation.ended.json`,
      `conversation.start.json`, `conversation.end.json`, `snapshot.request.json`. Placeholder ids,
      `warashi-01`, and a placeholder token (`00000000-0000-4000-8000-000000000000.` plus 43
      characters of `A`); no real secret.
    - _Requirements: 16.3_
  - [x] 2.3 Create `docs/fixtures/voice-v1/` and the persona marker list
    - One golden frame per frame type and direction: `in.hello`, `in.audio`, `in.look.result`,
      `in.bye`, `out.audio`, `out.interrupt`, `out.command`, `text.state`, `text.transcript`,
      `text.end` (short synthetic PCM, placeholder text, no names).
    - Two scripted Bedrock event streams, `sonic-session-ok.jsonl` and `sonic-session-tools.jsonl`
      (synthetic audio, placeholder text, a `toolUse` for `turn_head`, `set_lantern` and `look`,
      one interrupted marker).
    - `persona-markers.json`: the decision stated in the Overview. One entry per rule of
      `buildSystemPrompt()` taken from `persona.md`: Japanese only, short soft hiragana sentences,
      at most two short sentences, no slang or emoji or English words, no numbers or symbols read out,
      knows nothing about the person (no name, age or schedule), never guesses or invents family
      facts, declines unsafe or off-topic requests in character, never threatens or mentions death or
      injury, uses tools quietly without describing them. Each entry has `rule`, `marker` and
      `source`.
    - _Requirements: 5.10, 9.2, 16.4_
  - [x] 2.4 Extend the Python message codec and fixture tests
    - `device/warashi_agent/messages.py`: payload dataclasses and decode and encode for the five new
      types (`conversation.requested` and `conversation.ended` as events, `conversation.start`,
      `conversation.end` and `snapshot.request` as commands), `snapshot.captured.requestId`
      (optional, default `None`), the field rules of S4 to S6 (`sessionId` and `requestId` match
      `[A-Za-z0-9-]{1,64}`, `token` 1 to 128 characters, `maxSeconds` and `silenceSeconds` clamped to
      30..420 and 5..60), and `token` with `repr=False`. Add the new codes to the error list.
    - Extend `device/tests/test_fixtures.py`: every file in `docs/fixtures/schema-v1/` decodes to
      `valid` and re-encodes to an equal value; a type without a fixture or a fixture without a type
      fails and names it. Add unit tests for the new field rules.
    - _Requirements: 4.10, 16.1, 16.3_
  - [x] 2.5 Extend the TypeScript message codec
    - `cloud/lambda/_shared/messages.ts`: the same five types, `requestId`, field rules and clamps as
      task 2.4 (mirrors the Python codec). Extend `cloud/test/messages.test.ts` with the new
      fixtures, the field rules and the type-to-fixture check. The existing cross-language property
      of `cloud-judgement` (Property 10) keeps running over the larger fixture set.
    - _Requirements: 16.1, 16.3_

- [x] 3. Voice configuration
  - [x] 3.1 Implement the voice settings in `cloud/lambda/_shared/voice/config.ts`
    - `VoiceConfig` with every default and range of the design table "Cloud settings": the
      environment variable over CDK context over default order of `_shared/config.ts`,
      clamping of `maxSeconds` to 30..420, `silenceSeconds` and `noClientSeconds` to 5..60 on read
      (R6.14), `voiceGazeLimits` capped at pan 60 and tilt 30, `reviewerVoiceEnabled` default `false`,
      reviewer cap 2, a rejection error that names the setting and the value for every other range.
      Defaults of the open decisions in R15 are constants here with a comment that marks them open.
    - _Requirements: 3.10, 6.14, 7.5, 15.1, 15.2, 15.6_
  - [x] 3.2 Write unit tests in `cloud/test/voice/config.test.ts`
    - Defaults; each override source and order; each range boundary (inside, outside, non-finite,
      negative); gaze limits above 60 and 30 rejected; `voiceEnabled` false by default.
    - _Requirements: 6.14, 7.5, 15.1_

- [x] 4. Frame codec and reorder window (cloud)
  - [x] 4.1 Implement `cloud/lambda/_shared/voice/frames.ts` and `reorder.ts`
    - `InFrame`, `OutFrame`, `TextFrame`, `LookVerdict`, `decodeIn`, `encodeOut` as in the design:
      total functions, `pcm` must be valid Base64 with an even decoded length of at most 12,800
      bytes, unknown `t` is ignored or malformed, never valid. `makeReorder(window)` delivers frames
      in increasing `seq` with no duplicates, holds at most `window` frames, drops frames behind the
      window and counts gaps in `missed()`.
    - Pure, no AWS imports, no `Date.now()`.
    - _Requirements: 5.1, 5.3, 5.4, 5.5, 5.6, 5.7, 5.9_
  - [x] 4.2 Write unit tests in `cloud/test/voice/frames.test.ts`
    - Each fixture of `docs/fixtures/voice-v1/` decodes and re-encodes; odd length, bad Base64,
      oversize chunk, wrong field types, unknown `t`; reorder with gaps, duplicates and late frames;
      a frame without a fixture or a fixture without a frame fails and names it.
    - _Requirements: 5.3, 5.4, 5.7, 5.10, 16.5_
  - [x] 4.3 Write property test for the frame codec (TypeScript)
    - **Property 6: Frame codec round trip and robustness**
    - Test file `cloud/test/voice/frames.prop.test.ts`: round trip for every valid frame, decode
      never throws for any string, invalid frames are never valid, every golden fixture re-encodes to
      an equal value, the reorder window delivers in increasing `seq` with no duplicates and holds at
      most `window` frames.
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.7, 5.10, 16.4, 16.5**

- [x] 5. Session reducer
  - [x] 5.1 Implement `cloud/lambda/_shared/voice/session.ts`
    - `stepSession`, `SessionState`, `SessionEvent`, `Effect`, `EndReason` following the design
      pseudocode: forward-only phases, absorbing `ended`, first end reason wins, `no_client`,
      `limit`, `silence`, the silent re-check every `recheckSeconds`, language and unsafe-text ends,
      `streamClosed` handling, stranger verdict ends only in `live`, a verdict in `ending` or `ended`
      is discarded, and the single effect list `publishEnd`, `notifyDevice`, `releaseLock`,
      `recordSession` on finish with `closeStream` emitted before. The 50-malformed-frame end is an
      event of the runner that maps to `endRequest(error)`.
    - Pure, no clock reads (time is an argument).
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 8.4, 8.5, 8.7, 8.8, 9.4, 9.8_
  - [x] 5.2 Write unit tests in `cloud/test/voice/session.test.ts`
    - Every end reason from each phase; a second end request keeps the first reason; the grace
      deadline; `streamClosed` in `starting`, `live` and `ending`; a look verdict in `ending` is
      discarded and does not change the reason; the re-check does not count against
      `maxLooksPerSession` or `maxToolCalls`.
    - _Requirements: 6.4, 6.5, 6.6, 6.7, 6.9, 6.10, 6.11, 8.4, 8.7, 8.8_
  - [x] 5.3 Write property test for session termination
    - **Property 1: Session always terminates**
    - Test file `cloud/test/voice/session.prop.test.ts`: random event sequences and configurations in
      the allowed ranges, ticks at most 1 s apart; the state is `ended` no later than
      `maxSeconds + noClientSeconds + cleanupGraceMs` after the start; `ended` absorbs every event;
      the four finish effects are emitted exactly once with `closeStream` before; the first reason
      wins; the phase never moves backward.
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.7, 6.8**

- [x] 6. Ports, lock and daily caps
  - [x] 6.1 Create the ports and the in-memory store in `cloud/lambda/_shared/voice/ports.ts`
    - `SonicStream`, `SonicClient`, `VoiceChannel`, `VoiceStore`, `DollBus` as in the design.
      `VoiceStore` has no method that stores audio, text or a token (only hashes), so the type keeps
      speech out of the database. Add `cloud/test/voice/voice-store-fake.ts`, an in-memory
      `VoiceStore` with the same conditional lock write, `expiresAt` takeover, counter and release
      semantics as the DynamoDB design, and a settable clock.
    - _Requirements: 3.6, 3.7, 3.8, 14.1, 14.2_
  - [x] 6.2 Implement `cloud/lambda/_shared/voice/caps.ts`
    - `dayBucket`, `withinCap`, counter key builders for `user#<sub>`, `device` and `global`, the
      fixed increment order user, device, global, release of earlier counters on a later rejection,
      `Retry-After` seconds to the next UTC midnight (1 to 86,400), and the lock key builder
      (`device#<id>` or `sim#<ownerSub>`). Cap numbers come from `VoiceConfig`.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 15.2_
  - [x] 6.3 Write property test for daily caps
    - **Property 5: Daily caps**
    - Test file `cloud/test/voice/caps.prop.test.ts`: request sequences across users, scopes and day
      boundaries against the fake store; accepted starts per scope per day never exceed the cap; a
      later rejection leaves earlier counters unchanged; a new day restarts the count; `Retry-After`
      is an integer from 1 to 86,400.
    - **Validates: Requirements 3.2, 3.3, 3.4, 3.5**
  - [x] 6.4 Write property test for one session at a time
    - **Property 2: Never two sessions at once**
    - Test file `cloud/test/voice/lock.prop.test.ts`: random interleavings of start attempts,
      session ends, crashes without cleanup and clock advances for one lock key; at most one session
      holds an unexpired lock at any time, a successful start owns the lock, a lock is free or
      expired after its session ends or its `expiresAt` passes, and different keys never block each
      other.
    - **Validates: Requirements 3.6, 3.7, 3.8, 3.9**
  - [x] 6.5 Write unit tests in `cloud/test/voice/caps.test.ts`
    - Counter order, release on rejection, midnight rollover, lock takeover after expiry, reviewer
      cap of 2 when `reviewerVoiceEnabled`, independent keys.
    - _Requirements: 3.1, 3.2, 3.6, 3.9, 15.2_

- [x] 7. Tool dispatcher
  - [x] 7.1 Implement `cloud/lambda/_shared/voice/tools.ts`
    - `TOOL_SPECS`, `toolToCommand` and `lookResultForModel` following the design pseudocode: total
      for every name and input string, direction table, finite-number checks, clamp to
      `voiceGazeLimits`, lantern clamps with `fadeMs` default 1200, `bad_arguments`,
      `too_many_calls`, `too_many_moves`, `too_many_looks`, `too_fast`, `doll_unavailable`,
      `unknown_tool`. The result for the model holds only `ok`, the clamped angles or `who`. A helper
      builds exactly one `toolResult` per `toolUse` id.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 7.12, 7.14_
  - [x] 7.2 Write unit tests in `cloud/test/voice/tools.test.ts`
    - Each tool with valid, missing, huge, negative, `null`, string-in-number-field and nested
      inputs; each direction; the limit and interval errors; model-facing results never hold a name,
      id, confidence or face box; `look` timeout maps to `unsure`.
    - _Requirements: 7.3, 7.4, 7.7, 7.8, 7.9, 7.10, 7.11, 7.14, 8.3_
  - [x] 7.3 Write property test for tool commands within servo limits
    - **Property 3: Tool commands stay within limits**
    - Test file `cloud/test/voice/tools.prop.test.ts`: any tool name and any input string; no throw;
      every `gaze` has finite angles inside `voiceGazeLimits` (and so inside pan 60 and tilt 30);
      every `lantern` has `level` in 0..1 and an integer `fadeMs` in 0..10000; head commands per
      session never exceed `maxGazeCommands` and are at least `gazeMinIntervalMs` apart; every
      `toolUse` id gets exactly one `toolResult`, including on error, rejection and while ending.
    - **Validates: Requirements 7.2, 7.5, 7.6, 7.7, 7.9, 7.10, 7.12, 7.14**

- [x] 8. Prompt, language check and Sonic event builder
  - [x] 8.1 Implement `cloud/lambda/_shared/voice/prompt.ts`
    - `buildSystemPrompt()` with no parameters (so no family data can reach it) composed from the
      fixed sentences of the design, and the Sonic inference settings constants.
    - _Requirements: 9.1, 9.2, 9.3_
  - [x] 8.2 Implement `cloud/lambda/_shared/voice/language.ts`
    - `japaneseRatio` (null under four letters, else 0..1, never throws), `languageVerdict`
      (`undecided`, `ok` at 60 % kana or kanji, `bad` for at least two turns of four or more
      letters with no Japanese letters), `isUnsafeAssistantText` (case-insensitive blocked word).
    - _Requirements: 9.4, 9.5, 9.6, 9.7, 9.8_
  - [x] 8.3 Implement `cloud/lambda/_shared/voice/sonic-events.ts`
    - `sonicStartEvents`, `sonicAudioContentStart`, `sonicToolResult`, `sonicShutdownEvents` and a
      `sessionScript` builder that keeps the documented order: `sessionStart`, `promptStart` with
      the tool configuration, system prompt block, audio `contentStart` before any `audioInput`,
      every `contentStart` matched by one `contentEnd`, `promptEnd` and `sessionEnd` last and once.
      Model ID, voice ID and inference settings come from `VoiceConfig`.
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.7_
  - [x] 8.4 Write unit tests in `cloud/test/voice/prompt-language-sonic.test.ts`
    - Persona drift: read `docs/fixtures/voice-v1/persona-markers.json` and assert that
      `buildSystemPrompt()` contains the `marker` of every entry, and that every `persona.md` rule
      heading named by a `source` still exists (names the missing rule). The prompt contains no word
      from `blockedWords`. Language samples (Japanese, English, mixed, short). Event JSON shapes and
      the default model ID `amazon.nova-2-5-sonic` and voice `tiffany`.
    - _Requirements: 9.2, 9.3, 9.5, 9.6, 10.1, 10.7_
  - [x] 8.5 Write property test for the language check
    - **Property 9: Language check**
    - Test file `cloud/test/voice/language.prop.test.ts`: `japaneseRatio` is null or in 0..1 for any
      string and never throws; appending a turn of at least four Japanese letters to an `ok` list
      keeps `ok`; two or more turns of four or more letters with no Japanese are `bad`; fewer than
      four letters are `undecided`; `isUnsafeAssistantText` is true for any text holding a blocked
      word in any letter case.
    - **Validates: Requirements 9.4, 9.5, 9.6, 9.7, 9.8**
  - [x] 8.6 Write property test for the Sonic event order
    - **Property 10: Sonic event order**
    - Test file `cloud/test/voice/sonic-events.prop.test.ts`: generated session scripts with tools,
      barge-in and early end keep the documented order, every `contentStart` has one `contentEnd`,
      the shutdown events come last and at most once, and nothing follows `sessionEnd`.
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5**
  - [x] 8.7 Write property test for no family data and no stored speech
    - **Property 8: No family data and no stored speech**
    - Test file `cloud/test/voice/privacy.prop.test.ts`: registries of 0 to 100 members with random
      labels; the system prompt, every tool result, every `text` frame and every item given to
      `VoiceStore.putSession` contain no label (case-insensitive substring); stored session items
      have only the allowed keys of R14.2 and no audio, transcript, text or raw token; logged
      session ids are at most 8 characters.
    - **Validates: Requirements 9.1, 14.1, 14.2, 14.4, 14.5**

- [x] 9. Checkpoint - cloud pure cores
  - Ensure all tests pass (`make test` and `make lint`), ask the user if questions arise.

- [x] 10. Stream fakes and session runner
  - [x] 10.1 Create the stream fakes in `cloud/test/voice/fake-stream.ts`
    - `FakeSonic` replays a scripted event stream from `docs/fixtures/voice-v1/sonic-session-*.jsonl`
      and records every event it receives (so tests can assert the event order and that every
      `toolUse` got a `toolResult`). `FakeVoiceChannel` is an in-memory `in`, `out` and `text` bus with
      out-of-order, duplicate and malformed frame injection. `FakeDollBus` records topic, QoS and
      envelope. No fake imports the AWS SDK.
    - _Requirements: 6.12, 7.12, 10.5_
  - [x] 10.2 Implement `cloud/lambda/voice-session/session-runner.ts`
    - `runSession(payload, deps)` following the design pseudocode: open the channel, run the loop
      over frames, Sonic events, 250 ms ticks and tool results, call `stepSession`, run its effects,
      forward audio on the hot path through the reorder window, dispatch tools (always answer), check
      language and unsafe text, publish `interrupt` frames (a failed publish is dropped, no retry),
      end after 50 malformed frames, send commands over MQTT for a real doll or as `command` frames
      for the virtual doll, `look` with polling every 250 ms or a `look.result` frame, silent
      re-check, discard a look result once the phase is `ending` or `ended`, and a `finally` block
      that guarantees `closeStream`, one `end` frame, `conversation.end` for a doll session,
      lock release and the session record. Never stores audio or text.
    - _Requirements: 5.7, 5.8, 6.12, 6.13, 7.12, 7.13, 8.1, 8.2, 8.3, 8.4, 8.7, 8.8, 9.8, 10.6, 10.8, 14.1_
  - [x] 10.3 Write unit tests in `cloud/test/voice/session-runner.test.ts`
    - With the fakes and the fixture streams: a full happy path, barge-in, each end reason, Bedrock
      open failure ends `error` before any audio, a tool failing still gets its `toolResult`, a
      virtual-doll look through frames, a real-doll look through the store, a look in flight when the
      session ends is discarded, 50 malformed frames end the session, a lost interrupt publish does
      not stop the session, cleanup runs after a thrown error.
    - _Requirements: 5.8, 6.12, 6.13, 7.12, 7.13, 8.1, 8.2, 8.3, 8.8, 10.8_

- [x] 11. Start, grant and authorizer cores, and the judge change
  - [x] 11.1 Implement `cloud/lambda/voice-start/voice-start-core.ts`
    - `POST /conversations` (R1.1 to R1.8, R15.2): role and target rules (reviewer needs
      `reviewerVoiceEnabled`, browser and virtual only; `client: device` needs `target: real`),
      `voiceEnabled` and health-flag checks (`503 voice_unavailable`), caps and lock through
      `caps.ts`, token creation (`<sessionId>.<32-byte Base64URL secret>`, only SHA-256 hashes
      stored, observer token for doll sessions started from the dashboard), session item with the
      allowed keys only, async invoke of `voice-session`, `conversation.start` publish for the doll
      (token only inside that command on the doll's topic), `201` and `202` bodies, `GET` and
      `DELETE /conversations/{sessionId}` with the same `404 not_found` for an unknown or foreign
      session, `GET /me` `voice` block, the three-failures health flag.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.12, 3.1, 3.2, 3.6, 4.1, 4.2, 4.9, 9.9, 15.2_
  - [x] 11.2 Implement `cloud/lambda/voice-grant/voice-grant-core.ts`
    - `conversation.requested`: drop an event whose topic id differs from the envelope `deviceId`
      and log it with reason `topic_device_mismatch`, the envelope `id` and both ids (no payload or
      token); grant only when the stored verdict for the encounter is `family` and no older than
      `grantWindowSeconds`; then caps, lock, session creation and `conversation.start` with
      `source: "family_verdict"`. Otherwise no command and no session. Also handles
      `conversation.ended` to end the cloud session and release the lock.
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 4.9_
  - [x] 11.3 Implement `cloud/lambda/voice-authorizer/authorizer-core.ts`
    - `authorize(request, store, nowMs)` with the token regex, hash comparison in constant time,
      phase `starting` or `live`, `expiresAt` in the future, `EVENT_CONNECT`, `EVENT_SUBSCRIBE` and
      `EVENT_PUBLISH` rules: the client token publishes `/voice/<sid>/in` and subscribes `out` and
      `text`; the observer token subscribes `text` only; wildcards, other sessions and other channels
      are denied. Returns `isAuthorized` with a short `ttlOverride`.
    - _Requirements: 4.3, 4.4, 4.5, 4.6, 4.7, 4.11_
  - [x] 11.4 Write unit tests in `cloud/test/voice/start-grant-authorizer.test.ts`
    - Role matrix for every start combination; each error body and status; cap rejection releases
      counters; lock conflict; delete by owner and by a foreign caller (same `404`); grant with a
      missing, `stranger`, stale and fresh verdict; topic mismatch drops and logs without payload;
      authorizer matrix of token, channel, operation, phase and expiry; token strings never appear in
      logs.
    - _Requirements: 1.3, 1.4, 1.5, 1.8, 1.10, 1.12, 2.3, 2.5, 2.6, 4.4, 4.5, 4.6, 4.7, 4.11_
  - [x] 11.5 Update the `judge` Lambda for `requestId`
    - `cloud/lambda/judge/judge-core.ts`: when `snapshot.captured` carries `requestId`, also write
      `LOOK#<requestId>` with `verdict` and `at`, expiring after 10 minutes. The verdict logic, the
      notification and every existing behaviour stay unchanged (a `stranger` look still records the
      verdict and sends the single notification, R15.4). Extend `cloud/test/judge-core.test.ts` and
      the `ingest` tests with the new types and the `requestId` field.
    - _Requirements: 8.6, 14.3, 15.4_

- [x] 12. AWS adapters and Lambda handlers
  - [x] 12.1 Implement the adapters
    - `cloud/lambda/voice-session/adapters/sonic.ts` (`SonicClient` over
      `InvokeModelWithBidirectionalStream` with the HTTP/2 handler, model ID from config, SDK client
      at module scope), `appsync-events.ts` (`VoiceChannel`: IAM-signed WebSocket with
      `@smithy/signature-v4` and `@aws-crypto/sha256-js`, the `aws-appsync-event-ws` and
      `header-<base64url>` subprotocols, `connection_init`, `ka`, subscribe to `in`, HTTP publish of
      at most 5 events per request and at most 10 requests per second), `voice-dynamo.ts`
      (`VoiceStore` over the single table: conditional lock, `ADD count` counter with condition,
      session, `LOOK#` read, encounter verdict read, TTLs of two days, one hour, two days and 10
      minutes) and `iot-doll-bus.ts` (`DollBus`, QoS 1).
    - _Requirements: 3.6, 4.8, 8.1, 10.7, 14.3_
  - [x] 12.2 Write adapter tests in `cloud/test/voice/adapters.test.ts`
    - With `aws-sdk-client-mock` and a local fake WebSocket server: the subprotocol list and the
      signed headers (also that a Node.js 24 `WebSocket` accepts the long `header-` value, recorded in
      `design.md` by task 1.4), request shapes of the Dynamo conditions and TTLs, publish batching and
      rate limit, `qos` equals 1.
    - _Requirements: 3.6, 4.8, 10.7, 14.3_
  - [x] 12.3 Implement the four voice handlers
    - `cloud/lambda/voice-start/index.ts` (API Gateway v2 glue, reuses `_shared/http.ts`),
      `voice-grant/index.ts` (IoT rule, throws only on a store failure), `voice-authorizer/index.ts`
      and `voice-session/index.ts` (module-scope clients, configuration validated at start, calls
      `runSession`, uses the safe logger of `cloud-judgement` and logs at most the first 8 characters
      of a session id).
    - _Requirements: 4.3, 6.12, 14.5_
  - [x] 12.4 Write handler tests in `cloud/test/voice/handlers.test.ts` and `log-privacy.test.ts`
    - Each handler end to end with mocked clients and the real cores; invalid configuration refused
      at start; the log privacy test invokes every voice handler with a fixture holding a token, audio
      Base64, a display name and a pre-signed URL and asserts that none appears in the captured logs,
      also on failing paths.
    - _Requirements: 14.1, 14.5_

- [x] 13. Checkpoint - cloud application logic
  - Ensure all tests pass (`make test` and `make lint`), ask the user if questions arise.

- [x] 14. CDK `VoiceStack`
  - [x] 14.1 Implement `cloud/lib/voice-stack.ts`
    - AppSync Events API `warashi-voice` with the Lambda authorizer (token regex
      `^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$`, short cache) and IAM auth only, namespace `voice` without
      handler code, the four functions with their own roles and the design's permission table
      (`voice-session`: timeout 540 s, 512 MB, reserved concurrency `maxConcurrent` default 3, 0 async
      retries, max event age 30 s, Bedrock action on the one model ARN, AppSync actions on the one
      API, `iot:Publish` on `warashi/*/commands`; `voice-grant`: IoT rule `warashi_voice_requests`,
      0 retries, 30 s), 14-day log groups, outputs `VoiceHttpHost` and `VoiceRealtimeHost`, the CDK
      context key `voiceEnabled` (default `false`). Update `cloud/cdk.context.example.json`.
    - _Requirements: 3.10, 4.3, 4.8, 6.12_
  - [x] 14.2 Wire the HTTP routes and the web CSP
    - Add `POST /conversations`, `GET /conversations/{sessionId}` and `DELETE /conversations/{sessionId}`
      behind the existing JWT authorizer in `ApiStack`; `WebStack` takes the two Events API hosts as
      props and adds `https://<http host>` and `wss://<realtime host>` to the CSP `connect-src`;
      `cloud/bin/cloud.ts` orders the stacks `DataStack`, `JudgementStack`, `ApiStack`, `VoiceStack`,
      `WebStack` (the IoT data endpoint comes from `JudgementStack`, the API from `ApiStack`).
    - _Requirements: 1.1, 4.3, 16.6_
  - [x] 14.3 Write template tests in `cloud/test/voice/voice-stack.test.ts`
    - The Events API has Lambda and IAM auth only and no handler on the namespace; `voice-session`
      timeout 540 and reserved concurrency 3; each function's IAM statements have no `*` resource
      outside a documented exception list (names the role and action); `voice-start` and
      `voice-grant` have no Bedrock permission; `voice-authorizer` has only `GetItem`; the IoT rule
      SQL; the new routes sit behind the JWT authorizer; the CSP hosts; `voiceEnabled` is false by
      default; the route table and error code tests of `docs/schema.md` include the three routes,
      `session_active` and `voice_unavailable` and name any missing or extra entry.
    - _Requirements: 3.10, 4.3, 4.8, 16.6_
  - [x] 14.4 Update the cross-stack tests
    - `cloud/test/app-template.test.ts`: the project tag, own role and 14-day log group per Lambda,
      no forbidden resource types and unique outputs still hold with `VoiceStack`.
    - _Requirements: 3.10_

- [x] 15. Device configuration and `conversing` state
  - [x] 15.1 Add the `[conversation]` settings to `device/warashi_agent/config.py`
    - The seven keys of the design table (`conversation_enabled`, `conversation_max_s`,
      `conversation_silence_s`, `conversation_mic_gain`, `conversation_chunk_ms`,
      `conversation_mute_mic_while_speaking`, `conversation_connect_timeout_s`) with defaults and
      ranges, the typed `[aws]` additions `appsync_realtime_host` and `appsync_http_host`, and the
      cross-key rules: `conversation_silence_s + 5 <= conversation_max_s`, and
      `conversation_enabled` needs `[aws].enabled` and non-empty hosts. Violations use the existing
      `Violation` style. Add comment-only keys to `device/config.example.toml`. Unit tests in
      `device/tests/test_config.py`.
    - _Requirements: 12.14, 12.15_
  - [x] 15.2 Implement the `conversing` phase in `device/warashi_agent/state_machine.py` and `model.py`
    - New events (`ConversationStart`, `ConversationEnd`, `SnapshotRequest`, `ConversationFinished`),
      actions (`StartConversation`, `StopConversation`) and the `Conversing` phase with a deadline,
      `Greeting.pending_conversation`, and every cell of the design's transition table. Entering emits
      `state.changed` (reason `conversation`), `StartConversation` and `PublishStatus` with
      `micActive: true`; leaving emits exactly one `StopConversation` and one `conversation.ended`,
      the cooldown entry actions and the line rule (`conversation_bye` for `silence`, `limit`, `user`
      and a remote end; `conversation_trouble` for `error` and `language`; no line for `stranger`,
      `manual`, `offline`, `unsafe_output` and the `verdict` exit). `conversation.requested` is sent
      once per encounter. `speak` and an unknown session id are rejected or ignored. `Encounter_Bound`
      gains `conversation_max_s + 2T`. At most one `reaction.performed` per encounter. `token` has
      `repr=False` and is excluded from `redact.py` output and every published message. `micActive`
      is true only in `conversing`.
    - _Requirements: 2.1, 4.10, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10, 11.11, 11.12, 11.13, 11.14, 11.15, 11.16, 11.17, 11.18, 11.19, 11.20, 14.6_
  - [x] 15.3 Write unit tests in `device/tests/test_state_machine_conversing.py`
    - One test per cell of the transition table, including a rejected start when
      `conversation_enabled` is false, in `sleep` mode and in the wrong state; the line rule for every
      end reason; a stale session id; a second `snapshot.request` while one is outstanding; `speak` in
      `conversing`; the token never appears in `repr`, logs or published envelopes.
    - _Requirements: 11.1, 11.4, 11.9, 11.10, 11.11, 11.12, 11.16, 11.17, 4.10_
  - [x] 15.4 Write property test for the `conversing` exit
    - **Property 4: `conversing` always has an exit (device)**
    - Test file `device/tests/test_prop_conversing.py`: random event sequences with ticks at most `T`
      apart and valid configs; the state machine never stays in `conversing` longer than
      `conversation_max_s + T`; each exit of the design works; it never enters without a deadline,
      never in mode `sleep`, never while `conversation_enabled` is false; exactly one
      `StopConversation` and one `conversation.ended` on leaving; stale ids change nothing;
      `Encounter_Bound` holds with the extra term; at most one `reaction.performed` per encounter.
    - **Validates: Requirements 11.6, 11.7, 11.8, 11.9, 11.13, 11.14, 11.18, 11.19**

- [x] 16. Device conversation client
  - [x] 16.1 Create `device/warashi_agent/conversation/audio.py`
    - `apply_gain` over `array('h')` with clipping (no `audioop`), `split_chunks`, `speech_energy`.
      Pure, standard library only.
    - _Requirements: 12.3, 12.4, 12.5_
  - [x] 16.2 Write property test for audio gain and chunking (device)
    - **Property 7: Audio gain**
    - Test file `device/tests/test_prop_gain.py`: for even-length buffers and gains in range the
      length is preserved, every sample is inside the 16-bit range, gain 1.0 returns the input, signs
      are preserved or zero, clipping is symmetric; `split_chunks` returns chunks of exactly the
      requested even size and a shorter remainder, and the concatenation equals the input. The
      dashboard half is task 18.2.
    - **Validates: Requirements 12.3, 12.4, 12.5**
  - [x] 16.3 Create `frames.py`, `reorder.py` and `appsync.py` in `device/warashi_agent/conversation/`
    - `decode_out` (never raises, unknown `t` ignored), `encode_in`, the reorder window mirroring the
      cloud one, and the handshake builders: subprotocols `aws-appsync-event-ws` and
      `header-<base64url, no padding>` with `Authorization` and the HTTP `host`, `connection_init`,
      `subscribe`, `publish` (at most 5 events), `ka` handling. All pure.
    - _Requirements: 5.1, 5.3, 5.4, 5.5, 5.6, 5.7, 12.1_
  - [x] 16.4 Write tests for frames, reorder and handshake
    - `device/tests/test_conversation_frames.py` and `test_appsync.py`: every golden frame decodes and
      re-encodes; malformed frames; subprotocol is Base64URL without padding; reorder cases. Add the
      Python property test `device/tests/test_prop_frames.py`.
    - **Property 6: Frame codec round trip and robustness (Python)**
    - Same checks as task 4.3 over the Python codec and the shared fixtures.
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.7, 5.10, 16.4, 16.5**
  - [x] 16.5 Create the recorded-audio fakes for CI
    - `device/tests/voice_fixtures.py`: deterministic generation of 16 kHz tone bursts and silence at
      test time (no real voice file in the repository). `RecordedMic` returns those chunks,
      `RecordedSpeaker` collects every byte played, `FakeAppSyncServer` (a `websockets` server on
      loopback) speaks the handshake, checks the subprotocols and the token, relays `in` frames to a
      scripted session and sends `out` frames including out-of-order and duplicate ones. Added to
      `adapters/fakes.py`: `FakeConversation`. The guard of `cloud-judgement` task 2.2 still allows
      loopback only.
    - _Requirements: 12.2, 12.6, 12.8_
  - [x] 16.6 Implement `device/warashi_agent/conversation/client.py`
    - `ConversationClient.run(start)` as in the design: connect within
      `conversation_connect_timeout_s`, subscribe `out`, publish `hello`, pump microphone chunks with
      gain to `in` with `seq`, play 24 kHz frames through the reorder window, stop playback on
      `interrupt`, honour `conversation_mute_mic_while_speaking`, end on `bye`, local silence, a
      microphone failure (`arecord` exits or no data for 2 s, `microphone_failed`), transport failure
      (`conversation_failed`) or `request_stop`. Returns exactly one `ConversationEnd`, never raises,
      never logs the token.
    - _Requirements: 12.1, 12.2, 12.6, 12.7, 12.11, 12.12, 12.13_
  - [x] 16.7 Write tests in `device/tests/test_conversation_client.py`
    - Against `FakeAppSyncServer`, `RecordedMic` and `RecordedSpeaker`: connect, subscribe, hello,
      audio both ways, `interrupt` stops playback, half-duplex mode sends no chunk while playing,
      server close, bad token, no data, microphone failure, silence end.
    - _Requirements: 12.1, 12.2, 12.6, 12.7, 12.11, 12.12, 12.13_
  - [x] 16.8 Implement `device/warashi_agent/adapters/conversation.py`
    - `ConversationAdapter` (`ConversationPort`): a worker thread with an asyncio loop, real
      `arecord` and `aplay` wrappers (16 kHz in, 24 kHz out, card selected by name), `handle`
      enqueues and never raises, posts exactly one `ConversationFinished` per session id, `stop` is
      idempotent and ends both subprocesses within 1 s. Add `ConversationPort` to
      `adapters/ports.py`.
    - _Requirements: 12.8, 12.9, 12.10_
  - [x] 16.9 Write property test for one end per session
    - **Property 11: One end per session (device adapter)**
    - Test file `device/tests/test_prop_conversation_results.py`: random sequences of start and stop
      with scripted server behaviour (clean end, drop, hang, bad token, no data, microphone failure)
      against the fakes and a manual scheduler; every session id gets exactly one
      `ConversationFinished`, `stop` is idempotent, no audio subprocess is left after every deadline,
      and no microphone chunk is sent during playback in half-duplex mode. Add `pytest-timeout` marks
      so a blocking fake fails instead of hanging.
    - **Validates: Requirements 12.7, 12.8, 12.9, 12.10**
  - [x] 16.10 Wire the conversation into `__main__`, the dispatcher and the provisioning script
    - `device/warashi_agent/__main__.py` builds the `ConversationAdapter` only when
      `conversation_enabled` (the `--fake` mode uses `FakeConversation`); the dispatcher routes
      `StartConversation` and `StopConversation`; `scripts/provision_device.sh` writes
      `appsync_realtime_host` and `appsync_http_host` into `warashi-aws.toml` (read from the stack
      outputs passed by argument or environment, never committed); `device/systemd` needs no change.
      Tests in `device/tests/test_cli.py` and `test_provision_script.py`.
    - _Requirements: 11.1, 12.1, 12.15_
  - [x] 16.11 Add the two voice lines and keep the catalog in sync
    - Add `conversation_trouble` and `conversation_bye` to `device/warashi_agent/voice/lines.toml`
      with the design's text and subtitles (family category, at most 22 code points, no Latin
      letters). Run `scripts/export_voice_catalog.py` to copy the catalog to the dashboard and to
      `cloud/lambda/_shared/voice-lines.json`; the manifest tests and the catalog drift check of
      `cloud-judgement` task 10.7 must cover both lines. Generated WAV files come from the owner
      step O6 and are git-ignored as before.
    - _Requirements: 9.10, 16.7_

- [x] 17. Checkpoint - device and dashboard
  - Ensure all tests pass (`make test` and `make lint`), ask the user if questions arise.

- [x] 18. Dashboard voice client
  - [x] 18.1 Create `dashboard/src/voice/frames.ts` and `audio.ts`
    - `frames.ts`: the same codec as the cloud (a copy checked against the shared fixtures).
      `audio.ts`: pure `resampleTo16k`, `floatToPcm16`, `pcm16ToFloat`, 100 ms chunker and reorder.
      `worklet.ts` stays a thin processor that calls `audio.ts`.
    - _Requirements: 5.1, 5.7, 13.2, 13.3_
  - [x] 18.2 Write property tests for frames and audio (dashboard)
    - **Property 7: Audio gain (resampler half)**
    - Test file `dashboard/test/voice/audio.prop.test.ts`: for any sample rate and length the
      resampler returns `ceil(n * 16000 / rate)` samples within one and every value in `[-1, 1]`.
    - **Property 6: Frame codec round trip and robustness (dashboard)**
    - Test file `dashboard/test/voice/frames.prop.test.ts`: the same checks as task 4.3 over the
      dashboard copy and the shared fixtures.
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.10, 13.3, 16.4**
  - [x] 18.3 Implement `transport.ts`, `VoiceClient.ts` and `useVoice.ts`
    - `VoiceTransport` with a WebSocket implementation (subprotocols as in task 16.3) and
      `FakeVoiceTransport`; `VoiceClient` as in the design: `POST /conversations`, connect, subscribe
      `out` and `text`, publish `hello`, capture through the worklet, schedule 24 kHz playback back to
      back, stop all sources on `interrupt`, pass `command` frames to the simulation reducer, answer a
      virtual `snapshot.request` with a `look.result` frame, subscribe `text` with the observer token
      for a doll session, send `bye` and call `DELETE` on stop or tab close.
    - _Requirements: 13.1, 13.2, 13.4, 13.5, 13.6, 13.7, 13.9_
  - [x] 18.4 Handle the new envelopes in the simulation reducer
    - `dashboard/src/simulation`: the pure reducer accepts `conversation.*` and `snapshot.request`
      envelopes (the virtual doll enters and leaves a conversing phase and answers a look with its
      simulated verdict), with the same messages as the real device. Extend the reducer tests and the
      fixtures test (`dashboard/test/fixtures.test.ts`) with the new schema fixtures.
    - _Requirements: 13.5, 13.6, 16.3_
  - [x] 18.5 Implement `dashboard/src/components/TalkPanel.tsx`
    - Talk button for signed-in users, the Amazon Bedrock in Tokyo notice, a microphone-on indicator
      and Stop button while capturing, live subtitles and the end reason, the button disabled with a
      reason when `GET /me` reports `voice.enabled: false`, the role is not allowed or
      `remainingToday` is 0, and no name anywhere. English UI copy.
    - _Requirements: 13.7, 13.8, 13.10, 13.11, 13.12_
  - [x] 18.6 Write tests in `dashboard/test/voice/`
    - `VoiceClient` with `FakeVoiceTransport` (start, audio, command frame reaches the reducer,
      interrupt, stop sends `bye` then `DELETE`); `TalkPanel` states with Testing Library (disabled
      reasons, indicator, subtitles, no name); the cross-language fixture check for the dashboard
      frames.
    - _Requirements: 13.1, 13.4, 13.5, 13.8, 13.9, 13.10, 13.12_

- [x] 19. Owner scripts
  - [x] 19.1 Create `scripts/check_sonic_japanese.py`
    - Owner tool using `boto3` (the same exception as `generate_voice_lines.py`, never installed on
      the Pi): runs one Japanese text prompt through Nova Sonic in Tokyo, prints the transcript and
      `japaneseRatio` (a Python port of the cloud function, covered by a parity test against shared
      cases in `device/tests/test_check_sonic_japanese.py`), and writes a WAV for listening into a
      git-ignored folder. It plays nothing and needs credentials, so it is never part of `make test`.
    - _Requirements: 9.4, 15.6_
  - [x] 19.2 Create `scripts/check_appsync_ordering.py`
    - Owner tool that opens a test Events API with a session token, publishes 500 numbered events at
      10 per second on one channel, receives them and prints the number of out-of-order, duplicate and
      missing events and the p50 and p95 delivery delay. Pure analysis function covered by
      `device/tests/test_check_appsync_ordering.py` with a scripted event list. Result goes to
      `design.md` through owner step O3 (design point V9).
    - _Requirements: 5.7_

- [x] 20. Opt-in integration tests (never part of `make test`)
  - [x] 20.1 Write the voice integration tests
    - `cloud/test/integration/voice/voice.integration.test.ts`, using `describeIntegration`
      (`WARASHI_AWS_INTEGRATION=1`): one real Japanese turn against Bedrock in Tokyo reporting
      `japaneseRatio`, one browser-style session through the deployed Events API with a test token
      that reports the loop latency (p50 and p95) and the lead time of assistant text over audio
      (V13), and the session price per minute from the invoice-free token counts. Skipped, not failed,
      without the variable. Values go to `design.md` through owner step O3.
    - _Requirements: 9.4, 10.6, 15.6_

- [x] 21. Documentation, repository hygiene and the Kiro journal
  - [x] 21.1 Update `README.md` with the voice sections
    - English text: what the feature does and that it is off by default, the settings that turn it on
      (`voiceEnabled`, `conversation_enabled`), that Nova Sonic has no guardrails and that the face
      check at the start and the re-check are the only proof that a family member is present (a
      photograph of a family member passes), that voice goes to Amazon Bedrock in Tokyo and nothing is
      stored, the owner scripts of task 19 and a pointer to the owner steps.
    - _Requirements: 9.11, 13.11, 14.1_
  - [x] 21.2 Update `docs/third-party.md`
    - Add `python3-websockets` (BSD-3-Clause, installed from the OS package, not vendored) as a
      dependency. Record the GenU and Nova samples licenses checked in task 1.3 with repository,
      commit, license and URL, and state that no source file is copied. If any file was adapted, add
      a row with component, source URL and commit, license, files and a one-line change description,
      and keep the header notice in the file.
    - _Requirements: 15.6_
  - [x] 21.3 Update `structure.md` and `tech.md`
    - One line each for the new folders `cloud/lambda/_shared/voice/`,
      `device/warashi_agent/conversation/`, `dashboard/src/voice/`, `docs/fixtures/voice-v1/` and
      for the new dependencies (`python3-websockets` on the Pi, `websockets` as a laptop dev
      dependency, `@smithy/signature-v4` and `@aws-crypto/sha256-js` in `/cloud`), each with the
      reason. Add `docs/fixtures/voice-v1/persona-markers.json` as the home of the marker-phrase list.
    - _Requirements: 9.2_
  - [x] 21.4 Extend the repository scan
    - `cloud/test/repo-scan.test.ts`: the new fixtures (placeholder token only) are on the allow list;
      no real token, AppSync host, audio recording (`*.wav` outside the git-ignored voice folder) or
      name enters a tracked file; the README holds the statements of R9.11.
    - _Requirements: 9.11, 14.1_
  - [x] 21.5 Finalize `design.md`
    - Make sure the Lambda table matches the synthesized roles, every limit, quota and model ID has a
      citation or a "pending owner measurement" mark, the Region table is complete, and the open
      questions are marked decided or still owner-open (R15).
    - _Requirements: 15.1, 15.3, 15.5, 15.6_
  - [x] 21.6 Add the `docs/kiro-usage.md` journal entry
    - Append an English entry for the `voice-conversation` spec: the design review (V1 to V19), the
      AWS documentation checks done through the `aws-docs` MCP server, the property-based testing
      choices (session lifecycle, lock, tool limits, schema, pure cores), the recorded-audio fake
      approach, the persona marker decision and the owner steps left.
    - _Requirements: 15.6_

- [x] 22. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass (`make test` and `make lint`) with no Pi, no microphone, no AWS account and
    no credentials, `npx cdk synth` succeeds, and no test is skipped except the opt-in integration
    tests. Ask the user if questions arise.

## Owner and manual steps (not tasks, do not block the automated tasks)

- **O1. Opt in.** Set the CDK context `voiceEnabled = true` and deploy `VoiceStack`. Set
  `conversation_enabled = true` in the doll's `config.toml` only after O3 and O8 pass.
- **O2. Bedrock model access.** Confirm access to `amazon.nova-2-5-sonic` in `ap-northeast-1` and
  that the Region has AppSync Events (task 1.1 result).
- **O3. Measurements.** Run `scripts/check_sonic_japanese.py` (listen to the WAV, decide voice
  `tiffany` or `matthew`), `scripts/check_appsync_ordering.py` and the opt-in tests of task 20.1 with
  `WARASHI_AWS_INTEGRATION=1`. Copy value, date and source of Japanese quality, ordering, latency and
  price into `design.md` (items marked "pending owner measurement").
- **O4. Decisions still open (R15).** Reviewer voice (default off), stranger during a conversation
  (default: end silently), cascaded fallback (default: none), voice and model. Change the
  configuration defaults if the owner decides otherwise.
- **O5. Cognito users.** Reviewer voice needs `reviewerVoiceEnabled = true` and the reviewer account
  from `cloud-judgement`.
- **O6. Voice lines.** Run `scripts/generate_voice_lines.py` so the WAV files of
  `conversation_trouble` and `conversation_bye` exist on the doll.
- **O7. Provisioning.** Run `scripts/provision_device.sh` again so `warashi-aws.toml` holds the AppSync
  host names, copy it to the Pi and run `scripts/deploy_pi.sh`.
- **O8. Real-doll tests.** On the doll run `apt install python3-websockets`, check
  `python3 -c "import websockets; print(websockets.version.version)"` (O8b of the design), then test
  a family greeting that starts a conversation, a manual start, a stranger stepping in, an offline
  start, echo from the speaker (`conversation_mute_mic_while_speaking`) and the CPU load on the Pi
  Zero W.

## Notes

- All sub-tasks, including every property-based test, are required. No sub-task is marked optional.
- Property to task map: P1 5.3, P2 6.4, P3 7.3, P4 15.4, P5 6.3, P6 4.3 and 16.4 and 18.2 (three
  languages), P7 16.2 and 18.2 (two languages), P8 8.7, P9 8.5, P10 8.6, P11 16.9.
- The persona marker-phrase list (R9.2) lives in `docs/fixtures/voice-v1/persona-markers.json`
  (task 2.3) and is checked in task 8.4.
- The open-verification items of the design map to tasks: AppSync Events in Tokyo 1.1, Nova 2.5 voices,
  Japanese and price 1.2 and 20.1, GenU license 1.3 and 21.2, channel ordering 19.2.
- Other specs pick up their part through these tasks: `device-core-loop` (15.1, 15.2, 16.11),
  `cloud-judgement` (11.5, 2.5, 16.10), `dashboard-simulation` (18.4, 14.2).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["1.4", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3"] },
    { "id": 3, "tasks": ["2.4", "2.5", "3.1"] },
    { "id": 4, "tasks": ["3.2", "4.1", "6.1", "8.1", "8.2", "8.3", "15.1", "16.1", "16.3", "16.11", "18.1", "19.1", "19.2"] },
    { "id": 5, "tasks": ["4.2", "4.3", "5.1", "6.2", "7.1", "8.4", "8.5", "8.6", "15.2", "16.2", "16.4", "16.5", "18.2", "18.4"] },
    { "id": 6, "tasks": ["5.2", "5.3", "6.3", "6.4", "6.5", "7.2", "7.3", "8.7", "15.3", "15.4", "16.6", "18.3"] },
    { "id": 7, "tasks": ["9"] },
    { "id": 8, "tasks": ["10.1", "16.7", "16.8", "18.5"] },
    { "id": 9, "tasks": ["10.2", "16.9", "16.10", "18.6"] },
    { "id": 10, "tasks": ["17"] },
    { "id": 11, "tasks": ["10.3", "11.1", "11.2", "11.3", "11.5"] },
    { "id": 12, "tasks": ["11.4", "12.1"] },
    { "id": 13, "tasks": ["12.2", "12.3"] },
    { "id": 14, "tasks": ["12.4"] },
    { "id": 15, "tasks": ["13"] },
    { "id": 16, "tasks": ["14.1", "14.2", "20.1"] },
    { "id": 17, "tasks": ["14.3"] },
    { "id": 18, "tasks": ["14.4"] },
    { "id": 19, "tasks": ["21.1", "21.2", "21.3", "21.5", "21.6"] },
    { "id": 20, "tasks": ["21.4"] },
    { "id": 21, "tasks": ["22"] }
  ]
}
```
