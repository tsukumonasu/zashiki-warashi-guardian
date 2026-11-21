# Implementation Plan: cloud-judgement

## Overview

This plan builds the AWS backend in `/cloud` (TypeScript, CDK v2, Lambda `nodejs24.x`, vitest,
fast-check), the two scripts in `/scripts`, and the real MQTT `MqttCloudLink` in `/device`
(Python 3.13, `python3-paho-mqtt`, pytest, Hypothesis). It follows the approved
`requirements.md` and `design.md` in this folder and the task style of
`.kiro/specs/device-core-loop/tasks.md`. The design already uses TypeScript and Python, so no
language question is open.

Order of work:

1. Verify the items `design.md` lists as unverified and record the results in `design.md`.
2. Scaffold `/cloud`, then contract first: audit `docs/schema.md`, create the golden fixtures,
   and build the TypeScript and Python Schema_Codec checks. Checkpoint.
3. Pure cores: config, Verdict_Engine, Notify_Policy, Authorizer, Redactor, Rate_Limiter, TTL
   filter, line choice, persona, sanitizer, WAV wrapper. Each core is followed by its tests.
4. Ports, in-memory fakes, Judge, Ingest, speech and simulate cores, HTTP and admin cores.
5. Thin AWS adapters tested with mocked clients, then the Lambda handlers. Checkpoint.
6. CDK stacks with template tests. Checkpoint.
7. `scripts/provision_device.sh`, `scripts/generate_voice_lines.py`, the demo seeding script, then
   the device `MqttCloudLink`. Checkpoint.
8. Opt-in integration tests, README and docs, the repository scan, the `kiro-usage.md` entry.
   Final checkpoint.

Rules for every task:

- **Contract first.** `docs/schema.md` is changed before any producer or consumer (task 3.1).
- **Pure core, hardware-free and AWS-free tests.** Every AWS or MQTT dependency sits behind a
  port with a fake. `make test` needs no Raspberry Pi, no AWS account and no credentials.
- **Property-based tests are required tasks.** Each of the 22 Correctness Properties of
  `design.md` has exactly one property sub-task below. None is optional. Each runs at least 100
  iterations (fast-check `numRuns >= 100`, Hypothesis `max_examples >= 100`) and carries the tag
  `Feature: cloud-judgement, Property <n>: <title>`, so a failure reports the tag and the shrunk
  counterexample (R26.1, R26.7).
- **Small dependencies.** New dependencies are limited to those in the design's "Dependencies"
  section. Task 2.1 adds one line to `tech.md` or `structure.md` for each new folder or
  dependency (`cloud/lambda/_shared`, `docs/fixtures/schema-v1`, `boto3` for one script).
- **No secrets in git.** No certificate, key, account id, endpoint host, e-mail address or face
  image enters the repository. Use `*.example` files and CDK context.
- **Owner steps do not block automated tasks.** Steps that need the owner are listed in the
  section "Owner and manual steps" after the task list. They are not checkbox tasks. Every
  automated task passes with fakes and without them.

## Tasks

- [x] 1. Verify and record the unverified items of `design.md` (first implementation task)
  - [x] 1.1 Verify the documentation-based items and record them in `design.md`
    - Use the `aws-docs` MCP server (`search_documentation`, `read_documentation`) for each item:
      - Tokyo (`ap-northeast-1`) prices for Rekognition, Polly neural and Bedrock Nova Lite.
      - Whether `rekognition:SearchFacesByImage` and `rekognition:DetectFaces` accept a collection
        ARN as the IAM resource (Service Authorization Reference), so the household and demo
        collections can have separate permissions. If a resource type is not supported, record
        the fallback and the `design.md` Lambda table change it needs.
      - Whether an array claim such as `cognito:groups` reaches an HTTP API Lambda as an array or
        as a string, from the JWT authorizer documentation. `rolesFromClaims` accepts both either way.
      - The `python3-paho-mqtt` version on Raspberry Pi OS Trixie (Debian package page) and that
        the version 2 callback API is available. Record the command `apt policy python3-paho-mqtt`
        for the owner to confirm on the doll (owner step O8).
    - In `design.md`, replace each "unverified" mark with the value, the date (UTC `YYYY-MM-DD`)
      and the documentation page URL. Where only a deployed account can answer, replace the mark
      with "pending owner measurement, procedure in task 24.1" instead of a guess.
    - _Requirements: 27.4, 27.5_
  - [x] 1.2 Verify the CDK constants against the installed `aws-cdk-lib` and keep the check as a test
    - Create `cloud/package.json` and `cloud/tsconfig.json` with `aws-cdk-lib`, `constructs`,
      `typescript`, `vitest` and `fast-check` only, then run `npm install` in `/cloud`.
    - Add `cloud/test/cdk-constants.test.ts` asserting that `Runtime.NODEJS_24_X` exists and
      `aws-cdk-lib/aws-cloudfront-origins` exports `S3BucketOrigin`. If `NODEJS_24_X` is missing,
      the test names the newest Node.js LTS constant that is offered (R19.5).
    - Record the installed `aws-cdk-lib` version, the chosen runtime and the reason in `design.md`.
    - _Requirements: 19.5, 27.4_
  - [x] 1.3 Record the verification results and the pending measurements
    - Update the "Unverified" list in `design.md` so that every item is either measured (value,
      date, source) or marked "pending owner measurement" with the task that measures it
      (latency: 24.1; Nova Lite and Polly in Tokyo: 24.2). Add the Region table required by R19.6
      (every service and model used, its Region, a documentation link).
    - _Requirements: 19.6, 27.4, 27.5_

- [x] 2. Scaffold `/cloud` and the test guards
  - [x] 2.1 Complete the `/cloud` workspace and repository wiring
    - `cloud/package.json` with the dependencies of the design (`@aws-sdk/client-*` v3 for
      rekognition, s3, dynamodb with `lib-dynamodb`, iot-data-plane, sns, bedrock-runtime, polly,
      lambda, plus `s3-request-presigner`, `s3-presigned-post`, `esbuild`, `aws-sdk-client-mock`,
      `eslint`, `typescript-eslint`); `tsconfig.json` strict; flat `eslint.config.js`;
      `vitest.config.ts` with a setup file; folders `bin/`, `lib/`, `lambda/_shared/`,
      `lambda/<function>/`, `test/`.
    - `Makefile`: `make test` runs `vitest --run` in `/cloud` next to the device tests; `make lint`
      runs `eslint` and `tsc --noEmit` in `/cloud` next to ruff. Both pass on an empty scaffold.
    - `.gitignore`: add `cdk.context.json`, `cdk.out/`, `cloud/node_modules/`. Keep `.kiro/` tracked.
    - Add one line each to `structure.md` (or `tech.md`) for `cloud/lambda/_shared`,
      `docs/fixtures/schema-v1`, and `boto3` for `scripts/generate_voice_lines.py` only.
    - _Requirements: 19.3, 26.2, 26.6_
  - [x] 2.2 Add the network guard and the opt-in switch for integration tests
    - `cloud/test/setup.ts`: a vitest setup that makes any outbound `net`, `tls` or `http(s)`
      connection fail the test with an error that names the host (R26.3).
    - `device/tests/conftest.py`: the same guard for `socket.connect` (allow loopback only).
    - A helper `describeIntegration` that runs a suite only when the environment variable
      `WARASHI_AWS_INTEGRATION=1` is set and reports it as skipped otherwise (R26.5).
    - Tests that prove the guards: a test that tries to connect fails with the host name in the
      message; the integration helper skips without the variable.
    - _Requirements: 26.2, 26.3, 26.5_

- [x] 3. Contract and golden fixtures (contract first)
  - [x] 3.1 Audit and complete `docs/schema.md` before any code
    - Compare `docs/schema.md` with the six items of the design section "docs/schema.md Changes"
      (snapshot size note, `status.offline` timing, topic check, `judgement.result.confidence`
      meaning, HTTP API section, fixtures reference) and with the HTTP routes, error codes and
      role matrix used by `requirements.md` (R13 to R17). Fix every gap, with the reason next to
      the change. No event or command field changes, so `v` stays 1.
    - State in the document that `docs/fixtures/schema-v1/` holds one golden message per type.
    - _Requirements: 24.1, 24.13, 24.16_
  - [x] 3.2 Create the golden fixtures in `docs/fixtures/schema-v1/`
    - One JSON file per type: events `presence.detected`, `snapshot.captured` (small valid base64
      JPEG header), `state.changed`, `reaction.performed`, `encounter.ended`, `error.reported`;
      commands `judgement.result`, `speak`, `gaze`, `lantern`, `mode.set`; status `status.report`,
      `status.offline`. File names are the type with dots, for example `judgement.result.json`.
    - Use only placeholder ids and `warashi-01`; no names, hosts or account ids.
    - _Requirements: 24.13, 25.3_
  - [x] 3.3 Write the Python fixture tests in `device/tests/test_fixtures.py`
    - Decode every fixture with `warashi_agent.messages` to `valid`, re-encode it, and compare as
      JSON values (key order ignored). Fail with the type or file name when a type in
      `docs/schema.md` has no fixture or a fixture has no matching type (R24.15).
    - _Requirements: 24.13, 24.14, 24.15_

