# Requirements Document

## Introduction

`dashboard-simulation` is the web application (`/dashboard`) that reviewers and the family open. A visitor with no hardware and no account can experience the whole product in under two minutes: a virtual doll in a dim Japanese room reacts to four scenarios with the same events and commands as the real doll (`docs/schema.md`). Signed-in users add a "Live cloud" mode, the timeline of real encounters, a device panel, manual controls for the real doll and, for the family only, face registration. A persistent privacy indicator shows whether the real doll's camera or microphone is active.

The simulation engine is a pure reducer over schema messages, so it is property-testable. This spec covers the dashboard only. The message contract, the HTTP API and the roles are defined by `docs/schema.md` and the `cloud-judgement` spec; this spec consumes them and changes neither. Live voice conversation is out of scope and belongs to `voice-conversation`.

### Assumptions and defaults

- The Simulation_Mode default needs no network after the first load. Bundled sample responses stand in for the cloud.
- Audio for cached lines is bundled as WAV or MP3 files created by `scripts/generate_voice_lines.py`. If a bundled audio file is absent, the line is shown as subtitles only.
- Angle limits in the simulation equal the device defaults: pan ±30° and tilt ±20°, and never exceed the hard limits pan ±60° and tilt ±30°.
- Head motion in the simulation uses the device rule: at most 2° per step and at least 30 ms between steps.
- Scenario timings use the device defaults of `device-core-loop`; the Scenario_Script constants are listed in the design.
- The default device id for the real doll is `warashi-01`. The simulation uses `warashi-sim`.

## Glossary

- **Dashboard**: The React + Vite + TypeScript web application in `/dashboard`.
- **Doll**: The physical zashiki-warashi device running `warashi-agent`.
- **Virtual_Doll**: The SVG/CSS artwork in the Dashboard that shows head pan, head tilt, eyes and lantern glow, each animated independently.
- **Simulation_Engine**: The pure TypeScript module in `src/simulation/` with no React imports. It exports `step(state, input, now)` returning the next state and a list of outputs.
- **Sim_State**: The state held by the Simulation_Engine: device state, pan, tilt, lantern level, eye state, current subtitle, mode, and the Timeline entries of the running scenario.
- **Scenario**: One of four scripted runs: `family_home`, `stranger_night`, `nobody_there`, `network_down`.
- **Scenario_Script**: A `ScenarioPlan` (the ordered, timed inputs that one Scenario feeds into the Simulation_Engine) plus the world rules of the Simulation_Engine that answer those inputs.
- **Schema_Message**: An Envelope defined in `docs/schema.md` (event, command or status), with the field names and types of the contract.
- **Schema_Codec**: The TypeScript module that decodes and encodes Schema_Messages. It mirrors `docs/schema.md`.
- **Fixture_Set**: The golden messages in `docs/fixtures/schema-v1/`.
- **Simulation_Mode**: The default mode. Scenarios run in the browser with Sample_Responses and no network call.
- **Sample_Response**: A bundled JSON object shaped like a successful `POST /simulate` response, one per Scenario.
- **Live_Cloud_Mode**: The mode in which a Scenario calls `POST /simulate` on the API and uses the real response.
- **Landing_Screen**: The first screen. It tells the legend and offers "Enter the house".
- **Timeline**: The list of Encounter records, newest first. Simulated encounters and real encounters are shown in separate, labelled lists.
- **Encounter**: An Encounter record as defined in `docs/schema.md`.
- **Device_Panel**: The panel that shows the real Doll's online state, `state`, head angles, lantern level and last seen time from `GET /device/status`.
- **Control_Panel**: The panel with manual controls for the real Doll (speak a cached line, look left or right, lantern).
- **Family_Page**: The page for listing, registering and deleting faces.
- **Privacy_Indicator**: The persistent element that shows `cameraActive` and `micActive`.
- **API_Client**: The single typed TypeScript module that calls the HTTP API of `docs/schema.md`.
- **Config_File**: `/config.json` served from the Dashboard's own origin, with `apiUrl`, `region`, `userPoolId`, `userPoolClientId` and `illustrationBase`.
- **Role**: `family`, `reviewer` or `visitor` (not signed in), as returned by `GET /me` or assumed for no session.
- **Locked_Control**: A control that is visible, not operable, and shows a one-line explanation.
- **Mute_Control**: The always-visible control that switches all sound on or off.
- **Reduced_Motion**: The browser setting `prefers-reduced-motion: reduce`.
- **Family_Label**: A registered member's `displayName` or any other label that identifies a family member.
- **Test_Suite**: The vitest, Testing Library and fast-check tests of `/dashboard`, run by `make test`.

