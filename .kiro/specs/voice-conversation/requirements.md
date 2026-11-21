# Requirements Document

## Introduction

`voice-conversation` lets the zashiki-warashi hold a short spoken conversation in Japanese with a
family member, using Amazon Nova Sonic (speech-to-speech) in the Tokyo Region. A conversation starts
in one of two ways: the doll recognises a family member and asks the cloud for a session, or a
signed-in family member presses "Talk" in the dashboard. During the conversation the model can turn
the doll's head, set the lantern and look at who is there. Each tool call becomes a command from
`docs/schema.md`, so the same call moves the real doll or the virtual doll in the dashboard.

These requirements are derived from the approved `design.md` of this spec. The feature is P1: it is
off by default, and every session ends in the doll's normal cooldown, so P0 reliability is never
traded for it.

Three decisions are still open for the owner (reviewer voice access, behaviour when a stranger appears
during a conversation, and a cascaded fallback pipeline). Requirement 15 states the design's default
for each and marks it as open.

## Glossary

- **Voice_System**: The whole voice-conversation feature, made of the Voice_Cloud, the Doll_Agent and the Dashboard_Voice_Client.
- **Voice_Cloud**: The AWS part of the feature: the `voice-start`, `voice-grant`, `voice-authorizer` and `voice-session` functions, the Events_API and the related DynamoDB items.
- **Doll_Agent**: The `warashi-agent` program on the Raspberry Pi, including its state machine and its Conversation_Client.
- **Conversation_Client**: The Python asyncio client on the doll that connects to the Events_API and pipes the microphone and speaker.
- **Conversation_Adapter**: The thin adapter on the doll that runs the Conversation_Client and posts one `ConversationFinished` event per session.
- **Dashboard_Voice_Client**: The browser code in `dashboard/src/voice` (the `VoiceClient` and the `TalkPanel`).
- **Session_Function**: The long-running `voice-session` Lambda that owns one conversation, its Bedrock stream and its timers.
- **Session_Reducer**: The pure function `stepSession` that moves a session through `starting`, `live`, `ending` and `ended`.
- **Tool_Dispatcher**: The pure function `toolToCommand` plus the code that sends a `toolResult` for every `toolUse`.
- **Authorizer**: The `voice-authorizer` Lambda that authorizes every connect, subscribe and publish on the Events_API.
- **Events_API**: The AWS AppSync Events API `warashi-voice` with the channel namespace `voice`.
- **Session**: One conversation, identified by a `sessionId`, with a lifecycle of `starting`, `live`, `ending` and `ended`.
- **Client_Token**: The per-session secret that lets an audio client publish to the `in` channel and subscribe to the `out` and `text` channels.
- **Observer_Token**: The per-session secret that lets a browser that started a doll session subscribe to the `text` channel only.
- **Frame**: One JSON message on a voice channel (`hello`, `audio`, `look.result`, `bye`, `interrupt`, `command`, `state`, `transcript`, `end`).
- **Lock**: The DynamoDB item that allows one Session per lock key (`device#<deviceId>` or `sim#<ownerSub>`).
- **Cap**: A daily limit on Session starts for one scope (user, device or global), counted per UTC day.
- **End_Reason**: One of `silence`, `limit`, `stranger`, `user`, `manual`, `language`, `unsafe_output`, `error`, `no_client`, `offline`.
- **Look**: A request for a fresh snapshot during a Session (`snapshot.request`), answered by a family, stranger, nobody or unsure result.
- **Family_Verdict**: A `family` verdict of the `judge` Lambda for the current encounter.
- **Grant_Window**: The time (`grantWindowSeconds`, default 60) within which a Family_Verdict authorizes a doll Session.
- **Virtual_Doll**: The simulated doll of the dashboard simulation reducer.
- **Reviewer**: A signed-in guest account with the `reviewer` role.
- **Family_User**: A signed-in account with the `family` role.
- **Persona_Prompt**: The system prompt built by `buildSystemPrompt()`.
- **Language_Check**: The pure functions `japaneseRatio` and `languageVerdict` applied to assistant text.
- **Unsafe_Text_Check**: The pure function `isUnsafeAssistantText`.
- **Sonic_Event_Builder**: The pure functions that build Bedrock events (`sonicStartEvents`, `sonicAudioContentStart`, `sonicToolResult`, `sonicShutdownEvents`).
- **Conversing_State**: The `conversing` phase of the Doll_Agent state machine.
- **Contract_Document**: The file `docs/schema.md`.

## Requirements