- [x] 4. TypeScript Schema_Codec
  - [x] 4.1 Implement `cloud/lambda/_shared/messages.ts`
    - `decodeEnvelope`, `encodeEnvelope`, `makeCommand`, `topicFor`, `SCHEMA_VERSION`,
      `MAX_INBOUND_BYTES`, mirroring `device/warashi_agent/messages.py` and the decode order of
      R24.2 to R24.5 (malformed before `unsupported_version` before `unknown_type`). Drop undefined
      `data` fields on decode, omit undefined fields on encode, clamp in `makeCommand`
      (`lantern.level` 0..1, `fadeMs` 0..10000, face box 0..1), reject non-finite numbers, and make
      `topicFor` throw for an unknown kind or an empty device id.
    - Pure, no AWS imports, no `Date.now()` (time and ids are passed in).
    - _Requirements: 6.3, 24.1, 24.2, 24.3, 24.4, 24.5, 24.6, 24.7, 24.9, 24.10, 24.11, 24.12_
  - [x] 4.2 Write unit tests in `cloud/test/messages.test.ts`
    - Each fixture decodes to `valid`; `v` of 0, 1.5, `"1"`, `true` is malformed; `v` 2 is
      ignored; unknown type is ignored; the precedence rules of R24.5; the 131,072-byte limit;
      `speak` with both or neither of `lineId` and `audioUrl`; `makeCommand` clamps and rejection;
      `topicFor` for all kinds and the error cases. A test that every fixture file has a type and
      every type has a fixture (R24.15, TypeScript side).
    - _Requirements: 24.2, 24.3, 24.4, 24.5, 24.9, 24.10, 24.11, 24.12, 24.15_
  - [x] 4.3 Write property test for the envelope round trip
    - **Property 9: Envelope round trip**
    - Test file `cloud/test/prop-envelope-roundtrip.test.ts`; generators for every type; also
      checks that invalid `v`, ids, enumerations, non-finite numbers and oversize input are rejected.
    - **Validates: Requirements 6.3, 24.1, 24.6, 24.7, 24.8**
  - [x] 4.4 Write property test for the cross-language contract
    - **Property 10: Cross-language contract**
    - TypeScript side `cloud/test/prop-cross-language.test.ts` and Python side
      `device/tests/test_prop_cross_language.py` (Hypothesis, at least 100 examples): every fixture
      in `docs/fixtures/schema-v1` and every generated mutation of it that stays valid decodes
      and re-encodes to a semantically equal value in both languages, and both codecs agree on the
      outcome kind (`valid`, `ignored`, `malformed`) for the same input.
    - **Validates: Requirements 24.13, 24.14**
  - [x] 4.5 Write property test for the snapshot size bound
    - **Property 11: Snapshot size bound**
    - Test file `cloud/test/prop-snapshot-size.test.ts`: the largest legal `snapshot.captured`
      (90,000-byte JPEG, longest legal ids, extreme angles) encodes to fewer than 128,000 bytes,
      and smaller legal inputs never exceed it.
    - **Validates: Requirements 2.5**

- [x] 5. Checkpoint - contract and codec
  - Ensure all tests pass (`make test` and `make lint`), ask the user if questions arise.

- [x] 6. Configuration module
  - [x] 6.1 Implement `cloud/lambda/_shared/config.ts`
    - Defaults of R27.1, override order environment variable over CDK context over default
      (R27.2), validation of every range and of `searchFloor <= strangerMax <= familyMin <= 100`
      (R5.16, R27.3), `reviewerRealEncounters` as `hidden` or `redacted` (R14.9), snapshot expiry
      1 to 7 days. A rejection error names the setting and the invalid value.
    - Rate limit defaults of R15.11 and `status_interval_s` (R12.4) live here as well.
    - _Requirements: 5.16, 14.8, 14.9, 15.11, 27.1, 27.2, 27.3_
  - [x] 6.2 Write unit tests in `cloud/test/config.test.ts`
    - Defaults; each override source and their order; each range boundary (inside, outside,
      non-finite, negative); the ordering rule; `reviewerRealEncounters` values.
    - _Requirements: 5.16, 14.9, 27.1, 27.2, 27.3_

- [x] 7. Verdict_Engine
  - [x] 7.1 Implement `cloud/lambda/_shared/verdict.ts`
    - `decideVerdict`, `isStrangerCandidate`, `classifySearchError`, and the types of the design,
      following the pseudocode (adapter failure gives `uncertain`, `no_face` has `face: null`,
      family band, uncertain band, stranger only with a good-quality face and `confidence >=
      acceptMin`, boxes clamped to 0..1).
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.11, 5.12, 5.13, 5.14_
  - [x] 7.2 Write unit tests in `cloud/test/verdict.test.ts`
    - Each branch and boundary: exactly `familyMin`, just below; exactly `strangerMax`; weak face;
      small face; each quality limit; missing quality; failure; `no_face`; `classifySearchError`
      mapping of `InvalidParameterException` and throttling names.
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.9_
  - [x] 7.3 Write property test for verdict totality
    - **Property 1: Verdict totality**
    - Test file `cloud/test/prop-verdict-totality.test.ts`.
    - **Validates: Requirements 5.11, 5.12**
  - [x] 7.4 Write property test for threshold soundness
    - **Property 2: Threshold soundness**
    - Test file `cloud/test/prop-verdict-thresholds.test.ts`; similarities concentrated around the
      thresholds.
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.13**
  - [x] 7.5 Write property test for monotonicity
    - **Property 3: Monotonicity**
    - Test file `cloud/test/prop-verdict-monotonic.test.ts`.
    - **Validates: Requirements 5.15**
  - [x] 7.6 Write property test for failure safety
    - **Property 4: Failure safety**
    - Test file `cloud/test/prop-verdict-failure.test.ts`.
    - **Validates: Requirements 5.9**
  - [x] 7.7 Write property test for device-accept consistency
    - **Property 5: Device-accept consistency**
    - Test file `cloud/test/prop-verdict-accept.test.ts`.
    - **Validates: Requirements 5.14**

- [x] 8. Notify_Policy
  - [x] 8.1 Implement `cloud/lambda/_shared/notify.ts`
    - `shouldNotify` and `buildStrangerNotification` as in the design: subject at most 100
      characters, body with device label, UTC ISO 8601 time and dashboard URL, and no image link,
      face data or name.
    - _Requirements: 9.2, 9.3, 9.4, 9.5, 9.9_
  - [x] 8.2 Write unit tests in `cloud/test/notify.test.ts`
    - Each reason (`not_stranger`, `encounter_done`, `within_window`, `clock_skew`, `send`);
      window boundary; subject length; no name or URL other than the dashboard URL.
    - _Requirements: 9.2, 9.5, 9.9_
  - [x] 8.3 Write property test for notification limits
    - **Property 6: Notification limits**
    - Test file `cloud/test/prop-notify-limits.test.ts`; sequences with non-decreasing times.
    - **Validates: Requirements 9.2, 9.3, 9.4, 9.5**