## Requirements

### Requirement 1: Landing screen and entry

**User Story:** As a visitor, I want a short legend and one obvious button, so that I reach the virtual doll within two clicks.

#### Acceptance Criteria

1. WHEN the Dashboard loads with no session, THE Landing_Screen SHALL show the legend of the zashiki-warashi in exactly two sentences, a title in kanji with its reading and English translation, and a button labelled "Enter the house".
2. WHEN the visitor activates "Enter the house", THE Dashboard SHALL show the Simulation_Mode view with the Virtual_Doll in its room and the four Scenario buttons.
3. THE Dashboard SHALL let a visitor reach the Simulation_Mode view and complete one Scenario without sign-in.
4. THE Landing_Screen SHALL offer a "Sign in" action that is separate from "Enter the house".
5. WHEN the visitor activates "Enter the house", THE Dashboard SHALL treat the activation as the user gesture that permits sound.
6. IF the Config_File cannot be loaded, THEN THE Dashboard SHALL keep Simulation_Mode available and SHALL hide the "Sign in" action and Live_Cloud_Mode with the message "Cloud features are unavailable right now".

### Requirement 2: Scenario buttons and Scenario scripts

**User Story:** As a reviewer, I want four buttons that each play one complete story, so that I see every doll reaction in under two minutes.

#### Acceptance Criteria

1. THE Simulation_Mode view SHALL show four buttons labelled "A family member comes home", "A stranger enters at night", "Something moves, but no one is there" and "The network is down", mapped to `family_home`, `stranger_night`, `nobody_there` and `network_down`.
2. WHEN a Scenario button is activated and no Scenario is running, THE Simulation_Engine SHALL start the Scenario_Script of that Scenario from the state `sleeping`.
3. THE Scenario_Script of each Scenario SHALL contain, in this order: `presence.detected`, a state change to `waking`, a lantern fade-in, a head turn, `snapshot.captured`, the verdict step, the reaction, `reaction.performed`, `encounter.ended`, and a return to `sleeping`. The Scenario `network_down` SHALL contain no `snapshot.captured` and no verdict step. A Scenario_Script is a `ScenarioPlan` (the ordered, timed inputs of the Scenario) together with the world rules of the Simulation_Engine (how the engine answers those inputs).
4. THE Scenario_Script of each Scenario SHALL complete within 120 seconds of simulated time at normal speed.
5. WHILE a Scenario is running, THE Dashboard SHALL disable the four Scenario buttons and show a "Stop" button.
6. WHEN the "Stop" button is activated, THE Simulation_Engine SHALL end the Scenario with `encounter.ended` of reason `manual`, return the Virtual_Doll to center and `sleeping`, and re-enable the Scenario buttons.
7. WHEN a Scenario ends normally, THE Dashboard SHALL re-enable the four Scenario buttons.
8. IF a Scenario button is activated while a Scenario is running, THEN THE Simulation_Engine SHALL ignore the input and leave the Sim_State unchanged.

### Requirement 3: Scenario content

**User Story:** As a reviewer, I want each scenario to show the behaviour that matches its name, so that I understand what the doll does in each situation.

#### Acceptance Criteria

1. WHEN `family_home` runs, THE Simulation_Engine SHALL emit a `judgement.result` with verdict `family`, state changes `sleeping`, `waking`, `seeking`, `gazing`, `greeting`, `cooldown`, `sleeping` in that order, and a `reaction.performed` of kind `family` with `offline` false.
2. WHEN `stranger_night` runs, THE Simulation_Engine SHALL emit a `judgement.result` with verdict `stranger`, a silent stare phase with no `speak` before the stranger line, a `reaction.performed` of kind `stranger` with `offline` false, and a Timeline entry that shows "Family notified".
3. WHEN `nobody_there` runs, THE Simulation_Engine SHALL emit a `judgement.result` with verdict `no_face` and `face` of `null`, four snapshots in total before the state change from `seeking` to `uncertain` with reason `no_face`, then a state change to `cooldown`, and a `reaction.performed` of kind `uncertain`.
4. WHEN `network_down` runs, THE Simulation_Engine SHALL emit `cloud.disconnected` as a device-internal input, SHALL emit no `snapshot.captured` and no `judgement.result`, SHALL change state to `uncertain` with reason `offline`, and SHALL emit a `reaction.performed` of kind `uncertain` with `offline` true.
5. THE Simulation_Engine SHALL use the state names, the `state.changed` reasons and the reason mapping of `docs/schema.md`.
6. WHEN a Scenario produces a verdict, THE Simulation_Engine SHALL set `confidence` to a number from 0 to 1 and, for `family` and `stranger`, a `face` box with `left`, `top`, `width` and `height` from 0 to 1.
7. THE Dashboard SHALL show the scenario's verdict as a visible text label: "Family", "Stranger", "No face", "Uncertain" or "Offline".

