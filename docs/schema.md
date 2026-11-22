# Message contract — draft v1

Single source of truth for everything exchanged between the doll (`/device`), the cloud
(`/cloud`) and the dashboard (`/dashboard`, including the simulation).

> Status: **draft v1, refined by the `device-core-loop` design**
> (`.kiro/specs/device-core-loop/design.md`, section "docs/schema.md Changes"). Each change is
> marked with its reason next to it. The `cloud-judgement` design
> (`.kiro/specs/cloud-judgement/design.md`) verified the AWS limits, clarified a few cloud-side
> rules and defined the HTTP API below. The `dashboard-simulation` design
> (`.kiro/specs/dashboard-simulation/design.md`) added S1 (consent notice text location) and S2
> (voice-line catalog source). No event or command field changed, so `v` stays 1.
> The `voice-conversation` design (`.kiro/specs/voice-conversation/design.md`, rows S1 to S21)
> added the conversation events, commands, states, the "Voice session channels" section and the
> `/conversations` routes; `v` stays 1 because every change adds a type, an optional field or an
> enumeration value. The `remote-actions` change (remote photo and typed speech from the dashboard) added optional
fields, one `state.changed` reason and three HTTP routes; `v` stays 1. From now on, change this
file first and keep code and tests in all three parts in sync with it.

## Transport
AWS IoT Core, MQTT over TLS, QoS 1. `<id>` is the device id, for example `warashi-01`.

| Topic | Direction | Payload |
|---|---|---|
| `warashi/<id>/events` | device → cloud | JSON envelope with an event type |
| `warashi/<id>/commands` | cloud → device | JSON envelope with a command type |
| `warashi/<id>/status` | device → cloud | JSON envelope `status.report`; the MQTT last will publishes `status.offline` |

The dashboard simulation passes the same envelopes in memory, without MQTT.

## Envelope
```json
{
  "v": 1,
  "id": "0b8f6c1e-3a52-4d0f-9d53-2f1f3c1f7a10",
  "ts": "2026-11-20T12:34:56.789Z",
  "deviceId": "warashi-01",
  "encounterId": "c1d2e3f4-0000-4000-8000-000000000001",
  "type": "presence.detected",
  "data": {}
}
```

| Field | Meaning |
|---|---|
| `v` | Contract version, an integer ≥ 1. A receiver ignores a message with a higher `v` and reports `error.reported` with code `unsupported_version`. A `v` that is not an integer ≥ 1 (for example `0`, `1.5`, `"1"` or `true`) makes the message malformed. |
| `id` | Unique message id (UUID). Receivers drop duplicates (QoS 1 can redeliver). |
| `ts` | Sender time, UTC, ISO 8601 with milliseconds. |
| `deviceId` | The doll this message belongs to. |
| `encounterId` | Groups everything from one visit. Created by the device on `presence.detected`; `null` outside an encounter. `status.report` envelopes always carry `null`. Commands may carry `null`. |
| `type`, `data` | See the tables below. Unknown types are ignored and reported, never fatal. |

**Version.** `v` stays `1`. *Reason:* no version of the contract has been deployed yet, so the
`device-core-loop` refinements are part of v1 instead of a new version.

**Incoming size limit.** The device treats an incoming message larger than 131,072 bytes as
malformed. *Reason:* gives the decoder a safe input bound.

**Duplicates and extra fields.** The device drops a command whose `id` is among the last
`dedup_window_size` (default 256) accepted ids, without reporting an error. It ignores and
discards `data` fields that this document does not define. *Reason:* makes duplicate handling
bounded and keeps extra fields (such as names) out of the device.

**Commands without an encounter.** Commands may carry `encounterId: null`. The device matches a
`judgement.result` to its snapshot by `snapshotId` only. *Reason:* the cloud cannot always know
the current encounter.

## Events (device → cloud)
| `type` | `data` | Meaning |
|---|---|---|
| `presence.detected` | `{ "source": "pir" \| "sound" \| "manual" }` | A new encounter starts. |
| `snapshot.captured` | `{ "snapshotId": string, "width": int, "height": int, "panDeg": number, "tiltDeg": number, "jpegBase64": string, "requestId": string \| null, "purpose": "judge" \| "photo" }` | A snapshot taken at the given head angles. Asks the cloud for a verdict. `requestId` is optional (default `null`) and set only when the snapshot answers a `snapshot.request` (S3). `purpose` is optional (default `"judge"`); `"photo"` marks a snapshot that only has to be stored: the cloud does not search faces, sends no `judgement.result` and sends no notification (R1). |
| `state.changed` | `{ "from": State, "to": State, "reason": Reason }` | State machine transition. `reason` is one of the values in "`state.changed` reasons" below. |
| `reaction.performed` | `{ "kind": "family" \| "stranger" \| "uncertain", "lineId": string \| null, "offline": boolean }` | What the doll actually did. `offline` is true when it reacted without a verdict. |
| `encounter.ended` | `{ "reason": "cooldown" \| "manual" \| "error" }` | The encounter is over. |
| `error.reported` | `{ "code": ErrorCode, "message": string, "refId": string \| null }` | A recoverable problem (no secrets, no image data). `code` is one of the codes in "`error.reported` codes" below. `refId` is always present. |
| `conversation.requested` | `{ "reason": "family_verdict" }` | The doll asks for a voice session. Sent once per encounter on entering `greeting` after an accepted `family` verdict, only when `conversation_enabled` is on and the cloud is connected. |
| `conversation.ended` | `{ "sessionId": string, "reason": ConversationEndReason }` | The doll left `conversing`. Sent on every exit from that state. |

Changes from `voice-conversation` (S1 to S3):