- [x] 9. Authorizer, Redactor, Rate_Limiter and TTL filter
  - [x] 9.1 Implement `cloud/lambda/_shared/authz.ts`
    - `rolesFromClaims` (array or string forms, reviewer wins), `authorize`, and the route table
      with the family and reviewer sets of R13.7. Any other route string is denied.
    - _Requirements: 13.4, 13.5, 13.7_
  - [x] 9.2 Write unit tests in `cloud/test/authz.test.ts`
    - Claim forms (`["family"]`, `"family"`, `"[family reviewer]"`, absent, empty, unknown group);
      every route for both roles; a test that the route table equals the role matrix of
      `docs/schema.md` and reports each missing or extra route (R24.16, route half).
    - _Requirements: 13.4, 13.5, 13.7, 24.16_
  - [x] 9.3 Write property test for the authorization table
    - **Property 15: Authorization table**
    - Test file `cloud/test/prop-authz.test.ts`.
    - **Validates: Requirements 13.4, 13.5, 13.7**
  - [x] 9.4 Implement `cloud/lambda/_shared/types.ts` and `redact.ts`
    - `EncounterRecord` and related types from `docs/schema.md`; `redactEncounter(record, role)`
      with the illustration mapping of R14.1, removal of `snapshot`, `hasImage`, `jpegBase64`,
      `face`, member data and S3 keys at any depth for `reviewer`, identity for `family`, and
      idempotence.
    - _Requirements: 14.1, 14.2, 14.3, 14.6, 14.7_
  - [x] 9.5 Write property test for redaction
    - **Property 14: Redaction**
    - Test file `cloud/test/prop-redact.test.ts`; records with nested forbidden keys, events with
      `hasImage`, `jpegBase64` and `face`.
    - **Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.7**
  - [x] 9.6 Implement `cloud/lambda/_shared/ratelimit.ts`
    - `bucketOf`, `withinLimit`, key builders for the per-user hourly, per-user generate hourly
      and global daily counters, `Retry-After` seconds computation (1 to 86,400), and the
      all-or-nothing guard that does not leave other counters incremented after one rejection
      (the guard uses the `StateStore.incrementCounter` port of task 11.1; this task defines the
      pure parts and the guard against an interface type).
    - _Requirements: 15.10, 15.11, 15.12, 15.13_
  - [x] 9.7 Write property test for the rate limit
    - **Property 16: Rate limit**
    - Test file `cloud/test/prop-ratelimit.test.ts`; request sequences across bucket boundaries
      against an in-memory counter model.
    - **Validates: Requirements 15.10, 15.13**
  - [x] 9.8 Implement `cloud/lambda/_shared/ttl.ts`
    - `isLive(item, nowSeconds)` and `filterLive(items, nowSeconds)`; items with `ttl <= now` are
      dropped, items without `ttl` are kept; `ttlFor(createdAtMs, days)` for the 30-day encounter
      TTL, 1-day claim TTL and rate counter TTLs.
    - _Requirements: 11.4, 11.5_
  - [x] 9.9 Write property test for the TTL filter
    - **Property 20: TTL filter**
    - Test file `cloud/test/prop-ttl.test.ts`.
    - **Validates: Requirements 11.5**
  - [x] 9.10 Write unit tests for the Redactor, Rate_Limiter and TTL helpers
    - `cloud/test/redact.test.ts`, `ratelimit.test.ts`, `ttl.test.ts`: each illustration value,
      `null` verdict, family identity, retry-after bounds, bucket restart, TTL equal to creation
      plus 2,592,000 s.
    - _Requirements: 11.4, 14.1, 14.6, 15.12, 15.13_

- [x] 10. Speech pure modules
  - [x] 10.1 Implement `cloud/lambda/_shared/lines.ts` and `voice-lines.json`
    - `VoiceLine`, `Category`, `chooseLine(lines, category, rand)` with the index guard.
    - Create `cloud/lambda/_shared/voice-lines.json` from `device/warashi_agent/voice/lines.toml`
      (id, category, ja, en). Task 21.3 keeps it in sync.
    - _Requirements: 7.1, 7.2, 7.3_
  - [x] 10.2 Write property test for line choice
    - **Property 19: Line choice**
    - Test file `cloud/test/prop-lines.test.ts`; `rand` includes 0 and the largest double below 1.
    - **Validates: Requirements 7.2, 7.3**
  - [x] 10.3 Implement `cloud/lambda/_shared/persona.ts` and `sanitizer.ts`
    - `buildPrompt(situation, hint)` from the persona rules and the situation only (no name, member
      data or image data in the type of its inputs); `sanitizeLine(text, blockedWords)` with the
      rules of R7.6 (1 to 40 characters, at most two sentences, no Latin letters, no emoji, no
      blocked word, no threat).
    - _Requirements: 7.5, 7.6_
  - [x] 10.4 Write property test for the line sanitizer
    - **Property 18: Line sanitizer**
    - Test file `cloud/test/prop-sanitizer.test.ts`.
    - **Validates: Requirements 7.6**
  - [x] 10.5 Implement `cloud/lambda/_shared/wav.ts`
    - `pcm16ToWav(pcm, sampleRate)` with a 44-byte RIFF/WAVE header, 16-bit mono, rate 8,000 or
      16,000; throws on odd length and returns no bytes.
    - _Requirements: 7.10, 7.11_
  - [x] 10.6 Write property test for the WAV wrapper (TypeScript side)
    - **Property 17: WAV wrapper**
    - Test file `cloud/test/prop-wav.test.ts`. The Python port is covered by the same property in
      task 21.5.
    - **Validates: Requirements 7.10, 7.11, 22.6**
  - [x] 10.7 Write unit tests and the TOML parity test
    - `cloud/test/lines.test.ts`, `persona.test.ts`, `sanitizer.test.ts`, `wav.test.ts`: category
      with no lines returns `null`, prompt contains no member name, blocked word, threat, emoji and
      two-sentence cases, header fields of a short buffer.
    - `device/tests/test_voice_lines_json.py`: `voice-lines.json` and `lines.toml` (read with
      `tomllib`) agree in line count and in id, category, `ja` and `en` of every line; the
      failure message names the first difference (R7.1). This keeps a TOML parser out of `/cloud`.
    - _Requirements: 7.1, 7.2, 7.5, 7.6, 7.10, 7.11_

- [x] 11. Ports, in-memory fakes and the safe logger
  - [x] 11.1 Create the ports in `cloud/lambda/_shared/ports.ts`
    - `FaceSearch`, `SnapshotStore`, `DeviceBus`, `Notifier`, `StateStore`, `SpeechSynth`, and a
      `Repository` port for encounter, event, member, device-status and sample-manifest reads and
      writes (so the cores never touch the SDK). `StateStore` has `claim`, `claimNotifySlot`,
      `releaseNotifySlot`, `incrementCounter`. All methods are async and typed with the pure types.
    - _Requirements: 4.1, 9.1, 9.8, 15.10_
  - [x] 11.2 Create the in-memory fakes in `cloud/test/fakes.ts`
    - `FakeFaceSearch` (scripted outcomes, failures, throttling, call recording),
      `FakeSnapshotStore`, `FakeDeviceBus` (records topic and QoS), `FakeNotifier` (scripted
      failure), `FakeStateStore` and `FakeRepository` implementing the same conditional write and
      transaction semantics as the DynamoDB design (`attribute_not_exists`, claim TTL, notify slot
      transaction), `FakeSpeechSynth`. No fake imports the AWS SDK.
    - _Requirements: 26.2_
  - [x] 11.3 Write unit tests for the fakes in `cloud/test/fakes.test.ts`
    - Conditional claim succeeds once; notify-slot transaction fails when the encounter or the
      device window already holds a notification; counter condition; release restores the slot.
    - _Requirements: 4.1, 9.1, 9.7, 15.10_
  - [x] 11.4 Implement the safe logger `cloud/lambda/_shared/safelog.ts`
    - `log(event, fields)` that drops or masks image bytes, base64 image text, any URL with a
      signature query parameter, and values of keys named `displayName`, `jpegBase64`, `faceIds`;
      logs ids and counts only. Used by every handler.
    - _Requirements: 3.2, 8.6, 25.1_
  - [x] 11.5 Write unit tests for the safe logger in `cloud/test/safelog.test.ts`
    - Fixture fields holding a JPEG signature string, a pre-signed URL and a display name never
      appear in the captured output; a face id and a display name are never logged together.
    - _Requirements: 8.6, 25.1_

- [x] 12. Judge core
  - [x] 12.1 Implement `cloud/lambda/judge/judge-core.ts`
    - `handleSnapshot(event, deps)` following the design pseudocode: decode and checks (R2.1 to
      R2.4, R3), snapshot claim before any search (R4.1, R4.2, R4.5), parallel store and search,
      throttle retry once with 50 to 250 ms jitter if under 1.5 s (R5.10), `DetectFaces` only for
      stranger candidates and `InvalidParameterException` (R5.7, R5.8), `decideVerdict`, publish
      `judgement.result` with qos 1 and a 2-second limit before any table write (R6.1 to R6.9),
      encounter meta update (R10.4), `notifyOnce` with slot release on failure (R9.1, R9.7, R9.8).
      Matches discarded below the family threshold never reach logs or output (R8.5).
    - No `speak` is published on this path (R6.5).
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 2.7, 2.8, 3.2, 3.4, 4.1, 4.2, 4.5, 5.7, 5.8, 5.9, 5.10, 6.1, 6.3, 6.4, 6.5, 6.6, 6.8, 6.9, 8.5, 9.1, 9.7, 9.8, 10.4_
  - [x] 12.2 Write unit tests in `cloud/test/judge-core.test.ts`
    - Family, stranger, no face, uncertain band; each adapter failure; throttle retry and its
      1.5 s cutoff; bad JPEG signature, oversize and tiny payloads; store failure still publishes;
      publish failure still writes and logs `publish_failed`; `encounterId` null passthrough;
      notify success, failure with slot release, second stranger snapshot inside the window.
    - _Requirements: 2.4, 2.8, 5.7, 5.9, 5.10, 6.6, 6.9, 9.7, 9.8_
  - [x] 12.3 Write property test for notify slot atomicity
    - **Property 7: Notify slot atomicity**
    - Test file `cloud/test/prop-notify-slot.test.ts`; concurrent `notifyOnce` calls against the
      `FakeStateStore` transaction, with scripted notifier failures.
    - **Validates: Requirements 9.6, 9.8**