### Requirement 4: Schema fidelity and the Schema_Codec

**User Story:** As the owner, I want the simulation to speak the same messages as the real system, so that the dashboard cannot drift from the contract.

#### Acceptance Criteria

1. THE Schema_Codec SHALL define TypeScript types for every event, command and status type listed in `docs/schema.md`, with the same field names and value sets.
2. WHEN the Schema_Codec decodes a message that follows `docs/schema.md`, THE Schema_Codec SHALL return a valid Schema_Message.
3. IF a message breaks a rule of `docs/schema.md` (size above 131,072 bytes, invalid JSON, `v` that is not an integer of at least 1, a missing field, a wrong type, a value outside an enumeration, a non-finite number, or a `speak` without exactly one of `lineId` and `audioUrl`), THEN THE Schema_Codec SHALL return a malformed result that names the first failing rule.
4. IF a message has `v` greater than 1, THEN THE Schema_Codec SHALL return an unsupported-version result and no message.
5. THE Schema_Codec SHALL encode a valid Schema_Message to JSON.
6. FOR ALL valid Schema_Messages, decoding the encoding of the message SHALL produce a value equal to the original message, ignoring key order (round-trip property).
7. FOR ALL files in the Fixture_Set, THE Test_Suite SHALL decode the file to a valid Schema_Message and SHALL re-encode the message to a value equal to the file content, ignoring key order.
8. IF a message type listed in `docs/schema.md` has no file in the Fixture_Set, or a file has no matching type, THEN THE Test_Suite SHALL fail and name the type or file.
9. WHEN the Simulation_Engine emits a Schema_Message, THE Simulation_Engine SHALL emit an Envelope with `v` 1, a UUID `id`, a `ts` in UTC ISO 8601 with milliseconds, `deviceId` `warashi-sim`, and an `encounterId` that is a UUID from `presence.detected` to `encounter.ended` and `null` otherwise, except that `status.report` carries `null`.
10. FOR ALL Scenarios and all input times, every Schema_Message that the Simulation_Engine emits SHALL decode to valid with the Schema_Codec.

### Requirement 5: Pure simulation engine

**User Story:** As a developer, I want the simulation to be a pure function of its inputs, so that every behaviour is reproducible and property-testable.

#### Acceptance Criteria

1. THE Simulation_Engine SHALL contain no React import, no DOM access, no network call and no timer; the current time and any random value SHALL be passed in as arguments.
2. FOR ALL Sim_States and inputs, THE Simulation_Engine SHALL return the same next state and outputs when called twice with equal arguments (determinism).
3. THE Simulation_Engine SHALL accept as input a `tick`, a Schema_Message command, a device-internal input (`servo.arrived`, `audio.finished`, `audio.failed`, `snapshot.ready`, `snapshot.failed`, `cloud.connected`, `cloud.disconnected`, `pir.rising`) or a user action (start Scenario, stop).
4. IF the Simulation_Engine receives an input that is not defined for the current state, THEN THE Simulation_Engine SHALL return the state unchanged and SHALL emit no `state.changed`.
5. IF the Simulation_Engine receives a command with a duplicate `id` among the last 256 accepted ids, THEN THE Simulation_Engine SHALL drop the command without a state change and without an `error.reported`.
6. WHEN the Simulation_Engine changes the device state, THE Simulation_Engine SHALL emit one `state.changed` with `from`, `to` and the `reason` given by the reason mapping of `docs/schema.md`.
7. FOR ALL sequences of valid inputs, every `state.changed` that the Simulation_Engine emits SHALL have a `from` equal to the Sim_State device state before the input and a `to` equal to the device state after the input.

### Requirement 6: Head limits and slow motion

**User Story:** As a reviewer, I want the virtual head to move like the real one, so that the simulation shows the real constraints.

#### Acceptance Criteria

