# Architecture

How the three parts fit together. The message contract is `docs/schema.md`; this file shows
the cloud side as built by the `cloud-judgement` spec. Everything deploys to `ap-northeast-1`.

## Overview

```mermaid
graph TD
    subgraph Doll["Doll (Pi Zero W)"]
        AG[warashi-agent<br/>MqttCloudLink]
    end
    subgraph IoT["AWS IoT Core"]
        BR[MQTT broker<br/>8883, X.509]
        R1[Rule: snapshots]
        R2[Rules: events and status]
    end
    subgraph Fn["Lambda (Node.js)"]
        J[judge]
        I[ingest]
        A1[api-read]
        SG[snapshot-signer]
        A2[api-simulate]
        A3[api-admin]
    end
    subgraph Data["Data"]
        S3[(S3 data bucket)]
        DDB[(DynamoDB warashi)]
        RK1[Rekognition<br/>household collection]
        RK2[Rekognition<br/>demo collection]
    end
    SNS[SNS topic<br/>stranger alerts]
    BED[Bedrock Nova Lite]
    POL[Polly neural]
    subgraph Web["Web"]
        CF[CloudFront + S3 OAC]
        APIGW[HTTP API<br/>JWT authorizer]
        COG[Cognito user pool<br/>groups: family, reviewer]
    end
    DASH[Dashboard SPA]

    AG <-->|MQTT QoS 1| BR
    BR --> R1 --> J
    BR --> R2 --> I
    J --> RK1
    J --> S3
    J --> DDB
    J --> SNS
    J -->|iot-data Publish qos=1| BR
    I --> DDB
    DASH --> CF
    DASH --> COG
    DASH --> APIGW
    APIGW --> A1 --> DDB
    A1 -->|invoke, family only| SG --> S3
    APIGW --> A2 --> RK2
    A2 --> BED
    A2 --> POL
    A2 --> S3
    A2 --> DDB
    APIGW --> A3 --> RK1
    A3 --> S3
    A3 --> DDB
    A3 -->|iot-data Publish qos=1| BR
```

`POST /commands` runs in its own function (`ApiCommands`) so that `api-admin` holds no IoT
permission. Only `snapshot-signer` can read `snapshots/*`.

## CDK stacks (`cloud/lib`)

| Stack (file) | Contents |
|---|---|
| `DataStack` (`data-stack.ts`) | Private S3 data bucket with lifecycle rules per prefix, DynamoDB table `warashi` (on demand, TTL, one GSI), Rekognition collections for the household and the demo. |
| `JudgementStack` (`judgement-stack.ts`) | IoT data endpoint lookup, device IoT policy (`device-policy.ts`), topic rules, `judge` and `ingest` functions, SNS topic for stranger alerts. |
| `ApiStack` (`api-stack.ts`) | Cognito user pool (groups `family`, `reviewer`), HTTP API with JWT authorizer, `api-read`, `snapshot-signer`, `api-simulate`, `api-admin`, commands function. |
| `WebStack` (`web-stack.ts`) | Private S3 site bucket, CloudFront with origin access control, `config.json` deployment, API CORS setting. |
| `BudgetStack` (`budget-stack.ts`) | Monthly cost budget with notifications. |

Wiring is in `cloud/bin/cloud.ts`. Shared settings are read in `cloud/lib/context.ts`.
Deploy order: `DataStack`, `JudgementStack`, `ApiStack`, `WebStack`; `BudgetStack` is independent.

## Lambda functions (`cloud/lambda/<function>`)

Each function is a thin `index.ts` handler plus a pure `*-core.ts` module.