- [x] 13. Ingest core
  - [x] 13.1 Implement `cloud/lambda/ingest/ingest-core.ts`
    - `handleIngest(event, deps)`: sender identity check (R3.1 to R3.3), message claim (R4.3 to
      R4.5), event items `ENC#<id>` / `EVT#<ts>#<id>` with `jpegBase64` removed and
      `hasImage: true` (R10.1, R10.2), meta item creation with GSI1 keys on the first event
      (R10.8), meta updates for `state.changed`, `reaction.performed`, `encounter.ended` (R10.3),
      no item for a null `encounterId` (R10.5), unknown type stored nowhere (R10.6), duplicate
      event id leaves the meta unchanged (R10.9), write failure reported to the caller (R10.10),
      status handling with the cloud's arrival time (R12.1 to R12.3). `data` fields outside the
      contract are dropped before storage (R8.2). Items get the 30-day `ttl` (R11.4).
    - _Requirements: 3.1, 3.2, 3.3, 4.3, 4.4, 4.5, 8.2, 10.1, 10.2, 10.3, 10.5, 10.6, 10.8, 10.9, 10.10, 11.4, 11.7, 12.1, 12.2, 12.3_
  - [x] 13.2 Write unit tests in `cloud/test/ingest-core.test.ts`
    - Each event type; the first event creates the meta item; status report then offline then
      report; `ts` never used for the online decision; a failing write reports an error and
      leaves earlier items unchanged.
    - _Requirements: 10.1, 10.2, 10.3, 10.8, 10.9, 10.10, 12.1, 12.2, 12.3_
  - [x] 13.3 Write property test for idempotent handling
    - **Property 12: Idempotent handling**
    - Test file `cloud/test/prop-idempotent.test.ts`; the same envelope id or `snapshotId`
      delivered N times (2 to 10) to the Judge core and the Ingest core with the fakes gives the
      side effects of one delivery.
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.7**
  - [x] 13.4 Write property test for the spoof guard
    - **Property 13: Spoof guard**
    - Test file `cloud/test/prop-spoof.test.ts`; a message whose `deviceId` differs from
      `topicDeviceId` (including missing, non-string and empty) causes no write, no publish, no
      notification, and the log has the `security_mismatch` entry with no payload.
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4**

- [x] 14. Speech generator and simulate core
  - [x] 14.1 Implement `cloud/lambda/_shared/speech-generator.ts`
    - `generateSpeech(situation, hint, deps)` as in the design: stranger generation off by default
      (R7.13), Bedrock JSON `{ja, en}` with a 5 s limit, sanitizer, cached-line fallback with
      `generated: false` and `lineId` set on any failure (R7.7), Polly MP3 with a 5 s limit,
      Polly failure returns the line with `mp3Url: null` (R7.9). Never called by the Judge (R7.12).
    - _Requirements: 7.4, 7.5, 7.7, 7.8, 7.9, 7.12, 7.13_
  - [x] 14.2 Implement `cloud/lambda/api-simulate/simulate-core.ts`
    - `handleSimulate(request, deps)`: body validation (R15.1 to R15.3), rate limit guard before
      any search (R15.10 to R15.13), demo collection only (R15.4), ignore extra fields (R15.5),
      verdict, `judgement.result` and `speak` envelopes with `deviceId: "warashi-sim"` and
      `encounterId: null` in that order (R15.7), speech, latency in integer milliseconds with
      `search <= total` (R15.6), 300-second MP3 URL or `null` (R15.15), no publish and no
      encounter write (R15.8), `500 internal` without partial output on failure (R15.9). Output
      builders accept the member registry only to prove that no label leaks (R8.1, R8.3).
    - _Requirements: 8.1, 8.3, 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 15.10, 15.12, 15.13, 15.15_
  - [x] 14.3 Write unit tests in `cloud/test/speech-simulate.test.ts`
    - Bedrock failure, bad JSON, sanitizer rejection, Polly failure, stranger generation off;
      simulate with a valid, unknown and malformed `sampleId`; non-boolean `generate`; rate limit
      429 with no search; extra body fields ignored; nothing published.
    - _Requirements: 7.7, 7.9, 7.13, 15.1, 15.2, 15.3, 15.5, 15.8, 15.12_
  - [x] 14.4 Write property test for label leakage
    - **Property 8: No label leakage**
    - Test file `cloud/test/prop-no-label.test.ts`; registries of 0 to 100 members with random
      display names; for every situation other than `family` (and the offline reaction) the
      reaction, prompt, speech, notification and simulate outputs contain no label as a
      case-insensitive substring; `judgement.result`, `status.report` and stored events contain no
      field outside the contract.
    - **Validates: Requirements 8.1, 8.2**

- [x] 15. HTTP layer, read, signer and admin cores
  - [x] 15.1 Implement `cloud/lambda/_shared/http.ts`
    - API Gateway v2 event to request mapping, claims extraction (role only from the token,
      R13.8), JSON body parse with the 1,048,576-byte limit, error bodies
      `{ error: { code, message } }` with messages of at most 200 characters and no secrets
      (R13.10), the error codes and statuses of `docs/schema.md`, `Retry-After`, and the
      `Access-Control-Allow-Origin` header only for the configured web origin (R13.11).
    - _Requirements: 13.1, 13.3, 13.6, 13.8, 13.9, 13.10, 13.11_
  - [x] 15.2 Write unit tests in `cloud/test/http.test.ts`
    - Each error code and status; long message truncation; malformed JSON; oversize body; origin
      allow and deny; a test that the implemented error codes equal the list in `docs/schema.md`
      and reports each missing or extra code (R24.16, error half).
    - _Requirements: 13.9, 13.10, 13.11, 24.16_
  - [x] 15.3 Implement `cloud/lambda/api-read/api-read-core.ts`
    - `GET /me`, `/samples`, `/encounters` (limit 1 to 50, opaque validated cursor, newest first,
      `nextCursor`), `/encounters/{id}`, `/device/status` (online rule of R12.4, empty status of
      R12.5, `lastSeenAt` of R12.6). Applies `filterLive`, `redactEncounter` and
      `reviewerRealEncounters` (`hidden` returns an empty list and `not_found`). The core has **no
      S3 dependency**: it asks the injected `SnapshotUrlSigner` for family requests only, and never
      calls it for the reviewer (see 15.5).
    - _Requirements: 11.5, 11.8, 12.4, 12.5, 12.6, 13.12, 13.13, 13.14, 13.15, 13.16, 14.1, 14.4, 14.6, 14.8_
  - [x] 15.4 Write unit tests in `cloud/test/api-read-core.test.ts`
    - Each route for both roles; pagination and the cursor error; expired items hidden before
      DynamoDB TTL deletes them; missing snapshot gives `snapshot: null`; `hidden` and `redacted`
      settings; device status online and offline cases including the 3 x interval rule and a
      later offline mark.
    - _Requirements: 11.8, 12.4, 12.5, 13.14, 13.15, 13.16, 14.8_
  - [x] 15.5 Implement reviewer read isolation (`snapshot-signer`) and record the decision
    - Decision (decided, A5, Requirements 14.4, 14.10 to 14.12): keep one `api-read` function **without any S3
      permission** and add a small internal `snapshot-signer` function, invoked synchronously by
      `api-read` only after the role is `family`. The signer role alone has `s3:GetObject` on
      `snapshots/*`; it refuses any request that carries the role `reviewer` or a key outside
      `snapshots/`, and returns 300-second pre-signed URLs. The `api-read` role has only
      `lambda:InvokeFunction` on the signer ARN. This satisfies "no permission to read objects
      under `snapshots/`" for the identity that serves reviewer requests, and needs no new HTTP
      route, so `docs/schema.md` keeps `snapshot` inside the encounter record (R14.6).
    - Implement `cloud/lambda/snapshot-signer/signer-core.ts` and the `SnapshotUrlSigner` adapter
      used by `api-read`.
    - The decision is final (owner-decided, A5). `design.md` already records the function, its
      permissions, the Open Questions note and Security Considerations; keep them in sync.
    - _Requirements: 11.6, 14.4, 14.6, 14.10, 14.11, 25.5_
  - [x] 15.6 Write unit tests in `cloud/test/signer-core.test.ts`
    - The signer refuses `reviewer`, keys outside `snapshots/` and path-traversal keys; URL lifetime
      is 300 s; `api-read` never calls the signer for a reviewer, including both-groups tokens.
    - _Requirements: 11.6, 14.4, 14.10, 14.11_
  - [x] 15.7 Implement `cloud/lambda/api-admin/commands-core.ts`
    - `POST /commands`: types `speak`, `gaze`, `lantern`, `mode.set`; `speak` only with a known
      `lineId` and no `audioUrl`; mode values; finite-number checks and clamping (`gaze` -60..60 and
      -30..30, `lantern` ranges); `deviceId` pattern; publish through `makeCommand` with qos 1 and
      `encounterId: null`; `202` with `id` and `deviceOnline`; offline doll still published once;
      `500 internal` with a generic message on publish failure and no retry.
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 16.9, 16.10, 16.11_
  - [x] 15.8 Implement `cloud/lambda/api-admin/faces-core.ts`
    - `GET /faces`, `POST /faces/upload` (pre-signed POST, JPEG or PNG, 1 to 5,000,000 bytes,
      300 s), `POST /faces` (consent version, name length, exactly one face, `ExternalImageId` is
      the opaque member id, add photo to an existing member, `404` for an unknown member,
      staging object deleted in every outcome, indexed faces deleted when the count is not one,
      member record fields), `DELETE /faces/{memberId}` (`204`, `404`, `500` with the record kept).
      Never logs a face id together with a name.
    - _Requirements: 8.6, 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10, 17.11, 17.12, 17.13, 17.14, 17.15, 17.16_
  - [x] 15.9 Write unit tests in `cloud/test/api-admin-core.test.ts`
    - Every command validation branch and clamp; offline publish; reviewer `403` with no publish;
      face registration flow: consent mismatch, bad name, zero and two faces, unknown member,
      add photo, delete, delete failure keeps the record, staging cleanup in every outcome.
    - _Requirements: 16.3, 16.4, 16.5, 16.6, 16.7, 16.9, 16.10, 17.4, 17.5, 17.7, 17.8, 17.10, 17.14, 17.15_