1. THE Simulation_Engine SHALL clamp every target pan angle to the range of the pan limit (default ±30°) and every target tilt angle to the range of the tilt limit (default ±20°) before the angle reaches the Sim_State.
2. IF a configured limit exceeds ±60° pan or ±30° tilt, THEN THE Simulation_Engine SHALL reject the configuration and use the defaults.
3. WHEN the Simulation_Engine moves the head, THE Simulation_Engine SHALL change pan and tilt by at most 2° per motion step and SHALL space motion steps at least 30 ms apart.
4. IF a `gaze` command carries a non-finite angle, THEN THE Simulation_Engine SHALL treat the command as malformed, SHALL leave the head unchanged and SHALL emit `error.reported` with code `malformed_message`.
5. WHEN an encounter ends, THE Simulation_Engine SHALL move the head to center (pan 0°, tilt 0°) with the same step rule and SHALL then emit `servo.arrived`.
6. WHEN the Simulation_Engine receives `mode.set` with `sleep` during an encounter, THE Simulation_Engine SHALL end the encounter with state change reason `manual`.
7. FOR ALL sequences of commands and ticks, including `gaze` commands with any finite angles, THE Sim_State pan SHALL stay within the pan limit and THE Sim_State tilt SHALL stay within the tilt limit after every input.
8. FOR ALL sequences of ticks, the absolute change of pan and of tilt between two consecutive Sim_States SHALL be at most one step (default 1°, never above 2°), and SHALL be 0 when less than `glideIntervalMs` (at least 30 ms) has passed between the two states.

### Requirement 7: Renderable state

**User Story:** As a reviewer, I want the virtual doll to always be drawn correctly, so that no input leaves a broken or blank screen.

#### Acceptance Criteria

1. FOR ALL sequences of inputs, THE Sim_State SHALL have a device state that is one of `sleeping`, `waking`, `seeking`, `gazing`, `greeting`, `warning`, `uncertain` or `cooldown`, a finite pan and tilt, a lantern level from 0 to 1, an eye state from a defined set, and a subtitle that is `null` or a pair of non-empty Japanese and English strings.
2. WHEN the Virtual_Doll receives a Sim_State, THE Virtual_Doll SHALL render the head at the pan and tilt of the Sim_State, the eyes at the eye state, and the lantern glow at the lantern level, each with its own animation.
3. IF the Dashboard receives a `conversing` state from a real `status.report`, THEN THE Device_Panel SHALL show the state name and THE Virtual_Doll SHALL render the `greeting` pose.
4. THE Virtual_Doll SHALL be drawn with original SVG and CSS artwork in a traditional Japanese style.
5. WHILE the Sim_State device state is `sleeping`, THE Virtual_Doll SHALL show the lantern level 0 and the eyes closed.

### Requirement 8: Voice lines and subtitles

**User Story:** As a reviewer, I want every spoken line shown in Japanese with an English subtitle, so that I follow the story without sound.

#### Acceptance Criteria

1. WHEN the Simulation_Engine accepts a `speak` command, THE Dashboard SHALL show the `ja` text and the `en` subtitle together while the line plays, and for at least 3 seconds if no audio plays.
2. WHILE the Mute_Control is on, THE Dashboard SHALL play no sound and SHALL still show subtitles.
3. THE Dashboard SHALL show the Mute_Control on every view and keep the Mute_Control reachable by keyboard.
4. THE Dashboard SHALL start no audio before a user gesture has occurred.
5. IF the browser blocks audio playback or the audio file is missing, THEN THE Dashboard SHALL show the subtitle, SHALL emit `audio.failed` to the Simulation_Engine, and SHALL let the Scenario continue.
6. WHEN audio playback ends, THE Dashboard SHALL send `audio.finished` to the Simulation_Engine.
7. WHEN a Scenario ends, THE Dashboard SHALL stop any playing audio and clear the subtitle within 1 second.

### Requirement 9: Privacy of labels in simulation

**User Story:** As a family member, I want no family label to appear in a non-family scenario, so that the simulation shows the same privacy rule as the real system.

#### Acceptance Criteria

1. FOR ALL Scenarios whose verdict is `stranger`, `no_face` or `uncertain`, and for the offline Scenario, THE Simulation_Engine outputs, the Sim_State and the Timeline entries SHALL contain no Family_Label as a substring, compared case-insensitively.
2. FOR ALL Scenarios, every `judgement.result`, `status.report` and event emitted by the Simulation_Engine SHALL contain no Family_Label.
3. WHERE a Scenario has the verdict `family`, THE Simulation_Engine MAY include a family nickname in the text of a `speak` command only.
4. WHEN the Dashboard builds a Live_Cloud_Mode result for a Scenario whose verdict is not `family`, THE Dashboard SHALL discard any `speak` text, subtitle or Timeline field that contains a Family_Label and SHALL show the cached line text instead.
5. THE Dashboard SHALL NOT store a Family_Label in `localStorage`, `sessionStorage`, cookies or logs.

### Requirement 10: Timeline

**User Story:** As a family member or reviewer, I want one ordered list of encounters with the verdict and the spoken line, so that I can read what the doll did.

#### Acceptance Criteria

