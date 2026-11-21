# Implementation Plan: dashboard-simulation

## Overview

The dashboard is built from the inside out. The contract changes (S1, S2) and the clarifications (Q1 to Q4) come first, because `docs/schema.md` changes before any producer or consumer. The cloud-side items X1 to X3 are cross-spec tasks that the dashboard depends on. Then the pure core in `dashboard/src/simulation/` is built with its property tests: codec, config, head tracker, machine, world, engine, plans, privacy, timeline and the small pure helpers. The shell libraries (API client, sign-in, audio, roles, service worker) follow. React components, pages and the scenario runner come after a checkpoint. The four scenario component tests, the role-view tests, the README "Reviewer quick start" and the owner-check list close the plan.

Language: TypeScript (strict), as in the design. Test tools: vitest, Testing Library, fast-check.

Conventions used by every task:

- Property tests are required tasks (no `*`). Each property has its own sub-task and its own file `dashboard/test/prop/<name>.prop.test.ts`, tagged `Feature: dashboard-simulation, Property N: <text>`, with at least 100 runs.
- Property tests share generators and the scenario driver from `dashboard/test/helpers/` (task 7.2).
- Nothing in `src/simulation/` imports React or touches DOM, timers, network, `Date` or `Math.random` (eslint override from task 3.1).
- Tasks marked **Cross-spec** change files owned by another spec. They are listed here so the dashboard is not blocked silently; coordinate them with `.kiro/specs/cloud-judgement/tasks.md`.

## Tasks

- [x] 1. Contract and requirement changes first
  - [x] 1.1 Apply schema change S1 to `docs/schema.md`
    - In the `GET /me` route text, state that `consentNoticeVersion` names a notice text bundled by the dashboard under `dashboard/src/content/consent/<version>.md`, and that the cloud and the dashboard are released together when the version changes.
    - Add the reason in the same style as the other schema notes.
    - _Requirements: 15.3_
  - [x] 1.2 Apply schema change S2 to `docs/schema.md`
    - In `POST /commands` and "Shared definitions", state that the voice-line catalog is the device's `voice/lines.toml` (ids, categories, `ja`, `en`), that `scripts/export_voice_catalog.py` copies it to the dashboard, and that the cloud's `lineId` check uses the same ids.
    - Update the status block at the top of the file to name `dashboard-simulation` as the design that added S1 and S2. `v` stays 1.
    - _Requirements: 14.1, 8.1_
  - [x] 1.3 Apply requirement clarifications Q1 to Q4 to `.kiro/specs/dashboard-simulation/requirements.md`
    - Q1 (12.5): the engine receives the `judgement.result` as an input command and uses the `lineId` of the `speak` as the line the doll says.
    - Q2 (2.3): "Scenario_Script" is a `ScenarioPlan` plus the engine's world rules, and `network_down` has no `snapshot.captured`.
    - Q3 (3.3): `nobody_there` makes four snapshots before `uncertain` with reason `no_face`.
    - Q4 (6.8): between two consecutive states pan and tilt change by at most one step (default 1°, never above 2°), and not at all when less than `glideIntervalMs` has passed.
    - _Requirements: 2.3, 3.3, 6.8, 12.5_

- [x] 2. Cloud-side dependencies (Cross-spec, `cloud-judgement`)
  - [x] 2.1 X1: allow password sign-in on the public app client
    - In `cloud/lib` (`ApiStack`), set `authFlows.userPassword: true` on the public SPA app client, keep it without a client secret, and set no Cognito domain.
    - Update the CDK assertion test for the app client.
    - Cross-spec: `cloud-judgement` owns this file. Note the change in its `design.md` and `tasks.md`.
    - _Requirements: 11.1_
  - [x] 2.2 X2: CORS rule on the data bucket for browser uploads
    - In `cloud/lib` (`DataStack`), add a bucket CORS rule: `AllowedOrigins` the CloudFront origin of the dashboard, `AllowedMethods` `POST`, `AllowedHeaders` `*`.
    - Update the CDK assertion test. Never use `*` as the allowed origin.
    - Cross-spec: `cloud-judgement` owns this file.
    - _Requirements: 15.5_
  - [x] 2.3 X3: `POST /simulate` response fixtures
    - Create `docs/fixtures/simulate-v1/family.json`, `stranger.json` and `no_face.json`, shaped like a successful `POST /simulate` response of `docs/schema.md` (with `commands` envelopes using `deviceId: "warashi-sim"` and `encounterId: null`). They contain no name and no image data.
    - Add a short note in `docs/schema.md` ("Fixtures and contract checks") that these files exist and are checked by the dashboard tests (task 5.2) and by the cloud tests.
    - Cross-spec: the cloud tests of `cloud-judgement` should assert that `/simulate` output matches the same shape.
    - _Requirements: 2.2, 3.6_

