# Requirements Document

## Introduction

`cloud-judgement` is the AWS backend of the zashiki-warashi guardian. It receives a snapshot from
the doll over AWS IoT Core, decides whether the face is family, a stranger, absent or uncertain,
answers the doll with a `judgement.result`, records the encounter, notifies the family once when a
stranger stands at the door, and serves the dashboard through an authenticated HTTP API. The spec
also covers the pieces that connect the doll to this backend: `scripts/provision_device.sh`,
`scripts/generate_voice_lines.*` and the real MQTT `MqttCloudLink` of `warashi-agent`.

These requirements are derived from `.kiro/specs/cloud-judgement/design.md` and
`docs/schema.md` (the message contract and the HTTP API). Out of scope: the dashboard UI
(`dashboard-simulation`) and live voice conversation (`voice-conversation`).

### Assumptions and defaults

The design's Open Questions are not yet answered by the owner. Until they are, these defaults
apply, and each is stated again as a requirement below so it can be changed in one place:

- **A1.** The real doll keeps choosing its own cached voice line. The cloud sends no automatic
  `speak` after a verdict (Requirement 6.5). Generated audio for the real doll is a later P1 item.
- **A2.** The default Polly voice is neural Kazuha. The default Bedrock model is
  `amazon.nova-lite-v1:0` in `ap-northeast-1`. Both are configuration (Requirement 7).
- **A3.** The reviewer sees real encounters in redacted form, without any image. A stricter
  option that hides real encounters from the reviewer is a configuration value
  (Requirement 14.8).
- **A4. (Decided)** Stranger notification is "at-least-once, normally once": a notification slot
  is released when sending fails, so a later snapshot can retry (Requirement 9.8).
- **A5. (Decided)** Reviewer read isolation is a function split. `api-read`, which serves reviewer
  requests, has no S3 permission on `snapshots/`. A separate internal function, `snapshot-signer`,
  holds `s3:GetObject` on `snapshots/*`, signs snapshot URLs only for Family_Role requests and
  refuses Reviewer_Role requests. No new HTTP route is added (Requirements 14.4, 14.10 to 14.12).
- **A6.** The e-mail address, the monthly budget amount and the demo sample portraits are supplied
  by the owner through CDK context and a one-time seeding step (Requirements 19.3, 20.2, 15.1).

## Glossary

- **Doll**: The physical zashiki-warashi device that runs `warashi-agent` on a Raspberry Pi Zero W.
- **Device_Link**: The `MqttCloudLink` class in `device/warashi_agent/adapters/cloud.py`, which implements the `CloudLink` protocol of `device-core-loop`.
- **IoT_Broker**: The AWS IoT Core MQTT broker in `ap-northeast-1`.
- **Device_Policy**: The AWS IoT policy created by CDK and attached to each device certificate.
- **Topic_Rules**: The AWS IoT topic rules `warashi_snapshots`, `warashi_ingest_events` and `warashi_ingest_status`.
- **Judge**: The `judge` Lambda function that turns a `snapshot.captured` event into a `judgement.result`.
- **Ingest**: The `ingest` Lambda function that validates and stores events and status messages.
- **Api_Read**: The `api-read` Lambda function that serves the read routes of the HTTP API. It has no S3 permission on `snapshots/` and obtains snapshot URLs for Family_Role requests only from the Snapshot_Signer.
- **Snapshot_Signer**: The internal `snapshot-signer` Lambda function. It is the only function with `s3:GetObject` on `snapshots/*`, it is invoked only by the Api_Read, it signs snapshot URLs only for Family_Role requests, and it refuses Reviewer_Role requests. It has no HTTP route.
- **Api_Simulate**: The Lambda function that serves `POST /simulate`.
- **Api_Admin**: The Lambda function that serves `POST /commands` and the `/faces` routes.
- **HTTP_API**: The API Gateway HTTP API with a Cognito JWT authorizer, defined in `docs/schema.md`.
- **Envelope**: The JSON message wrapper defined in `docs/schema.md` (`v`, `id`, `ts`, `deviceId`, `encounterId`, `type`, `data`).
- **Schema_Codec**: The pure TypeScript module `messages.ts` that encodes and decodes Envelopes, and its Python counterpart `device/warashi_agent/messages.py`.
- **Verdict_Engine**: The pure module `verdict.ts` that implements `decideVerdict`, `isStrangerCandidate` and `classifySearchError`.
- **Verdict**: One of `family`, `stranger`, `no_face`, `uncertain`.
- **Stranger_Candidate**: A search outcome with a detected face whose best similarity is absent or below `strangerMax`.
- **Face_Search**: The port to Amazon Rekognition (`SearchFacesByImage`, `DetectFaces`).
- **Household_Collection**: The Rekognition collection `warashi-household` that holds the family's face vectors.
- **Demo_Collection**: The Rekognition collection `warashi-demo` that holds only consented sample portraits.
- **Data_Bucket**: The private S3 bucket for snapshots, generated audio, staging photos and samples.
- **Table**: The DynamoDB single table `warashi`.
- **Notifier**: The interface that sends the stranger notification, implemented with Amazon SNS e-mail.
- **Notify_Policy**: The pure module `notify.ts` that implements `shouldNotify` and `buildStrangerNotification`.
- **Speech_Generator**: The component that produces a generated line with Amazon Bedrock and speech with Amazon Polly.
- **Line_Sanitizer**: The pure function `sanitizeLine` that accepts or rejects generated text.
- **Line_Catalog**: The cached voice lines in `device/warashi_agent/voice/lines.toml` and the derived `cloud/lambda/_shared/voice-lines.json`.
- **Authorizer**: The pure module `authz.ts` that implements `rolesFromClaims` and `authorize`.
- **Redactor**: The pure function `redactEncounter` in `redact.ts`.
- **Rate_Limiter**: The DynamoDB counter logic (`incrementCounter`, `bucketOf`, `withinLimit`).
- **Family_Role**: The Cognito group `family` with full access to the HTTP_API.
- **Reviewer_Role**: The Cognito group `reviewer`, a read-only guest role. If both groups are present, the Reviewer_Role applies.
- **Web_Hosting**: The private S3 site bucket with a CloudFront distribution (origin access control) that serves the dashboard.
- **Cloud_App**: The CDK v2 application in `/cloud` with the stacks `DataStack`, `JudgementStack`, `ApiStack`, `WebStack` and `BudgetStack`.
- **Provision_Script**: `scripts/provision_device.sh`.
- **Voice_Script**: `scripts/generate_voice_lines.*`.
- **Fixtures**: The golden message files in `docs/fixtures/schema-v1/`.
- **Notify_Window**: The configuration value `notifyWindowMs`, default 600,000 ms (10 minutes).
- **Test_Suite**: The vitest and fast-check tests in `/cloud` and the pytest and Hypothesis tests in `/device`, run by `make test`.

## Requirements

### Requirement 1: Device connectivity and IoT policy

**User Story:** As the owner, I want each doll to reach only its own MQTT topics with a clean session, so that a stolen or misconfigured doll cannot read or write another doll's data and a late command cannot replay.

#### Acceptance Criteria

1. WHEN a device connects to AWS IoT Core, THE Device_Policy SHALL allow `iot:Connect` only to a client id equal to `${iot:Connection.Thing.ThingName}` and only while the certificate is attached to that thing (`iot:Connection.Thing.IsAttached` is `true`).
2. WHEN a device connects to AWS IoT Core, THE Device_Policy SHALL allow `iot:Connect` only when `iot:ConnectAttributes` contains nothing but `LastWill`, so that a connection requesting a persistent session is refused.
3. WHEN a device publishes a message, THE Device_Policy SHALL allow `iot:Publish` only on `warashi/${iot:Connection.Thing.ThingName}/events` and `warashi/${iot:Connection.Thing.ThingName}/status`.
4. WHEN a device subscribes or receives a message, THE Device_Policy SHALL allow `iot:Subscribe` only on the topic filter `warashi/${iot:Connection.Thing.ThingName}/commands` and `iot:Receive` only on the topic `warashi/${iot:Connection.Thing.ThingName}/commands`.
5. THE Device_Policy SHALL contain no resource equal to `*`, and every topic resource SHALL start with `warashi/${iot:Connection.Thing.ThingName}/`.
6. THE Device_Policy SHALL contain no statement that allows an action other than `iot:Connect`, `iot:Publish`, `iot:Subscribe` and `iot:Receive`.
7. THE Topic_Rules SHALL consist of exactly three rules: `warashi_snapshots` (`warashi/+/events` where `type = 'snapshot.captured'`, action `judge`), `warashi_ingest_events` (`warashi/+/events`, action `ingest`) and `warashi_ingest_status` (`warashi/+/status`, action `ingest`).
8. THE Topic_Rules SHALL match no rule on the `commands` topic, so that cloud-originated commands are not fed back into the event log.
9. THE Topic_Rules SHALL add `topic(2) AS topicDeviceId` to every selected message, so that the receiving Lambda can compare it with the `deviceId` in the envelope.
10. THE Cloud_App SHALL grant `iot.amazonaws.com` permission to invoke `judge` and `ingest`, with a `SourceArn` equal to the ARN of the matching rule and a `SourceAccount` condition equal to the deploying account.
11. IF a connection or publish request violates the Device_Policy, THEN THE Device_Policy SHALL cause AWS IoT Core to deny the request, and no message from that request SHALL reach `judge` or `ingest`.

