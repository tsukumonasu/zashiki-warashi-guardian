# Message contract — draft v1

Single source of truth for everything exchanged between the doll (`/device`), the cloud
(`/cloud`) and the dashboard (`/dashboard`, including the simulation).

> Status: **draft v1, refined by the `device-core-loop` design**
> (`.kiro/specs/device-core-loop/design.md`, section "docs/schema.md Changes"). Each change is
> marked with its reason next to it. Refine it again in `cloud-judgement` once AWS limits are
> verified. From now on, change this file first and keep code and tests in all three parts in
> sync with it.

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

Snapshot size: the whole MQTT message must stay under the AWS IoT Core message size limit
(128 KB at the time of writing — **verify in the AWS documentation**; the `cloud-judgement`
spec does this). The device therefore keeps the raw JPEG at or below 90,000 bytes (640×480,
reduced quality if needed) before base64-encoding it. *Reason:* the limit is kept until the
cloud spec verifies the broker limit.

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
To be defined in the `cloud-judgement` design. Encounter records returned by the API reuse
the envelope and the types above so the timeline and the simulation share one model.