- [x] 3. Dashboard project scaffold
  - [x] 3.1 Create the `dashboard/` project
    - Create `package.json`, `vite.config.ts`, `tsconfig.json` (strict), `eslint.config.js`, `index.html`, `src/main.tsx` placeholder and the vitest setup (jsdom, Testing Library, fast-check).
    - Dependencies: `react`, `react-dom`. Dev: `vite`, `typescript`, `vitest`, `@testing-library/react`, `@testing-library/user-event`, `jsdom`, `fast-check`, `eslint`, `typescript-eslint`. Add one line in `.kiro/steering/tech.md` or `structure.md` only if a dependency is not already named there.
    - In `eslint.config.js`, add an override for `src/simulation/**` that forbids imports of `react`, `react-dom`, `src/lib`, `src/hooks`, `src/components`, and forbids the globals `window`, `document`, `fetch`, `setTimeout`, `setInterval`, `Date`, `performance`, `localStorage` and `Math.random`.
    - Add the vitest `test/` folders (`test/prop`, `test/helpers`, `test/components`).
    - _Requirements: 5.1, 20.8, 20.9_
  - [x] 3.2 Wire the dashboard into `make test` and `make lint`
    - Update the root `Makefile`: `make test` runs `vitest --run` in `dashboard/` and `python scripts/export_voice_catalog.py --check`; `make lint` runs eslint and `tsc --noEmit` in `dashboard/`.
    - _Requirements: 20.9_

- [x] 4. Schema_Codec
  - [x] 4.1 Implement `src/simulation/types.ts` message types and `codec.ts`
    - Define `SchemaMessage` as a discriminated union with one member per event, command and status type of `docs/schema.md`, plus `State`, `Reason`, `ErrorCode` and the Encounter, StatusReportData and Speech types.
    - Implement `decodeText`, `decodeValue`, `encode` and `ALL_TYPES`, with the rule order and rule names of the design (size, json, not_object, version_type, unsupported_version, missing_field, wrong_type, non_finite, bad_enum, speak_source, unknown_type). Drop undefined `data` fields on decode.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - [x] 4.2 Write property test for the codec round trip
    - **Property 1: Codec round trip**
    - **Validates: Requirements 4.2, 4.5, 4.6**
  - [x] 4.3 Write property test for codec rejection of each broken rule
    - **Property 2: Codec rejects each broken rule with its name**
    - **Validates: Requirements 4.3, 4.4**
  - [x] 4.4 Write the fixture check
    - Decode every file in `docs/fixtures/schema-v1/` to `valid` and re-encode to an equal value (key order ignored).
    - Parse the type lists from the tables of `docs/schema.md` and fail, naming the type or file, when a type has no fixture or a fixture has no type.
    - _Requirements: 4.7, 4.8, 20.5_

- [x] 5. Bundled data: voice catalog and sample responses
  - [x] 5.1 Create `scripts/export_voice_catalog.py` and the catalog
    - Read `device/warashi_agent/voice/lines.toml` with `tomllib`; write `dashboard/src/simulation/data/voice-catalog.json` (`id`, `category`, `ja`, `en`, `durationMs`, `audio`) and copy WAV files to `dashboard/public/audio/<id>.wav` (using `wave` for the duration). A line without a WAV file gets `audio: null`.
    - Add `--check`: regenerate in memory, fail when the committed catalog differs or a `lines.toml` id is missing. Standard library only.
    - Add a pytest for the script in `device/tests/` or `scripts/tests/` (no hardware needed).
    - _Requirements: 8.1, 8.5, 14.1, 18.5_
  - [x] 5.2 Bundle the Sample_Responses and test them
    - Copy the three fixtures of task 2.3 into `dashboard/src/simulation/data/sample-responses/` (the test compares them with `docs/fixtures/simulate-v1/` so they cannot drift).
    - Test that each response decodes, its `commands` decode to `valid`, `confidence` is in 0..1, face boxes are within 0..1, and none contains a name.
    - _Requirements: 2.2, 3.6, 19.1_