### Requirement 2: Snapshot ingestion and size limit

**User Story:** As the owner, I want the cloud to accept only well-formed snapshots within the broker's size limit, so that a bad message cannot cause a wrong verdict or a failure.

#### Acceptance Criteria

1. WHEN the Judge receives a message from the `warashi_snapshots` rule, THE Judge SHALL decode the message with the Schema_Codec before any other processing.
2. IF the Schema_Codec reports the message as malformed, ignored (`unsupported_version` or `unknown_type`) or not of type `snapshot.captured`, THEN THE Judge SHALL end the invocation with no write, no publish and no notification, and SHALL log the reason and the message `id` only.
3. IF the `deviceId` of a decoded `snapshot.captured` message differs from the `<id>` segment of the topic it arrived on, THEN THE Judge SHALL end the invocation as in Requirement 3.2.
4. IF `data.jpegBase64` is not valid base64, decodes to more than 100,000 bytes, decodes to fewer than 3 bytes, or does not begin with the JPEG signature `FF D8 FF`, THEN THE Judge SHALL end the invocation with no write, no publish and no notification, and SHALL log the reason and the message `id` only, with no image data.
5. THE Test_Suite SHALL verify that the largest legal `snapshot.captured` message (a 90,000-byte JPEG, the longest legal ids and angles) encodes to fewer than 128,000 bytes.
6. WHEN the Judge accepts a snapshot, THE Judge SHALL send the decoded JPEG bytes to Face_Search without reading them back from the Data_Bucket.
7. WHEN the Judge accepts a snapshot, THE Judge SHALL start storing the JPEG in the Data_Bucket under `snapshots/<deviceId>/<yyyymmdd>/<snapshotId>.jpg`, where `<yyyymmdd>` is the UTC date of the envelope `ts`, concurrently with the face search.
8. IF storing the JPEG fails, THEN THE Judge SHALL still publish the verdict, SHALL record the failure in a log entry that contains no image data, and SHALL leave no partial object in the Data_Bucket for that `snapshotId`.

### Requirement 3: Sender identity check

**User Story:** As the owner, I want the cloud to ignore any message whose `deviceId` differs from the topic it arrived on, so that one doll cannot write into another doll's record.

#### Acceptance Criteria

1. WHEN the Judge or the Ingest receives a message on an events topic or a status topic, THE receiving function SHALL compare the Envelope `deviceId` with `topicDeviceId` by exact, case-sensitive string equality before performing any other processing of the message.
2. IF `deviceId` differs from `topicDeviceId`, THEN THE receiving function SHALL perform zero writes to storage, zero publishes to any topic and zero notifications for that message, and SHALL write one `security_mismatch` log entry that contains the message `id` and `topicDeviceId` and contains none of the following: payload `data`, `jpegBase64`, image bytes and the claimed `deviceId`.
3. IF the Envelope `deviceId` is missing, is not a string, or is an empty string, THEN THE receiving function SHALL treat the message as a mismatch and apply criterion 2, using `null` as the logged message `id` when the `id` is not readable.
4. THE Judge SHALL publish a `judgement.result` only to the commands topic of the `topicDeviceId` of the message that triggered it, and SHALL publish at most one `judgement.result` per accepted `snapshot.captured` message.

### Requirement 4: Idempotent handling of redelivered messages

**User Story:** As the owner, I want a redelivered or duplicated message to have the effect of a single delivery, so that QoS 1 redelivery and double rule firing do not cause duplicate verdicts, events or notifications.

#### Acceptance Criteria

1. WHEN the Judge accepts a snapshot, THE Judge SHALL claim the key `SNAP#<snapshotId>` with a conditional write (`attribute_not_exists`) and a TTL of 86,400 seconds before it calls Face_Search.
2. IF the claim for a `snapshotId` already exists, THEN THE Judge SHALL end the invocation with no publish, no write, no notification and no Face_Search call.
3. WHEN the Ingest accepts a message, THE Ingest SHALL claim the key `MSG#<id>` with a conditional write and a TTL of 86,400 seconds before it stores any item.
4. IF the claim for a message `id` already exists, THEN THE Ingest SHALL store no further item for that message and SHALL end the invocation without returning an error.
5. IF the conditional write for a claim fails for a reason other than an existing claim, THEN THE Judge or THE Ingest SHALL end the invocation with an error, with no publish, no stored item and no notification, so that the message can be redelivered.
6. THE Cloud_App SHALL configure the Judge asynchronous invocation with 0 retries and a maximum event age of 60 seconds.
7. FOR ALL messages delivered N times (2 ≤ N ≤ 10) within the 86,400-second claim window, THE Judge and THE Ingest SHALL produce the side effects of one delivery: exactly one `judgement.result` published, exactly one event item stored and at most one stranger notification sent.

### Requirement 5: Verdict decision

**User Story:** As a family member, I want the doll to name a person family or stranger only when the evidence is strong, so that the doll rarely greets an intruder or alarms the family without cause.

#### Acceptance Criteria

1. WHEN the Judge searches the Household_Collection, THE Face_Search SHALL call `SearchFacesByImage` with `QualityFilter` set to `NONE` and `FaceMatchThreshold` set to `searchFloor` (default 50), and SHALL use the largest detected face in the image as the search face.
2. WHEN the search outcome contains a detected face and the best similarity is at least `familyMin` (default 90) and `similarity / 100` is at least `acceptMin` (default 0.80), THE Verdict_Engine SHALL return `family` with `confidence = similarity / 100`.
3. WHEN the best similarity is at least `strangerMax` (default 70) and below `familyMin`, THE Verdict_Engine SHALL return `uncertain`.
4. WHEN the search outcome is a Stranger_Candidate whose face confidence is at least `faceConfidenceMin` (default 90), whose face width is at least `minFaceWidth` (default 0.08 of the image width), whose quality meets `minSharpness` (default 30), `minBrightness` (default 25) and `maxYawDeg` (default 40, compared against the absolute yaw), and whose face confidence divided by 100 is at least `acceptMin`, THE Verdict_Engine SHALL return `stranger` with `confidence = faceConfidence / 100`.
5. IF a Stranger_Candidate fails any condition of criterion 4, or the face quality is unavailable, THEN THE Verdict_Engine SHALL return `uncertain` with `confidence` set to the face confidence divided by 100, or 0 when the face confidence is unavailable.
6. WHEN the Face_Search finds no face, THE Verdict_Engine SHALL return `no_face` with `confidence` 1 and `face` null.
7. IF the search raises `InvalidParameterException`, THEN THE Judge SHALL call `DetectFaces` to separate "no face" from a bad request, SHALL return `no_face` when `DetectFaces` finds zero faces, and SHALL return `uncertain` with `confidence` 0 and `face` null when `DetectFaces` fails or finds at least one face.
8. WHEN the search outcome is a Stranger_Candidate, THE Judge SHALL call `DetectFaces` once to obtain the face quality before it decides.
9. IF Face_Search, `DetectFaces` or any other adapter fails for a reason other than throttling that criterion 10 retries, THEN THE Verdict_Engine SHALL return `uncertain` with `confidence` 0 and `face` null.
10. IF Face_Search reports throttling and less than 1.5 seconds have elapsed since the Judge started, THEN THE Judge SHALL retry the call once after a jittered delay between 50 and 250 milliseconds, and IF the retry also fails or the 1.5 seconds have already elapsed, THEN THE Judge SHALL treat the call as an adapter failure under criterion 9.
11. THE Verdict_Engine SHALL return a `confidence` within 0 to 1 and, when `face` is not null, a face box whose four fields are within 0 to 1, and SHALL return `face` null whenever the Verdict is `no_face`. A `face` of null is also allowed for `uncertain` when no face box is available.
12. THE Verdict_Engine SHALL return exactly one of `family`, `stranger`, `no_face` or `uncertain` for every search outcome, every face quality value (including missing values) and every configuration that satisfies criterion 16.
13. THE Verdict_Engine SHALL return `family` only when the best similarity is at least `familyMin`, and SHALL return `stranger` only when the best similarity is absent or below `strangerMax`.
14. THE Verdict_Engine SHALL return a `family` or `stranger` Verdict only with `confidence` at least `acceptMin`.
15. WHILE every other input is fixed, WHEN the best similarity rises, THE Verdict_Engine SHALL NOT change a `family` Verdict to another Verdict.
16. IF a configuration violates `searchFloor <= strangerMax <= familyMin <= 100`, or sets `acceptMin` outside 0 to 1, or sets any threshold to a non-finite or negative number, THEN THE Cloud_App SHALL reject the configuration at synthesis or at function start with an error that names the violated rule, and SHALL NOT process any snapshot with it.
17. THE README SHALL state that the largest face in the image decides the Verdict, so a second person behind a family member is not judged.

### Requirement 6: Publishing the judgement result