- [x] 16. AWS adapters (thin, tested with mocked clients)
  - [x] 16.1 Implement the Rekognition adapter `cloud/lambda/_shared/adapters/rekognition.ts`
    - `FaceSearch` over `SearchFacesByImage` (`QualityFilter: NONE`, `FaceMatchThreshold` from
      config, largest face, bytes input) and `DetectFaces` (all attributes needed for quality);
      maps `InvalidParameterException` and throttling to the signals of the design; collection id
      passed in (household for the Judge, demo for simulate). SDK clients created at module scope.
    - _Requirements: 5.1, 5.7, 5.8, 15.4_
  - [x] 16.2 Write adapter tests in `cloud/test/rekognition-adapter.test.ts`
    - With `aws-sdk-client-mock`: request shapes (`QualityFilter: NONE`, threshold, collection),
      error mapping, face box and quality extraction.
    - _Requirements: 5.1, 5.7, 5.8_
  - [x] 16.3 Implement the S3 and DynamoDB adapters
    - `adapters/s3.ts` (`SnapshotStore.put` with the key layout of R2.7, no partial object on
      failure, 300 s signing) and `adapters/dynamo.ts` (`StateStore` and `Repository` over the
      single table: conditional claims with TTL, notify-slot `TransactWriteItems`, release,
      `ADD count` counter with condition, encounter and status reads with GSI1 newest first, TTL
      attributes, no image bytes).
    - _Requirements: 2.7, 2.8, 4.1, 4.3, 9.1, 10.7, 11.4, 11.6, 11.7, 15.10_
  - [x] 16.4 Write adapter tests in `cloud/test/s3-dynamo-adapter.test.ts`
    - Request shapes: condition expressions, transaction items, `ttl` values, GSI1 query order,
      counter condition, claim conflict mapped to "not first", other errors surfaced (R4.5).
    - _Requirements: 4.1, 4.5, 9.1, 10.7, 11.4, 15.10_
  - [x] 16.5 Implement the IoT data and SNS adapters
    - `adapters/iot-bus.ts`: `Publish` with `qos: 1`, endpoint from an environment variable, a 2 s
      limit (`DeviceBus`). `adapters/sns.ts`: `Notifier` publishing to the one topic.
    - _Requirements: 6.1, 6.2, 6.6, 9.10, 16.1_
  - [x] 16.6 Write adapter tests in `cloud/test/iot-sns-adapter.test.ts`
    - `qos` equals 1, topic is `warashi/<id>/commands`, timeout handling, SNS subject and message
      passed through unchanged.
    - _Requirements: 6.1, 6.2, 6.6, 9.10_
  - [x] 16.7 Implement the Bedrock and Polly adapter `adapters/speech.ts`
    - `SpeechSynth`: Bedrock `InvokeModel` with the configured model id, 5 s limit; Polly
      `Engine: neural`, `VoiceId` from config, SSML `prosody` with `rate` and `volume` only, MP3
      for browsers and `pcm` 16 kHz for `wav16k` (wrapped by `pcm16ToWav`), 5 s limit.
    - _Requirements: 7.4, 7.8, 27.1_
  - [x] 16.8 Write adapter tests in `cloud/test/speech-adapter.test.ts`
    - Request shapes (`Engine`, `OutputFormat`, `SampleRate`, no `pitch`), timeouts, JSON parse
      failure handling.
    - _Requirements: 7.4, 7.8_

- [x] 17. Lambda handlers
  - [x] 17.1 Implement the `judge` handler `cloud/lambda/judge/index.ts`
    - Module-scope SDK clients, configuration from environment variables validated at start (R5.16),
      calls `handleSnapshot` with real adapters. Throws only for the claim failure of R4.5.
    - _Requirements: 4.5, 5.16, 6.2_
  - [x] 17.2 Implement the `ingest` handler `cloud/lambda/ingest/index.ts`
    - Same pattern; throws on a table write failure so the message can be redelivered (R10.10).
    - _Requirements: 4.5, 10.10_
  - [x] 17.3 Implement the API handlers
    - `cloud/lambda/api-read/index.ts`, `api-simulate/index.ts`, `api-admin/index.ts`,
      `snapshot-signer/index.ts`: API Gateway v2 glue, `authorize` before any route logic (`401` and
      `403` produce no side effect), route dispatch, `Retry-After` for `429`, configuration
      validated at start.
    - _Requirements: 13.1, 13.3, 13.6, 13.7, 13.8, 15.12, 17.1, 17.2_
  - [x] 17.4 Write handler tests with mocked AWS clients in `cloud/test/handlers.test.ts`
    - Each handler end to end with `aws-sdk-client-mock` and the real cores: judge happy path and
      duplicate, ingest, every API route with `401`, `403`, `400`, `404`, `429` and success,
      invalid configuration refused at start.
    - _Requirements: 4.5, 5.16, 13.3, 13.6, 14.5, 15.12, 17.2_
  - [x] 17.5 Write the log privacy test in `cloud/test/log-privacy.test.ts`
    - Invoke each handler with a fixture event holding image bytes, base64 image text, a
      pre-signed URL and a family member display name; assert that none appears in the captured log
      output (also for failing paths).
    - _Requirements: 8.6, 25.1_

- [x] 18. Checkpoint - application logic
  - Ensure all tests pass (`make test` and `make lint`), ask the user if questions arise.