- [x] 6. Pure simulation engine
  - [x] 6.1 Implement engine types, `config.ts` and `rng.ts`
    - In `types.ts` add `DeviceState`, `EyeState`, `VerdictLabel`, `ScenarioPlan`, `PlannedVerdict`, `Input`, `InternalEvent`, `Output`, `SimState`, `Phase`.
    - `config.ts`: `DEFAULT_CONFIG` and `validateConfig` (limits above ±60°/±30°, step above 2°, interval below 30 ms, or cooldown below `glideTimeoutS + lanternFadeOutMs / 1000` fall back to the default).
    - `rng.ts`: mulberry32 `next(state) -> [value, state]`, a pure UUID v4 builder from four draws, and a pure ISO-8601 UTC formatter for epoch milliseconds (no `Date`).
    - _Requirements: 5.1, 6.2, 4.9_
  - [x] 6.2 Write property test for unsafe configuration fallback
    - **Property 8: Unsafe configuration falls back to the defaults**
    - **Validates: Requirements 6.2**
  - [x] 6.3 Implement `head.ts`
    - `pan = clamp(snapshotPan + (cx − 0.5) × hfov)` and `tilt = clamp(snapshotTilt + (0.5 − cy) × vfov)`, `hfov` 54, `vfov` 41.8, mirroring `device-core-loop`.
    - Add a golden table test (corner and center faces) shared with the device's head tracker expectations.
    - _Requirements: 6.1, 3.1_
  - [x] 6.4 Implement `machine.ts`
    - The device state machine with the states, edges and reasons of `docs/schema.md`: accept rule (confidence 0.80), scan attempts (three moves at -15°, 15°, 0°), silent stare before the stranger line, `on_speak` rules (`unknown_line`, `speak_rejected`, `audio_busy`, `command_rejected_state`), `mode.set sleep` to `cooldown` with reason `manual`, reaction line choice (plan line id if permitted, else sorted-by-id choice from `state.rng`), one `reaction.performed` per encounter.
    - A single `enter(state, to, reason)` helper reads `from` from the state before the change.
    - Subtitle text comes from the catalog, except a `family` line that passes `safeLineText`.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 5.4, 5.6, 5.7, 6.6, 8.1, 9.1_
  - [x] 6.5 Implement `world.ts`
    - Motion model: one step at most per call, only when `now − lastStepAt ≥ glideIntervalMs`, step `min(glideStepDeg, remaining)`, clamp after each step, targets clamped when set, emit `servo.arrived` when both axes reach the target.
    - Lantern model: linear fade from `from` to target over `fadeMs`, recomputed from `now`.
    - Responders: `snapshot.ready` after `cameraDelayMs`, `judgement.result` after `verdictDelayMs` when the cloud is up, nothing when it is down.
    - _Requirements: 6.1, 6.3, 6.5, 3.4_
  - [x] 6.6 Implement `engine.ts` (`initialState`, `step`)
    - Compose decode, dedup (last 256 ids), dispatch, motion, lantern, responders and the bounded (16 rounds) feedback loop. Emit envelopes with `v` 1, UUID `id`, UTC `ts`, `deviceId` `warashi-sim`, `encounterId` set from `presence.detected` to `encounter.ended`, `null` for `status.report`.
    - A malformed command gives one `error.reported` (`malformed_message`) and no other change; `unsupported_version` and `wrong_device` likewise. The `stop` user action equals `mode.set sleep`. `start` while `running` is ignored.
    - Only contract messages appear in `Output.message`; device-internal events never do.
    - _Requirements: 2.2, 2.5, 2.6, 2.7, 2.8, 4.9, 5.2, 5.3, 5.5, 6.4, 6.5, 8.7_
  - [x] 6.7 Write property test for engine determinism
    - **Property 3: Engine determinism**
    - **Validates: Requirements 5.2**
  - [x] 6.8 Write property test for ignored inputs
    - **Property 4: Ignored inputs change nothing**
    - **Validates: Requirements 2.8, 5.4, 5.5**
  - [x] 6.9 Write property test for state change consistency
    - **Property 5: State changes are consistent and follow the schema**
    - Parse the "Reason mapping" table of `docs/schema.md` in the test to build the allowed (`from`, `to`, `reason`) set.
    - **Validates: Requirements 3.5, 5.6, 5.7**
  - [x] 6.10 Write property test for head limits
    - **Property 6: Head angles stay inside the limits**
    - Include `gaze` with any finite double (for example 1e300) and non-finite values.
    - **Validates: Requirements 6.1, 6.4, 6.7**
  - [x] 6.11 Write property test for slow motion
    - **Property 7: Motion is slow**
    - **Validates: Requirements 6.3, 6.8**
  - [x] 6.12 Write property test for renderable state
    - **Property 9: The state is always renderable**
    - **Validates: Requirements 7.1, 7.5, 8.7**
  - [x] 6.13 Write property test for envelope validity
    - **Property 10: Every emitted message is a valid, well-formed envelope**
    - **Validates: Requirements 4.9, 4.10**