**User Story:** As the doll, I want the verdict back within a few seconds over a reliable channel, so that the doll reacts before its own timeout.

#### Acceptance Criteria

1. WHEN the Judge has decided a Verdict, THE Judge SHALL publish a `judgement.result` Envelope to `warashi/<deviceId>/commands` using the IoT data plane `Publish` call with `qos` set to 1.
2. THE Judge SHALL read the IoT data endpoint (`iot:Data-ATS`) from an environment variable provided by the Cloud_App.
3. THE `judgement.result` data SHALL contain exactly the fields `snapshotId`, `verdict`, `confidence` and `face` as defined in `docs/schema.md`, and no other field, name or label. `confidence` SHALL be a number from 0 to 1 inclusive. `face` SHALL be either a bounding box with `left`, `top`, `width` and `height` each from 0 to 1 inclusive, or `null` when the Verdict is `no_face` or when no face box is available.
4. WHEN the Judge has decided a Verdict, THE Judge SHALL complete the `judgement.result` publish attempt (success or failure) before it starts writing the encounter record to the Table.
5. THE Judge SHALL publish no `speak` command as part of the automatic path.
6. IF the `judgement.result` publish call fails or does not return within 2 seconds, THEN THE Judge SHALL log a `publish_failed` entry containing the `snapshotId` and no image data, SHALL NOT retry the publish, and SHALL still write the Verdict to the Table.
7. WHEN the doll publishes a snapshot, THE Cloud_App SHALL deliver the `judgement.result` to the IoT_Broker within 3 seconds at the 95th percentile on the family path and within 4 seconds at the 95th percentile on the stranger path, measured from the broker's receipt of the `snapshot.captured` message to the broker's receipt of the `judgement.result`, over at least 20 runs of the opt-in integration test, and recorded in `design.md`.
8. THE Judge SHALL set `encounterId` of the `judgement.result` Envelope to the `encounterId` of the snapshot message, and SHALL set `deviceId` to the `<id>` segment of the topic on which the snapshot message arrived.
9. IF the snapshot message carries `encounterId` of `null`, THEN THE Judge SHALL set `encounterId` of the `judgement.result` Envelope to `null`.

### Requirement 7: Reaction lines and generated speech

**User Story:** As the owner, I want optional in-character generated lines that always fall back to cached lines, so that speech never blocks a verdict and never says something unsafe.

#### Acceptance Criteria

1. THE Voice_Script SHALL write `cloud/lambda/_shared/voice-lines.json` (id, category, `ja`, `en`) from `device/warashi_agent/voice/lines.toml`, and THE Test_Suite SHALL fail WHEN the JSON and the TOML differ in the number of lines, or in the id, category, `ja` or `en` of any line.
2. WHEN a line is requested for a category, THE `chooseLine` function SHALL return a line of that category, or null when the Line_Catalog has no line of that category.
3. FOR ALL values of the random input in the range 0 up to but excluding 1, THE `chooseLine` function SHALL return an index from 0 to (number of lines of the category − 1), and SHALL return the same result for the same category, catalog and random input.
4. WHEN `POST /simulate` has `generate` set to true and the caller has used fewer than `generatePerHour` generations in the current hour, THE Speech_Generator SHALL ask Amazon Bedrock for one line as JSON `{"ja": string, "en": string}` using the model id in configuration (default `amazon.nova-lite-v1:0`), with a Bedrock call timeout of 5,000 ms.
5. THE Speech_Generator SHALL build the prompt from the persona rules and the situation category only, and the prompt SHALL contain no person's name, no member data and no image data.
6. THE Line_Sanitizer SHALL return the text only when the text has 1 to 40 characters, at most two sentences, no Latin letters, no emoji, no word from the blocked-word list and no threat, and SHALL otherwise return null.
7. IF Bedrock fails or times out, the response does not parse as the required JSON, the `ja` or `en` value is missing or not a string, or the Line_Sanitizer returns null for `ja`, THEN THE Speech_Generator SHALL return a cached line of the same category with `generated` false and `lineId` set.
8. WHEN the Speech_Generator has a sanitized line, THE Speech_Generator SHALL synthesize MP3 with Amazon Polly (`Engine` `neural`, `VoiceId` from configuration, default `Kazuha`, SSML prosody `rate` and `volume` only) with a Polly call timeout of 5,000 ms.
9. IF Polly fails or times out, THEN THE Speech_Generator SHALL return the sanitized line with `generated` true, `lineId` null and `mp3Url` null, and the `POST /simulate` response SHALL still be returned with the verdict.
10. THE `pcm16ToWav` function SHALL return a byte array of length `44 + n` for `n` bytes of 16-bit mono PCM, with a RIFF header whose size fields, sample format, channel count and sample rate (8,000 or 16,000 Hz) are consistent, followed by the unchanged PCM data.
11. IF the PCM input has an odd length, THEN THE `pcm16ToWav` function SHALL reject the input with an error and SHALL return no bytes.
12. THE Speech_Generator SHALL NOT be called by the Judge, and no automatic path SHALL send generated audio to the real doll.
13. IF the situation is `stranger` and `allowStrangerGeneration` is false (the default), THEN THE Speech_Generator SHALL NOT call Bedrock or Polly and SHALL return a cached line of the `stranger` category with `generated` false and `lineId` set.

### Requirement 8: No family label in a non-family reaction

**User Story:** As a family member, I want my name or nickname never to be spoken, shown or sent when the person is not family, so that a stranger learns nothing about the household.

#### Acceptance Criteria

1. FOR ALL situations other than `family` (verdicts `stranger`, `no_face`, `uncertain`, and a reaction without a verdict because the cloud is offline) and FOR ALL member registries (including an empty registry and a registry of 100 members), THE reaction, prompt, speech and notification builders SHALL produce output in which no registered member `displayName` and no member label appears as a substring, compared case-insensitively.
2. THE Judge, THE Ingest and THE Api_Simulate SHALL emit `judgement.result`, `status.report` and stored events in which every `data` field is defined in `docs/schema.md`, and SHALL drop any other field before sending or storing the message.
3. WHEN `POST /simulate` returns a Verdict other than `family`, THE Api_Simulate SHALL return a `speech` object and a `commands` list in which no member `displayName` and no member label appears, for both `generate: true` and `generate: false`.
4. WHEN a `stranger` notification is sent to the family, THE Notifier SHALL build the notification text and subject so that they contain no member `displayName` and no member label.
5. IF a Rekognition face search for a non-family verdict returns matches below the family similarity threshold, THEN THE Judge SHALL discard those matches and SHALL NOT place the matched face id, the member id or the `displayName` of any such match in the verdict, the commands, the speech, the notification or any log entry.
6. THE Judge, THE Ingest and THE Api_Admin SHALL NOT write a log entry that contains both a face id and a `displayName` or member label.

### Requirement 9: Stranger notification

**User Story:** As a family member, I want one message when a stranger stands at the door, not a flood, so that I notice it and trust the alert.

#### Acceptance Criteria

1. WHEN the Verdict is `stranger`, the encounter has no earlier notification, and either no earlier notification exists for the device or at least `notifyWindowMs` milliseconds have passed since the device's last notification, THE Judge SHALL claim the notify slot with one DynamoDB transaction and SHALL then send one message through the Notifier.
2. THE Notify_Policy SHALL return `notify` false for every Verdict other than `stranger`.
3. FOR ANY sequence of snapshots with non-decreasing times, THE Notify_Policy SHALL allow at most one notification per encounter.
4. FOR ANY sequence of snapshots with non-decreasing times, THE Notify_Policy SHALL allow two notifications for one device only when their times differ by at least `notifyWindowMs` milliseconds.
5. IF the current time is earlier than the time of the device's last notification, THEN THE Notify_Policy SHALL return `notify` false with reason `clock_skew`.
6. FOR ALL concurrent `notifyOnce` calls for one encounter, THE Judge SHALL send at most one message through the Notifier, as modeled by an in-memory store that applies the same conditional transaction.
7. IF the conditional transaction of criterion 1 fails because the encounter or the device window already holds a notification, THEN THE Judge SHALL NOT call the Notifier and SHALL return `notified` false for that call without raising an error.
8. IF the Notifier reports an error when it sends, THEN THE Judge SHALL release the notify slot so that a later `stranger` snapshot of the same encounter may try again, SHALL record the failure without image data, face ids or names, and SHALL continue the judgement so that the `judgement.result` command is still published. THE Judge SHALL NOT release the slot after a successful send. The guarantee is therefore: at most one successfully sent message per encounter and per Notify_Window, plus further attempts only after a reported failure; a failure reported after SNS accepted the message may cause one extra message.
9. THE `buildStrangerNotification` function SHALL produce a subject of at most 99 characters (the SNS Publish page requires fewer than 100) and a body that contain the device label, the time in UTC ISO 8601 and the dashboard URL, and no image, no link to an image, no face data and no name.
10. THE Cloud_App SHALL send stranger notifications through an Amazon SNS topic with an e-mail subscription whose address is passed as CDK context, behind the `Notifier` interface.
11. IF the CDK context holds no e-mail address or an address that is not a valid e-mail address, THEN THE Cloud_App SHALL fail synthesis with an error that names the missing or invalid context key, and SHALL NOT create the subscription.
12. THE README and the stack output SHALL tell the owner to confirm the e-mail subscription within 48 hours.