- **S1 `conversation.requested`.** *Reason:* the cloud decides whether the doll gets a session.
- **S2 `conversation.ended`.** *Reason:* the cloud closes its session and releases the lock even
  when the doll ended it.
- **S3 `snapshot.captured.requestId`.** `snapshot.captured.data` gains the optional field
  `requestId: string | null` (default `null`). It is set only for a snapshot that answers a
  `snapshot.request`. *Reason:* lets the `judge` Lambda store a result under the id that the
  session waits for.
- **R1 `snapshot.captured.purpose`.** Optional, `"judge"` (default) or `"photo"`. *Reason:* a photo
  that the family asked for must not be judged, notified or counted as a visitor.
- **`ConversationEndReason`** is one of `silence`, `limit`, `stranger`, `user`, `manual`,
  `language`, `unsafe_output`, `error`, `no_client`, `offline`. *Reason:* one enumeration for the
  doll, the cloud and the dashboard.

Notes on the event fields:

- **`presence.detected.source`.** The device emits `source: "pir"` only (`device-core-loop`).
  `sound` (P2, wake on sound) and `manual` are reserved. *Reason:* neither feature exists yet.
- **`state.changed.reason`.** Always present; assigned by the mapping table below.
  *Reason:* the timeline can show why a transition happened, including timeouts.
- **`encounter.ended.reason`.** `cooldown`, `manual` or `error`. The draft value `timeout` is
  removed. *Reason:* every encounter ends through cooldown. Timeouts are visible in
  `state.changed`; `error` marks a reset after an internal error.
- **`error.reported.refId`.** The `id` of the incoming message that caused the error, or `null`
  when no incoming message caused it. `message` is at most 200 characters; the sender truncates
  longer text. *Reason:* receivers can link an error to the message that caused it and handle
  codes without parsing text.

Snapshot size: the AWS IoT Core MQTT publish payload limit is **128 KB and cannot be raised**
(verified in the AWS IoT Core quotas, `cloud-judgement` design). The device keeps the raw JPEG at
or below 90,000 bytes (640×480, reduced quality if needed) before base64-encoding it. Worst case:
90,000 bytes become 120,000 base64 characters, and with the envelope the message stays below
128,000 bytes. Raising the JPEG cap beyond about 95,000 bytes would break this bound and needs a
new transport (pre-signed S3 upload). *Reason:* the broker limit is now verified, and the bound is
enforced by a test.

Cloud receiver rules (added by `cloud-judgement`):

- **Topic check.** A cloud receiver drops an event or status message whose `deviceId` differs from
  the `<id>` segment of the topic it arrived on. *Reason:* `deviceId` is written by the device.
- **`judgement.result.confidence`.** For `family` it is the best face similarity divided by 100.
  For `stranger` it is the face-detection confidence of the searched face, not a probability that
  the person is a stranger. *Reason:* keeps the number meaningful for the device's accept
  thresholds. For `uncertain` it is the face-detection confidence divided by 100, or 0 when no
  face confidence is available or the search failed. For `no_face` it is 1 and `face` is `null`.
  Always a number from 0 to 1. *Reason:* the number stays within the documented range for every
  verdict, and a failure never produces a made-up score.
- **Stored events.** In every record the cloud stores or returns, `snapshot.captured` has
  `jpegBase64` removed and gains `hasImage: true`. *Reason:* keeps images out of the event log.

### `state.changed` reasons
| `reason` | Meaning |
|---|---|
| `presence` | A PIR edge started a new encounter. |
| `arrived` | The awaited head movement arrived (when leaving `waking`, also after the lantern fade-in). |
| `verdict` | A `judgement.result` for the current snapshot was accepted. |
| `no_face` | Every scan attempt of the encounter saw no face. |
| `timeout` | A state, snapshot or audio deadline passed without the awaited feedback. |
| `offline` | The cloud was disconnected, so the doll reacted without a verdict. |
| `audio_done` | The reaction line finished or failed. |
| `manual` | A `mode.set` with `mode: "sleep"` ended the encounter early. |
| `cooldown_done` | The cooldown time elapsed. |
| `error` | A snapshot failed, no voice line of the needed category was available, or the device restarted after an internal error. |
| `conversation` | The doll entered `conversing` (S7). |
| `conversation_done` | The doll left `conversing` after a normal end (S7). |
| `photo_done` | A remote photo was taken and sent, so the doll goes back to rest (R2). |

*Reason (S7):* the timeline can show why the doll entered or left a conversation.

#### Reason mapping
The device sets `reason` by the **first row whose transition and cause both match**.