- [x] 7. Scenario plans and scenario properties
  - [x] 7.1 Implement `plans.ts`
    - `planFromResponse(scenario, response)` and the four plan builders (`family_home`, `stranger_night`, `nobody_there` with four `no_face` attempts, `network_down` with `cloud: "down"`), the `buildJudgementEnvelope` helper that creates a fresh `id` and the engine's current `snapshotId` (D5), and the scenario-to-sample label mapping.
    - Use `safeLineText` for every displayed line text (D6).
    - _Requirements: 2.1, 2.2, 3.1, 3.2, 3.3, 3.4, 12.3, 12.5_
  - [x] 7.2 Create shared test helpers in `dashboard/test/helpers/`
    - fast-check generators: `arbSeed`, `arbScenario`, `arbTickGap`, `arbEnvelope`, `arbFiniteAngle`, `arbCommand` (valid and malformed), `arbInput`, `arbLabels`.
    - `drive(plan, seed, gap, options)`: ticks every `gap` ms, answers each `audio.play` with `audio.finished` after `durationHintMs ?? 3000`, stops when the engine is `sleeping` with `running` false or after 130 simulated seconds, and returns states, outputs and messages.
    - _Requirements: 20.1, 20.2, 20.4_
  - [x] 7.3 Write property test for scenario completion
    - **Property 11: A scenario completes in order and returns to rest**
    - **Validates: Requirements 2.3, 2.4, 3.1, 3.3, 3.4, 3.7, 6.5**
  - [x] 7.4 Write property test for the silent stare
    - **Property 12: A stranger line never comes before the silent stare**
    - **Validates: Requirements 3.2**
  - [x] 7.5 Write property test for stopping
    - **Property 13: Stopping always ends the encounter cleanly**
    - **Validates: Requirements 2.6, 6.6**
  - [x] 7.6 Write property test for plan fidelity
    - **Property 18: The plan keeps the response's verdict**
    - **Validates: Requirements 12.5**

- [x] 8. Privacy
  - [x] 8.1 Implement `privacy.ts`
    - `containsLabel` (case-insensitive substring, empty labels ignored), `safeLineText` (catalog text for every verdict except `family`; for `family` the response text only if non-empty, at most 200 characters), and `scrubMessages`.
    - _Requirements: 9.1, 9.2, 9.3, 9.4_
  - [x] 8.2 Write property test for family labels in scenarios
    - **Property 14: Scenarios never reveal a family label**
    - **Validates: Requirements 9.1, 9.2, 9.3**
  - [x] 8.3 Write property test for Live results
    - **Property 15: Live results cannot smuggle text for non-family verdicts**
    - **Validates: Requirements 9.4**

- [x] 9. Pure helpers: timeline, controls, indicator, faces, doll label
  - [x] 9.1 Implement `timeline.ts`
    - `compareEncounters` (`startedAt` descending, `encounterId` ascending), `sortEncounters`, `insertSimulated` (cap 50, oldest dropped), `buildSimEncounter` (verdict, confidence, reaction kind, line, `notified` for a stranger reaction, `mode`).
    - _Requirements: 10.1, 10.2, 10.4, 10.12_
  - [x] 9.2 Write property test for timeline order
    - **Property 16: Timeline order is total and stable**
    - **Validates: Requirements 10.2, 10.3**
  - [x] 9.3 Write property test for timeline insertion
    - **Property 17: Inserting keeps the existing order and the 50-entry cap**
    - **Validates: Requirements 10.4, 10.12**
  - [x] 9.4 Implement `controls.ts`
    - `buildCommand` for `speak` (only `lineId`), `look` (pan ±20, tilt 0), `lantern` (level 0..1, `fadeMs` integer 0..10000) and `mode`; non-finite numbers become 0.
    - _Requirements: 14.2, 14.3, 14.4, 14.11_
  - [x] 9.5 Write property test for command ranges
    - **Property 20: Manual commands stay inside the documented ranges**
    - **Validates: Requirements 14.3, 14.4**
  - [x] 9.6 Implement `indicator.ts`
    - `indicatorView(StatusFetch)` with the four views and the exact texts of the design.
    - _Requirements: 13.5, 13.6, 13.7, 13.8_
  - [x] 9.7 Write property test for the privacy indicator
    - **Property 19: The privacy indicator never claims "off" without evidence**
    - **Validates: Requirements 13.5, 13.6, 13.7, 13.8**
  - [x] 9.8 Implement `faces.ts` helpers
    - `validateFaceFile({ type, size })` (JPEG or PNG, at most 5,000,000 bytes, reason otherwise) and `canRegister(consent, displayName)` (name length 1..40 Unicode code points).
    - _Requirements: 15.4, 15.6_
  - [x] 9.9 Write property test for face file rules
    - **Property 21: Face file rules**
    - **Validates: Requirements 15.6**
  - [x] 9.10 Write property test for the registration gate
    - **Property 22: Registration is enabled only with consent and a valid name**
    - **Validates: Requirements 15.4**
  - [x] 9.11 Implement `doll-label.ts`
    - `dollLabel(state)` with the device state, `left` / `ahead` / `right` (ahead within ±2°) and `dark` / `dim` / `bright`.
    - _Requirements: 17.6_
  - [x] 9.12 Write property test for the doll's text alternative
    - **Property 26: The doll's text alternative follows its state**
    - **Validates: Requirements 17.6**