### Requirement 10: Encounter log

**User Story:** As a family member, I want every encounter recorded with its events, so that I can read what the doll saw and did.

#### Acceptance Criteria

1. WHEN the Ingest accepts an event with a non-null `encounterId`, THE Ingest SHALL append an item `ENC#<encounterId>` / `EVT#<ts>#<id>` to the Table, so that events of one encounter are read in `ts` order.
2. WHEN the Ingest stores a `snapshot.captured` event, THE Ingest SHALL remove `jpegBase64` from the stored item and add `hasImage: true`, so that the stored item contains no image data.
3. WHEN the Ingest stores a `state.changed`, `reaction.performed` or `encounter.ended` event, THE Ingest SHALL update the encounter meta item (`state`, `reaction`, `endedAt`) with the values carried by that event.
4. WHEN the Judge decides a Verdict, THE Judge SHALL write `verdict`, `confidence`, `snapshotKey` and the published command to the encounter meta item before the command is published, or within the same operation.
5. IF an event carries `encounterId` null, THEN THE Ingest SHALL append no item to any encounter and SHALL log the event `type` only, without the payload.
6. IF a message has an unknown `type`, THEN THE Ingest SHALL store nothing and SHALL log the unknown type.
7. THE Table SHALL list encounters of a device newest first through GSI1 (`gsi1pk` `DEV#<deviceId>`, `gsi1sk` `startedAt`).
8. WHEN the Ingest accepts the first event of an `encounterId` that has no meta item, THE Ingest SHALL create the encounter meta item with `startedAt` set to that event's `ts` and the GSI1 keys from criterion 7, so that the encounter appears in the device list.
9. IF the Ingest receives an event whose `id` is already stored for the same `encounterId`, THEN THE Ingest SHALL store no second event item and SHALL leave the encounter meta item with the same values, re-applying only the idempotent meta patch that the event carries (a redelivery after a failed meta update then completes it).
10. IF a write to the Table fails, THEN THE Ingest SHALL log the failure with the event `type` and `id`, SHALL report the failure to its caller so that the message can be redelivered, and SHALL leave previously stored items unchanged.

### Requirement 11: Retention and storage safety

**User Story:** As a family member, I want snapshots to disappear within days and never be reachable by the public, so that the doll respects the household's privacy.

#### Acceptance Criteria

1. THE Data_Bucket SHALL expire objects under `snapshots/` 3 days after their creation, and the configured expiry SHALL NOT exceed 7 days.
2. THE Data_Bucket SHALL expire objects under `audio/` and `faces-staging/` 1 day after their creation.
3. THE Data_Bucket SHALL block all public access, enforce TLS (`enforceSSL`) and encrypt objects at rest.
4. WHEN an encounter item is created, THE Table SHALL store a `ttl` attribute (epoch seconds, integer) equal to the creation time plus 30 days (2,592,000 seconds), and THE Table SHALL have TTL enabled on the attribute `ttl`.
5. FOR ALL items and times, THE read helpers SHALL return no item whose `ttl` is less than or equal to the current time, including items that DynamoDB TTL has not yet deleted.
6. WHEN THE Cloud_App creates a pre-signed URL, THE Cloud_App SHALL set its lifetime to 300 seconds.
7. THE Table SHALL store no image bytes and no base64 image text.
8. IF an object under `snapshots/` is expired or deleted, THEN THE Api_Read SHALL return `snapshot: null` for the encounter instead of a URL, and the response SHALL NOT be an error.

### Requirement 12: Device status and offline handling

**User Story:** As a family member, I want the dashboard to show whether the doll is online and whether its camera or microphone is active, so that I know what the doll is doing.

#### Acceptance Criteria

1. WHEN the Ingest accepts a `status.report`, THE Ingest SHALL store its `data` as the device status together with `receivedAtMs` set to the Ingest's arrival time in epoch milliseconds, replacing any previously stored status for that device.
2. WHEN the Ingest accepts a `status.offline`, THE Ingest SHALL mark the device offline with `receivedAtMs` set to the Ingest's arrival time in epoch milliseconds, SHALL keep the last stored `status.report` data unchanged, and SHALL NOT use the message `ts` for any ordering or online decision.
3. WHEN the Ingest accepts a `status.report` and the device is currently marked offline, THE Ingest SHALL clear the offline mark so that `GET /device/status` returns `online` true, regardless of the `ts` values of the `status.report` and the earlier `status.offline`.
4. WHEN `GET /device/status` is called, THE Api_Read SHALL return `online` true only if a `status.report` has been stored, its `receivedAtMs` is later than or equal to the `receivedAtMs` of the last `status.offline` (or no `status.offline` exists), and the elapsed time since its `receivedAtMs` is at most 3 × `status_interval_s` (default 3 × 60 s = 180 s); in every other case THE Api_Read SHALL return `online` false.
5. WHEN `GET /device/status` is called and no `status.report` has been stored for the device, THE Api_Read SHALL return `online` false, `lastSeenAt` null and `status` null.
6. WHEN `GET /device/status` is called and a `status.report` has been stored, THE Api_Read SHALL return `lastSeenAt` as the UTC ISO 8601 timestamp with milliseconds of that report's `receivedAtMs`, and `status` as the stored report `data`, including the boolean fields `cameraActive` and `micActive`.

### Requirement 13: HTTP API and roles

**User Story:** As the owner, I want every API route protected by sign-in and two clear roles, so that family members manage the doll and reviewers can only look.

#### Acceptance Criteria

1. THE HTTP_API SHALL require a valid Cognito JWT on every route.
2. THE Cloud_App SHALL create the Cognito user pool with self sign-up disabled and the groups `family` and `reviewer`.
3. IF the token is missing, malformed, has an invalid signature, belongs to another user pool or app client, or is expired, THEN THE HTTP_API SHALL respond `401` with error code `unauthorized`, SHALL run no route logic and SHALL produce no side effect.
4. THE Authorizer SHALL derive the role from the `cognito:groups` claim, accepting an array or a string, and SHALL return the Reviewer_Role when `reviewer` is present, otherwise the Family_Role when `family` is present, otherwise no role.
5. IF the `cognito:groups` claim is absent, empty or holds only unknown group names, THEN THE Authorizer SHALL return no role.
6. IF the token has no role, or the role is not allowed for the route, THEN THE HTTP_API SHALL respond `403` with error code `forbidden` and SHALL produce no side effect.
7. THE Authorizer SHALL allow the Family_Role exactly the routes in the role matrix of `docs/schema.md` and the Reviewer_Role exactly `GET /me`, `GET /samples`, `GET /encounters`, `GET /encounters/{id}`, `GET /device/status` and `POST /simulate`, and SHALL deny every other route string.
8. THE HTTP_API SHALL take the role only from the token claims and never from the request body, query or headers.
9. IF a request fails validation (malformed JSON, a missing or wrongly typed field, a value outside its documented range, or a body larger than 1,048,576 bytes), THEN THE HTTP_API SHALL respond `400` with error code `validation_failed`, SHALL produce no side effect and SHALL leave stored data unchanged.
10. THE HTTP_API SHALL return errors as `{ "error": { "code": string, "message": string } }`, and the message SHALL be at most 200 characters and SHALL contain no image data, face id, name or pre-signed URL.
11. THE HTTP_API SHALL accept cross-origin requests only from the Web_Hosting origin, and SHALL send no cross-origin allow header for any other origin.
12. WHEN `GET /me` is called, THE Api_Read SHALL return `role`, `consentNoticeVersion` and `limits` (`simulatePerHour`, `generatePerHour`), each limit being an integer of at least 1.
13. WHEN `GET /samples` is called, THE Api_Read SHALL return the `sampleId` and expected `label` of each entry in `samples/manifest.json`, and no name.
14. WHEN `GET /encounters` is called, THE Api_Read SHALL accept `limit` as an integer from 1 to 50 (default 20) and an opaque `cursor`, SHALL return at most `limit` items newest first, and SHALL return `nextCursor` as a string when more items exist, otherwise null.
15. IF `limit` is outside 1 to 50 or not an integer, or `cursor` is not a value this API issued, THEN THE Api_Read SHALL respond `400` with error code `validation_failed`.
16. WHEN `GET /encounters/{id}` is called for an existing encounter, THE Api_Read SHALL return the record with `events` in time order, and WHEN the encounter does not exist or has expired, THE Api_Read SHALL respond `404` with error code `not_found`.

### Requirement 14: Reviewer redaction

**User Story:** As the owner, I want a public reviewer account to be read-only and unable to see real snapshots, so that a demo guest never sees inside the household.

#### Acceptance Criteria