### Requirement 1: Start a Session from the dashboard

**User Story:** As a Family_User, I want to press "Talk" in the dashboard, so that I can speak with the doll or with the virtual doll.

#### Acceptance Criteria

1. WHEN a signed-in user sends `POST /conversations` with `client: "browser"`, THE Voice_Cloud SHALL create a Session, invoke the Session_Function, and return `201` with `sessionId`, `clientToken`, the Events_API hosts, the three channel names, `maxSeconds`, `silenceSeconds` and `expiresAt`.
2. WHEN a signed-in user sends `POST /conversations` with `client: "device"` and `target: "real"`, THE Voice_Cloud SHALL create a Session, publish `conversation.start` to the doll, and return `202` with `sessionId`, `observerToken`, the Events_API hosts, the channel names and `deviceOnline`.
3. IF the request has `client: "device"` and `target: "virtual"`, THEN THE Voice_Cloud SHALL return `400 validation_failed` and create no Session.
4. IF the request has `target: "real"` and the caller has the `reviewer` role, THEN THE Voice_Cloud SHALL return `403 forbidden` and create no Session.
5. WHERE `reviewerVoiceEnabled` is `false`, THE Voice_Cloud SHALL return `403 forbidden` to a Reviewer who sends `POST /conversations`.
6. WHERE `reviewerVoiceEnabled` is `true`, THE Voice_Cloud SHALL accept `POST /conversations` from a Reviewer only with `client: "browser"` and `target: "virtual"`.
7. IF `voiceEnabled` is `false`, THEN THE Voice_Cloud SHALL return `503 voice_unavailable` to every start request and create no Session.
8. IF the Lock for the requested lock key is held and unexpired, THEN THE Voice_Cloud SHALL return `409 session_active` and create no Session.
9. WHEN the owner of a Session sends `DELETE /conversations/{sessionId}`, THE Voice_Cloud SHALL end the Session with the End_Reason `user` and return `204`.
10. IF a caller who is not the owner, or an unknown `sessionId`, is used with `GET` or `DELETE /conversations/{sessionId}`, THEN THE Voice_Cloud SHALL return `404 not_found` and change nothing.
11. WHEN a signed-in user sends `GET /me`, THE Voice_Cloud SHALL include `voice` with `enabled`, `maxSeconds` and `remainingToday`.
12. WHEN the owner check of AC 1.10 fails, THE Voice_Cloud SHALL return the same `404 not_found` response for an existing Session of another owner as for an unknown `sessionId`, and SHALL NOT return `403 forbidden`, so that the response does not reveal whether the Session exists.

### Requirement 2: Start a Session from the doll

**User Story:** As a family member, I want the doll to offer a conversation when it recognises me, so that I can talk to it without opening the dashboard.

#### Acceptance Criteria

1. WHEN the Doll_Agent enters `greeting` after an accepted `family` verdict, `conversation_enabled` is `true` and the cloud link is connected, THE Doll_Agent SHALL send `conversation.requested` once for that encounter.
2. WHEN the Voice_Cloud receives `conversation.requested`, THE Voice_Cloud SHALL grant a Session only if its own record shows a `family` verdict for the encounter that is no older than the Grant_Window.
3. IF the stored verdict is missing, is not `family`, or is older than the Grant_Window, THEN THE Voice_Cloud SHALL send no `conversation.start` and create no Session.
4. WHEN the Voice_Cloud grants a doll Session, THE Voice_Cloud SHALL publish `conversation.start` with `sessionId`, `token`, `maxSeconds`, `silenceSeconds` and `source: "family_verdict"`.
5. IF the topic id of the received event differs from the `deviceId` of its envelope, THEN THE Voice_Cloud SHALL drop the event.
6. IF the topic id of the received event differs from the `deviceId` of its envelope, THEN THE Voice_Cloud SHALL write a log record that marks the event as dropped, with the reason `topic_device_mismatch`, the envelope `id` and both device ids, and without payload or token, for audit and security tracing.

### Requirement 3: Daily caps and one Session per doll

**User Story:** As the owner, I want hard limits on the number and the cost of voice sessions, so that the feature stays within budget and is not abused.

#### Acceptance Criteria

