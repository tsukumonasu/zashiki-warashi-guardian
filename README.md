# Zashiki-Warashi Guardian

> A traditional Japanese doll that wakes when someone approaches, lights its lantern,
> slowly turns to look at them, greets family members, and unsettles strangers —
> then notifies the family.

<!-- photo or GIF of the doll here -->

**[Live dashboard →](#)** <!-- replace with the deployed URL before submission -->

---

## Try it now (no hardware, no account needed)

> Not deployed yet. The dashboard and its simulation mode are built by the
> `dashboard-simulation` spec; this section will list the exact steps.

1. Open the dashboard URL above.
2. Click **Simulation mode**.
3. Follow the on-screen prompts. The full encounter flow runs in your browser.

## Development

```
make setup   # creates device/.venv (Python 3.13) with pytest, Hypothesis and ruff
make test
make lint
```

---

## What it is

A Kiroween 2026 entry in the **Frankenstein** category: a traditional craft doll ×
Raspberry Pi Zero W × generative AI, united by a single message contract.

The system has three parts that share one schema (`docs/schema.md`):

| Part | Description |
|---|---|
| `device/` | Python agent on a Raspberry Pi Zero W inside the doll's stand |
| `cloud/` | AWS serverless — face recognition, voice, event log, notifications |
| `dashboard/` | React web app with a simulation mode reviewers can run in-browser |

---

## Architecture

<!-- architecture diagram here (docs/architecture.md) -->

---

## How Kiro was used

See [`docs/kiro-usage.md`](docs/kiro-usage.md) and [`.kiro/`](.kiro/) for steering files,
specs, and hooks.

---

## Build it yourself

The parts list, wiring diagram and estimated costs will be added here before submission. The
cloud steps below are complete.

See [`device/tools/README.md`](device/tools/README.md) for bring-up and hardware check scripts.

### Cloud: deploy

The cloud app in `cloud/` is AWS CDK v2 in TypeScript (stacks: data, judgement, api, web, budget).
It uses serverless, pay-per-use services only. The main Region is `ap-northeast-1` (Tokyo).

1. Install the AWS CLI v2, Node.js, and sign in with credentials for your own AWS account.
2. Create `cloud/cdk.context.json` from the example. The file is git-ignored; never commit it.

   ```
   cd cloud
   npm install
   cp cdk.context.example.json cdk.context.json
   ```

   Edit the three required keys in `cdk.context.json`:

   | Key | Meaning |
   |---|---|
   | `notificationEmail` | Receives stranger notifications (SNS e-mail subscription). |
   | `budgetAmountUsd` | Monthly budget in USD, greater than 0. |
   | `budgetEmail` | Receives the budget alerts (50, 80 and 100 percent). |

   Synthesis fails with a message naming the key if one is missing or invalid. Tunable settings
   (for example `familyMin`, `strangerMax`, `snapshotExpiryDays`, `statusIntervalS`,
   `reviewerSimulatePerHour`) can be added to the same file. An environment variable with the
   prefix `WARASHI_` (for example `WARASHI_FAMILY_MIN`) overrides the context value. The defaults
   and ranges are in `cloud/lambda/_shared/config.ts`.
3. Bootstrap the account once, then deploy everything, including the built dashboard:

   ```
   npx cdk bootstrap
   npx cdk deploy --all
   ```

   The stack outputs list the values you need later: `IotEndpoint`, `DevicePolicyName`,
   `StrangerTopicArn`, `DataBucketName`, `HouseholdCollectionId`, `DemoCollectionId`, `ApiUrl`,
   `UserPoolId`, `UserPoolClientId` and `WebUrl`.
4. **Confirm the e-mail subscription within 48 hours.** SNS sends a confirmation message to
   `notificationEmail` after the first deployment. Until you confirm it, no stranger
   notification reaches you, and an unconfirmed subscription expires after 48 hours.
5. Create the family and reviewer users in the Cognito user pool (self sign-up is off) and add
   them to the `family` and `reviewer` groups.

### Cloud: teardown

```
cd cloud
npx cdk destroy --all
```

Hackathon stacks use `RemovalPolicy.DESTROY`, so the data bucket, tables and face collections go
with the stacks. Everything is tagged `project=zashiki-warashi`.

### Provision a doll

`scripts/provision_device.sh` creates the IoT thing and certificate, attaches the device policy,
downloads the Amazon Root CA and writes a `warashi-aws.toml` for the device config. It needs the
AWS CLI v2 and `curl`. The `--out` folder must be outside any git work tree, so keys never reach
the repository.

```
scripts/provision_device.sh --thing warashi-01 --out ~/warashi-secrets/warashi-01 \
    --policy <DevicePolicyName>
```

`<DevicePolicyName>` is the stack output of the same name. Optional flags: `--region`,
`--rotate` (new certificate, old one retired afterwards) and `--pi-dir` (certificate folder on
the Pi, used for the paths in the generated file). Copy the folder to the Pi with `scp`, paste
`warashi-aws.toml` into the `[aws]` section of `config.toml` (see `device/config.example.toml`),
then check the link on the doll and deploy:

```
python3 device/tools/check_cloud.py      # on the Pi; --config, --timeout, --no-command are optional
scripts/deploy_pi.sh                     # from the laptop; needs $PI_HOST
```

### Generate the cached voice lines

`scripts/generate_voice_lines.py` runs on your computer with your own AWS credentials, never on
the Pi. It reads `device/warashi_agent/voice/lines.toml`, calls Amazon Polly (neural, default
voice Kazuha), writes one 16 kHz mono WAV per line beside `lines.toml`, and updates
`cloud/lambda/_shared/voice-lines.json`. Unchanged lines are skipped. It needs `boto3` on the laptop.

```
python3 scripts/generate_voice_lines.py [--voice Kazuha] [--region ap-northeast-1]
```

### Seed the demo collection

`POST /simulate` runs against sample portraits you provide. Put consented portraits as `<id>.jpg`
and a `manifest.json` (ids and labels only, no names) in a local folder that stays outside the
repository, then run:

```
python3 scripts/seed_demo_collection.py --bucket <DataBucketName> --samples-dir <folder>
```

The script uploads the samples to `samples/` and indexes only the `family`-labeled portraits into
the `warashi-demo` collection. The household collection is never touched. Until you seed it,
`POST /simulate` rejects unknown samples with `validation_failed`.

### Tests

`make test` and `make lint` run with no Pi, no AWS account and no credentials. The integration
tests in `cloud/test/integration/` are opt-in. They are skipped unless you set
`WARASHI_AWS_INTEGRATION=1`, and they talk to your deployed stack:

```
cd cloud
WARASHI_AWS_INTEGRATION=1 npx vitest --run test/integration
```

Run only that folder. The judgement test needs a **test** thing (not the real doll, because it
uses the same MQTT client id), provisioned with `scripts/provision_device.sh`, and these
variables: `WARASHI_IT_IOT_ENDPOINT`, `WARASHI_IT_DEVICE_ID`, `WARASHI_IT_CERT`, `WARASHI_IT_KEY`,
`WARASHI_IT_CA`, `WARASHI_IT_FAMILY_JPEG` and `WARASHI_IT_STRANGER_JPEG`. Optional:
`WARASHI_IT_API_URL`, `WARASHI_IT_FAMILY_TOKEN` and `WARASHI_IT_REVIEWER_TOKEN`. The header of
`cloud/test/integration/judgement.integration.test.ts` describes each one. Results (p50 and p95
latency) go to the git-ignored `cloud/.integration-out/`. Stranger rounds can send notifications.

### Owner steps

Steps that only the owner can do (demo seeding, e-mail confirmation, voice listening test, Bedrock
model access, account steps, integration measurements, real-doll test) are listed in the section
"Owner and manual steps" of
[`.kiro/specs/cloud-judgement/tasks.md`](.kiro/specs/cloud-judgement/tasks.md).

### Limits to know

- **Art piece, not an alarm.** The guardian is an art piece and not an alarm product. Do not rely
  on it to protect a home. A photograph of a family member (a printed picture or a phone screen)
  may be greeted as family, because the recognition has no liveness check.
- **The largest face decides.** Only the largest face in the image is judged, so a second person
  standing behind a family member is not judged.

---

## Privacy and safety

- Snapshots are stored only in the owner's AWS account and expire within 7 days.
- Face registrations require explicit consent and can be deleted at any time.
- Family names are never spoken or shown to a stranger.
- The dashboard always indicates whether the doll's camera or microphone is active.
- Reviewer demo accounts are read-only: no real snapshots, no doll commands, no face management.

---

## License

MIT — see [LICENSE](LICENSE).  
Third-party notices: [`docs/third-party.md`](docs/third-party.md).