| Function | Trigger | Purpose |
|---|---|---|
| `judge` | IoT rule (`snapshot.captured`) | Verdict, `judgement.result` command, snapshot storage, encounter update, stranger notification. |
| `ingest` | IoT rules (events, status) | Validate, drop duplicates, strip the image, append to the encounter log, track device status. |
| `api-read` | HTTP API | `/me`, `/samples`, `/encounters`, `/encounters/{id}`, `/device/status`, with role-based redaction. |
| `snapshot-signer` | Internal invoke from `api-read` | Signs short-lived snapshot URLs for the family role only. |
| `api-simulate` | HTTP API | `POST /simulate` against the demo collection, optional generated speech. |
| `api-admin` | HTTP API (family) | Face registration and deletion. `POST /commands` is a separate function. |

## Ports and adapters

Decision logic lives in pure modules under `cloud/lambda/_shared` (`verdict.ts`, `notify.ts`,
`messages.ts`, `redact.ts`, `authz.ts`, `ratelimit.ts`, `sanitizer.ts`, `persona.ts`, `lines.ts`,
`wav.ts`, `ttl.ts`, `config.ts`). Time and randomness are passed in. AWS calls sit behind the
interfaces in `_shared/ports.ts`; the real implementations are in `_shared/adapters/`.

| Port | Adapter | AWS service |
|---|---|---|
| `FaceSearch` | `adapters/rekognition.ts` | Rekognition |
| `SnapshotStore` | `adapters/s3.ts` | S3 |
| `DeviceBus` | `adapters/iot-bus.ts` | IoT Core data plane |
| `Notifier` | `adapters/sns.ts` | SNS |
| `SpeechSynth` | `adapters/speech.ts` | Bedrock, Polly |
| `StateStore`, `Repository` | `adapters/dynamo.ts` | DynamoDB |

Tests use the fakes in `cloud/test/fakes.ts`, so `make test` needs no AWS account.

## Data flow: one snapshot

```mermaid
sequenceDiagram
    participant D as Doll
    participant B as IoT broker
    participant J as judge Lambda
    participant R as Rekognition
    participant S as S3
    participant T as DynamoDB
    participant N as SNS

    D->>B: events: snapshot.captured (QoS 1)
    B->>J: rule invokes asynchronously
    J->>T: claim SNAP#snapshotId (conditional put)
    par
        J->>R: SearchFacesByImage
        J->>S: PutObject snapshots/...
    end
    opt stranger candidate or invalid image
        J->>R: DetectFaces
    end
    J->>B: commands: judgement.result (QoS 1)
    B->>D: judgement.result
    J->>T: write verdict, event, snapshot key
    opt verdict is stranger and notification allowed
        J->>T: transact: claim notify slot
        J->>N: publish one message
    end
```

The `ingest` function receives every event and status message in parallel and writes the
encounter log. It removes `jpegBase64` and sets `hasImage: true` before storing.

## Data flow: dashboard simulation

```mermaid
sequenceDiagram
    participant W as Dashboard
    participant G as HTTP API
    participant A as api-simulate
    participant T as DynamoDB
    participant R as Rekognition (demo)
    participant L as Bedrock + Polly

    W->>G: POST /simulate {sampleId, generate}
    G->>A: JWT claims
    A->>T: increment rate counters (conditional)
    A->>R: SearchFacesByImage on the sample image
    A->>A: decide verdict, build commands, choose line
    opt generate and under the cap
        A->>L: line, sanitize, MP3
    end
    A-->>W: verdict, commands, speech, latency
```

Nothing is published to the doll and no encounter is stored by `simulate`.

## DynamoDB and S3

One DynamoDB table `warashi` (`pk`, `sk`, TTL attribute `ttl`, one GSI for the per-device
encounter list). Item kinds: encounter meta and events, message dedupe, snapshot claim, device
status, notify slot, family member, rate counter.

S3 data bucket prefixes: `snapshots/` (expire in days), `audio/` (1 day), `faces-staging/`
(1 day), `samples/` (owner-supplied, never in git).

## Dashboard hosting

The dashboard is a static SPA served from CloudFront. It reads `/config.json` from its own origin
at start-up (API URL, Region, Cognito ids). Sign-in is Cognito; the role comes from the
`cognito:groups` claim.