- [x] 19. CDK stacks with template tests
  - [x] 19.1 Implement context and configuration validation `cloud/lib/context.ts`
    - Reads the notification e-mail, budget amount (number greater than 0) and budget e-mail
      (at most 254 characters, exactly one `@`) from CDK context; fails synthesis naming the key
      (R9.11, R19.4, R20.3); merges the tunable defaults of task 6.1. Add
      `cloud/cdk.context.example.json` with placeholder values only (`example.invalid`).
    - _Requirements: 9.10, 9.11, 19.3, 19.4, 20.2, 20.3, 27.2, 27.3_
  - [x] 19.2 Implement the pure device policy builder `cloud/lib/device-policy.ts`
    - Returns the policy document of the design: connect only for the attached thing and only
      `LastWill`, publish on `events` and `status`, subscribe on the `commands` topic filter,
      receive on `commands`; no `*` resource; only the four IoT actions.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_
  - [x] 19.3 Write property test for the device policy shape
    - **Property 21: Device policy shape**
    - Test file `cloud/test/prop-device-policy.test.ts`; generated region, account and thing
      placeholders; also unit assertions for R1.1 to R1.4 and R1.6.
    - **Validates: Requirements 1.5**
  - [x] 19.4 Implement `DataStack` and its template tests
    - Private S3 bucket (block public access, `enforceSSL`, SSE, lifecycle: `snapshots/` from
      config days default 3 and never above 7, `audio/` and `faces-staging/` 1 day), DynamoDB
      table `warashi` (on-demand, TTL attribute `ttl`, GSI1), Rekognition collections with the
      fixed ids `warashi-household` and `warashi-demo`, `RemovalPolicy.DESTROY` with
      auto-delete objects.
    - Template tests `cloud/test/data-stack.test.ts` (cite R11, R17.16, R19.7, R20.6).
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 17.16, 19.7, 19.8, 20.6_
  - [x] 19.5 Implement `JudgementStack` and its template tests
    - `DescribeEndpoint` custom resource for `iot:Data-ATS`, device policy from 19.2, the three
      topic rules with the exact SQL (including `topic(2) AS topicDeviceId`) and no rule on
      `commands`, `judge` and `ingest` functions (own roles, 0 async retries, max event age 60 s,
      15 s and 10 s timeouts, 512 MB, 14-day log groups), Lambda permissions with `SourceArn` and
      `SourceAccount`, SNS topic with the e-mail subscription from context, esbuild bundling.
    - Template tests `cloud/test/judgement-stack.test.ts` (cite R1.7 to R1.10, R4.6, R9.10).
    - _Requirements: 1.7, 1.8, 1.9, 1.10, 4.6, 9.10, 19.5, 20.7, 25.5_
  - [x] 19.6 Implement `ApiStack` and its template tests
    - Cognito user pool (self sign-up disabled, groups `family` and `reviewer`), public SPA app
      client, HTTP API with JWT authorizer on every route, `api-read` (no S3 permission, invoke on
      the signer only), `snapshot-signer`, `api-simulate`, `api-admin`, each with its own role as in
      the design Lambda table, CORS limited to the web origin, `POST /simulate` throttle of 2 per
      second and burst 5, 14-day log groups.
    - Template tests `cloud/test/api-stack.test.ts` (cite R13, R14.4, R14.12, R15.14). One test shows the
      `api-read` and `api-simulate` roles have no `s3:GetObject` on `snapshots/*`, the signer role
      is the only one with it, and `api-read` has only `lambda:InvokeFunction` on the signer.
    - _Requirements: 13.1, 13.2, 13.11, 14.4, 14.12, 15.4, 15.14, 20.7, 25.5_
  - [x] 19.7 Implement `WebStack` and its template tests
    - Private site bucket with CloudFront origin access control, HTTPS redirect, `index.html`
      fallback for 403 and 404, `BucketDeployment` of `dashboard/dist` when it exists or a
      one-page placeholder when it does not, `/config.json` with exactly `apiUrl`, `region`,
      `userPoolId`, `userPoolClientId`, `illustrationBase`, a cache lifetime of at most 60 s for it.
    - Resolve the reference cycle between `WebStack` (needs API and Cognito values) and `ApiStack`
      (needs the web origin for CORS) inside the five-stack layout of R19.1. Record the chosen
      resolution in `design.md`. If no resolution keeps R18.6 and R19.8 as written, stop and ask the
      owner before changing the requirement.
    - Template tests `cloud/test/web-stack.test.ts` (cite R18), including synthesis with and
      without `dashboard/dist`.
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9_
  - [x] 19.8 Implement `BudgetStack` and its template tests
    - One monthly cost budget with notifications at 50, 80 and 100 percent on actual spend to the
      budget e-mail; synthesis fails with the key name for a missing or invalid context value.
    - Template tests `cloud/test/budget-stack.test.ts` (cite R20.1 to R20.3).
    - _Requirements: 20.1, 20.2, 20.3_
  - [x] 19.9 Wire the app `cloud/bin/cloud.ts`, outputs, Region and runtime choice
    - Five stacks in dependency order in `ap-northeast-1`; the ten outputs of R19.2, each in
      exactly one stack; tag `project=zashiki-warashi` on everything; Lambda runtime `nodejs24.x`
      (or the newest offered LTS from task 1.2). Update the `design.md` Lambda table with
      `snapshot-signer` and record the runtime and Region choices (R19.5, R19.6).
    - _Requirements: 19.1, 19.2, 19.5, 19.6, 25.2_
  - [x] 19.10 Write cross-stack template tests in `cloud/test/app-template.test.ts`
    - Every taggable resource has the `project` tag; no IAM statement with resource `*` unless on a
      documented exception list (test names the role and action); no resource policy with
      `Principal: *`; every Lambda has its own role and a 14-day log group; no EC2, NAT gateway,
      RDS, ECS service, OpenSearch domain or provisioned DynamoDB table (names the resource type and
      logical id); outputs present and unique; runtime constant. Each test name cites its requirement.
    - _Requirements: 19.2, 19.5, 20.4, 20.5, 20.7, 25.2, 25.5, 25.6, 25.7, 26.4_

- [x] 20. Checkpoint - CDK
  - Ensure all tests pass (`make test` and `make lint`), `npx cdk synth` succeeds with the example
    context, ask the user if questions arise.

- [x] 21. Provisioning, voice and seeding scripts
  - [x] 21.1 Create `scripts/provision_device.sh`
    - Bash, `set -euo pipefail`, executable, AWS CLI v2 only (no `jq`). Arguments `--thing`,
      `--out`, `--policy`, `--region` (default `ap-northeast-1`), `--rotate`. `umask 077` before the
      first file, `--out` mode `0700`, key mode `0600`, refuse an `--out` inside a git work tree
      (symlinks resolved), idempotent thing, certificate, policy and attach steps, endpoint from
      `describe-endpoint --endpoint-type iot:Data-ATS`, Amazon Root CA 1 download, `warashi-aws.toml`
      with the nine keys, rotation that deactivates the old certificate only after both new
      attachments succeed, no key material on stdout, stderr or logs, usage message for missing
      arguments.
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8, 21.9, 21.10, 21.11_
  - [x] 21.2 Write tests for the provisioning script in `device/tests/test_provision_script.py`
    - Run the script with `bash` and stub `aws`, `curl` and `git` executables on `PATH` that record
      arguments: first run, second run creates nothing new, modes of the directory and key,
      `--out` inside a work tree refused with no AWS call, endpoint or CA failure leaves no
      `warashi-aws.toml`, rotation order and failure leaves the old certificate active, missing
      arguments, default Region, and a check that no stub output or script output contains key text.
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.6, 21.7, 21.8, 21.9, 21.10, 21.11_
  - [x] 21.3 Create `scripts/generate_voice_lines.py` with the Python WAV port
    - Reads `lines.toml` with `tomllib`, validates ids and text length (R22.8) before any Polly call,
      calls Polly (`Engine: neural`, voice from config default `Kazuha`, `pcm`, 16,000 Hz) with
      `boto3`, wraps the PCM with a Python `pcm16_to_wav`, writes `<id>.wav`, skips unchanged lines
      using a git-ignored hash sidecar, reports id and duration (0.1 s) or the skipped id, writes
      `cloud/lambda/_shared/voice-lines.json`, continues after a failed line without writing that
      line's files and exits non-zero at the end. Add the sidecar file to `.gitignore`.
    - _Requirements: 7.1, 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7, 22.8_
  - [x] 21.4 Write tests in `device/tests/test_generate_voice_lines.py`
    - With a fake Polly client: generation, skip on unchanged hash, regeneration on a text or voice
      change, a failed line keeps old files and the exit code is non-zero, empty response, missing
      credentials message, duplicate or empty id and over-long text stop before any call,
      `voice-lines.json` equals the parity test of task 10.7.
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.7, 22.8_
  - [x] 21.5 Write property test for the WAV wrapper (Python port)
    - **Property 17: WAV wrapper**
    - Test file `device/tests/test_prop_wav_port.py` (Hypothesis, at least 100 examples): header
      fields (RIFF/WAVE markers, format code 1, 1 channel, 16,000 Hz, 16 bits, data and file sizes)
      and data bytes identical to the input; odd length rejected. This is the Python half of
      Property 17; the TypeScript half is task 10.6.
    - **Validates: Requirements 7.10, 7.11, 22.6**
  - [x] 21.6 Create `scripts/seed_demo_collection.py` and its tests
    - Reads `samples/manifest.json` and the sample images from a local folder given by the owner,
      uploads them under `samples/` and indexes them into `warashi-demo` only (never the household
      collection), with the opaque id as `ExternalImageId`. The script is code only; the owner runs
      it (owner step O1). Test with fake `boto3` clients in `device/tests/test_seed_demo.py`: only
      the demo collection is used, manifest labels are validated, no names are written.
    - _Requirements: 15.1, 15.4, 25.3_