| From → To | Cause | `reason` |
|---|---|---|
| `sleeping` → `waking` | `pir.rising` | `presence` |
| any state other than `sleeping` → `sleeping` | restart after an internal error of the state machine, published by the device main loop | `error` |
| `cooldown` → `sleeping` | cooldown deadline | `cooldown_done` |
| `waking`, `seeking`, `gazing`, `greeting`, `warning` or `uncertain` → `cooldown` | `mode.set` with `mode: "sleep"` | `manual` |
| `conversing` → `cooldown` | `mode.set` with `mode: "sleep"` | `manual` |
| `conversing` → `cooldown` | `cloud.disconnected` | `offline` |
| `conversing` → `cooldown` | a `stranger` verdict for a `snapshot.request` | `verdict` |
| `conversing` → `cooldown` | `ConversationFinished` from the adapter, or `conversation.end` for the current session | `conversation_done` |
| `conversing` → `cooldown` | adapter failure | `error` |
| `conversing` → `cooldown` | `conversing` deadline | `timeout` |
| `sleeping` → `conversing` | `conversation.start` with `source: "manual"` | `conversation` |
| `sleeping` → `waking` | `snapshot.request` with `purpose: "photo"` | `manual` |
| `waking` → `cooldown` | cloud disconnected when leaving `waking` for a photo | `offline` |
| `seeking` → `cooldown` | the photo snapshot was published | `photo_done` |
| `seeking` → `cooldown` | `snapshot.failed` for the photo | `error` |
| `seeking` → `cooldown` | photo snapshot deadline | `timeout` |
| `greeting` → `conversing` | audio done with a pending conversation grant | `conversation` |
| `waking` → `uncertain` | cloud disconnected when leaving `waking`, whatever the leaving cause | `offline` |
| `waking` → `seeking` | `servo.arrived` and lantern fade-in elapsed | `arrived` |
| `waking` → `seeking` | waking deadline | `timeout` |
| `seeking` → `uncertain` | `cloud.disconnected` | `offline` |
| `seeking` → `uncertain` | `snapshot.failed` | `error` |
| `seeking` → `uncertain` | snapshot attempt deadline | `timeout` |
| `seeking` → `uncertain` | scan attempts used up with `no_face` | `no_face` |
| `seeking` → `gazing`, `greeting`, `warning` or `uncertain` | verdict | `verdict` |
| `gazing` → `greeting` or `warning` | `servo.arrived` | `arrived` |
| `gazing` → `greeting` or `warning` | gazing deadline | `timeout` |
| `greeting`, `warning` or `uncertain` → `cooldown` | no voice line of the needed category | `error` |
| `greeting`, `warning` or `uncertain` → `cooldown` | `audio.finished` or `audio.failed` | `audio_done` |
| `greeting`, `warning` or `uncertain` → `cooldown` | audio deadline | `timeout` |

*Reason (R2):* a remote photo is a short manual encounter: `sleeping` → `waking` → `seeking` →
`cooldown` → `sleeping`, with `presence.detected` `source: "manual"`, no `judgement.result`, no
reaction and no voice line. The `waking` → `seeking` rows of the table above also apply to it.

*Reason (S8):* one reason per cause. The conversation rows sit after the `manual` row of the other
states; the row for "any state other than `sleeping` → `sleeping`" is unchanged. A `stranger`
verdict inside `conversing` ends the conversation and the encounter goes to `cooldown`, not
`warning`; the next PIR edge after the cooldown starts a fresh encounter. (S9) `state.changed.to`
may be `conversing`, which is already in State, and `encounter.ended.reason` is unchanged: the
encounter still ends through `cooldown`.

### `error.reported` codes
The device publishes `error.reported` only with these codes.

| Code | Emitted by | When | `refId` |
|---|---|---|---|
| `unknown_type` | device, inbound check | undefined `type`, or an event or status type received as a command | message `id` |
| `unsupported_version` | device, inbound check | `v` greater than 1 | message `id` if it is a string, else `null` |
| `malformed_message` | device, inbound check | the message breaks a rule of this document (size, UTF-8, JSON, `v`, missing field, wrong type, value outside an enumeration, non-finite number, `speak` without exactly one of `lineId` and `audioUrl`) | message `id` if readable, else `null` |
| `wrong_device` | device, inbound check | `deviceId` differs from the device's own id | message `id` |
| `speak_rejected` | device, state machine | `audioUrl` while the accepted verdict is not `family`, or a `lineId` whose category is not permitted for the current situation | command `id` |
| `audio_busy` | device, state machine | `speak` while earlier audio is unfinished | command `id` |
| `command_rejected_state` | device, state machine | `gaze` or `lantern` in `sleeping` or `cooldown`; `speak` during the silent stare before the stranger line; `snapshot.request` with `purpose: "photo"` outside `sleeping` | command `id` |
| `unknown_line` | device, state machine | `speak.lineId` is not a cached voice line | command `id` |
| `voice_line_missing` | device, state machine | no cached voice line of the reaction's category | `null` |
| `voice_line_invalid` | device, startup | a voice line was rejected, or the voice manifest is missing or invalid | `null` |
| `voice_file_missing` | device, startup | a voice line's WAV file is missing or not 16-bit PCM mono | `null` |
| `audio_failed` | device, audio playback | playback failed, timed out or the file was missing | `null` |
| `download_failed` | device, audio playback | `audioUrl` download failed, timed out, was too large or was not a 16-bit PCM WAV | `null` |
| `audio_device_missing` | device, startup probe | `aplay -L` failed or does not list the configured audio device | `null` |
| `camera_missing` | device, startup probe | `rpicam-still --list-cameras` failed or found no camera | `null` |
| `camera_failed` | device, camera | capture failed or timed out | `null` |
| `snapshot_too_large` | device, camera | the JPEG is still above the device's JPEG limit (at most 90,000 bytes) at the lowest quality | `null` |
| `internal_error` | device, main loop | the state machine raised an exception and was restarted | `null` |
| `adapter_failed` | device, hardware adapter | an adapter worker raised an exception | `null` |
| `conversation_failed` | device, conversation client | the audio client failed: connect, authentication or transport | `null` |
| `microphone_failed` | device, microphone | `arecord` failed or produced no data | `null` |

*Reason (S12):* receivers handle the two voice codes without parsing text. `command_rejected_state`
also covers `speak` in `conversing`, a `snapshot.request` outside `conversing` or while another is
outstanding, and a `conversation.start` the doll cannot accept (S11).