1. WHEN a Scenario ends, THE Dashboard SHALL add one Encounter to the simulated list of the Timeline with start time, end time, verdict, confidence, reaction kind, line in Japanese and in English, and whether the family was notified.
2. THE Timeline SHALL order Encounters by `startedAt` descending, and by `encounterId` ascending for equal `startedAt`.
3. FOR ALL lists of Encounters, sorting the list twice, or sorting a permutation of the list, SHALL produce the same order (stable ordering property).
4. FOR ALL Timeline lists and any insertion of a new Encounter, THE Timeline SHALL keep the relative order of the existing entries unchanged.
5. THE Timeline SHALL show the simulated list and the real list under separate headings and SHALL NOT mix a simulated Encounter into the real list.
6. WHEN a signed-in user opens the real list, THE API_Client SHALL call `GET /encounters` with `limit` 20 and SHALL call again with the returned `nextCursor` when the user activates "Show older".
7. WHEN the user opens an Encounter, THE API_Client SHALL call `GET /encounters/{id}` and THE Dashboard SHALL show its events in time order, each with its `state.changed` reason where present.
8. WHILE the user's Role is `family`, THE Dashboard SHALL show the `snapshot.url` thumbnail of an Encounter when the field is not `null`, and SHALL show "Snapshot expired" when the field is `null`.
9. WHILE the user's Role is `reviewer`, THE Dashboard SHALL show the silhouette named by `illustration` loaded from `illustrationBase` and SHALL show no real image and no face box.
10. IF the real list is empty, THEN THE Dashboard SHALL show "No visits yet".
11. IF a request for the real list fails, THEN THE Dashboard SHALL show "The doll's story could not be loaded" with a "Try again" action and SHALL keep the simulated list visible.
12. THE Dashboard SHALL keep at most 50 simulated Encounters in memory and SHALL drop the oldest first.

### Requirement 11: Sign-in and roles

**User Story:** As a reviewer or family member, I want to sign in once and see only what my role allows, so that the home stays private.

#### Acceptance Criteria

1. WHEN the user activates "Sign in", THE Dashboard SHALL start the Cognito sign-in with the `userPoolId` and `userPoolClientId` from the Config_File.
2. WHEN sign-in succeeds, THE API_Client SHALL call `GET /me` and THE Dashboard SHALL use the returned `role` as the Role.
3. THE API_Client SHALL send the access token as `Authorization: Bearer <token>` on every API call.
4. THE Dashboard SHALL NOT decide the Role from anything other than the `role` of `GET /me`.
5. IF an API call returns `401 unauthorized`, THEN THE Dashboard SHALL discard the session, SHALL return to Simulation_Mode as a visitor, and SHALL show "Please sign in again".
6. IF an API call returns `403 forbidden`, THEN THE Dashboard SHALL show "This is someone's home. That area is closed to guests." and SHALL leave the rest of the view unchanged.
7. THE Dashboard SHALL store the access token in memory only or in the storage defined by the design, and SHALL NOT write the token to logs or to the URL.
8. WHEN the user activates "Sign out", THE Dashboard SHALL discard the session and the cached real Encounters and SHALL return to Simulation_Mode as a visitor.
9. THE Dashboard SHALL show the Role as "Guest", "Reviewer" or "Family" in the header.

### Requirement 12: Live cloud mode

**User Story:** As a signed-in reviewer, I want to run the same scenarios through the real backend and see how long each step took, so that I can judge the cloud side.

#### Acceptance Criteria

1. WHERE the user is signed in, THE Dashboard SHALL show a "Live cloud" switch that is off by default.
2. WHILE the "Live cloud" switch is off, THE Dashboard SHALL call no `POST /simulate`.
3. WHILE the "Live cloud" switch is on and a Scenario with a sample (`family_home`, `stranger_night`, `nobody_there`) starts, THE API_Client SHALL call `POST /simulate` with the `sampleId` of that Scenario and `generate` false.
4. WHERE the Role is `family` or `reviewer` and the user ticks "Generate a new line", THE API_Client SHALL send `generate` true.
5. WHEN `POST /simulate` returns 200, THE Simulation_Engine SHALL receive the `judgement.result` and `speak` from `commands` as input commands in the returned order, SHALL take the verdict from the `judgement.result` input command, SHALL use the `lineId` of the `speak` as the line the doll says, and THE Dashboard SHALL show the returned `latencyMs.total` and `latencyMs.search` in milliseconds.
6. WHEN the Scenario is `network_down` and the "Live cloud" switch is on, THE Dashboard SHALL run the offline Scenario without a call and SHALL show "No cloud call: the network is down".
7. WHEN `speech.mp3Url` is not `null`, THE Dashboard SHALL play the MP3 only after a user gesture and while the Mute_Control is off, and SHALL show the `ja` and `en` text of the `speech`.
8. IF `POST /simulate` returns `429 rate_limited`, THEN THE Dashboard SHALL show "The cloud needs a rest. Try again in N seconds." with N from `Retry-After`, SHALL NOT retry automatically, and SHALL offer to run the Scenario in Simulation_Mode.
9. IF `POST /simulate` returns any other error or the request does not finish within 10 seconds, THEN THE Dashboard SHALL show "The cloud did not answer", SHALL leave no partial Encounter in the Timeline, and SHALL offer to run the Scenario in Simulation_Mode.
10. THE Dashboard SHALL show for each step of a Live_Cloud_Mode run its name and its duration, and SHALL label the durations as measured in the browser.
11. WHEN a Scenario runs in Live_Cloud_Mode, THE Dashboard SHALL label the Encounter in the simulated list "Live cloud".

