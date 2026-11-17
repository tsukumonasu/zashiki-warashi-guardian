---
inclusion: fileMatch
fileMatchPattern: ["cloud/**", "scripts/provision_device*", "scripts/generate_voice_lines*"]
---

# Cloud conventions (AWS)

## Shape
- AWS CDK v2 in TypeScript, small stacks by concern (device connectivity, judgement, API,
  web hosting, voice). One `npx cdk deploy --all` brings up everything, including the built
  dashboard. Stack outputs expose every URL and ID the README needs.
- Serverless and pay-per-use only, with no always-on compute: the stack stays online for
  reviewers until 2027-01-29 without meaningful idle cost. Add a small monthly budget alarm.
- Main region `ap-northeast-1` (Tokyo). Use another region only for a service or model that
  is not available there (for example Amazon Nova Sonic), and say so in the design together
  with the documentation page that proves it.

## Services and how we use them
- **AWS IoT Core** — the only path between the doll and the cloud. MQTT over TLS with one
  X.509 certificate per device. The IoT policy lets a device use only its own topics
  (`warashi/<deviceId>/...`). Topics and payloads are defined in `docs/schema.md`.
- **Amazon Rekognition** — one face collection for the household. `SearchFacesByImage` gives
  the verdict and the bounding box of the largest face. "No face" and "low similarity" are
  normal outcomes, not errors.
- **Amazon Bedrock** — short in-character lines from a small, fast text model, with the
  persona steering as the basis of the system prompt. Live conversation uses Amazon Nova Sonic (P1).
- **Amazon Polly** — Japanese speech for generated lines and for pre-generating the cached
  lines. Produce 16 kHz mono PCM wrapped as WAV for the device, and MP3 for browsers.
- **Amazon S3** — snapshots and generated audio: private, lifecycle expiry of 7 days or less,
  reachable only through short-lived pre-signed URLs.
- **Amazon DynamoDB** — encounters and device status (on-demand capacity, TTL on items).
- **Amazon SNS** — stranger notifications to the family, at most one per encounter. Keep the
  notifier behind a small interface so another channel can be added later.
- **Amazon API Gateway + Lambda + Amazon Cognito** — the dashboard API. No self sign-up; one
  family user and one reviewer demo user are created out of band. Two roles, enforced in the
  API and not only in the UI: `family` has full access; `reviewer` is read-only — live-cloud
  simulation (rate-limited) and a redacted timeline, with no real snapshots, no commands to
  the real doll and no face management.
- **Amazon CloudFront + S3** — dashboard hosting.

## Rules
- Verify limits, quotas, regional availability, model IDs and API shapes with the `aws-docs`
  MCP server before relying on them, and cite the page in `design.md`.
- Least-privilege IAM per function. No `*` resources unless the service requires it — and
  then a comment says why.
- Lambda handlers are thin. Verdict logic, debounce logic and message building are pure
  modules with unit and property-based tests; AWS SDK clients are mocked.
- Never log image bytes, face IDs together with names, or full pre-signed URLs.
- Everything is tagged `project=zashiki-warashi`. Hackathon stacks may use
  `RemovalPolicy.DESTROY`; the README documents teardown (`npx cdk destroy --all`).
- No account IDs, ARNs containing account IDs, endpoints, e-mail addresses or phone numbers
  in the repository. Pass them as CDK context or environment variables.
