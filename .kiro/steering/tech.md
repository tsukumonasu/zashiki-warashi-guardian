---
inclusion: always
---

# Tech stack and working agreements

## Stack at a glance
| Part | Stack |
|---|---|
| `/device` | Python 3 (the system Python of Raspberry Pi OS) on a Pi Zero W: armv6l, 512 MB RAM, one core. gpiozero (lgpio backend), `rpicam-still`, ALSA `aplay` / `arecord`, paho-mqtt. Tests: pytest + Hypothesis. |
| `/cloud` | AWS CDK v2 in TypeScript. IoT Core, Lambda (current Node.js LTS runtime), S3, Rekognition, Bedrock, Polly, DynamoDB, SNS, API Gateway, Cognito, CloudFront. Tests: vitest + fast-check. |
| `/dashboard` | React + Vite + TypeScript. Tests: vitest + Testing Library + fast-check. |
| Contract | `docs/schema.md` — every event and command exchanged between the three parts. |

Scoped steering adds detail: `hardware.md` (the physical doll), `cloud.md`, `dashboard.md`,
`persona.md` (anything the doll says), `kiroween-submission.md` (submission checklist).

## Working agreements
- **Language.** Everything written to the repository — code, identifiers, comments, commit
  messages, specs, docs, UI copy — is in **English**. The doll's spoken lines are Japanese
  with English subtitles. In chat, answer the developer in **Japanese**.
- **Contract first.** Change `docs/schema.md` before changing any message producer or
  consumer, then update all three parts and their tests in the same change.
- **Pure core.** Decision logic — the device state machine, the cloud verdict logic, the
  dashboard simulation reducer — is pure and deterministic. Time and randomness are passed
  in, so the logic can be property-tested.
- **Hardware-free tests.** Every hardware and AWS dependency sits behind a small adapter with
  a fake. `make test` passes on a laptop and in CI with no Raspberry Pi and no AWS account.
- **Property-based tests are required tasks,** not optional ones, for the pure cores and the
  message schema.
- **Verify AWS facts, do not guess.** Limits, quotas, regional availability, model IDs and
  API shapes are checked with the `aws-docs` MCP server and the page is cited in `design.md`.
- **Small dependencies.** The Pi is tiny and slow, and reviewers read this code. Prefer the
  standard library and a few well-known packages. On the Pi, install with `apt` first
  (`python3-gpiozero`, `python3-lgpio`, `python3-paho-mqtt`); avoid packages that need native
  wheels unavailable for armv6l (for example `awscrt` / AWS IoT Device SDK v2, numpy-heavy stacks).
- **No secrets in git.** Certificates, tokens, Wi-Fi details, account IDs, host names,
  personal names and face images never enter the repository. Use `*.example` files and
  environment variables.
- **Readable over clever.** Small functions, explicit names, docstrings that explain why.

## Commands that must keep working
- `make test` — all unit and property tests (device, cloud, dashboard).
- `make lint` — ruff (Python), eslint and tsc (TypeScript).
- `scripts/deploy_pi.sh` — rsync `/device` to `$PI_HOST` and restart the service.
- `npx cdk deploy --all` in `/cloud` — deploy the backend and the dashboard.