### Requirement 13: Device panel and privacy indicator

**User Story:** As a family member or reviewer, I want to see whether the real doll is online and whether its camera or microphone is active, so that I know what the doll is doing.

#### Acceptance Criteria

1. WHERE the user is signed in, THE API_Client SHALL call `GET /device/status` with `deviceId` `warashi-01` when the view opens and every 30 seconds while the page is visible.
2. WHEN `GET /device/status` returns `online` true, THE Device_Panel SHALL show "Awake", the `state`, `panDeg`, `tiltDeg`, `lantern` and the `lastSeenAt` time.
3. WHEN `GET /device/status` returns `online` false, THE Device_Panel SHALL show "The doll is asleep or out of reach" and the `lastSeenAt` time or "never seen" when `lastSeenAt` is `null`.
4. THE Privacy_Indicator SHALL be visible on every view, signed in or not.
5. WHILE the Dashboard has no `status` from the real Doll (visitor, or `status` is `null`), THE Privacy_Indicator SHALL show "Simulation: no real camera or microphone is in use".
6. WHILE `status.cameraActive` is true, THE Privacy_Indicator SHALL show "Camera on" with a visible symbol, and WHILE `status.micActive` is true, THE Privacy_Indicator SHALL show "Microphone on" with a visible symbol.
7. WHILE `status.cameraActive` is false and `status.micActive` is false, THE Privacy_Indicator SHALL show "Camera off, microphone off".
8. IF `GET /device/status` fails or the doll is offline, THEN THE Privacy_Indicator SHALL show "Camera and microphone state unknown" instead of "off".
9. THE Privacy_Indicator SHALL use a text label together with any color or symbol.
10. IF `motionEnabled` is false in the status, THEN THE Device_Panel SHALL show "Motion is switched off on the doll".

### Requirement 14: Controls for the real doll

**User Story:** As a family member, I want to call the real doll within safe limits, so that I can speak, look and light the lantern from the app.

#### Acceptance Criteria

1. WHERE the Role is `family`, THE Control_Panel SHALL offer: a selector of cached line ids with its Japanese text and English subtitle, "Look left", "Look right", and a lantern level control with a fade time.
2. WHEN the user activates a control, THE API_Client SHALL call `POST /commands` once with `deviceId` `warashi-01` and the command of that control, and `speak` SHALL carry only a `lineId`.
3. THE Control_Panel SHALL limit "Look left" and "Look right" to `panDeg` within -30 to 30 and `tiltDeg` within -20 to 0 to 20, and SHALL never send values beyond -60..60 pan or -30..30 tilt.
4. THE Control_Panel SHALL limit the lantern `level` to 0..1 and `fadeMs` to 0..10000.
5. WHEN `POST /commands` returns `202` with `deviceOnline` true, THE Dashboard SHALL show "Sent to the doll".
6. WHEN `POST /commands` returns `202` with `deviceOnline` false, THE Dashboard SHALL show "The doll is offline. The command was not stored and will not play later."
7. IF `POST /commands` returns `400`, `500` or the request fails, THEN THE Dashboard SHALL show the failure with a "Try again" action and SHALL NOT retry automatically.
8. WHILE a `POST /commands` request is pending, THE Control_Panel SHALL disable the control that sent the request.
9. WHERE the Role is `reviewer` or the user is a visitor, THE Control_Panel SHALL show the same controls as Locked_Controls with the line "This is someone's home. Only the family can call the doll."
10. WHILE a Locked_Control is shown, THE API_Client SHALL send no `POST /commands`.
11. WHERE the Role is `family`, THE Control_Panel SHALL show a "Put the doll to sleep" and a "Wake the guard" control that send `mode.set` with `sleep` and `guard`.

