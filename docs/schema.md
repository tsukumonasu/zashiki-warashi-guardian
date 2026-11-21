# Message contract — draft v1

Single source of truth for everything exchanged between the doll (`/device`), the cloud
(`/cloud`) and the dashboard (`/dashboard`, including the simulation).

> Status: **draft v1, refined by the `device-core-loop` design**
> (`.kiro/specs/device-core-loop/design.md`, section "docs/schema.md Changes"). Each change is
> marked with its reason next to it. The `cloud-judgement` design
> (`.kiro/specs/cloud-judgement/design.md`) verified the AWS limits, clarified a few cloud-side
> rules and defined the HTTP API below. No event or command field changed, so `v` stays 1. From
> now on, change this file first and keep code and tests in all three parts in sync with it.

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
| `snapshot.captured` | `{ "snapshotId": string, "width": int, "height": int, "panDeg": number, "tiltDeg": number, "jpegBase64": string }` | A snapshot taken at the given head angles. Asks the cloud for a verdict. |
| `state.changed` | `{ "from": State, "to": State, "reason": Reason }` | State machine transition. `reason` is one of the values in "`state.changed` reasons" below. |
| `reaction.performed` | `{ "kind": "family" \| "stranger" \| "uncertain", "lineId": string \| null, "offline": boolean }` | What the doll actually did. `offline` is true when it reacted without a verdict. |
| `encounter.ended` | `{ "reason": "cooldown" \| "manual" \| "error" }` | The encounter is over. |
| `error.reported` | `{ "code": ErrorCode, "message": string, "refId": string \| null }` | A recoverable problem (no secrets, no image data). `code` is one of the codes in "`error.reported` codes" below. `refId` is always present. |

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

#### Reason mapping
The device sets `reason` by the **first row whose transition and cause both match**.

| From → To | Cause | `reason` |
|---|---|---|
| `sleeping` → `waking` | `pir.rising` | `presence` |
| any state other than `sleeping` → `sleeping` | restart after an internal error of the state machine, published by the device main loop | `error` |
| `cooldown` → `sleeping` | cooldown deadline | `cooldown_done` |
| `waking`, `seeking`, `gazing`, `greeting`, `warning` or `uncertain` → `cooldown` | `mode.set` with `mode: "sleep"` | `manual` |
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
| `command_rejected_state` | device, state machine | `gaze` or `lantern` in `sleeping` or `cooldown`; `speak` during the silent stare before the stranger line | command `id` |
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

## Commands (cloud → device)
| `type` | `data` | Meaning |
|---|---|---|
| `judgement.result` | `{ "snapshotId": string, "verdict": "family" \| "stranger" \| "no_face" \| "uncertain", "confidence": number, "face": { "left": number, "top": number, "width": number, "height": number } \| null }` | Verdict for one snapshot. `confidence` and the face box are fractions 0..1 of the image. Never contains a name. |
| `speak` | `{ "lineId": string \| null, "audioUrl": string \| null, "ja": string, "en": string }` | Say a line: exactly one of `lineId` (cached on the device) or `audioUrl` (short-lived HTTPS URL to a WAV file) is set. |
| `gaze` | `{ "panDeg": number, "tiltDeg": number }` | Look in a direction. The device clamps to its calibrated limits and moves slowly. |
| `lantern` | `{ "level": number, "fadeMs": int }` | Lantern brightness 0..1 with a fade time. |
| `mode.set` | `{ "mode": "guard" \| "sleep" }` | `sleep` ignores presence until set back to `guard`. |

Notes on the command fields:

- **`speak.audioUrl`.** `https` only (redirects to a non-`https` URL are refused). It must point
  to a 16-bit PCM WAV of at most 2,000,000 bytes. The device plays it only when the encounter's
  accepted verdict is `family`, and otherwise rejects it with `speak_rejected`. A `speak` with
  both or neither of `lineId` and `audioUrl` set is malformed. *Reason:* bounds the download
  size and makes the privacy rule enforceable on the device.
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
- **`micActive`.** `false` while no feature records audio (no feature of `device-core-loop`
  does). *Reason:* makes the privacy indicator exact.
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

## Shared definitions
- **State**: `sleeping` · `waking` · `seeking` · `gazing` · `greeting` · `warning` ·
  `uncertain` · `conversing` (P1) · `cooldown`.
- **Reason**: the `state.changed` reason values listed in "`state.changed` reasons".
- **ErrorCode**: the codes listed in "`error.reported` codes".
- **Angles** are degrees relative to the calibrated center. Positive pan turns the head
  toward larger image x (the doll's right); positive tilt looks up. Mounting direction is a
  device configuration concern (`pan_invert`, `tilt_invert`), not part of the contract.
- **Privacy:** names never appear in `judgement.result`, `status.report` or any event. The
  text of a `speak` command may contain a family nickname only when the verdict was `family`.
  The device discards `data` fields this document does not define.
- **Idempotency:** every command is safe to receive twice. The device drops a repeated `id`
  within its duplicate window (see "Duplicates and extra fields").

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
  `face_count_invalid` (422), `rate_limited` (429, with `Retry-After` seconds), `internal` (500).
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

### Routes
`GET /me` → `{ "role": "family" | "reviewer", "consentNoticeVersion": string, "limits": { "simulatePerHour": int, "generatePerHour": int } }`.
Each limit is an integer of at least 1.

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
`[A-Za-z0-9_-]`. `speak` needs a `lineId` from the line catalog. An unknown `type`, a missing or
non-finite number, or a `mode` other than `guard` or `sleep` gives `400 validation_failed` and
publishes nothing. An offline doll still gets one publish and `deviceOnline: false`; the command is
never stored or replayed. A failed publish gives `500 internal` without a retry. *Reason:* the
dashboard cannot make the doll move beyond what the hardware rules allow, and a late command
never acts on a visit that has ended.

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

The route table and the error code list in "HTTP API" are also checked by tests: the routes and
codes implemented in `/cloud` must equal the role matrix and the error list above, and a missing or
extra entry fails the tests and is named. *Reason:* this document stays the single source of truth,
and drift is caught by a test instead of by a reviewer.