1. WHEN the role is the Reviewer_Role, THE Redactor SHALL return an encounter record with `snapshot` null and `illustration` set to exactly one of `silhouette-family`, `silhouette-stranger`, `silhouette-none` or `silhouette-uncertain`, chosen by the Verdict as follows: `family` gives `silhouette-family`, `stranger` gives `silhouette-stranger`, `no_face` gives `silhouette-none`, and `uncertain` or a null Verdict gives `silhouette-uncertain`.
2. WHEN the role is the Reviewer_Role, THE Redactor SHALL return an encounter record that contains no face box, no member data, no S3 key and no image reference of any kind (including `hasImage`, `jpegBase64`, `face`, `memberId`, `displayName`, `faceCount` and any URL pointing to an image object) at any nesting depth.
3. WHEN the role is the Reviewer_Role, THE Redactor SHALL remove `hasImage`, `jpegBase64` and `face` from every event in `events`, and SHALL keep every other event field unchanged, including event order and event count.
4. IF a request carries the Reviewer_Role, THEN THE HTTP_API SHALL NOT include a snapshot URL or an S3 key in any response body, and the execution role of the Api_Read, which serves the Reviewer_Role request, SHALL have no permission to read objects under `snapshots/`.
5. IF a request carries the Reviewer_Role and calls a route that the role matrix marks as not permitted for the Reviewer_Role, THEN THE HTTP_API SHALL reject the request with a `forbidden` error and SHALL NOT change any stored data or publish any message to a doll.
6. WHEN the role is the Family_Role, THE Redactor SHALL return the record unchanged except that `snapshot` is a pre-signed GET URL valid for 300 seconds, or null when the image expired or never existed, and `illustration` is null.
7. FOR ALL records, THE Redactor SHALL be idempotent: applying it twice to a record gives a result equal to applying it once. THE Redactor SHALL return for the Family_Role a record equal to its input, apart from the `snapshot` and `illustration` fields defined in criterion 6.
8. WHERE the configuration value `reviewerRealEncounters` is `hidden`, THE Api_Read SHALL return an empty `items` list with `nextCursor` null to the Reviewer_Role for `GET /encounters`, and a `not_found` error for `GET /encounters/{id}` whatever the id. WHERE the value is `redacted` or is not set, THE Api_Read SHALL return redacted records as in criteria 1 to 3.
9. IF the configuration value `reviewerRealEncounters` is set to anything other than `hidden` or `redacted`, THEN THE Cloud_App SHALL reject the configuration at synthesis or at function start with an error that names the setting, and THE Api_Read SHALL return no encounter record to the Reviewer_Role until the value is valid.
10. IF a request to the Snapshot_Signer carries the Reviewer_Role, or names an object key outside `snapshots/` (including a key with a path-traversal segment), THEN THE Snapshot_Signer SHALL return no URL and SHALL return a refusal.
11. WHEN the Api_Read serves a request with the Family_Role, THE Api_Read SHALL obtain each snapshot URL from the Snapshot_Signer, and WHEN the request carries the Reviewer_Role (including a token with both groups), THE Api_Read SHALL NOT invoke the Snapshot_Signer.
12. THE Test_Suite SHALL include a template assertion that the IAM policies of the Api_Read and of the Api_Simulate grant no `s3:GetObject` on `snapshots/*` (directly or through a wildcard resource), that only the Snapshot_Signer role grants it, and that the Api_Read role grants only `lambda:InvokeFunction` on the Snapshot_Signer in addition to its table and configuration access.

### Requirement 15: Simulation against the live cloud

**User Story:** As a reviewer, I want to run the judgement pipeline on a sample portrait, so that I can try the cloud without touching a real doll or a real household.

#### Acceptance Criteria

1. WHEN `POST /simulate` is called with a `sampleId` that matches `[a-z0-9_-]{1,64}` and exists in `samples/manifest.json`, THE Api_Simulate SHALL run the simulation for that sample.
2. IF `sampleId` is missing, does not match `[a-z0-9_-]{1,64}`, or is not in `samples/manifest.json`, THEN THE Api_Simulate SHALL respond `400 validation_failed`, run no search, and increment no generate counter.
3. IF the `generate` field is present and is not a boolean, THEN THE Api_Simulate SHALL respond `400 validation_failed`. IF `generate` is absent, THEN THE Api_Simulate SHALL treat it as false.
4. THE Api_Simulate SHALL search only the Demo_Collection, and the Api_Simulate role SHALL have no permission on the Household_Collection.
5. THE Api_Simulate SHALL accept no uploaded image from any role. IF the request body contains an image or any field other than `sampleId` and `generate`, THEN THE Api_Simulate SHALL ignore that field and use only the sample from `samples/manifest.json`.
6. WHEN the simulation succeeds, THE Api_Simulate SHALL respond `200` with `sampleId`, `verdict`, `confidence`, `face`, `commands`, `speech` and `latencyMs` (`total`, `search`) as defined in `docs/schema.md`. `latencyMs.total` and `latencyMs.search` SHALL be integers in milliseconds, with `search` not greater than `total`.
7. THE Api_Simulate SHALL build `commands` as Envelopes with `deviceId` `warashi-sim` and `encounterId` null. `commands` SHALL hold the `judgement.result` and the `speak` that the doll would act on, in that order.
8. THE Api_Simulate SHALL publish nothing to the IoT_Broker and SHALL write no encounter item.
9. IF the face search or the speech generation fails or exceeds its timeout, THEN THE Api_Simulate SHALL respond `500 internal`, return no partial result and no image data, face id or pre-signed URL in the error message, and leave no encounter item.
10. WHEN a caller requests `POST /simulate`, THE Rate_Limiter SHALL increment a per-user hourly counter and a global daily counter, and WHEN `generate` is true THE Rate_Limiter SHALL also increment a per-user hourly generate counter, each with one conditional `UpdateItem`.
11. THE Rate_Limiter SHALL apply these defaults: Reviewer_Role 20 simulations and 3 generations per hour per user, Family_Role 100 simulations per hour per user, and 300 simulations per day in total. WHERE a limit is configured by an environment setting, THE Rate_Limiter SHALL use that value instead of the default.
12. IF any counter would exceed its limit, THEN THE HTTP_API SHALL respond `429` with error code `rate_limited` and a `Retry-After` header holding a whole number of seconds from 1 to 86,400 until the exceeded bucket resets. THE Api_Simulate SHALL run no search and generate no speech for that request.
13. FOR ALL request sequences, THE Rate_Limiter SHALL accept no more requests in one bucket than the limit, and a new bucket SHALL restart the count at zero. A request rejected by one counter SHALL NOT leave the other counters incremented.
14. THE HTTP_API SHALL apply a route throttle of 2 requests per second with a burst of 5 on `POST /simulate`.
15. WHEN `speech` contains an MP3, THE Api_Simulate SHALL return `mp3Url` as a pre-signed URL that expires 300 seconds after it is issued. WHEN `speech` contains no MP3, THE Api_Simulate SHALL return `mp3Url` as null.

### Requirement 16: Commands to the real doll

**User Story:** As a family member, I want to call the doll from the dashboard, so that I can make it speak a cached line, look somewhere, change its lantern or sleep.

#### Acceptance Criteria

1. WHEN a Family_Role caller sends a valid `POST /commands`, THE Api_Admin SHALL publish the command Envelope to `warashi/<deviceId>/commands` with `qos` 1 and `encounterId` null, and SHALL respond `202` with `id` (a UUID) and `deviceOnline` (a boolean), within 3 seconds of receiving the request.
2. THE Api_Admin SHALL accept the command types `speak`, `gaze`, `lantern` and `mode.set`.
3. IF the command `type` is not one of `speak`, `gaze`, `lantern` or `mode.set`, THEN THE Api_Admin SHALL respond `400 validation_failed` and publish nothing.
4. IF a `speak` command carries `audioUrl`, or carries a `lineId` that is not in the Line_Catalog, or carries no `lineId`, THEN THE Api_Admin SHALL respond `400 validation_failed` and publish nothing.
5. IF a `mode.set` command carries a `mode` other than `guard` or `sleep`, THEN THE Api_Admin SHALL respond `400 validation_failed` and publish nothing.
6. WHEN a valid `lantern` or `gaze` command carries finite numbers outside the allowed range, THE Api_Admin SHALL clamp `lantern.level` to 0 to 1, `lantern.fadeMs` to 0 to 10,000, `gaze.panDeg` to -60 to +60 and `gaze.tiltDeg` to -30 to +30 before publishing, and SHALL publish the clamped values.
7. IF a `lantern` or `gaze` command carries a number field that is missing, not a number, or not finite (NaN or infinity), THEN THE Api_Admin SHALL respond `400 validation_failed` and publish nothing.
8. IF `deviceId` is not 1 to 64 characters of `[A-Za-z0-9_-]`, THEN THE Api_Admin SHALL respond `400 validation_failed` and publish nothing.
9. WHEN the stored device status is offline, THE Api_Admin SHALL still publish the command once, SHALL respond `202` with `deviceOnline` false, and SHALL NOT store or re-publish the command for later delivery.
10. IF the Reviewer_Role calls `POST /commands`, THEN THE HTTP_API SHALL respond `403 forbidden` and publish nothing.
11. IF publishing to the MQTT topic fails, THEN THE Api_Admin SHALL respond `500 internal` with an error message that contains no topic name, certificate detail or stack trace, and SHALL NOT retry the publish.