### Requirement 15: Family page and face registration

**User Story:** As a family member, I want to register or delete a face with a clear consent notice, so that the doll knows family and respects privacy.

#### Acceptance Criteria

1. WHERE the Role is `family`, THE Family_Page SHALL list members from `GET /faces` with `displayName`, `faceCount` and `createdAt`, and SHALL show no face id.
2. WHERE the Role is `reviewer` or the user is a visitor, THE Dashboard SHALL show the Family_Page link and content as Locked_Controls with the line "This is someone's home. Only the family can manage faces." and SHALL send no request to a `/faces` route.
3. WHEN the user starts a registration, THE Family_Page SHALL show the consent notice for `consentNoticeVersion` from `GET /me` and a checkbox that is unticked by default.
4. WHILE the consent checkbox is unticked or `displayName` is outside 1 to 40 characters, THE Family_Page SHALL keep the "Register" action disabled.
5. WHEN the user submits a registration, THE API_Client SHALL call `POST /faces/upload`, upload the file (JPEG or PNG of at most 5,000,000 bytes) to the returned URL, and call `POST /faces` with the `stagingKey`, `displayName`, `memberId` (or `null`) and `consent` of `{ noticeVersion, accepted: true }`.
6. IF the chosen file is not a JPEG or PNG, or is larger than 5,000,000 bytes, THEN THE Family_Page SHALL show the reason and SHALL make no API call.
7. IF `POST /faces` returns `422 face_count_invalid`, THEN THE Family_Page SHALL show "The photo must show exactly one face."
8. IF `POST /faces` returns `409 consent_required`, THEN THE Family_Page SHALL reload `GET /me` and ask for consent again.
9. WHEN the user activates "Delete" for a member and confirms in a dialog that names the member, THE API_Client SHALL call `DELETE /faces/{memberId}` and THE Family_Page SHALL remove the member from the list on `204`.
10. WHEN a registration or deletion ends, THE Family_Page SHALL discard the selected file and its preview from memory.
11. THE Family_Page SHALL show the sentence "Faces are stored only in your AWS account and can be deleted at any time."

### Requirement 16: Locked controls and role presentation

**User Story:** As a reviewer, I want to see what the family can do and why I cannot, so that I understand the product without touching someone's home.

#### Acceptance Criteria

1. WHERE the Role is `reviewer`, THE Dashboard SHALL show the Control_Panel and the Family_Page as Locked_Controls, each with a one-line explanation.
2. WHILE a Locked_Control is shown, THE Dashboard SHALL mark the control with `aria-disabled="true"` and SHALL keep the explanation reachable by keyboard focus.
3. WHERE the Role is `reviewer`, THE Dashboard SHALL show no real snapshot, face box, member name or image reference of any kind.
4. WHEN a reviewer's `GET /encounters` result is empty or returns `404 not_found` because the owner hid real visits, THE Dashboard SHALL show "The owner has hidden real visits from guests. Try the scenarios instead."
5. WHILE the user is a visitor, THE Dashboard SHALL show the Device_Panel, the real Timeline list, the Control_Panel and the Family_Page as Locked_Controls with the line "Sign in to see the real doll."

### Requirement 17: Accessibility and motion

**User Story:** As a user of any ability, I want to use the app by keyboard, with captions and without forced motion, so that everyone can follow the story.

#### Acceptance Criteria

1. THE Dashboard SHALL make every interactive element operable by keyboard with a visible focus indicator.
2. THE Dashboard SHALL give normal text a contrast ratio of at least 4.5:1 and large text at least 3:1 against its background (WCAG AA).
3. WHILE Reduced_Motion is set, THE Virtual_Doll SHALL move the head to its target in one step per target change without a glide, SHALL replace lantern fades with a change over at most 100 ms, and SHALL show no looping animation.
4. WHILE Reduced_Motion is set, THE Simulation_Engine SHALL still emit the same Schema_Messages in the same order as without Reduced_Motion.
5. THE Dashboard SHALL announce each new subtitle and each state change label to assistive technology through an ARIA live region with polite priority.
6. THE Dashboard SHALL give the Virtual_Doll an accessible name and a text alternative that states the current state, pan direction and lantern level.
7. THE Dashboard SHALL present captions for all audio.
8. THE Dashboard SHALL use no flashing content above 3 flashes per second and no sudden loud sound.

### Requirement 18: Responsive layout and look

**User Story:** As a reviewer on any device, I want a quiet, readable layout, so that the story works on a laptop and on a phone.

#### Acceptance Criteria

