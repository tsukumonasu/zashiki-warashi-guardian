# Message contract — draft v1

Single source of truth for everything exchanged between the doll (`/device`), the cloud
(`/cloud`) and the dashboard (`/dashboard`, including the simulation).

> Status: **draft written before the first spec.** Refine it during the `device-core-loop`
> design phase (and again in `cloud-judgement` once AWS limits are verified). After that,
> change this file first and keep code and tests in all three parts in sync with it.

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
| `v` | Contract version. A receiver ignores a message with a higher `v` and reports `error.reported`. |
| `id` | Unique message id (UUID). Receivers drop duplicates (QoS 1 can redeliver). |
| `ts` | Sender time, UTC, ISO 8601 with milliseconds. |
| `deviceId` | The doll this message belongs to. |
| `encounterId` | Groups everything from one visit. Created by the device on `presence.detected`; `null` outside an encounter. |
| `type`, `data` | See the tables below. Unknown types are ignored and reported, never fatal. |

## Events (device → cloud)
| `type` | `data` | Meaning |
|---|---|---|
| `presence.detected` | `{ "source": "pir" \| "sound" \| "manual" }` | A new encounter starts. |
| `snapshot.captured` | `{ "snapshotId": string, "width": int, "height": int, "panDeg": number, "tiltDeg": number, "jpegBase64": string }` | A snapshot taken at the given head angles. Asks the cloud for a verdict. |
| `state.changed` | `{ "from": State, "to": State }` | State machine transition. |
| `reaction.performed` | `{ "kind": "family" \| "stranger" \| "uncertain", "lineId": string \| null, "offline": boolean }` | What the doll actually did. `offline` is true when it reacted without a verdict. |
| `encounter.ended` | `{ "reason": "cooldown" \| "timeout" \| "manual" }` | The encounter is over. |
| `error.reported` | `{ "code": string, "message": string }` | A recoverable problem (no secrets, no image data). |

Snapshot size: the whole MQTT message must stay under the AWS IoT Core message size limit
(128 KB at the time of writing — **verify in the AWS documentation**). The device therefore
keeps the raw JPEG at or below 90,000 bytes (640×480, reduced quality if needed) before
base64-encoding it.

## Commands (cloud → device)
| `type` | `data` | Meaning |
|---|---|---|
| `judgement.result` | `{ "snapshotId": string, "verdict": "family" \| "stranger" \| "no_face" \| "uncertain", "confidence": number, "face": { "left": number, "top": number, "width": number, "height": number } \| null }` | Verdict for one snapshot. `confidence` and the face box are fractions 0..1 of the image. Never contains a name. |
| `speak` | `{ "lineId": string \| null, "audioUrl": string \| null, "ja": string, "en": string }` | Say a line: exactly one of `lineId` (cached on the device) or `audioUrl` (short-lived HTTPS URL to a WAV file) is set. |
| `gaze` | `{ "panDeg": number, "tiltDeg": number }` | Look in a direction. The device clamps to its calibrated limits and moves slowly. |
| `lantern` | `{ "level": number, "fadeMs": int }` | Lantern brightness 0..1 with a fade time. |
| `mode.set` | `{ "mode": "guard" \| "sleep" }` | `sleep` ignores presence until set back to `guard`. |

## Status (device → cloud)
| `type` | `data` | When |
|---|---|---|
| `status.report` | `{ "state": State, "panDeg": number, "tiltDeg": number, "lantern": number, "cameraActive": boolean, "micActive": boolean, "motionEnabled": boolean, "uptimeSec": int, "agentVersion": string }` | Every 60 s and on each state change. |
| `status.offline` | `{}` | Published by the broker as the last will when the device disconnects. |

## Shared definitions
- **State**: `sleeping` · `waking` · `seeking` · `gazing` · `greeting` · `warning` ·
  `uncertain` · `conversing` (P1) · `cooldown`.
- **Angles** are degrees relative to the calibrated center. Positive pan turns the head
  toward larger image x (the doll's right); positive tilt looks up. Mounting direction is a
  device configuration concern (`pan_invert`, `tilt_invert`), not part of the contract.
- **Privacy:** names never appear in `judgement.result`, `status.report` or any event. The
  text of a `speak` command may contain a family nickname only when the verdict was `family`.
- **Idempotency:** every command is safe to receive twice.

## HTTP API (dashboard ⇄ cloud)
To be defined in the `cloud-judgement` design. Encounter records returned by the API reuse
the envelope and the types above so the timeline and the simulation share one model.