- [x] 22. Device `MqttCloudLink`
  - [x] 22.1 Add the typed `[aws]` configuration to `device/warashi_agent/config.py`
    - `AwsConfig` (`enabled`, `endpoint`, `port`, `ca_file`, `cert_file`, `key_file`,
      `keepalive_s`, `reconnect_min_s`, `reconnect_max_s`) parsed from the opaque `[aws]` table with
      violations in the existing `Violation` style; `enabled = false` skips file checks. Keep
      `device/config.example.toml` free of real values (comments only). Unit tests in
      `device/tests/test_config.py`.
    - _Requirements: 23.2, 23.3, 23.5_
  - [x] 22.2 Implement `MqttCloudLink` in `device/warashi_agent/adapters/cloud.py`
    - Implements the existing `CloudLink` protocol (`start(post)`, `publish(envelope)`, `stop()`)
      and posts only `InboundRaw`, `CloudConnected` and `CloudDisconnected` through `post`. A
      `MqttClientFactory` protocol and a thin real factory that imports `paho.mqtt.client` lazily
      (apt package only; paho callback API version 2, MQTT 3.1.1, `clean_session=True`, client id
      equal to the device id, TLS with the configured files, port 8883, keepalive 60). Last will
      `status.offline` on `warashi/<id>/status` at QoS 1 before connecting. A pure backoff helper
      that doubles from `reconnect_min_s` up to `reconnect_max_s` and resets on connect.
      `connect_async` plus `loop_start`, subscribe on every connect, `cloud.connected` only after the
      acknowledged subscription (10 s limit, else disconnect and retry), `cloud.disconnected` once
      per established connection, raw payload hand-off in under 50 ms, `publish` returns within
      50 ms and never raises, topic by type (`status.*` to `status`, others to `events`) at QoS 1,
      while disconnected drop `snapshot.captured` and other events and keep only the latest
      `status.report`, bounded queue of 32 messages, logging without payload content (use
      `format_envelope`), `stop` disconnects cleanly within 5 seconds and is idempotent.
      `LocalCloudLink` is unchanged.
    - _Requirements: 23.1, 23.3, 23.4, 23.5, 23.6, 23.7, 23.8, 23.9, 23.10, 23.11, 23.12, 23.13, 23.14, 23.16_
  - [x] 22.3 Write unit tests in `device/tests/test_mqtt_cloud_link.py`
    - With a fake `MqttClientFactory` and a manual clock, no network: connect options and will
      message, subscribe on every connect, connected and disconnected posting rules, subscription
      timeout, topic routing, drops while disconnected with log lines free of payload content,
      latest status kept and sent after reconnect, queue bound, publish failure swallowed, `stop`
      twice, no event after `stop`.
    - _Requirements: 23.3, 23.4, 23.6, 23.7, 23.8, 23.9, 23.10, 23.11, 23.12, 23.13, 23.14, 23.17_
  - [x] 22.4 Write property test for link safety
    - **Property 22: Link safety (Hypothesis, device)**
    - Test file `device/tests/test_prop_mqtt_link.py`; random sequences of connect, disconnect,
      publish of every envelope type and client failures against the fake client.
    - **Validates: Requirements 23.10, 23.12, 23.13**
  - [x] 22.5 Write property test for the backoff delay
    - Test file `device/tests/test_prop_mqtt_backoff.py` (Hypothesis, at least 100 examples,
      tagged `Feature: cloud-judgement, Backoff bounds (R23.17)`): for any valid
      `reconnect_min_s <= reconnect_max_s` the delay sequence never leaves the bounds, doubles until
      the maximum and resets to the minimum after a connect. This is the extra property that R23.17
      asks for; it is not one of the 22 numbered properties.
    - _Requirements: 23.5, 23.17_
  - [x] 22.6 Select the link in `__main__` and update the systemd unit
    - `device/warashi_agent/__main__.py`: `--fake` selects the fake link, `[aws].enabled = true`
      selects `MqttCloudLink`, otherwise `LocalCloudLink`. Update
      `device/systemd/warashi-agent.service` to `After=network-online.target time-sync.target
      sound.target` and `Wants=network-online.target time-sync.target`. Tests in
      `device/tests/test_cli.py` for the three selections and in `device/tests/test_repository.py`
      for the unit keys. `python3-paho-mqtt` stays the only new Pi package (apt only).
    - _Requirements: 23.2, 23.15, 23.16_
  - [x] 22.7 Create the bring-up script `device/tools/check_cloud.py`
    - Connects with the real link, publishes one `status.report`, waits up to 10 s for
      `cloud.connected` and for a command round trip, prints PASS or FAIL with the failed step
      (including the clock and certificate hints), and never prints key material. A unit test with
      the fake factory covers PASS and FAIL.
    - _Requirements: 23.3, 23.6, 23.17_

- [x] 23. Checkpoint - scripts and device
  - Ensure all tests pass (`make test` and `make lint`), `bash -n` passes for both shell scripts, ask
    the user if questions arise.

- [x] 24. Opt-in integration tests (never part of `make test`)
  - [x] 24.1 Write the judgement integration test and the latency harness
    - `cloud/test/integration/judgement.integration.test.ts`, using `describeIntegration`
      (`WARASHI_AWS_INTEGRATION=1`): publish a fixture `snapshot.captured` with a test device
      certificate or the IoT data plane, read the `judgement.result`, assert the contract, run at
      least 20 family-path and 20 stranger-path rounds, and print p50 and p95 against the targets of
      R6.7 (3 s and 4 s). It also logs the shape of the `cognito:groups` claim received by a
      deployed `api-read` (R27.4). Skipped, not failed, without the variable.
    - _Requirements: 6.7, 26.5, 27.4_
  - [x] 24.2 Write the speech and simulate integration test
    - `cloud/test/integration/simulate.integration.test.ts`: Nova Lite JSON line and Polly MP3 in
      Tokyo, then `POST /simulate` against the deployed API with a reviewer token and a seeded
      sample. Skipped without the variable.
    - _Requirements: 7.4, 7.8, 15.6, 26.5_

- [x] 25. Documentation, repository hygiene and the Kiro journal
  - [x] 25.1 Update `README.md` with the cloud sections
    - English text for: deployment (`npx cdk deploy --all` with `cdk.context.json` from the
      example), teardown (`npx cdk destroy --all`), confirming the SNS e-mail subscription within 48
      hours, the art-piece-not-an-alarm statement and that a photograph of a family member may be
      greeted as family, the largest-face limitation, provisioning and voice generation commands,
      the opt-in integration tests, and a pointer to the owner steps.
    - _Requirements: 5.17, 9.12, 19.7, 25.8_
  - [x] 25.2 Update `docs/architecture.md` and `docs/third-party.md`
    - Create `docs/architecture.md` if absent: the architecture and sequence diagrams of the design
      and the data flow. Add any adapted code or assets to `docs/third-party.md` with licenses
      (for example the Amazon Root CA download source).
    - _Requirements: 25.3_
  - [x] 25.3 Write the repository scan and documentation tests
    - `cloud/test/repo-scan.test.ts`: scan every git-tracked file (`git ls-files`) for certificates,
      private keys, tokens, account ids, ARNs with an account id, endpoint hosts, e-mail addresses,
      phone numbers, personal names and image files under sample or face paths; report path and
      line; a documented allow list covers `*.example`, `example.invalid` and fixtures with
      placeholder ids. A second test checks that the README holds the statements of R5.17, R9.12,
      R19.7 and R25.8, and that `cdk.context.json` is listed in `.gitignore`.
    - _Requirements: 19.3, 25.3, 25.4, 25.8_
  - [x] 25.4 Finalize `design.md`
    - Make sure the Lambda table matches the synthesized roles (including `snapshot-signer`), every
      limit, quota, model id and API shape has a citation or an "unverified" mark, the runtime and
      Region tables are complete, and open points A1 to A6 are marked as decided or still owner-open.
      Document the notification retry caveat of R9.8 (a failure reported after SNS accepted the
      message may cause one extra message) in Error Handling.
    - _Requirements: 9.8, 19.5, 19.6, 25.5, 27.4, 27.5_
  - [x] 25.5 Add the `docs/kiro-usage.md` journal entry
    - Append an English entry for the `cloud-judgement` spec: the design review that found C1 to
      C21, the AWS documentation checks done through the `aws-docs` MCP server, property-based
      testing choices, the reviewer isolation decision and the owner steps left.
    - _Requirements: 27.5_