1. THE Dashboard SHALL lay out without horizontal scrolling and without overlapping elements at viewport widths from 360 px to 1920 px.
2. THE Dashboard SHALL show the Virtual_Doll, the Scenario buttons and the subtitle in one view at 360 px width after at most one vertical scroll.
3. THE Dashboard SHALL use a washi-paper texture, sumi-ink headings, a deep indigo night background and an andon-lantern glow, and SHALL use fonts under the SIL Open Font License.
4. THE Dashboard SHALL use only original or properly licensed images, fonts and audio, and SHALL list adapted assets in `docs/third-party.md`.
5. THE Dashboard SHALL write all UI copy in English with Japanese accents, and every Japanese line SHALL have an English subtitle.
6. THE Dashboard SHALL contain no gore, no threat and no jump scare.

### Requirement 19: Offline and error behaviour

**User Story:** As a reviewer with a poor connection, I want the simulation to keep working and the app to say clearly what is unavailable, so that nothing hangs.

#### Acceptance Criteria

1. WHEN the Dashboard has loaded once, THE Dashboard SHALL run all four Scenarios in Simulation_Mode with no network connection.
2. WHERE the browser supports service workers, THE Dashboard SHALL cache the application files, the Sample_Responses, the illustrations and the bundled audio for offline use.
3. IF the browser has no network connection, THEN THE Dashboard SHALL show "Offline: the simulation still works" and SHALL disable Live_Cloud_Mode, the Control_Panel and the Family_Page actions.
4. IF an API call does not finish within 10 seconds, THEN THE API_Client SHALL abort the request and return a timeout error.
5. IF an unexpected error occurs while rendering a view, THEN THE Dashboard SHALL show "The doll lost her thread. Reload to start again." and SHALL keep the header, the Mute_Control and the Privacy_Indicator.
6. THE API_Client SHALL be the only module that calls the HTTP API, and SHALL return typed results for every route and every error code of `docs/schema.md`.
7. FOR ALL error codes listed in the HTTP API of `docs/schema.md`, THE API_Client SHALL map the code to a typed error value, and an unknown code SHALL map to `internal`.
8. THE Dashboard SHALL write no image data, token, face id or pre-signed URL to the console or to logs.

### Requirement 20: Quality gates and documentation

**User Story:** As the owner, I want tests that guard the core rules and a quick start that reviewers can follow, so that the submission works and stays correct.

#### Acceptance Criteria

1. THE Test_Suite SHALL include a fast-check property test, as a required task, that for any sequence of commands (including `gaze` with any finite angles) and ticks, the Sim_State pan and tilt stay within the limits (Requirement 6.7).
2. THE Test_Suite SHALL include a fast-check property test, as a required task, that for any sequence of inputs the Sim_State is renderable (Requirement 7.1).
3. THE Test_Suite SHALL include a fast-check property test, as a required task, that Timeline ordering is stable (Requirement 10.3 and 10.4).
4. THE Test_Suite SHALL include a fast-check property test, as a required task, that a stranger Scenario, a no-face Scenario, an uncertain Scenario and the offline Scenario never reveal a Family_Label, for any set of registered Family_Labels (Requirement 9.1 and 9.2).
5. THE Test_Suite SHALL include a fast-check round-trip property test for the Schema_Codec and a fixture check (Requirement 4.6 and 4.7).
6. THE Test_Suite SHALL include a component test per Scenario (four in total) that clicks the Scenario button, advances fake time, and asserts the state labels in order, the verdict label, the subtitle in Japanese and English, and the new Timeline entry.
7. THE Test_Suite SHALL include component tests for the Role views: visitor, reviewer (Locked_Controls, illustration instead of snapshot) and family (thumbnail, Control_Panel enabled), and a component test of the Privacy_Indicator for each of its five text states.
8. THE Test_Suite SHALL run with no backend, no AWS account and no network, using a fake API_Client.
9. WHEN `make test` runs, THE Test_Suite SHALL run the Dashboard tests, and `make lint` SHALL run eslint and `tsc` on `/dashboard` without error.
10. THE README SHALL contain a "Reviewer quick start" section that lists the exact clicks for each of the four Scenarios, the Live cloud switch and the demo sign-in, and states for each what the reviewer should see.
11. THE README SHALL state that a reviewer needs no hardware and no account for the simulation, and that the demo account is read-only.
12. THE "Reviewer quick start" SHALL let a new reader complete all four Scenarios in under two minutes, and the section SHALL state this time.
13. THE README SHALL contain no secret, account id, host name, personal name or credential for the demo account; the credentials SHALL be given in the Devpost submission text only.