- [x] 11. Shell libraries (no React)
  - [x] 11.1 Implement `src/lib/api.ts`
    - `createApiClient` with all routes of `docs/schema.md`, bearer token on every call, 10 s abort through an injected timer, error parsing, `mapErrorCode` (unknown code to `internal`), `Retry-After` clamped to 1..86,400 (60 when missing), success-body guards, `Result` return type, no `console`, no throw.
    - Return `unauthorized` without a request when there is no token.
    - _Requirements: 10.6, 10.7, 11.3, 12.8, 19.4, 19.6, 19.7, 19.8_
  - [x] 11.2 Write property test for error code mapping
    - **Property 23: API error codes map to a known code**
    - **Validates: Requirements 19.7**
  - [x] 11.3 Write property test for the bearer token
    - **Property 24: Every API call carries the bearer token**
    - **Validates: Requirements 11.3**
  - [x]* 11.4 Write unit tests for the API client
    - Timeout at 10 s with fake timers, `Retry-After` parsing, body guard failure becomes `internal`, `console` spy sees nothing, `cursor` passing for "Show older".
    - _Requirements: 10.6, 12.8, 19.4, 19.8_
  - [x] 11.5 Implement `src/lib/auth.ts` and `src/lib/settings.ts`
    - `Session` with `USER_PASSWORD_AUTH` through `fetch` (`Content-Type: application/x-amz-json-1.1`, `X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth`), token and expiry in a closure only, refresh and ID tokens discarded, a `ChallengeName` gives `needs_setup`, near-expiry (60 s) behaves as `401`, `signOut` clears the session.
    - `settings.ts`: load `/config.json`, validate `apiUrl`, `region`, `userPoolId`, `userPoolClientId`, `illustrationBase`; a failure returns a typed "unavailable" result.
    - _Requirements: 1.6, 11.1, 11.2, 11.5, 11.7, 11.8_
  - [x]* 11.6 Write unit tests for sign-in
    - Documented request shape, token kept in memory only (spies on `localStorage`, `sessionStorage`, `document.cookie`, `history`, `console`), challenge gives the setup message, password cleared.
    - _Requirements: 9.5, 11.1, 11.7_
  - [x] 11.7 Implement `src/lib/audio.ts`
    - `AudioPlayer` with `unlock` (silent 1-sample WAV inside a gesture), `play`, `stop`, `setMuted`. Muted or missing source waits `max(minHoldMs, 3000)` then calls `finished`; blocked or rejected playback calls `failed`; exactly one callback per request. Also a `FakePlayer` with a manual clock in `test/helpers/`.
    - _Requirements: 8.1, 8.2, 8.4, 8.5, 8.6, 8.7_
  - [x] 11.8 Write property test for subtitle hold time
    - **Property 25: Subtitles stay visible long enough**
    - **Validates: Requirements 8.1, 8.5**
  - [x] 11.9 Implement `roles.ts`, `router.ts` and `clock.ts` in `src/lib/`
    - `capabilities(role)` as in the design; a hash router (`#/`, `#/house`, `#/timeline`, `#/family`); an injectable clock.
    - _Requirements: 11.4, 16.1, 16.5_
  - [x] 11.10 Implement the service worker
    - `public/sw.js`: pre-cache `/`, `/audio/*`, `/illustrations/*`, `/fonts/*` from a list generated by a small Vite plugin; accept resource URLs posted after `load`; cache-first for same-origin GET of cached files; network-first for `/config.json`; never touch cross-origin requests.
    - `src/lib/sw-register.ts`: register only on `https:` or `localhost`; ignore failures silently.
    - _Requirements: 19.1, 19.2_