### Requirement 17: Face registration

**User Story:** As a family member, I want to register and delete my own face with a clear consent step, so that the doll knows me and I stay in control of my data.

#### Acceptance Criteria

1. WHERE a request is made to `GET /faces`, `POST /faces/upload`, `POST /faces` or `DELETE /faces/{memberId}`, THE HTTP_API SHALL allow the request only when the caller has the Family_Role.
2. IF a caller without the Family_Role calls `GET /faces`, `POST /faces/upload`, `POST /faces` or `DELETE /faces/{memberId}`, THEN THE HTTP_API SHALL respond `403 forbidden`, SHALL return no member data, and SHALL change no stored data.
3. WHEN `POST /faces/upload` is called, THE Api_Admin SHALL return a pre-signed POST for the `faces-staging/` prefix that accepts only JPEG or PNG files of 1 to 5,000,000 bytes and expires in 300 seconds.
4. IF `consent.accepted` is not the boolean `true` or `consent.noticeVersion` differs from `consentNoticeVersion`, THEN THE Api_Admin SHALL respond `409 consent_required`, SHALL index no face, SHALL create or change no member record, and SHALL delete the staging object.
5. IF `displayName` has fewer than 1 or more than 40 characters, THEN THE Api_Admin SHALL respond `400 validation_failed`, SHALL index no face, SHALL create or change no member record, and SHALL delete the staging object.
6. WHEN a valid `POST /faces` is called, THE Api_Admin SHALL index the staged photo into the Household_Collection with `ExternalImageId` set to the opaque member id and never a name, and SHALL respond `201` with `memberId` and `faceCount`.
7. IF the photo does not contain exactly one face, THEN THE Api_Admin SHALL delete every face it indexed from that photo, SHALL create or change no member record, and SHALL respond `422 face_count_invalid`.
8. WHEN `POST /faces` finishes with any outcome, including success, validation failure, consent failure, unknown member, face count failure and internal failure, THE Api_Admin SHALL delete the staging object.
9. WHEN a valid `POST /faces` carries a `memberId` that matches an existing member, THE Api_Admin SHALL add the face to that member, SHALL increase that member's `faceCount` by 1, and SHALL keep the member's existing `displayName`.
10. IF `POST /faces` carries a `memberId` that matches no existing member, THEN THE Api_Admin SHALL respond `404 not_found`, SHALL index no face, and SHALL create no member record.
11. WHEN a face is registered, THE Api_Admin SHALL store `displayName`, `faceIds`, `consentVersion`, `consentAt` (UTC ISO 8601 with milliseconds) and `createdBy` in the member record.
12. WHEN `GET /faces` is called, THE Api_Admin SHALL return `memberId`, `displayName`, `createdAt`, `consentVersion` and `faceCount` for each member, and no face id, and SHALL return an empty `members` list when no member exists.
13. WHEN `DELETE /faces/{memberId}` is called for a known member, THE Api_Admin SHALL delete the member's face vectors from the Household_Collection and the member record, and SHALL respond `204`.
14. IF `DELETE /faces/{memberId}` is called for an unknown member, THEN THE Api_Admin SHALL respond `404 not_found` and SHALL change no stored data.
15. IF deleting the face vectors from the Household_Collection fails during `DELETE /faces/{memberId}`, THEN THE Api_Admin SHALL keep the member record, SHALL respond `500 internal`, and SHALL leave the request safe to repeat.
16. THE Cloud_App SHALL create the Household_Collection and the Demo_Collection with the fixed ids `warashi-household` and `warashi-demo`, not derived from any value that can change.

### Requirement 18: Dashboard hosting

**User Story:** As a reviewer, I want the dashboard at one HTTPS URL that needs no rebuild when the backend changes, so that I can open it and try it at once.

#### Acceptance Criteria

1. THE Web_Hosting SHALL serve the dashboard through CloudFront from a private S3 bucket using origin access control, with public access to the bucket blocked on all four S3 public-access settings.
2. WHEN a viewer requests the dashboard URL over HTTP, THE Web_Hosting SHALL redirect the request to the same URL over HTTPS.
3. IF a viewer requests a path that does not exist in the bucket, THEN THE Web_Hosting SHALL return the content of `index.html` with a successful response, so that the single-page app can route, and SHALL do so for the not-found and access-denied responses of the bucket.
4. WHERE the folder `dashboard/dist` exists at synthesis, THE WebStack SHALL deploy its contents to the bucket.
5. IF the folder `dashboard/dist` does not exist at synthesis, THEN THE WebStack SHALL deploy a one-page placeholder as `index.html` and SHALL complete synthesis without error.
6. THE WebStack SHALL deploy `/config.json` with exactly the keys `apiUrl`, `region`, `userPoolId`, `userPoolClientId` and `illustrationBase`, each set from the deployed stacks, and SHALL create no other key.
7. WHEN the backend stack values change and the stacks are deployed again, THE WebStack SHALL update `/config.json` without rebuilding the dashboard bundle.
8. THE Web_Hosting SHALL serve `/config.json` with a CloudFront cache lifetime of at most 60 seconds, so that a changed value reaches a viewer within 60 seconds after the CloudFront invalidation completes.
9. THE `/config.json` file SHALL contain no secret and no credential, including no access key, token, client secret, password or pre-signed URL.

### Requirement 19: Stack outputs and one-command deployment

**User Story:** As the owner, I want one command to deploy everything and clear outputs for the README, so that I can rebuild the stack in a new account.

#### Acceptance Criteria

1. WHEN `npx cdk deploy --all` runs in `/cloud` with a valid `cdk.context.json` and a bootstrapped target account, THE Cloud_App SHALL deploy `DataStack`, `JudgementStack`, `ApiStack`, `WebStack` and `BudgetStack` in dependency order and finish with exit code 0 and with every stack in the `CREATE_COMPLETE` or `UPDATE_COMPLETE` state.
2. WHEN a deployment of `npx cdk deploy --all` completes, THE Cloud_App SHALL expose the stack outputs `ApiUrl`, `WebUrl`, `IotEndpoint`, `UserPoolId`, `UserPoolClientId`, `DevicePolicyName`, `HouseholdCollectionId`, `DemoCollectionId`, `DataBucketName` and `StrangerTopicArn`, each with a non-empty value and each defined in exactly one stack.
3. THE Cloud_App SHALL read the notification e-mail address, the budget amount in USD and the budget e-mail address from CDK context, and THE repository SHALL contain `cdk.context.example.json` with placeholder values only and SHALL list `cdk.context.json` in `.gitignore`.
4. IF a required context value (notification e-mail address, budget amount or budget e-mail address) is missing, empty, or not a valid value (an e-mail address without exactly one `@`, or a budget amount that is not a number greater than 0), THEN THE Cloud_App SHALL fail at synthesis, before any resource is created, with an error message that names the missing or invalid context key.
5. THE Cloud_App SHALL set the runtime of every Lambda function to `nodejs24.x`, or to the newest Node.js LTS runtime offered by the installed `aws-cdk-lib` when `nodejs24.x` is not offered, and `design.md` SHALL state which runtime was chosen and why.
6. THE Cloud_App SHALL deploy every stack to `ap-northeast-1`, and `design.md` SHALL list each service or model that needs another Region, with its Region and a link to the AWS documentation page that states the requirement.
7. THE README SHALL document teardown with `npx cdk destroy --all`, and THE Cloud_App MAY use `RemovalPolicy.DESTROY` for hackathon resources.
8. WHEN `npx cdk destroy --all` runs after a successful deployment, THE Cloud_App SHALL delete all five stacks, including the contents of the data bucket, and leave no stack of this application in the target account.

### Requirement 20: Budget alarm and no always-on cost

**User Story:** As the owner, I want the stack to stay online until judging ends without meaningful idle cost, so that reviewers can use it for weeks.

#### Acceptance Criteria

1. THE BudgetStack SHALL create exactly one monthly `AWS::Budgets::Budget` of type cost, with one notification at each of 50, 80 and 100 percent of the budget amount, based on actual spend, and each notification SHALL be sent to the budget e-mail address.
2. THE BudgetStack SHALL read the budget amount (a number greater than 0, in USD) and the budget e-mail address (an e-mail address of at most 254 characters) from CDK context.
3. IF the budget amount or the budget e-mail address is missing from CDK context, or either value is invalid, THEN THE BudgetStack SHALL fail `cdk synth` with an error that names the missing or invalid context key, and SHALL produce no template.
4. THE Cloud_App SHALL create no always-on compute resource.
5. IF a synthesized template of the Cloud_App contains an EC2 instance, NAT gateway, RDS instance, ECS service, OpenSearch domain or DynamoDB table with provisioned capacity, THEN the template test SHALL fail and SHALL name the offending resource type and logical id.
6. THE Table SHALL use on-demand (pay-per-request) capacity, with no provisioned read or write capacity set.
7. THE Cloud_App SHALL set the retention of every Lambda log group to 14 days, and a template test SHALL fail IF any Lambda function in a synthesized template has no log group with a retention of 14 days.

### Requirement 21: Device provisioning script

