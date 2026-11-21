---
inclusion: always
---

# Repository structure

```
.kiro/                  steering, specs, hooks, settings — always committed, never in .gitignore
device/
  warashi_agent/
    __main__.py         entry point: builds the adapters and runs the loop
    state_machine.py    pure logic: step(state, event, now) -> (state, actions)
    messages.py         events and commands, encode / decode (mirrors docs/schema.md)
    config.py           loads and validates config.toml (pins, calibration, timeouts)
    adapters/           servo.py lantern.py pir.py camera.py audio.py cloud.py fakes.py
    voice/              lines.toml (id, Japanese text, English subtitle) + cached audio
  tools/                bring-up scripts used on the real doll (test, check, calibrate)
  tests/                pytest + Hypothesis, no hardware needed
  systemd/              warashi-agent.service
  config.example.toml
cloud/
  bin/  lib/            CDK app and stacks
  lambda/<function>/    one folder per Lambda: thin handler + pure logic module + tests
dashboard/
  src/simulation/       pure reducer + virtual doll (same messages as the real device)
  src/pages/  src/components/  src/lib/
docs/
  schema.md             message contract — single source of truth
  architecture.md       diagrams and data flow
  wiring/               wiring diagrams and photos of the build
  kiro-usage.md         running journal of how Kiro was used (feeds the submission write-up)
  third-party.md        adapted code or assets, with their licenses
scripts/                deploy_pi.sh, provision_device.sh, generate_voice_lines.*
LICENSE  README.md  Makefile
```

## Rules
- One spec per feature under `.kiro/specs/`: `device-core-loop`, `cloud-judgement`,
  `dashboard-simulation`, `voice-conversation`.
- The message contract is #[[file:docs/schema.md]]. Code that produces or consumes messages
  matches it exactly, and tests enforce this in all three parts.
- Adapters are thin and make no decisions. Decisions live in the pure modules.
- `device/` runs on a laptop with `--fake`; the dashboard simulation runs with no backend.
- A new top-level folder or a new dependency needs one line here or in `tech.md` saying why.
- `cloud/lambda/_shared/` holds pure modules (message codec, envelope checks, clamping) used by
  more than one Lambda, so each function bundles one copy instead of duplicating code.
- `docs/fixtures/schema-v1/` holds golden messages for every event, command and status type, so the
  Python and TypeScript tests check the same bytes against `docs/schema.md`.
- `boto3` is allowed for `scripts/generate_voice_lines.py` only (Polly pre-generation on a
  laptop). It is never a dependency of `/device` and is never installed on the Pi.
- `aws-cdk` (CLI, dev dependency of `/cloud`) runs `cdk synth` and `cdk deploy`.
- `@smithy/signature-v4`, `@aws-crypto/sha256-js`, `@smithy/protocol-http`, `@smithy/types`
  (dependencies of `/cloud`) sign the AppSync Events WebSocket and publish requests of the voice
  session with IAM (SigV4); `@smithy/node-http-handler` gives the Bedrock bidirectional stream its
  HTTP/2 handler; `@aws-sdk/credential-provider-node` supplies the Lambda role credentials to the signer.
- `tsx` (dev dependency of `/cloud`) runs the TypeScript CDK app (`bin/`) without a build step.
- `@types/node` (dev dependency of `/dashboard`) types the `node:fs` reads in tests that load `docs/` files, such as `test/fixtures.test.ts`.
- `cloud/lambda/_shared/voice/` holds the pure voice modules (frame codec, session reducer, prompt,
  language check) used by the voice Lambdas and the dashboard tests, so one copy defines the frames.
- `cloud/lambda/voice-start/`, `voice-grant/`, `voice-authorizer/` and `voice-session/` are the four
  voice Lambdas, one folder each with a thin handler and a pure core. `voice-session/adapters/` holds
  the only code that imports the Bedrock and AppSync Events SDKs.
- `device/warashi_agent/conversation/` is the doll's audio client for a voice session (microphone,
  playback, WebSocket). It is an adapter: it makes no decisions, and the state machine owns them.
- `dashboard/src/voice/` holds the browser audio client and the virtual doll's voice session, using
  the same frames as the real doll.
- `docs/fixtures/voice-v1/` holds one golden frame per frame type and direction, the scripted Sonic
  streams, and `persona-markers.json` (the marker-phrase list that the prompt drift test checks
  against `persona.md`), so the Python, TypeScript and dashboard tests read the same bytes.
- `websockets` is the one new dependency of `/device`. On the Pi it comes from `apt`
  (`python3-websockets`, owner step O8b); on a laptop it is a dev dependency for the tests. It is
  pure Python, so it needs no native wheel for armv6l.
- `aws_sdk_bedrock_runtime` (with `boto3`) is allowed for `scripts/check_sonic_japanese.py` only. It
  runs on the owner's laptop, is imported lazily, and is never a dependency of `/device`.