1. WHEN a start request is accepted, THE Voice_Cloud SHALL increment the Caps of the scopes that apply to it in the fixed order user, device, global.
2. IF a Cap rejects a start request, THEN THE Voice_Cloud SHALL release the counters that the request already incremented and return `429 rate_limited`.
3. WHEN a Cap rejects a start request, THE Voice_Cloud SHALL set `Retry-After` to a whole number of seconds from 1 to 86,400 that ends at the next UTC midnight.
4. WHEN the UTC day changes, THE Voice_Cloud SHALL count each Cap from zero for the new day.
5. THE Voice_Cloud SHALL keep the number of accepted starts per scope per UTC day at or below that scope's Cap.
6. WHEN a start request needs a Lock, THE Voice_Cloud SHALL take the Lock with one conditional write that succeeds only when the Lock does not exist or its `expiresAt` is in the past.
7. WHILE a Session holds an unexpired Lock, THE Voice_Cloud SHALL reject every other start request for the same lock key.
8. WHEN a Session ends or its `expiresAt` passes, THE Voice_Cloud SHALL leave the Lock released or expired so that the next start request can take it.
9. THE Voice_Cloud SHALL let start requests for different lock keys proceed independently.
10. THE Session_Function SHALL run with a reserved concurrency of `maxConcurrent` (default 3), which is below the 20-session Bedrock quota.

### Requirement 4: Session tokens and channel authorization

**User Story:** As the owner, I want every voice connection to be authorized for one session and one set of channels, so that nobody else can listen to or speak into a conversation.

#### Acceptance Criteria

1. WHEN a Session is created, THE Voice_Cloud SHALL create a Client_Token of the form `<sessionId>.<secret>` with a 32-byte random secret in Base64URL and store only its SHA-256 hash.
2. WHEN a doll Session is started from the dashboard, THE Voice_Cloud SHALL also create an Observer_Token and store only its hash.
3. WHEN the Events_API receives a connect, subscribe or publish operation, THE Authorizer SHALL authorize it only if the token matches the stored hash, the Session phase is `starting` or `live`, and `expiresAt` is in the future.
4. THE Authorizer SHALL allow the Client_Token to publish `/voice/<sid>/in` and to subscribe `/voice/<sid>/out` and `/voice/<sid>/text`.
5. THE Authorizer SHALL allow the Observer_Token to subscribe `/voice/<sid>/text` only.
6. IF the channel is a wildcard, belongs to another Session, or is not one of the three Session channels, THEN THE Authorizer SHALL return `isAuthorized: false`.
7. IF the token is expired, wrong, or tied to a Session in phase `ending` or `ended`, THEN THE Authorizer SHALL return `isAuthorized: false`.
8. WHEN the Session_Function connects to the Events_API, THE Session_Function SHALL use IAM signing with permissions limited to the one Events API.
9. WHEN the Voice_Cloud sends a token to the doll, THE Voice_Cloud SHALL send it only inside a `conversation.start` command on the doll's own MQTT topic.
10. THE Doll_Agent SHALL exclude the `token` field of `conversation.start` from every log line and every published message.
11. WHEN a subscribe request that uses the Observer_Token names the channel `/voice/<sid>/text`, THE Authorizer SHALL evaluate the text-subscribe permission of AC 4.5 and authorize it; WHEN the request names any other channel, THE Authorizer SHALL deny it under AC 4.5 and AC 4.6.

### Requirement 5: Channel frames and audio ordering

**User Story:** As a developer, I want one frame protocol shared by the doll, the cloud and the dashboard, so that all three parts exchange audio and control messages the same way.

#### Acceptance Criteria

1. THE Voice_System SHALL encode and decode every Frame as defined in the "Voice session channels" section of the Contract_Document.
2. FOR ALL valid Frames, decoding the encoded Frame SHALL produce a Frame equal to the original (round-trip property).
3. IF a Frame has `pcm` that is not valid Base64, decodes to an odd number of bytes, or decodes to more than 12,800 bytes, THEN THE Voice_System SHALL treat the Frame as malformed.
4. IF a Frame has an unknown `t` or the wrong type for a field, THEN THE Voice_System SHALL treat the Frame as malformed or ignore it, and never treat it as valid.
5. FOR ALL input strings, THE Frame decoder SHALL return a result without throwing.
6. WHEN the Voice_System sends an `audio` Frame, THE Voice_System SHALL include a sequence number `seq`.
7. WHEN the receiver of `audio` Frames has a missing `seq` gap, THE receiver SHALL hold at most `reorderWindow` Frames, deliver Frames in increasing `seq` with no duplicates, and drop Frames that arrive behind the window.
8. WHEN the Session_Function has received 50 malformed Frames, THE Session_Function SHALL end the Session with the End_Reason `error`.
9. THE Voice_System SHALL send audio in chunks of `chunkMs` (default 100 ms) with 16 kHz 16-bit mono LPCM towards the model and 24 kHz 16-bit mono LPCM from the model.
10. THE Python, TypeScript and dashboard tests SHALL decode every golden Frame in `docs/fixtures/voice-v1/` and re-encode it to a semantically equal value.