**User Story:** As the owner, I want one safe script that creates the doll's certificate and config, so that I can set up a doll without leaking keys.

#### Acceptance Criteria

1. WHEN the Provision_Script runs with `--thing`, `--out` and `--policy` and all three values are valid, THE Provision_Script SHALL create the IoT thing if it does not exist, create a certificate and private key in `--out`, attach the policy to the certificate, attach the certificate to the thing, and exit with status zero.
2. WHEN the Provision_Script runs a second time with the same `--thing`, `--out` and `--policy` and without `--rotate`, THE Provision_Script SHALL create no second thing, SHALL create no second certificate, SHALL leave the existing certificate and private key files unchanged, and SHALL exit with status zero.
3. THE Provision_Script SHALL create `--out` with mode `0700` and the private key file with mode `0600`, and SHALL NOT write the private key to any path outside `--out` or to any file that exists with a wider mode at any moment (`umask 077` set before the first file is created).
4. IF `--out` resolves, after following symbolic links, to a path inside a git work tree, THEN THE Provision_Script SHALL create no file and no AWS resource, SHALL print an error message naming the reason, and SHALL exit with a non-zero status.
5. WHEN provisioning succeeds, THE Provision_Script SHALL read the endpoint with `describe-endpoint --endpoint-type iot:Data-ATS`, download Amazon Root CA 1 into `--out`, and write `warashi-aws.toml` into `--out` containing the keys `enabled`, `endpoint`, `port`, `ca_file`, `cert_file`, `key_file`, `keepalive_s`, `reconnect_min_s` and `reconnect_max_s`, each with a value, with `port` set to 8883 and the three file keys pointing to files that exist.
6. IF reading the endpoint or downloading Amazon Root CA 1 fails, THEN THE Provision_Script SHALL NOT write `warashi-aws.toml`, SHALL print an error message naming the failed step, and SHALL exit with a non-zero status.
7. WHEN `--rotate` is given, THE Provision_Script SHALL create a new certificate, attach the policy and the thing to it, and only after both attachments succeed deactivate and detach the old certificate from the thing and the policy, then exit with status zero.
8. IF any step before the old certificate is deactivated fails during `--rotate`, THEN THE Provision_Script SHALL leave the old certificate active and attached, SHALL print an error message naming the failed step, and SHALL exit with a non-zero status.
9. THE Provision_Script SHALL NOT write private key material, or any content read from the private key file, to standard output, standard error or any log file.
10. IF `--thing`, `--out` or `--policy` is missing or has an empty value, THEN THE Provision_Script SHALL print a usage message, SHALL create no file and no AWS resource, and SHALL exit with a non-zero status.
11. WHEN `--region` is not given, THE Provision_Script SHALL use `ap-northeast-1` for every AWS call.

### Requirement 22: Voice line generation script

**User Story:** As the owner, I want to generate the doll's cached voice lines from the line list, so that the doll can speak offline.

#### Acceptance Criteria

1. WHEN the Voice_Script runs, THE Voice_Script SHALL read `lines.toml`, call Polly (`Engine` `neural`, voice from configuration with default `Kazuha`, `OutputFormat` `pcm`, `SampleRate` 16000), wrap the result as a 16-bit mono 16 kHz WAV and write `<id>.wav` beside `lines.toml`.
2. WHEN the Voice_Script has processed every line of `lines.toml`, THE Voice_Script SHALL write `voice-lines.json` as in Requirement 7.1.
3. WHEN the text and the voice settings of a line are unchanged since its last successful generation and its `<id>.wav` exists, THE Voice_Script SHALL skip that line, using a hash stored in a git-ignored sidecar file.
4. WHEN the Voice_Script generates a line, THE Voice_Script SHALL report the id and the duration in seconds, rounded to 0.1 s, of that line, and WHEN it skips a line, THE Voice_Script SHALL report the id of the skipped line.
5. THE Voice_Script SHALL run on the owner's computer with the owner's AWS credentials and SHALL NOT be required on the Pi.
6. THE Voice_Script SHALL use a Python port of `pcm16ToWav` that has its own test for the header fields (RIFF/WAVE markers, PCM format code 1, 1 channel, 16,000 Hz sample rate, 16 bits per sample, and the data and file sizes) and for the data bytes being identical to the input PCM bytes.
7. IF the Polly call fails for a line, the response is empty, or the AWS credentials are missing or expired, THEN THE Voice_Script SHALL report the line id and the cause, SHALL NOT write or overwrite that line's `<id>.wav` or its hash, SHALL continue with the remaining lines for a failed line, and SHALL exit with a non-zero status after the last line.
8. IF `lines.toml` is missing, cannot be parsed, or contains a duplicate or empty line id, or a line text longer than 3,000 characters, THEN THE Voice_Script SHALL report the cause, SHALL NOT call Polly, and SHALL exit with a non-zero status without changing existing `.wav` files or `voice-lines.json`.

### Requirement 23: Device MQTT cloud link

**User Story:** As the doll, I want a small, non-blocking MQTT link that survives Wi-Fi loss, so that the core loop keeps reacting offline and reconnects by itself.

#### Acceptance Criteria

1. THE Device_Link SHALL implement the `CloudLink` protocol of `device-core-loop` (`start`, `publish`, `stop`).
2. WHEN `__main__` starts with `--fake`, THE `__main__` SHALL select a fake link. WHEN `__main__` starts without `--fake` and `[aws].enabled` is true, THE `__main__` SHALL select the Device_Link. WHEN `__main__` starts without `--fake` and `[aws].enabled` is false, THE `__main__` SHALL select the local link.
3. THE Device_Link SHALL use `paho-mqtt` with the version 2 callback API, protocol MQTT 3.1.1, `clean_session` true, client id equal to the device id, TLS with the configured CA, certificate and key, and port 8883.
4. THE Device_Link SHALL register a last will of `status.offline` on `warashi/<id>/status` with QoS 1 before it connects, and SHALL set a keepalive of 60 seconds.
5. WHEN a connection attempt fails, including the first attempt at boot, THE Device_Link SHALL retry with exponential backoff that doubles the delay after each failure, starts at `reconnect_min_s` and never exceeds `reconnect_max_s`. WHEN a connection is established, THE Device_Link SHALL reset the delay to `reconnect_min_s`.
6. WHEN a connection is established, THE Device_Link SHALL subscribe to `warashi/<id>/commands` with QoS 1, and WHEN the broker acknowledges the subscription, THE Device_Link SHALL post `cloud.connected` exactly once for that connection.
7. IF the subscription is not acknowledged within 10 seconds or the broker rejects it, THEN THE Device_Link SHALL disconnect, SHALL NOT post `cloud.connected`, and SHALL retry under the backoff rule.
8. WHEN a connection that had posted `cloud.connected` is lost, THE Device_Link SHALL post `cloud.disconnected` exactly once for that connection.
9. WHEN a message arrives on the commands topic, THE Device_Link SHALL post its raw payload bytes to the device pipeline without parsing or validating it, and without blocking the network thread for more than 50 ms.
10. WHEN `publish` is called, THE Device_Link SHALL return within 50 ms without raising an exception for any envelope or client failure, and SHALL send `status.*` types to the `warashi/<id>/status` topic and every other type to the `warashi/<id>/events` topic with QoS 1.
11. IF a client failure occurs during `publish`, THEN THE Device_Link SHALL log the failure without payload content and SHALL treat the envelope as dropped.
12. WHILE the Device_Link is disconnected, THE Device_Link SHALL drop each `snapshot.captured` envelope, SHALL keep only the latest `status.report` and send it after reconnect, and SHALL drop every other envelope, and SHALL log each drop with the envelope type and id and without payload content.
13. THE Device_Link SHALL bound its client queue to 32 messages. IF the queue is full when `publish` is called, THEN THE Device_Link SHALL drop the new envelope and log the drop under the rule above.
14. WHEN `stop` is called, THE Device_Link SHALL disconnect cleanly and then stop the network loop within 5 seconds, and SHALL NOT post `cloud.disconnected` or `cloud.connected` afterwards. WHEN `stop` is called twice, THE Device_Link SHALL ignore the second call.
15. THE systemd unit SHALL start `warashi-agent` after `network-online.target` and `time-sync.target`.
16. THE Device_Link SHALL use only `python3-paho-mqtt` from `apt` and the Python standard library.
17. THE Test_Suite SHALL test the Device_Link with a fake `MqttClientFactory`, with no network and no real clock waits, and SHALL include a property-based test that the delay sequence stays within `reconnect_min_s` and `reconnect_max_s`.

### Requirement 24: Shared message schema and fixtures

**User Story:** As a developer, I want one contract understood identically by the doll, the cloud and the dashboard, so that no part misreads another.

#### Acceptance Criteria