- [x] 10. Checkpoint - pure core and shell libraries
  - Ensure all tests pass (`make test`, `make lint`), ask the user if questions arise.

- [x] 12. React shell
  - [x] 12.1 Add copy, design tokens, fonts and third-party list
    - `src/content/copy.ts` with every fixed UI string used by the requirements; `tokens.css` (washi, sumi, indigo night, andon amber); self-hosted Shippori Mincho subset (OFL) in `public/fonts/`; `public/illustrations/silhouette-{family,stranger,none,uncertain}.svg` (original artwork); `docs/third-party.md` entries for fonts and audio.
    - _Requirements: 10.9, 18.3, 18.4, 18.5_
  - [x] 12.2 Implement `VirtualDoll`, `Subtitle` and `LiveRegion`
    - Original SVG and CSS: room, body, head group, four eye shapes, lantern glow with separate transitions for head, eyes and glow. Under Reduced_Motion draw the target values, lantern change within 100 ms, no looping animation. `role="img"` with `dollLabel`. Polite live region for each subtitle and state label.
    - Render the `greeting` pose for a real `conversing` state.
    - _Requirements: 7.2, 7.3, 7.4, 17.3, 17.5, 17.6, 17.7_
  - [x] 12.3 Implement `useScenarioRunner`
    - Tick every 50 ms with the injected clock, call `engine.step`, forward `audio.play` / `audio.stop` outputs to the player and feed `audio.finished` / `audio.failed` back, keep `SimState`, append the finished encounter with `insertSimulated`, catch engine exceptions for the error boundary, unlock audio inside the click handler.
    - _Requirements: 2.2, 2.5, 2.7, 8.4, 8.5, 8.6, 8.7, 10.1_
  - [x] 12.7 Implement `Locked` and `ControlPanel`
    - `Locked`: `aria-disabled="true"`, focusable, explanation linked by `aria-describedby`, no handler that can reach the API.
    - `ControlPanel`: line selector from the catalog (id, Japanese, English), "Look left", "Look right", lantern level and fade, "Put the doll to sleep", "Wake the guard"; one `POST /commands` per activation, control disabled while pending, the messages of Requirement 14, no automatic retry. Reviewer and visitor see the same controls as Locked_Controls.
    - _Requirements: 14.1, 14.2, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10, 14.11, 16.1, 16.2_
  - [x] 12.5 Implement `ScenarioPanel` and the House page
    - Four buttons with the exact labels, disabled while running, "Stop" while running, the visible verdict label, state label, subtitle and the Virtual_Doll in one view at 360 px.
    - _Requirements: 1.2, 1.3, 2.1, 2.5, 2.6, 2.7, 3.7, 18.2_
  - [x] 12.6 Implement `PrivacyIndicator`, `DevicePanel` and `useDeviceStatus`
    - Indicator from `indicatorView` with symbol and text, outside the error boundary's replaceable area. Device panel texts of Requirement 13, `motionEnabled` notice, polling on open and every 30 s while `document.visibilityState` is visible, visitor sees a Locked panel.
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.9, 13.10, 16.5_
  - [x] 12.8 Implement the Timeline components and page
    - Separate "Simulated" and "Real" lists, `limit` 20 with "Show older" using `nextCursor`, encounter detail with events in time order and reasons, family thumbnail or "Snapshot expired", reviewer silhouette from `illustrationBase`, "No visits yet", the hidden-visits message, "The doll's story could not be loaded" with "Try again", and "Family notified (simulated, nothing was sent)".
    - _Requirements: 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11, 16.3, 16.4_
  - [x] 12.9 Implement the Family page and consent content
    - `src/content/consent/<version>.md` for the version named by the cloud, member list without face ids, consent notice with an unticked checkbox, upload sequence (`faceUpload`, `FormData` with the pre-signed fields first and `file` last, `faceRegister`), 422 and 409 handling, delete dialog naming the member, file and preview discarded after each operation, the privacy sentence, out-of-date notice handling, Locked view for reviewer and visitor.
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 15.10, 15.11, 16.1_
  - [x] 12.4 Add Live cloud mode
    - Extend `useScenarioRunner` and the House page: the "Live cloud" switch (signed-in only, off by default), `GET /samples` lookup, `POST /simulate` with `generate`, the "Generate a new line" tick, the plan from the response, MP3 playback after a gesture and while sound is on, step durations labelled as measured in the browser, the "Live cloud" label on the encounter, the 429 and 10 s timeout messages with an offer to run in Simulation_Mode, no Timeline entry on failure, and "No cloud call: the network is down" for `network_down`.
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11_
  - [x] 12.10 Implement the app shell, Landing page and error boundary
    - `main.tsx` and `App.tsx`: header with role label and always-visible Mute_Control and Privacy_Indicator, Landing page (two-sentence legend, kanji title with reading and translation, "Enter the house", separate "Sign in"), sign-in form, sign-out, 401 and 403 handling, offline banner, `ErrorBoundary` with "The doll lost her thread. Reload to start again.", config failure behaviour, service worker registration, responsive layout from 360 px to 1920 px.
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 8.3, 11.5, 11.6, 11.8, 11.9, 17.1, 18.1, 19.3, 19.5_