### Requirement 6: Session lifecycle and limits

**User Story:** As the owner, I want every Session to end on its own and clean up after itself, so that no conversation runs forever or leaves locks behind.

#### Acceptance Criteria

1. THE Session_Reducer SHALL move a Session only forward through the phases `starting`, `live`, `ending` and `ended`.
2. WHILE a Session is in phase `ended`, THE Session_Reducer SHALL return the same state and no effects for every event.
3. WHEN ticks arrive at most 1 s apart, THE Session_Reducer SHALL bring every Session to `ended` no later than `maxSeconds + noClientSeconds + cleanupGraceMs` after the start, whatever events arrive.
4. WHEN a Session in phase `starting` has seen no `hello` for `noClientSeconds`, THE Session_Reducer SHALL begin ending with the End_Reason `no_client`.
5. WHEN a Session in phase `live` has run for `maxSeconds`, THE Session_Reducer SHALL begin ending with the End_Reason `limit`.
6. WHEN a Session in phase `live` has had no user speech and no model audio for `silenceSeconds`, THE Session_Reducer SHALL begin ending with the End_Reason `silence`.
7. WHEN the first end request arrives, THE Session_Reducer SHALL record its End_Reason and keep that reason for the rest of the Session.
8. WHEN a Session reaches phase `ended`, THE Session_Reducer SHALL emit `publishEnd`, `notifyDevice`, `releaseLock` and `recordSession` exactly once, and `closeStream` SHALL have been emitted before.
9. WHEN a Session is in phase `ending` and the model stream closes, THE Session_Reducer SHALL finish the Session at once.
10. WHEN a Session is in phase `ending` for `cleanupGraceMs` (3,000 ms), THE Session_Reducer SHALL finish the Session.
11. IF the model stream closes while the Session is in phase `starting` or `live`, THEN THE Session_Reducer SHALL begin ending with the End_Reason `error`.
12. IF the Bedrock stream cannot be opened, THEN THE Session_Function SHALL end the Session with the End_Reason `error` before any audio is sent.
13. WHEN a Session ends for any reason, THE Session_Function SHALL close the Bedrock stream, publish one `end` Frame, and publish `conversation.end` to the doll for a doll Session.
14. THE Voice_Cloud SHALL clamp `maxSeconds` to 30..420, `silenceSeconds` to 5..60 and `noClientSeconds` to 5..60 when it reads its configuration.

### Requirement 7: Tools that move the doll

**User Story:** As a Family_User, I want to ask the doll to look somewhere or change its lantern, so that the conversation feels alive without risking the doll's hardware.

#### Acceptance Criteria

1. THE Tool_Dispatcher SHALL accept the tool names `turn_head`, `set_lantern` and `look` and answer every other name with an error result.
2. FOR ALL tool names and all input strings, THE Tool_Dispatcher SHALL return a result without throwing.
3. WHEN `turn_head` has a valid `direction`, THE Tool_Dispatcher SHALL map it to an absolute pan and tilt from the direction table (left −20/0, right 20/0, up 0/12, down 0/−8, center 0/0).
4. WHEN `turn_head` has finite `pan_deg` or `tilt_deg`, THE Tool_Dispatcher SHALL use them, with 0 for the missing one.
5. THE Tool_Dispatcher SHALL clamp every `gaze` angle to `[-voiceGazeLimits.pan, voiceGazeLimits.pan]` and `[-voiceGazeLimits.tilt, voiceGazeLimits.tilt]`, with defaults pan 30 and tilt 20 and an upper bound of pan 60 and tilt 30.
6. THE Tool_Dispatcher SHALL produce a `gaze` envelope only with finite `panDeg` and `tiltDeg`.
7. WHEN `set_lantern` has a finite `level`, THE Tool_Dispatcher SHALL produce a `lantern` envelope with `level` clamped to 0..1 and an integer `fadeMs` clamped to 0..10000, with 1200 ms when `fade_ms` is missing.
8. IF a tool input is invalid JSON, has a missing or non-finite required value, or has an unknown direction, THEN THE Tool_Dispatcher SHALL return the error result `bad_arguments`.
9. IF a Session has used `maxToolCalls`, `maxGazeCommands` or `maxLooksPerSession`, THEN THE Tool_Dispatcher SHALL return an error result and send no command.
10. IF two head commands are less than `gazeMinIntervalMs` apart, THEN THE Tool_Dispatcher SHALL return the error result `too_fast` and send no command.
11. IF the doll is not reachable, THEN THE Tool_Dispatcher SHALL return the error result `doll_unavailable` and send no command.
12. WHEN the model sends a `toolUse`, THE Session_Function SHALL send exactly one `toolResult` for its id, including when the tool failed, was rejected, or the Session is ending.
13. WHEN a tool command is for a real doll, THE Session_Function SHALL publish it over MQTT; WHEN it is for the Virtual_Doll, THE Session_Function SHALL send it as a `command` Frame.
14. THE Tool_Dispatcher SHALL return to the model only the fields `ok`, the clamped angles, or `who`, and never a name, an id, a confidence or a face box.