1. WHEN the Schema_Codec decodes input that follows `docs/schema.md`, THE Schema_Codec SHALL return `valid` together with the decoded Envelope.
2. IF the input has `v` that is an integer greater than 1, THEN THE Schema_Codec SHALL return `ignored` with reason `unsupported_version`.
3. IF the input has `v` that is an integer of at least 1 and a `type` that `docs/schema.md` does not define, THEN THE Schema_Codec SHALL return `ignored` with reason `unknown_type`.
4. IF the input breaks any other rule of `docs/schema.md`, THEN THE Schema_Codec SHALL return `malformed`. These violations include: size above 131,072 bytes, invalid UTF-8, invalid JSON, `v` that is not an integer of at least 1 (for example `0`, `1.5`, `"1"` or `true`), a missing field, a field of the wrong type, a value outside an enumeration, a non-finite number, and a `speak` command without exactly one of `lineId` and `audioUrl`.
5. IF an input matches more than one of the outcomes in criteria 2 to 4, THEN THE Schema_Codec SHALL return `malformed` when `v` is not an integer of at least 1 or the size, UTF-8 or JSON rule is broken, and otherwise SHALL return `ignored` with reason `unsupported_version` before `unknown_type`.
6. WHEN the Schema_Codec decodes a message, THE Schema_Codec SHALL drop every `data` field that `docs/schema.md` does not define, and the decoded Envelope SHALL contain none of the dropped fields.
7. WHEN the Schema_Codec encodes an Envelope, THE Schema_Codec SHALL omit every field whose value is undefined.
8. FOR ALL valid Envelopes, decoding the encoding of an Envelope SHALL produce an Envelope equal to the original (round trip), checked by a property-based test of at least 100 generated cases in each of the TypeScript and Python Test_Suites.
9. WHEN `makeCommand` builds a command, THE Schema_Codec SHALL clamp `lantern.level` to 0..1, `lantern.fadeMs` to 0..10000, each `judgement.result` face box field to 0..1, and SHALL keep `gaze` angles unchanged if finite.
10. IF `makeCommand` receives a non-finite number in a `lantern`, `gaze` or face box field, THEN THE Schema_Codec SHALL reject the command with an error and SHALL NOT return a command.
11. WHEN `topicFor` is called with a device id and a kind of `events`, `commands` or `status`, THE `topicFor` function SHALL return the string `warashi/<deviceId>/<kind>`.
12. IF `topicFor` is called with a kind other than `events`, `commands` or `status`, or with an empty device id, THEN THE `topicFor` function SHALL reject the call with an error.
13. THE repository SHALL contain, in `docs/fixtures/schema-v1/`, at least one golden message for every event, command and status type listed in `docs/schema.md`.
14. FOR ALL Fixtures, THE TypeScript Schema_Codec and THE Python Schema_Codec SHALL each decode the Fixture to `valid` and re-encode it to a value that is semantically equal (same JSON values, key order ignored) to the Fixture.
15. IF a type in `docs/schema.md` has no Fixture, or a Fixture file has no matching type, THEN THE Test_Suite SHALL fail and SHALL name the type or file concerned.
16. IF the route table or the error codes of the implementation differ from the role matrix or the error list in `docs/schema.md`, THEN THE Test_Suite SHALL fail and SHALL name each route or code that is missing or extra.

### Requirement 25: Privacy, logging, tagging and secrets

**User Story:** As the owner, I want the code and the stack to follow the privacy rules by construction, so that no image, name or secret leaks through logs, tags or git.

#### Acceptance Criteria

1. THE Judge, THE Ingest, THE Api_Read, THE Api_Simulate and THE Api_Admin SHALL write no image bytes, no base64 image text, no full pre-signed URL (any URL containing a signature query parameter) and no family member display name to any log output, and a Test_Suite check SHALL invoke each handler with a fixture event that contains each of these values and verify that none appears in the captured log output.
2. THE Cloud_App SHALL tag every taggable resource with the key `project` and the value `zashiki-warashi`, and a template test SHALL fail WHEN any taggable resource in the synthesized template lacks this tag.
3. THE repository SHALL contain no certificate, private key, token, account id, ARN with an account id, endpoint host, e-mail address, phone number, personal name or face image.
4. WHEN the Test_Suite runs, THE Test_Suite SHALL scan every git-tracked file for the patterns listed in criterion 3 and SHALL fail with the file path and line number of each match, excluding only files and values on a documented allow list (for example `*.example` placeholders and the reserved `example.invalid` host).
5. THE Cloud_App SHALL give each Lambda function its own IAM role with exactly the permissions listed in the Lambda table of `design.md`, and no two Lambda functions SHALL share a role.
6. IF a synthesized IAM statement has the resource `*` and its action is not on a documented exception list in `design.md`, THEN a template test SHALL fail and SHALL name the role and the action.
7. THE Cloud_App SHALL create no resource policy (S3 bucket policy, Lambda permission, SNS topic policy, or other resource-based policy) with `Principal` `*`, and a template test SHALL fail WHEN the synthesized template contains one.
8. THE README SHALL state in English that the guardian is an art piece and not an alarm product, and that a photograph of a family member may be greeted as family.

### Requirement 26: Required property-based and hardware-free tests

**User Story:** As a reviewer of the code, I want the pure logic proven by property-based tests that run on a laptop, so that I can trust the verdicts and the privacy rules without AWS or a Pi.

#### Acceptance Criteria

1. THE Test_Suite SHALL implement each of the 22 Correctness Properties of `design.md` as exactly one required property-based test (fast-check in `/cloud`, Hypothesis in `/device`), configured to run at least 100 iterations per test and tagged `Feature: cloud-judgement, Property <number>: <title>`, where `<number>` is 1 to 22 and `<title>` is the property's title in `design.md`.
2. WHEN `make test` runs on a computer with no Raspberry Pi, no AWS account and no AWS credentials, THE Test_Suite SHALL pass with zero failed tests and zero skipped tests, using fakes for Face_Search, the snapshot store, the device bus, the Notifier, the state store, the speech synthesizer and the MQTT client.
3. IF a test in `make test` attempts a network connection to an AWS endpoint or to an MQTT broker, THEN THE Test_Suite SHALL fail that test with an error that names the attempted connection.
4. THE Test_Suite SHALL include at least one CDK template assertion (vitest) for each of Requirements 1, 4.6, 11, 13, 14.12, 18, 19, 20 and 25, and each assertion SHALL carry a comment or test name that cites its requirement number.
5. THE Test_Suite SHALL keep every integration test that needs an AWS account out of `make test`, SHALL run such tests only WHEN an explicit opt-in environment variable is set, and SHALL report them as skipped, not failed, WHEN the variable is not set. These opt-in tests are the only tests exempt from the zero-skipped rule of criterion 2.
6. WHEN `make lint` runs, THE repository SHALL pass `ruff`, `eslint` and `tsc` with zero errors and zero warnings for the files of this spec.
7. IF a property-based test fails, THEN THE Test_Suite SHALL report the failing test's tag and the shrunk counterexample (the minimal failing input) in the test output, and SHALL exit with a non-zero status.

### Requirement 27: Configuration defaults and documentation of facts

**User Story:** As the owner, I want every tunable value and every unverified AWS fact in one place, so that I can calibrate on real photos and trust the documented limits.

#### Acceptance Criteria

1. THE Cloud_App SHALL provide these configuration defaults: `searchFloor` 50, `familyMin` 90, `strangerMax` 70, `faceConfidenceMin` 90, `minFaceWidth` 0.08, `minSharpness` 30, `minBrightness` 25, `maxYawDeg` 40, `acceptMin` 0.80, `notifyWindowMs` 600,000, snapshot expiry 3 days and `reviewerRealEncounters` `redacted`.
2. WHERE a CDK context value or an environment variable is set for a default of criterion 1, THE Cloud_App SHALL use that value instead of the default. WHERE both are set, THE Cloud_App SHALL use the environment variable.
3. IF an override of criterion 2 is outside the valid range of its setting (`searchFloor`, `familyMin`, `strangerMax` and `faceConfidenceMin` in 0 to 100; `minFaceWidth` and `acceptMin` in 0 to 1; `minSharpness` and `minBrightness` in 0 to 255; `maxYawDeg` in 0 to 90; `notifyWindowMs` an integer from 0 to 86,400,000; snapshot expiry an integer number of days from 1 to 7; `reviewerRealEncounters` neither `redacted` nor `hidden`), is not a number where one is required, or makes `strangerMax` greater than `familyMin`, THEN THE Cloud_App SHALL reject the configuration at synth or start-up with an error naming the setting and its invalid value, and SHALL NOT deploy or run with that value.
4. WHEN the first implementation task completes, THE `design.md` SHALL record, for each item that can be verified from the AWS documentation or the local toolchain (array claim form of `cognito:groups` from the documentation, collection ARN support in IAM, CDK runtime constants, `paho-mqtt` version available through `apt`), the verified value, the verification date (UTC, `YYYY-MM-DD`) and its source (the documentation page URL or the command that was run), and SHALL remove the item's "unverified" mark. For each item that needs a deployed account (latencies, real prices, the real claim shape), THE first implementation task SHALL mark the item in `design.md` as "pending owner measurement", and the owner SHALL replace the mark with the measured value, date and source after the first deployment. THE `design.md` SHALL contain no item that is neither measured nor marked "pending owner measurement".
5. THE `design.md` SHALL cite the AWS documentation page URL for every limit, quota, model id and API shape that the implementation relies on, and SHALL mark any such item without a citation as "unverified".