## Commands (cloud → device)
| `type` | `data` | Meaning |
|---|---|---|
| `judgement.result` | `{ "snapshotId": string, "verdict": "family" \| "stranger" \| "no_face" \| "uncertain", "confidence": number, "face": { "left": number, "top": number, "width": number, "height": number } \| null }` | Verdict for one snapshot. `confidence` and the face box are fractions 0..1 of the image. Never contains a name. |
| `speak` | `{ "lineId": string \| null, "audioUrl": string \| null, "ja": string, "en": string, "remote": boolean }` | Say a line: exactly one of `lineId` (cached on the device) or `audioUrl` (short-lived HTTPS URL to a WAV file) is set. `remote` is optional (default `false`); see "`speak.remote`" below. |
| `gaze` | `{ "panDeg": number, "tiltDeg": number }` | Look in a direction. The device clamps to its calibrated limits and moves slowly. |
| `lantern` | `{ "level": number, "fadeMs": int }` | Lantern brightness 0..1 with a fade time. |
| `mode.set` | `{ "mode": "guard" \| "sleep" }` | `sleep` ignores presence until set back to `guard`. |
| `conversation.start` | `{ "sessionId": string, "token": string, "maxSeconds": int, "silenceSeconds": int, "source": "family_verdict" \| "manual" }` | Start the doll's audio client for a voice session. `token` is a secret: the device never logs it and never publishes it. |
| `conversation.end` | `{ "sessionId": string, "reason": ConversationEndReason }` | The cloud ends a session. Safe to receive twice and for an unknown session. |
| `snapshot.request` | `{ "requestId": string, "purpose": "look" \| "photo" }` | Take a snapshot. `purpose` is optional (default `"look"`). A `look` is valid in `conversing` only (voice session). A `photo` is valid in `sleeping` only: the doll wakes, takes one picture and goes back to rest (R2). Elsewhere the device answers `command_rejected_state`. The doll answers with a `snapshot.captured` that carries the same `requestId` (and `purpose: "photo"` for a photo). |

Changes from `voice-conversation` (S4 to S6):

- **S4 `conversation.start`.** *Reason:* starts the doll's audio client.
- **S5 `conversation.end`.** *Reason:* the cloud can end a session on the doll.
- **S6 `snapshot.request`.** *Reason:* serves the `look()` tool and the silent family re-check.
- **Field rules.** `sessionId` and `requestId` match `[A-Za-z0-9-]{1,64}`. `token` is 1 to 128
  characters. The doll clamps `maxSeconds` to 30..420 and `silenceSeconds` to 5..60; finite values
  outside these ranges are valid, as for other numbers. Cloud tool commands reuse `gaze` and
  `lantern` unchanged. *Reason:* bounds the values and keeps the existing command set.
- **S11 `speak` in `conversing`.** The device rejects it with `command_rejected_state`.
  *Reason:* one audio user at a time.

Notes on the command fields:

- **`speak.audioUrl`.** `https` only (redirects to a non-`https` URL are refused). It must point
  to a 16-bit PCM WAV of at most 2,000,000 bytes. The device plays it only when the encounter's
  accepted verdict is `family`, and otherwise rejects it with `speak_rejected`. A `speak` with
  both or neither of `lineId` and `audioUrl` set is malformed. *Reason:* bounds the download
  size and makes the privacy rule enforceable on the device.
- **`speak.remote`.** Optional boolean, default `false`, honoured only together with `audioUrl`. When
  `true`, the family typed this text on the dashboard; the device plays the WAV in any state except
  `conversing`, without the `family` verdict check, and still enforces the size limit, the
  download timeout and `audio_busy`. When `false`, the rule above applies unchanged. *Reason
  (R3):* the owner wants to warn or greet through the doll while nobody is recognised. The text is
  checked in the cloud (length, no threat word, no Latin letter, no emoji) before it is
  synthesized.
- **Out-of-range numbers.** The device clamps `lantern.level` to 0..1, `lantern.fadeMs` to
  0..10000 and the `judgement.result` face box fields to 0..1. `gaze` angles must be finite and
  are clamped to the calibrated limits. Finite numbers outside these ranges are valid, not
  malformed; non-finite numbers are malformed. *Reason:* defines device behaviour for
  out-of-range values.
- **Matching verdicts.** The device matches `judgement.result` by `snapshotId` only, never by
  `encounterId` (see "Commands without an encounter" above).

## Status (device → cloud)
| `type` | `data` | When |
|---|---|---|
| `status.report` | `{ "state": State, "mode": "guard" \| "sleep", "panDeg": number, "tiltDeg": number, "lantern": number, "cameraActive": boolean, "micActive": boolean, "motionEnabled": boolean, "uptimeSec": int, "agentVersion": string }` | On each state change, on each change of `cameraActive`, on the first tick after start, and every `status_interval_s` (default 60 s). |
| `status.offline` | `{}` | Published by the broker as the last will when the device disconnects. |

Notes on the status fields:

- **`mode`, timing and `encounterId`.** `status.report` carries the current mode and is sent at
  the times in the table. Its envelope always carries `encounterId: null`. *Reason:* the
  dashboard shows when the doll ignores presence, the camera indicator stays current, and
  status stays independent of encounters.
- **`micActive`.** `true` while the state is `conversing` and `false` otherwise. A
  `status.report` is also sent on each change of `micActive`, at the same moment as the state
  change (S10). *Reason:* makes the privacy indicator exact.
- **`status.offline` timing.** The broker publishes the last will that the device registered at
  connect time, so its `ts` is the connect time. Receivers use their own arrival time for it and
  never its `ts`. AWS does not guarantee the order of will messages across reconnects; a later
  `status.report` therefore overrides an earlier offline mark. *Reason:* avoids a false "offline"
  after a quick reconnect.
- **Session.** The device connects with a clean MQTT session and subscribes again on every
  connect. Commands sent while it is offline are lost, never replayed. *Reason:* a replayed
  `speak` or `gaze` would act on a visit that has ended.

## Device-internal events (not on the wire)
These events exist only inside the device, as inputs to its state machine. They are never
published on MQTT, never appear in envelopes, and are not part of the contract types above.
*Reason:* prevents the cloud and the dashboard from expecting them on MQTT.