### Requirement 8: Look and family re-check

**User Story:** As a family member, I want the conversation to stop if a stranger steps in, so that the doll does not chat with someone it does not know.

#### Acceptance Criteria

1. WHEN the model calls `look` for a real doll, THE Session_Function SHALL send `snapshot.request` with a new `requestId` and poll the `LOOK#<requestId>` item every 250 ms until `lookTimeoutSeconds`.
2. WHEN the model calls `look` for the Virtual_Doll, THE Session_Function SHALL send the `snapshot.request` envelope as a `command` Frame and wait for a `look.result` Frame.
3. IF no look result arrives within `lookTimeoutSeconds`, THEN THE Session_Function SHALL answer the tool with `who: "unsure"`.
4. WHEN `recheckSeconds` is greater than 0 and a Session is `live`, THE Session_Function SHALL request a silent Look every `recheckSeconds` without counting it against `maxLooksPerSession` or `maxToolCalls`.
5. WHEN a Look returns the verdict `stranger`, THE Session_Reducer SHALL begin ending with the End_Reason `stranger`.
6. WHEN `snapshot.captured` carries a `requestId`, THE judge Lambda SHALL also write `LOOK#<requestId>` with the verdict and expire it after 10 minutes.
7. WHILE a Session is in phase `ending` or `ended`, THE Session_Function SHALL start no new Look.
8. IF a Look is in flight when the Session phase becomes `ending` or `ended`, THEN THE Session_Function SHALL discard its result and SHALL NOT apply its verdict to the Session or change the recorded End_Reason.

### Requirement 9: Persona, language and safety of the model output

**User Story:** As the owner, I want the doll to stay in character, to speak Japanese and to say nothing unsafe, so that the feature is family-friendly.

#### Acceptance Criteria

1. THE Persona_Prompt SHALL be built without any input from the family registry, so that it contains no name, no age, no schedule and no other family data.
2. THE Persona_Prompt SHALL contain a sentence for each persona rule listed in the design's marker-phrase list.
3. THE Persona_Prompt SHALL contain no blocked word from `blockedWords`.
4. WHEN the first two assistant turns have ended and the Language_Check verdict is `bad`, THE Session_Reducer SHALL begin ending with the End_Reason `language`.
5. THE Language_Check SHALL return `null` from `japaneseRatio` for text with fewer than four letters, and a number from 0 to 1 otherwise, and never throw.
6. THE Language_Check SHALL return `undecided` for turns with fewer than four letters, `ok` as soon as one turn with at least four letters reaches 60 % kana or kanji, and `bad` when at least two turns with four or more letters have no Japanese letters.
7. WHEN a turn with at least four Japanese letters is appended to a list whose verdict is `ok`, THE Language_Check SHALL keep the verdict `ok`.
8. WHEN the Unsafe_Text_Check finds a blocked word in assistant text, in any letter case, THE Session_Function SHALL send an `interrupt` Frame and begin ending with the End_Reason `unsafe_output`.
9. WHEN three Sessions in a row end with `language` or `error` within one hour, THE Voice_Cloud SHALL set the `VOICE#HEALTH` flag for one hour and return `503 voice_unavailable` to start requests during that hour.
10. WHILE the `VOICE#HEALTH` flag is set, THE Doll_Agent SHALL play the cached line `conversation_trouble` when a doll Session ends with `error` or `language`.
11. THE Voice_System SHALL document in the README that Nova Sonic has no guardrails and that the face check at the start and the re-check are the only proof that a family member is present.

### Requirement 10: Bedrock event protocol

**User Story:** As a developer, I want the events sent to Amazon Bedrock to follow the documented order, so that the model session starts, runs and ends correctly.