- [x] 26. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass (`make test` and `make lint`) with no Pi, no AWS account and no
    credentials, `npx cdk synth` succeeds, and no test is skipped except the opt-in integration
    tests. Ask the user if questions arise.

## Owner and manual steps (not tasks, do not block the automated tasks)

- **O1. Demo collection seeding.** Provide consented sample portraits and
  `samples/manifest.json` (labels only, no names), upload them with the AWS CLI and run
  `scripts/seed_demo_collection.py` after deployment. Until then `POST /simulate` returns
  `validation_failed` for unknown samples and all automated tests still pass (A6, R15.1).
- **O2. E-mail confirmation.** Confirm the SNS subscription e-mail within 48 hours of the first
  deployment (R9.12). Provide the notification and budget e-mail addresses in the git-ignored
  `cdk.context.json` (A6).
- **O3. Listening test.** Compare Polly neural Kazuha with the alternatives (Tomoko, standard
  Mizuki with `pitch`) and choose the voice; the choice is configuration (design point C9, A2).
- **O4. Bedrock model access.** Confirm `amazon.nova-lite-v1:0` works in `ap-northeast-1`; use
  Claude Haiku 4.5 only after the Marketplace agreement (design point C10).
- **O5. AWS account steps.** Bootstrap CDK, run `npx cdk deploy --all`, create the Cognito family
  and reviewer users and put them in their groups.
- **O6. Integration runs.** Run the opt-in tests of task 24 with `WARASHI_AWS_INTEGRATION=1`, then
  record p95 latency, the `cognito:groups` claim form and Tokyo prices still marked "pending
  owner measurement" in `design.md` with date and source (R6.7, R27.4).
  Procedure for the judgement harness (task 24.1): provision a **test** thing with
  `scripts/provision_device.sh --thing <test-id> --out <folder outside the repository>`, then run
  `WARASHI_AWS_INTEGRATION=1 npx vitest --run test/integration` in `/cloud` with the variables
  listed in the header of `cloud/test/integration/judgement.integration.test.ts`
  (`WARASHI_IT_IOT_ENDPOINT`, `_DEVICE_ID`, `_CERT`, `_KEY`, `_CA`, `_FAMILY_JPEG`,
  `_STRANGER_JPEG`; optional `_API_URL`, `_FAMILY_TOKEN`, `_REVIEWER_TOKEN`). The harness prints p50
  and p95 for 20 rounds per path against 3 s and 4 s and writes the same numbers to the git-ignored
  `cloud/.integration-out/`. Copy value, date and source into the "pending owner measurement" items
  of `design.md`.
  - **`cognito:groups` form at the Lambda.** The harness logs the shape inside the issued tokens
    and checks that `GET /me` returns the right role. The form that API Gateway hands to
    `api-read` (array or string) cannot be seen from outside. Read it once: enable the HTTP API
    access log with the field `$context.authorizer.claims.cognito:groups`, or add a temporary
    `console.log(typeof claims["cognito:groups"])` to `api-read`, call `GET /me` with a family
    token, read CloudWatch Logs, then remove the change. Record the form in `design.md`.
  - **`AWS::Budgets::Budget` in `ap-northeast-1`.** Tests cannot confirm that CloudFormation accepts
    the resource in a Tokyo stack (noted in task 1.3). At the first `npx cdk deploy --all`, watch
    the `BudgetStack` events: `CREATE_COMPLETE` for the budget resource confirms it. Then run
    `aws budgets describe-budgets --account-id <your account id> --region us-east-1` (the Budgets
    API endpoint) and check that the monthly budget and its 50, 80 and 100 percent notifications
    exist. If the stack fails, record the error in `design.md` and move `BudgetStack` to
    `us-east-1` (the one stack allowed in another Region, with the reason documented).
- **O7. Provisioning and real-doll test.** Run `scripts/provision_device.sh` with an `--out`
  folder outside the repository, copy the files to the Pi with `scp`, run
  `device/tools/check_cloud.py` and then `scripts/deploy_pi.sh`. Test a family face, a stranger and
  an offline start on the real doll. Run `scripts/generate_voice_lines.py` with the owner's
  credentials (R22.5).
- **O8. Pi package check.** On the doll run `apt policy python3-paho-mqtt` and confirm the version 2
  callback API is available (task 1.1).

## Notes

- All sub-tasks, including every property-based test, are required. No sub-task is marked
  optional.
- Property to task map: P1 7.3, P2 7.4, P3 7.5, P4 7.6, P5 7.7, P6 8.3, P7 12.3, P8 14.4, P9 4.3,
  P10 4.4, P11 4.5, P12 13.3, P13 13.4, P14 9.5, P15 9.3, P16 9.7, P17 10.6 and 21.5 (two languages),
  P18 10.4, P19 10.2, P20 9.9, P21 19.3, P22 22.4.
- **Reviewer read isolation (A5, R14.4)** is decided in task 15.5 and checked by a template test in
  task 19.6: `api-read` has no S3 permission and a separate `snapshot-signer` function holds
  `s3:GetObject` on `snapshots/*` and refuses reviewer requests.
- **Notification retry caveat (A4, R9.8)** is implemented in tasks 12.1 and 12.3 (slot released only
  after a reported send failure, never after a success) and documented in task 25.4.
- **Web and API stack cycle.** Task 19.7 has to resolve the CORS origin and `config.json`
  dependency between `WebStack` and `ApiStack` without breaking the five-stack layout. This is the
  one place where the plan may need a decision from the owner.
- Tasks that need AWS pricing, latency or claim-shape measurements record "pending owner
  measurement" in `design.md` until step O6 (task 1.3).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3"] },
    { "id": 2, "tasks": ["2.1", "3.1"] },
    { "id": 3, "tasks": ["2.2", "3.2"] },
    { "id": 4, "tasks": ["3.3", "4.1"] },
    { "id": 5, "tasks": ["4.2", "4.3", "4.4", "4.5"] },
    { "id": 6, "tasks": ["5"] },
    { "id": 7, "tasks": ["6.1", "7.1", "9.1", "9.6", "9.8", "10.1", "10.5"] },
    { "id": 8, "tasks": ["6.2", "7.2", "7.3", "7.4", "7.5", "7.6", "7.7", "8.1", "9.2", "9.3", "9.4", "9.7", "9.9", "10.2", "10.3", "10.6"] },
    { "id": 9, "tasks": ["8.2", "8.3", "9.5", "9.10", "10.4", "10.7", "11.1"] },
    { "id": 10, "tasks": ["11.2", "11.4", "14.1", "15.1", "16.1", "16.3", "16.5", "16.7"] },
    { "id": 11, "tasks": ["11.3", "11.5", "12.1", "13.1", "14.2", "15.2", "15.3", "15.5", "15.7", "15.8", "16.2", "16.4", "16.6", "16.8"] },
    { "id": 12, "tasks": ["12.2", "12.3", "13.2", "13.3", "13.4", "14.3", "14.4", "15.4", "15.6", "15.9"] },
    { "id": 13, "tasks": ["17.1", "17.2", "17.3"] },
    { "id": 14, "tasks": ["17.4", "17.5"] },
    { "id": 15, "tasks": ["18"] },
    { "id": 16, "tasks": ["19.1", "19.2"] },
    { "id": 17, "tasks": ["19.3", "19.4", "19.7", "19.8"] },
    { "id": 18, "tasks": ["19.5", "19.6"] },
    { "id": 19, "tasks": ["19.9"] },
    { "id": 20, "tasks": ["19.10"] },
    { "id": 21, "tasks": ["20"] },
    { "id": 22, "tasks": ["21.1", "21.3", "21.6", "22.1"] },
    { "id": 23, "tasks": ["21.2", "21.4", "21.5", "22.2"] },
    { "id": 24, "tasks": ["22.3", "22.4", "22.5", "22.6", "22.7"] },
    { "id": 25, "tasks": ["23"] },
    { "id": 26, "tasks": ["24.1", "24.2"] },
    { "id": 27, "tasks": ["25.1", "25.2", "25.4", "25.5"] },
    { "id": 28, "tasks": ["25.3"] },
    { "id": 29, "tasks": ["26"] }
  ]
}
```