- [x] 13. Component tests
  - [x] 13.1 Write the `family_home` scenario component test
    - Render, click the button, advance fake time in 50 ms steps with the fake player, assert the state labels in order, the verdict label "Family", the Japanese and English subtitle and the new simulated Timeline entry.
    - _Requirements: 20.6, 2.1, 3.1, 3.7_
  - [x] 13.2 Write the `stranger_night` scenario component test
    - Same assertions with verdict "Stranger", no subtitle during the stare, and "Family notified" with the simulated note.
    - _Requirements: 20.6, 3.2, 3.7, 10.1_
  - [x] 13.3 Write the `nobody_there` scenario component test
    - Same assertions with verdict "No face" and the `uncertain` line.
    - _Requirements: 20.6, 3.3, 3.7_
  - [x] 13.4 Write the `network_down` scenario component test
    - Same assertions with verdict "Offline", no snapshot step and no API call.
    - _Requirements: 20.6, 3.4, 3.7_
  - [x] 13.5 Write the role-view component tests
    - Visitor: all real-doll parts locked with "Sign in to see the real doll.". Reviewer: Locked_Controls with `aria-disabled`, silhouette instead of snapshot, no face box or member data, no `/faces` and no `POST /commands` request. Family: thumbnail, enabled Control_Panel. Use `FakeApiClient`.
    - _Requirements: 20.7, 14.9, 14.10, 15.2, 16.1, 16.2, 16.3, 16.5_
  - [x] 13.6 Write the Privacy_Indicator component test
    - Assert each of the five texts once: simulation, unknown, off, camera on, microphone on.
    - _Requirements: 20.7, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9_
  - [x]* 13.7 Write Live cloud component tests
    - No `simulate` call while the switch is off; one call with `generate: false` and the right `sampleId` when on; `generate: true` when ticked; no call for `network_down`; 429 and timeout messages; a failed run adds no Timeline entry.
    - _Requirements: 12.2, 12.3, 12.4, 12.6, 12.8, 12.9_
  - [x]* 13.8 Write Family page component tests
    - Upload sequence with `file` last, consent gate, 422 and 409 paths, delete dialog, `URL.revokeObjectURL` after an operation.
    - _Requirements: 15.4, 15.5, 15.7, 15.8, 15.9, 15.10_
  - [x]* 13.9 Write Device panel and controls tests
    - Polling on open and every 30 s while visible, online and offline texts, `motionEnabled` notice, one `POST /commands` per control, `202` messages with `deviceOnline` true and false, control disabled while pending.
    - _Requirements: 13.1, 13.2, 13.3, 13.10, 14.2, 14.5, 14.6, 14.8_
  - [x]* 13.10 Write reduced-motion, offline and error-boundary tests
    - Reduced_Motion draws targets and shows no looping animation while the same plan and seed emit the same messages; `navigator.onLine` false shows the banner, disables Live cloud, controls and face actions, and all four scenarios still run; a throwing child shows the recovery text and keeps the header, Mute_Control and Privacy_Indicator.
    - _Requirements: 17.3, 17.4, 19.1, 19.3, 19.5_
  - [x]* 13.11 Write static checks
    - Grep `src/simulation/` for forbidden imports and globals; grep `src/` for `fetch(` outside `lib/api.ts`, `lib/auth.ts` and the S3 upload helper; WCAG contrast of every token pair (4.5:1 normal, 3:1 large); every file in `public/fonts` and `public/audio` is named in `docs/third-party.md`; every catalog line has non-empty `ja` and `en`.
    - _Requirements: 5.1, 17.2, 18.4, 18.5, 19.6_

- [x] 14. Checkpoint - dashboard complete
  - Ensure all tests pass (`make test`, `make lint`), ask the user if questions arise.