#### Acceptance Criteria

1. THE Sonic_Event_Builder SHALL emit `sessionStart` first, `promptStart` with the tool configuration second, and the system prompt block third.
2. THE Sonic_Event_Builder SHALL emit the audio `contentStart` before any `audioInput`.
3. THE Sonic_Event_Builder SHALL match every `contentStart` with exactly one `contentEnd`.
4. THE Sonic_Event_Builder SHALL emit the shutdown events (`promptEnd`, `sessionEnd`) last and at most once, and no event SHALL follow `sessionEnd`.
5. WHEN the Session_Function builds a session script with tools, barge-in or an early end, THE Sonic_Event_Builder SHALL keep this order.
6. WHEN the model sends an interrupted marker, THE Session_Function SHALL publish an `interrupt` Frame.
7. THE Session_Function SHALL read the model ID, the voice ID and the inference settings from configuration, with `amazon.nova-2-5-sonic` in `ap-northeast-1` and `tiffany` as defaults.
8. IF publishing an `interrupt` Frame after the interrupted marker fails, THEN THE Session_Function SHALL drop that Frame without a retry and without guaranteed delivery, and SHALL continue the Session, so that a consumer may miss the interruption.

### Requirement 11: Conversing state on the doll

**User Story:** As the owner, I want the doll's state machine to enter and leave the conversation safely, so that the doll always returns to cooldown and sleep.

#### Acceptance Criteria

1. WHERE `conversation_enabled` is `false`, THE Doll_Agent SHALL send no `conversation.requested` and SHALL reject `conversation.start` with `command_rejected_state`.
2. WHEN `conversation.start` arrives in `greeting` with `source: "family_verdict"` and the accepted verdict is `family`, THE Doll_Agent SHALL store the grant and enter Conversing_State when the greeting line ends.
3. WHEN `conversation.start` with `source: "manual"` arrives in `sleeping` and the mode is `guard`, THE Doll_Agent SHALL emit `presence.detected` with `source: "manual"` and enter Conversing_State.
4. IF `conversation.start` arrives in any other state or in mode `sleep`, THEN THE Doll_Agent SHALL reject it with `command_rejected_state`.
5. WHEN the Doll_Agent enters Conversing_State, THE Doll_Agent SHALL set a deadline of entry time plus `conversation_max_s`, emit `state.changed`, emit `StartConversation`, and publish `status.report` with `micActive: true`.
6. WHILE the Doll_Agent is in Conversing_State and Ticks arrive at most `T` apart, THE Doll_Agent SHALL leave Conversing_State no later than `conversation_max_s + T` after entering it.
7. WHEN `conversation.end` for the current session, `ConversationFinished`, `mode.set` with `sleep`, `cloud.disconnected`, an adapter failure, or the deadline occurs in Conversing_State, THE Doll_Agent SHALL enter `cooldown` with the reason mapped in the Contract_Document.
8. WHEN the Doll_Agent leaves Conversing_State, THE Doll_Agent SHALL emit exactly one `StopConversation` and one `conversation.ended`.
9. IF an event carries a session id that is not the current one, THEN THE Doll_Agent SHALL leave the state unchanged.
10. WHEN the Doll_Agent leaves Conversing_State with the reason `silence`, `limit`, `user` or a remote end, THE Doll_Agent SHALL play `conversation_bye`.
11. WHEN the Doll_Agent leaves Conversing_State with the reason `error` or `language`, THE Doll_Agent SHALL play `conversation_trouble`.
12. WHEN the Doll_Agent leaves Conversing_State with the reason `stranger`, `manual`, `offline` or `unsafe_output`, THE Doll_Agent SHALL play no line.
13. THE Doll_Agent SHALL emit at most one `reaction.performed` per encounter, and neither conversation line SHALL publish one.
14. THE Doll_Agent SHALL keep the `Encounter_Bound` of `device-core-loop` extended by `conversation_max_s + 2T` when `conversation_enabled` is `true`.
15. WHEN `snapshot.request` arrives in Conversing_State with no Look outstanding, THE Doll_Agent SHALL take a snapshot and answer with `snapshot.captured` carrying the same `requestId`.
16. IF `snapshot.request` arrives outside Conversing_State or while a Look is outstanding, THEN THE Doll_Agent SHALL reject it with `command_rejected_state`.
17. IF `speak` arrives in Conversing_State, THEN THE Doll_Agent SHALL reject it with `command_rejected_state`.
18. WHEN a `stranger` verdict for the outstanding Look is accepted in Conversing_State, THE Doll_Agent SHALL emit `StopConversation` and enter `cooldown` with the reason `verdict`.
19. WHILE the state is Conversing_State, THE Doll_Agent SHALL report `micActive: true` in `status.report`, and `micActive: false` in every other state.
20. WHEN the Doll_Agent leaves Conversing_State with the `state.changed` reason `verdict` because a `stranger` verdict for the outstanding Look was accepted, THE Doll_Agent SHALL play no line, as for the reason `stranger` in AC 11.12.