| Event | Meaning |
|---|---|
| `tick` | Periodic clock event (every `tick_interval_ms`); all deadlines are checked on ticks. |
| `pir.rising` | The PIR sensor output went from low to high. |
| `pir.falling` | The PIR sensor output went from high to low. |
| `servo.arrived` | A head movement finished; carries its motion id. |
| `audio.finished` | A playback ended normally; carries its play id. |
| `audio.failed` | A playback or download failed or was interrupted; carries its play id and a code. |
| `snapshot.ready` | A snapshot JPEG is available; carries its snapshot id, the bytes, width and height. |
| `snapshot.failed` | A snapshot could not be taken; carries its snapshot id and `camera_failed` or `snapshot_too_large`. |
| `cloud.connected` | The device's cloud link came online. |
| `cloud.disconnected` | The device's cloud link went offline. |
| `adapter.error` | A hardware adapter failed; carries a code from the `error.reported` code list. |
| `ConversationFinished` | The conversation adapter ended, exactly once per session; carries the session id and a reason that is a `ConversationEndReason` or `adapter_failed`. |

## Shared definitions
- **State**: `sleeping` · `waking` · `seeking` · `gazing` · `greeting` · `warning` ·
  `uncertain` · `conversing` (P1) · `cooldown`.
- **Reason**: the `state.changed` reason values listed in "`state.changed` reasons".
- **ErrorCode**: the codes listed in "`error.reported` codes".
- **Angles** are degrees relative to the calibrated center. Positive pan turns the head
  toward larger image x (the doll's right); positive tilt looks up. Mounting direction is a
  device configuration concern (`pan_invert`, `tilt_invert`), not part of the contract.
- **Privacy:** names never appear in `judgement.result`, `status.report` or any event. The
  text of a `speak` command may contain a family nickname only when the verdict was `family`. A `remote` `speak` is typed by a family member, who is then responsible for what it says; the dashboard warns about this.
  The device discards `data` fields this document does not define. Voice transcripts and audio
  are never stored, and no tool result, prompt or frame contains a name (S14).
- **Voice-line catalog:** the device's `voice/lines.toml` (ids, categories, `ja`, `en`) is the
  single source of the catalog. `scripts/export_voice_catalog.py` copies it to the dashboard,
  and the cloud's `lineId` check uses the same ids. *Reason:* one source and a drift check
  keep the device, the cloud and the dashboard simulation on the same lines.
- **Idempotency:** every command is safe to receive twice. The device drops a repeated `id`
  within its duplicate window (see "Duplicates and extra fields").

## Voice session channels
Added by `voice-conversation` (S13). *Reason:* the doll, the cloud and the dashboard share one
frame definition. A voice session carries audio and text over an AWS AppSync Events API, not over
MQTT. The `v` of this contract stays 1.

### Namespace, channels and tokens
Namespace `voice`. A channel segment is at most 50 characters; `<sid>` is the session id (a UUID,
36 characters).

| Channel | Direction | Frames |
|---|---|---|
| `/voice/<sid>/in` | client → session | `hello`, `audio`, `look.result`, `bye` |
| `/voice/<sid>/out` | session → client | `audio`, `interrupt`, `command` |
| `/voice/<sid>/text` | session → client and observer | `state`, `transcript`, `end` |

A token is `<sessionId>.<secret>`, where `secret` is 32 random bytes in Base64URL. The token regex
is `^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$`. Two tokens exist.

| Token | Held by | Allowed operations |
|---|---|---|
| `clientToken` | the audio client (doll or browser) | publish `/voice/<sid>/in`; subscribe `/voice/<sid>/out` and `/voice/<sid>/text` |
| `observerToken` | a browser that started a doll session | subscribe `/voice/<sid>/text` |

The authorizer accepts a token only while the session phase is `starting` or `live` and
`expiresAt` is in the future. It rejects wildcard channels and every other channel. Tokens are
stored only as SHA-256 hashes. The doll never logs or publishes its token. *Reason:* a token is the
only credential of a session and must not leak.

### Frames
Every frame is a JSON object with a string `t`. A receiver ignores an unknown `t`. `LookVerdict` is
`family`, `stranger`, `no_face` or `uncertain`.

| Channel | `t` | Fields | Meaning |
|---|---|---|---|
| `in` | `hello` | `client: "device" \| "browser"`, `v: 1` | The client is connected and subscribed. |
| `in` | `audio` | `seq: int`, `pcm: string` | Microphone chunk. `pcm` is Base64 of 16 kHz S16LE mono. |
| `in` | `look.result` | `requestId: string`, `verdict: LookVerdict` | Virtual doll only: the simulated answer to a `snapshot.request` command frame. |
| `in` | `bye` | `reason: "user" \| "silence" \| "limit" \| "error"` | The client ends the session. |
| `out` | `audio` | `seq: int`, `pcm: string` | Model speech. `pcm` is Base64 of 24 kHz S16LE mono. |
| `out` | `interrupt` | none | Stop playback now (barge-in or unsafe output). |
| `out` | `command` | `envelope: Envelope` | Browser sessions only: a command envelope for the virtual doll. |
| `text` | `state` | `state: "waiting" \| "live" \| "ending"` | Session phase. |
| `text` | `transcript` | `role: "user" \| "assistant"`, `text: string`, `final: boolean` | Live subtitles. Never stored. |
| `text` | `end` | `reason: ConversationEndReason` | The session ended. |

Limits: an audio chunk of 100 ms is 3,200 bytes in and 4,800 bytes out, about 4.3 KB and 6.4 KB
after Base64, far below the 240 KB subscription limit. A frame is malformed when `pcm` is not valid
Base64, decodes to an odd number of bytes, or decodes to more than 12,800 bytes. A decoder never
throws; it returns the frame or a malformed result. A transcript text, like every other frame
field, never contains a name. *Reason:* bounds the input and keeps every receiver total.

**Hello.** A client sends `hello` once, right after it subscribed. The session treats a second
`hello` as the first, and it treats the first `in` `audio` frame that arrives before any `hello`
as the `hello`; that audio frame itself is dropped, because the model stream is not open yet.
*Reason (S21):* AppSync Events does not keep messages for a subscriber that is not connected yet,
so a `hello` published before the session Lambda finished subscribing to `/voice/<sid>/in` is lost.
Without this rule such a session waits until `noClientSeconds` while the client already streams
audio. The rule needs no client change and covers the doll and the browser.

## HTTP API (dashboard ⇄ cloud)
Defined by the `cloud-judgement` design. Encounter records reuse the envelope and the types
above so the timeline and the simulation share one model.

### Conventions
- **Base URL and settings.** The dashboard reads `/config.json` from its own origin at start-up:
  `{ "apiUrl", "region", "userPoolId", "userPoolClientId", "illustrationBase" }`. Nothing is
  compiled in.
- **Auth.** `Authorization: Bearer <Cognito access token>`. The cloud derives the role from the
  `cognito:groups` claim: `family`, `reviewer`. If both groups are present, `reviewer` applies. No
  group means no access.
- **Format.** JSON, UTF-8. Timestamps are UTC ISO 8601 with milliseconds. Ids are UUIDs except
  `sampleId`, which matches `[a-z0-9_-]{1,64}`.
- **Errors.** `{ "error": { "code": string, "message": string } }`. Codes: `unauthorized` (401),
  `forbidden` (403), `not_found` (404), `validation_failed` (400), `consent_required` (409),
  `face_count_invalid` (422), `rate_limited` (429, with `Retry-After` seconds), `internal` (500),
  `session_active` (409, a session already uses this doll or this virtual doll),
  `voice_unavailable` (503, kill switch or a failed start). A daily voice cap gives the existing
  `429 rate_limited` with `Retry-After` set to the seconds until the next UTC midnight (S19).
  Messages are at most 200 characters and never contain image data, face ids, names or pre-signed
  URLs. `Retry-After` is a whole number of seconds from 1 to 86,400. *Reason:* the error list is
  checked against the implementation (see "Fixtures and contract checks").
- **Every route requires a valid Cognito token.** A missing, malformed, expired or foreign token
  gives `401 unauthorized`; a token without a role, or a role not allowed for the route, gives
  `403 forbidden`. Neither has a side effect. The role comes only from the token claims, never from
  the body, query or headers. A route not in the matrix is denied for both roles.
- **Validation.** Malformed JSON, a missing or wrongly typed field, a value outside its range or a
  body larger than 1,048,576 bytes gives `400 validation_failed` and changes nothing.
- **CORS.** The API answers cross-origin requests only from the dashboard origin.
- **Role matrix.** `F` family, `R` reviewer.

| Route | F | R | Notes |
|---|---|---|---|
| `GET /me` | yes | yes | |
| `GET /samples` | yes | yes | |
| `GET /encounters` | full | redacted | |
| `GET /encounters/{id}` | full | redacted | |
| `GET /device/status` | yes | yes | |
| `POST /simulate` | yes | yes | rate limited |
| `POST /commands` | yes | no | |
| `GET /faces` | yes | no | |
| `POST /faces/upload` | yes | no | |
| `POST /faces` | yes | no | |
| `DELETE /faces/{memberId}` | yes | no | |
| `POST /photos` | yes | no | family only; asks the doll for one photo |
| `GET /photos/{requestId}` | yes | no | family only |
| `POST /say` | yes | no | family only; rate limited |
| `POST /conversations` | yes | only when `reviewerVoiceEnabled` | reviewer: browser client and virtual target only; otherwise `403 forbidden` |
| `GET /conversations/{sessionId}` | owner | owner | a non-owner gets `404 not_found` |
| `DELETE /conversations/{sessionId}` | owner | owner | a non-owner gets `404 not_found` |

### Routes
`GET /me` → `{ "role": "family" | "reviewer", "consentNoticeVersion": string, "limits": { "simulatePerHour": int, "generatePerHour": int }, "voice": { "enabled": boolean, "maxSeconds": int, "remainingToday": int } }`.
Each limit is an integer of at least 1. `voice.remainingToday` is an integer of at least 0.
*Reason (S18):* the dashboard can disable the Talk button and show the reason.
`consentNoticeVersion` names a notice text that the dashboard bundles under
`dashboard/src/content/consent/<version>.md`. The cloud and the dashboard are released together
whenever this version changes. *Reason:* the version a family member accepts must match the text
they were shown, and a cloud that expects a version the dashboard does not bundle would make every
face registration fail with `409 consent_required`.
A translation of a notice lives beside it as `<version>.<lang>.md` (today `ja`). It is the same
notice in another language, so it carries the same version, and `consent.noticeVersion` is the
same whichever language the family member read. The English `<version>.md` is the source and must
exist; a translation without it is ignored, and a missing translation falls back to English.
*Reason:* the dashboard has a Japanese UI, and a translated notice must never create a version the
cloud does not know.

`GET /samples` → `{ "samples": [ { "sampleId": string, "label": "family" | "stranger" | "no_face" | "uncertain" } ] }`.
Labels are the expected outcome shown in the dashboard. They never contain names.

`GET /encounters?limit=20&cursor=<opaque>` → `{ "items": [Encounter], "nextCursor": string | null }`.
`limit` is an integer from 1 to 50 (default 20). Newest first. Items past their expiry are never
returned. A `limit` outside 1 to 50 or a `cursor` this API did not issue gives `400 validation_failed`.

`GET /encounters/{id}` → `Encounter` with `events` filled, in time order. An unknown or expired id
gives `404 not_found`. When the owner sets `reviewerRealEncounters` to `hidden`, `reviewer` gets an
empty list with `nextCursor: null` and `404 not_found` for every id. *Reason:* lets the owner hide
real visits from the public demo account.

`GET /device/status?deviceId=warashi-01` → `{ "deviceId", "online": boolean, "lastSeenAt": ts | null, "status": StatusReportData | null }`.
`StatusReportData` is the `data` of `status.report`, including `cameraActive` and `micActive`.
`online` is false when the last `status.offline` arrived after the last `status.report`, or when no
report arrived within 3 × `status_interval_s`.

`POST /simulate` body `{ "sampleId": string, "generate": boolean }`. `generate` is optional and
defaults to `false`; a non-boolean value, or a `sampleId` that is missing, malformed or not in the
sample manifest, gives `400 validation_failed`. Any other body field is ignored; no image is ever
accepted. Over a rate limit it gives `429 rate_limited`; a failed search or speech generation gives
`500 internal` with no partial result. Success returns 200 with
`{ "sampleId", "verdict", "confidence", "face", "commands": [Envelope], "speech": Speech | null, "latencyMs": { "total": int, "search": int } }`.
`latencyMs.total` and `latencyMs.search` are integer milliseconds with `search` ≤ `total`.
`commands` holds the `judgement.result` and the `speak` that the doll would act on, in that order (envelopes use
`deviceId: "warashi-sim"`, `encounterId: null`). `Speech` is
`{ "lineId": string | null, "ja": string, "en": string, "mp3Url": string | null, "generated": boolean }`;
`mp3Url` is a pre-signed URL valid for 5 minutes. Nothing is published to a doll and no encounter
is stored.

`POST /commands` body `{ "deviceId": string, "command": { "type": "speak" | "gaze" | "lantern" | "mode.set", "data": object } }`
→ `202 { "id": uuid, "deviceOnline": boolean }`. `data` follows "Commands (cloud → device)", with
`speak` limited to `lineId` (a cached line); `audioUrl` is rejected with `validation_failed`.
The cloud clamps `lantern.level` to 0..1, `lantern.fadeMs` to 0..10000, `gaze.panDeg` to -60..60
and `gaze.tiltDeg` to -30..30 (the widest limits the device config accepts), and publishes with
QoS 1 to `warashi/<deviceId>/commands` with `encounterId: null`. `deviceId` is 1 to 64 characters of
`[A-Za-z0-9_-]`. `speak` needs a `lineId` from the line catalog, which is the device's `voice/lines.toml`
(see "Shared definitions"); the cloud's `lineId` check uses the same ids. An unknown `type`, a missing or
non-finite number, or a `mode` other than `guard` or `sleep` gives `400 validation_failed` and
publishes nothing. An offline doll still gets one publish and `deviceOnline: false`; the command is
never stored or replayed. A failed publish gives `500 internal` without a retry. *Reason:* the
dashboard cannot make the doll move beyond what the hardware rules allow, and a late command
never acts on a visit that has ended.

`POST /photos` body `{ "deviceId": string }` → `202 { "requestId": uuid, "deviceOnline": boolean }` (R4).
The cloud publishes `snapshot.request` with `purpose: "photo"` and the new `requestId` to
`warashi/<deviceId>/commands` and stores nothing yet. An offline doll still gets one publish
and `deviceOnline: false`. `deviceId` follows the rule of `POST /commands`. Over the hourly limit it
gives `429 rate_limited`. `reviewer` gets `403 forbidden`.

`GET /photos/{requestId}` → `{ "status": "pending" }` or
`{ "status": "ready", "url": string, "expiresAt": ts }` (R5). `url` is a pre-signed GET valid for
5 minutes; `ready` appears when the doll's `snapshot.captured` with `purpose: "photo"` and that
`requestId` was stored. An id that was never asked for, or whose picture has expired, stays
`pending` (the dashboard stops asking after a timeout). The picture expires with the other
snapshots (a few days). `reviewer` gets `403 forbidden`; the response never carries a name.

`POST /say` body `{ "deviceId": string, "text": string }` → `202 { "id": uuid, "deviceOnline": boolean }` (R6).
`text` is 1 to 60 characters (code points) and at most three sentences, with no Latin letter, no
emoji and no threat word; otherwise `400 validation_failed` and nothing is sent. The cloud
synthesizes a 16 kHz mono 16-bit PCM WAV with Polly (Japanese), stores it under the expiring
`audio/` prefix and publishes `speak` with `audioUrl` (5-minute URL), `remote: true`, `lineId: null`,
`ja` set to the text and `en` set to the fixed subtitle `A message from the family.`; it never
stores the text. Over the hourly limit it gives `429 rate_limited`; a failed synthesis gives
`500 internal`. `reviewer` gets `403 forbidden`.

`GET /faces` → `{ "members": [ { "memberId": uuid, "displayName": string, "createdAt": ts, "consentVersion": string, "faceCount": int } ] }`

`POST /faces/upload` → `{ "url": string, "fields": object, "stagingKey": string, "expiresInS": 300 }`
(pre-signed POST, JPEG or PNG, at most 5,000,000 bytes).

`POST /faces` body `{ "stagingKey": string, "displayName": string (1..40), "memberId": uuid | null, "consent": { "noticeVersion": string, "accepted": true } }`
→ `201 { "memberId": uuid, "faceCount": int }`. `consent.noticeVersion` must equal
`consentNoticeVersion` from `GET /me` and `accepted` must be `true`, otherwise `409 consent_required`.
`displayName` outside 1..40 characters gives `400 validation_failed`. The photo must contain
exactly one face, otherwise `422 face_count_invalid` (faces indexed from that photo are removed).
The staging object is deleted in every case. A given `memberId` adds another photo of the same
person and keeps the existing `displayName`; an unknown `memberId` gives `404 not_found`. The
face is indexed with an opaque member id, never a name. `GET /faces` never returns face ids. Every
`/faces` route gives `403 forbidden` to `reviewer`.

`DELETE /faces/{memberId}` → `204`. Deletes the face vectors and the member record.

`POST /conversations` body `{ "deviceId": string, "client": "browser" | "device", "target": "real" | "virtual" }`
(S16). `client: "device"` requires `target: "real"`, and `target: "real"` requires `family`.
`reviewer` may start only a browser session against the virtual doll, and only when
`reviewerVoiceEnabled` is on. Success for `browser` is `201 { "sessionId", "clientToken", "hosts": { "http", "realtime" }, "channels": { "in", "out", "text" }, "maxSeconds", "silenceSeconds", "expiresAt" }`.
Success for `device` is `202 { "sessionId", "observerToken", "hosts", "channels", "deviceOnline": boolean }`;
the cloud sends the doll a `conversation.start` command with `source: "manual"`. A busy doll or
virtual doll gives `409 session_active`; a kill switch or a failed start gives
`503 voice_unavailable`; a daily cap gives `429 rate_limited`. *Reason:* one start route for both
clients.

`GET /conversations/{sessionId}` → `{ "sessionId", "phase", "endReason": ConversationEndReason | null }`
(S17). `DELETE /conversations/{sessionId}` → `204` and ends the session with reason `user`. A
non-owner or an unknown id gives `404 not_found`. *Reason:* lets the UI show a failed start.

### Encounter record
```json
{
  "encounterId": "c1d2e3f4-0000-4000-8000-000000000001",
  "deviceId": "warashi-01",
  "startedAt": "2026-11-20T12:34:56.789Z",
  "endedAt": "2026-11-20T12:35:30.100Z",
  "state": "cooldown",
  "verdict": "stranger",
  "confidence": 0.97,
  "reaction": { "kind": "stranger", "lineId": "stranger_first", "offline": false },
  "notified": true,
  "snapshot": { "url": "https://example.invalid/signed", "expiresAt": "2026-11-20T12:40:00.000Z" },
  "illustration": null,
  "events": []
}
```

| Field | Meaning |
|---|---|
| `state` | Last `state.changed.to`, or `null`. |
| `verdict`, `confidence` | From the cloud's `judgement.result`, or `null` when none was sent (offline reaction). |
| `reaction` | Data of the last `reaction.performed`, or `null`. |
| `notified` | True when a stranger notification was sent for this encounter. |
| `snapshot` | Family only: a pre-signed GET URL valid for 5 minutes, or `null` when the image expired or never existed. Always `null` for `reviewer`. |
| `illustration` | Reviewer only: `silhouette-family`, `silhouette-stranger`, `silhouette-none` or `silhouette-uncertain`; `null` for `family`. |
| `events` | `[]` in list responses. In `GET /encounters/{id}` the envelopes in time order, with the `jpegBase64` rule above. |

`illustration` follows the verdict: `family` → `silhouette-family`, `stranger` →
`silhouette-stranger`, `no_face` → `silhouette-none`, `uncertain` or `null` → `silhouette-uncertain`.

For `reviewer` the record also has no face box, no member data and no image reference of any kind
at any depth. In its `events`, `hasImage`, `jpegBase64` and `face` are removed and every other
field, the order and the count stay unchanged. *Reason:* a public demo account must never see
inside the household. A `family` record is the stored record plus `snapshot`.

### Fixtures and contract checks
`docs/fixtures/schema-v1/` holds **one golden message per type**, at least one file for each event,
command and status type listed in this document (including `status.offline`). The Python and the
TypeScript tests both decode every fixture to `valid` and re-encode it to a semantically equal
value (key order ignored). A type without a fixture, or a fixture without a type, fails the tests
and names the type or file.

`docs/fixtures/schema-v1/` also holds one golden file for each type added by `voice-conversation`:
`conversation.requested`, `conversation.ended`, `conversation.start`, `conversation.end` and
`snapshot.request`.

`docs/fixtures/voice-v1/` holds **one golden frame for each frame type and direction** listed in
"Voice session channels", plus `sonic-session-ok.jsonl` and `sonic-session-tools.jsonl` (scripted
Bedrock event streams with short synthetic audio and placeholder text). The Python, TypeScript and
dashboard tests decode every file and re-encode it to a semantically equal value. A frame without a
fixture, or a fixture without a frame, fails and names it. *Reason:* the same bytes are checked in
all three parts.

The route table and the error code list in "HTTP API" are also checked by tests (S20, which now
include the voice routes and the codes `session_active` and `voice_unavailable`): the routes and
codes implemented in `/cloud` must equal the role matrix and the error list above, and a missing or
extra entry fails the tests and is named. *Reason:* this document stays the single source of truth,
and drift is caught by a test instead of by a reviewer.

`docs/fixtures/simulate-v1/` holds one example of a successful `POST /simulate` response for each of
`family.json`, `stranger.json` and `no_face.json`. Each has `commands` in the order
`judgement.result`, `speak` (envelopes with `deviceId: "warashi-sim"` and `encounterId: null`), a
`face` box and `confidence` within 0..1, `latencyMs.search` ≤ `latencyMs.total`, and no name or image
data. The dashboard tests (`dashboard-simulation` task 5.2, which also checks that its bundled copies
are identical) and the cloud tests of `/simulate` check this shape. *Reason:* the dashboard's offline
simulation and the live cloud answer stay in the same shape, and a test catches drift.