- [x] 15. Documentation
  - [x] 15.1 Write the README "Reviewer quick start"
    - In `README.md`, add the section with the exact clicks for each of the four scenarios, the Live cloud switch and the demo sign-in, and what the reviewer should see for each. State that no hardware and no account are needed for the simulation, that the demo account is read-only, and that all four scenarios take under two minutes.
    - Put no secret, account id, host name, personal name or demo credential in the README; the credentials go to the Devpost text only.
    - _Requirements: 20.10, 20.11, 20.12, 20.13_
  - [x] 15.2 Write the owner-check list `docs/dashboard-owner-checks.md`
    - A checklist of the manual and unverified items from the design, each with the expected result and a place to record the outcome: first `InitiateAuth` from the deployed origin (content type and CORS, D16); real upload to the pre-signed S3 POST with the `file` field last; audio unlock on iOS Safari (D10); service worker offline after one load in Chrome and Safari; layout from 360 px to 1920 px with one vertical scroll to the subtitle at 360 px; keyboard-only use and visible focus; a screen reader pass over one scenario; no flashing above 3 per second and no sudden loud sound; X1 and X2 confirmed in the deployed stack.
    - _Requirements: 8.4, 15.5, 17.1, 17.5, 17.8, 18.1, 18.2, 19.2_

- [x] 16. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional example tests and can be skipped for a faster MVP. Every property-based test, the four scenario component tests, the role-view tests, the Privacy_Indicator test and the README section are required.
- Each of the 26 design properties has exactly one task: P1 4.2, P2 4.3, P3 6.7, P4 6.8, P5 6.9, P6 6.10, P7 6.11, P8 6.2, P9 6.12, P10 6.13, P11 7.3, P12 7.4, P13 7.5, P14 8.2, P15 8.3, P16 9.2, P17 9.3, P18 7.6, P19 9.7, P20 9.5, P21 9.9, P22 9.10, P23 11.2, P24 11.3, P25 11.8, P26 9.12. The design groups several properties in one test file; this plan gives each its own file so parallel tasks never write the same file.
- Section 10 (checkpoint) sits after section 11 on purpose: it gates the React work on a green pure core and green shell libraries. Section numbers are labels, not the order. The dependency graph is the order.
- Cross-spec dependencies: X1 and X2 (tasks 2.1, 2.2) edit `cloud-judgement` stacks, and X3 (task 2.3) adds fixtures that its tests should also check. The dashboard cannot sign in or upload faces against a deployed stack until X1 and X2 are deployed. Simulation_Mode needs none of them.
- Owner checks (task 15.2) cannot be done by a coding agent: they need a deployed stack, a real browser or a phone. They are unverified in the design and must not be reported as passed until the owner records the result.
- Items verified or unverified in the design (Cognito content type, S3 form field order, iOS Safari audio unlock) are listed in `design.md` under "Verified facts".

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3", "2.1", "2.2", "2.3", "3.1"] },
    { "id": 1, "tasks": ["1.2", "3.2", "4.1", "9.8"] },
    { "id": 2, "tasks": ["4.2", "4.3", "4.4", "5.1", "5.2", "6.1", "8.1", "9.1", "9.4", "9.6", "9.9", "9.10", "11.1", "11.5", "11.7", "11.9", "11.10"] },
    { "id": 3, "tasks": ["6.2", "6.3", "6.5", "7.1", "9.2", "9.3", "9.5", "9.7", "9.11", "11.2", "11.3", "11.4", "11.6", "11.8"] },
    { "id": 4, "tasks": ["6.4", "9.12"] },
    { "id": 5, "tasks": ["6.6"] },
    { "id": 6, "tasks": ["7.2"] },
    { "id": 7, "tasks": ["6.7", "6.8", "6.9", "6.10", "6.11", "6.12", "6.13", "7.3", "7.4", "7.5", "7.6", "8.2", "8.3"] },
    { "id": 8, "tasks": ["10"] },
    { "id": 9, "tasks": ["12.1"] },
    { "id": 10, "tasks": ["12.2", "12.3", "12.7"] },
    { "id": 11, "tasks": ["12.5", "12.6", "12.8", "12.9"] },
    { "id": 12, "tasks": ["12.4", "12.10"] },
    { "id": 13, "tasks": ["13.1", "13.2", "13.3", "13.4", "13.5", "13.6", "13.7", "13.8", "13.9", "13.10", "13.11"] },
    { "id": 14, "tasks": ["14"] },
    { "id": 15, "tasks": ["15.1", "15.2"] },
    { "id": 16, "tasks": ["16"] }
  ]
}
```