### Requirement 12: Audio client on the doll

**User Story:** As a family member, I want the doll to hear me and answer with its own voice, so that a spoken conversation works on the small Raspberry Pi.

#### Acceptance Criteria

1. WHEN `StartConversation` is handled, THE Conversation_Client SHALL connect to the Events_API within `conversation_connect_timeout_s`, subscribe to `out`, and publish `hello`.
2. WHILE a Session is live, THE Conversation_Client SHALL send microphone audio as 16 kHz 16-bit mono chunks of `conversation_chunk_ms` and play incoming audio at 24 kHz.
3. THE Conversation_Client SHALL apply `conversation_mic_gain` with clipping to every microphone chunk, using the Python standard library without `audioop`.
4. FOR ALL PCM buffers of even length and all gains in the allowed range, THE `apply_gain` function SHALL return a buffer of the same length with every sample inside the 16-bit range, and SHALL return the input unchanged for gain 1.0.
5. FOR ALL buffers, THE `split_chunks` function SHALL return chunks of exactly the requested even size and a remainder shorter than one chunk, so that the concatenation equals the input.
6. WHEN an `interrupt` Frame arrives, THE Conversation_Client SHALL stop playback at once.
7. WHERE `conversation_mute_mic_while_speaking` is `true`, THE Conversation_Client SHALL send no microphone chunk while it plays model audio.
8. WHEN a Session ends for any cause (clean end, drop, hang, bad token, no data, microphone failure), THE Conversation_Adapter SHALL post exactly one `ConversationFinished` for that session id.
9. WHEN `stop` is called more than once, THE Conversation_Adapter SHALL treat the later calls as no-ops and SHALL stop the audio subprocesses within 1 s.
10. WHEN every deadline has passed, THE Conversation_Adapter SHALL have no `arecord` or `aplay` process left running.
11. IF `arecord` exits or produces no data for 2 s, THEN THE Conversation_Client SHALL report `error.reported` with `microphone_failed` and end with the reason `error`.
12. IF connect, authentication or transport fails, THEN THE Conversation_Client SHALL report `error.reported` with `conversation_failed` and end with the reason `error`.
13. WHEN the Conversation_Client sees neither speech energy nor incoming audio for `conversation_silence_s`, THE Conversation_Client SHALL end with the reason `silence`.
14. THE Doll_Agent SHALL load `conversation_*` settings only within these ranges and reject the rest: `conversation_max_s` 30..420, `conversation_silence_s` 5..60, `conversation_mic_gain` 0.5..16, `conversation_chunk_ms` 60..200, `conversation_connect_timeout_s` 2..20.
15. IF `conversation_silence_s + 5` is greater than `conversation_max_s`, or `conversation_enabled` is `true` while the AppSync hosts are empty, THEN THE Doll_Agent SHALL reject the configuration.

### Requirement 13: Dashboard voice client

**User Story:** As a Family_User or a Reviewer, I want a Talk panel in the dashboard, so that I can speak with the doll or the virtual doll from my browser.

#### Acceptance Criteria

1. WHEN a user presses Talk and grants microphone access, THE Dashboard_Voice_Client SHALL start a Session, open the Events_API WebSocket with the Client_Token, subscribe to `out` and `text`, and publish `hello`.
2. WHEN the browser captures audio, THE Dashboard_Voice_Client SHALL resample it to 16 kHz mono and send chunks of 100 ms.
3. FOR ALL input sample rates and lengths, THE resampler SHALL return `ceil(n * 16000 / rate)` samples within one sample, with every value inside `[-1, 1]`.
4. WHEN audio of 24 kHz arrives, THE Dashboard_Voice_Client SHALL schedule it back to back, and SHALL stop all scheduled sources when an `interrupt` Frame arrives.
5. WHEN a `command` Frame arrives for the Virtual_Doll, THE Dashboard_Voice_Client SHALL pass its envelope to the simulation reducer.
6. WHEN a `snapshot.request` command reaches the Virtual_Doll, THE Dashboard_Voice_Client SHALL publish a `look.result` Frame with the Virtual_Doll's simulated verdict.
7. WHEN a doll Session is started from the dashboard, THE Dashboard_Voice_Client SHALL subscribe to `text` with the Observer_Token and show subtitles and the End_Reason.
8. WHILE the browser captures audio, THE TalkPanel SHALL show a microphone-on indicator and a Stop button.
9. WHEN the user presses Stop or closes the tab, THE Dashboard_Voice_Client SHALL send a `bye` Frame and then call `DELETE /conversations/{sessionId}`.
10. IF `GET /me` reports `voice.enabled: false`, the role is not allowed, or `remainingToday` is 0, THEN THE TalkPanel SHALL disable the Talk button and show the reason.
11. THE TalkPanel SHALL tell the user that the voice goes to Amazon Bedrock in Tokyo.
12. THE TalkPanel SHALL show no name.

### Requirement 14: Privacy of voice data

**User Story:** As a family member, I want my voice and my family's names to stay out of storage and out of the model, so that the feature respects the privacy principles.

#### Acceptance Criteria

1. THE Voice_Cloud SHALL store no audio, no transcript and no model text in DynamoDB, logs or any other storage.
2. THE Voice_Cloud SHALL store a Session item with only these keys: `deviceId`, `client`, `target`, `ownerSub`, `role`, `phase`, `startedAt`, `expiresAt`, `clientTokenHash`, `observerTokenHash`, `endReason`, `endedAt` and `endRequested`.
3. THE Voice_Cloud SHALL expire Session items after two days, Lock items after one hour, Counter items after two days and Look items after 10 minutes.
4. FOR ALL family label registries, THE Persona_Prompt, every tool result, every `text` Frame and every stored item SHALL contain no family label.
5. THE Voice_Cloud SHALL log at most the first 8 characters of a `sessionId` and no audio, token, name or pre-signed URL.
6. WHILE no Session is in Conversing_State, THE Doll_Agent SHALL report `micActive: false`.

### Requirement 15: Open decisions and their defaults

**User Story:** As the owner, I want each open design decision to be stated with a default, so that the implementation proceeds and I can change it later.

#### Acceptance Criteria

1. THE Voice_System SHALL use `reviewerVoiceEnabled = false` as the default for Reviewer voice access, and this decision SHALL stay marked open for the owner.
2. WHERE `reviewerVoiceEnabled` is `true`, THE Voice_Cloud SHALL limit a Reviewer to 2 Session starts per UTC day.
3. THE Voice_System SHALL use the following default when a stranger appears during a conversation: the Session ends with the End_Reason `stranger`, the doll plays no line and enters `cooldown`, and this decision SHALL stay marked open for the owner.
4. WHEN a stranger Look ends a Session, THE judge Lambda SHALL still record the verdict and send the single family notification.
5. THE Voice_System SHALL use no cascaded pipeline (Transcribe, Nova Lite and Polly) as the default, SHALL end with `language` and play cached lines instead, and this decision SHALL stay marked open for the owner.
6. THE Voice_System SHALL use `tiffany` as the default voice and `amazon.nova-2-5-sonic` as the default model, both changeable by configuration, and these choices SHALL stay marked open until the listening test.

### Requirement 16: Contract and fixtures

**User Story:** As a developer, I want the contract file and its fixtures to describe every new message first, so that the doll, the cloud and the dashboard cannot drift apart.

#### Acceptance Criteria

1. WHEN implementation of this feature starts, THE Contract_Document SHALL contain the changes S1 to S20 of the design before any producer or consumer changes.
2. THE Voice_System SHALL keep the contract version `v` at 1.
3. THE Voice_System SHALL provide one golden file in `docs/fixtures/schema-v1/` for each of `conversation.requested`, `conversation.ended`, `conversation.start`, `conversation.end` and `snapshot.request`.
4. THE Voice_System SHALL provide one golden Frame in `docs/fixtures/voice-v1/` for each Frame type and direction.
5. IF a Frame type has no fixture or a fixture has no Frame type, THEN THE test suites SHALL fail and name the Frame or the file.
6. THE route table test and the error code test SHALL include `POST /conversations`, `GET /conversations/{sessionId}`, `DELETE /conversations/{sessionId}`, `session_active` and `voice_unavailable`.
7. THE voice-line catalog SHALL contain `conversation_trouble` and `conversation_bye` with the text and subtitles of the design, and the catalog drift check SHALL cover them.
