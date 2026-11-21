# Zashiki-Warashi Guardian

日本語: [README.ja.md](README.ja.md)

> A traditional Japanese doll that wakes when someone approaches, lights its lantern,
> slowly turns to look at them, greets family members, and unsettles strangers —
> then notifies the family.

<!-- photo or GIF of the doll here -->

**[Live dashboard →](#)** <!-- replace with the deployed URL before submission -->

---

## Reviewer quick start

The simulation needs **no hardware and no account**. A virtual doll runs the same messages as the
real one, in your browser, with bundled sample responses. It also works offline after the first
load. All four scenarios take **under two minutes** in total (about 62 seconds of doll time).
The sign-in below is optional and only adds the Live cloud switch. The demo account is
**read-only**: it cannot move or speak through the real doll, cannot manage faces and never sees
real snapshots. The demo credentials are in the Devpost submission text, not here.

### Simulation (no sign-in)

1. Open the dashboard URL above and click **Enter the house**.
2. Sound is on by default and starts only after your first scenario click. The **Mute sound**
   control in the header stays visible. Every spoken line also shows Japanese text with an English
   subtitle, so the scenarios work muted.
3. Under **Call a visitor**, click one scenario button. The buttons are disabled while one runs;
   **Stop** ends it early.

| Click | You should see |
|---|---|
| **A family member comes home** | State goes Waking, Looking for someone, Gazing, Greeting, Settling down, Sleeping. The lantern glows, the head turns slowly toward the visitor, verdict **Family**, a warm Japanese greeting with an English subtitle. A simulated visit is added to the timeline. About 14 s. |
| **A stranger enters at night** | The doll wakes and stares in silence, then whispers a line (subtitle appears only then). Verdict **Stranger**. The timeline entry shows **Family notified** with the note "(simulated, nothing was sent)". About 17 s. |
| **Something moves, but no one is there** | The doll looks around several times and finds nobody. Verdict **No face**, then a cautious "is someone there?" line. About 20 s. |
| **The network is down** | The doll reacts with no cloud and no snapshot: lantern, gaze and a cached line. Verdict **Offline**. About 11 s. |

4. Open **Timeline** in the navigation. Your runs are listed under **Simulated visits**, newest
   first. Select one to see its events in time order.

### Live cloud (demo sign-in)

1. On the first screen click **Sign in**, enter the demo username and password from the Devpost
   text, and click **Sign in**. The header then shows the role **Reviewer**.
2. Click **Enter the house**, then switch **Live cloud** on. It is off by default.
3. Optionally tick **Generate a new line** to make the cloud write a new spoken line.
4. Click any scenario button. The scenario now asks the real backend (face search and speech) and
   runs its answer on the same virtual doll. Step durations are labelled **Durations measured in
   the browser**. The entry in **Simulated visits** carries the **Live cloud** label.
   **The network is down** makes no cloud call and says "No cloud call: the network is down".
5. If the cloud is busy you see "The cloud needs a rest. Try again in N seconds."; if it does not
   answer within 10 seconds you see "The cloud did not answer". Click **Run in Simulation mode**
   to continue without the cloud. A failed run adds no timeline entry.
6. Real-doll areas (controls, face registration) show "This is someone's home" and stay locked.
   The **Real visits** list shows illustrations instead of snapshots.
7. Click **Sign out** when done.

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

### Voice conversation (optional, off by default)

After a `family` verdict the doll can hold a short spoken conversation in Japanese. The
dashboard can also start one with a virtual doll. The audio goes through an AWS AppSync Events
API to a Lambda function (`voice-session`) that talks to Amazon Nova Sonic on Amazon Bedrock.
Voice is a P1 feature: the core loop never depends on it, and every session ends in the doll's
normal cooldown.

**Off by default.** Two switches must both be on:

| Switch | Where | Default |
|---|---|---|
| `voiceEnabled` | CDK context in `cloud/cdk.context.json`; the kill switch of the whole feature (deploys `VoiceStack`) | `false` |
| `conversation_enabled` | `config.toml` on the doll | `false` |

`reviewerVoiceEnabled` (CDK context, default `false`) additionally lets the read-only reviewer
account talk to the virtual doll in the browser.

**Safety and privacy.**

- **Nova Sonic has no guardrails.** The doll relies on its persona prompt, a text check of the
  model output (blocked words, language), per-day caps, a session time limit and the kill switch.
- **The face check at the start and the re-check during the conversation are the only proof that a
  family member is present.** A photograph of a family member (a printed picture or a phone
  screen) passes them. Do not treat the conversation as authentication.
- Voice goes from the doll or the browser to Amazon Bedrock in the Tokyo Region
  (`ap-northeast-1`). Nothing is stored: no audio, no transcript. Live subtitles are shown while
  the session runs and then dropped. The persona prompt contains no family names.
- The dashboard and the status report show when the microphone is active.

**Owner steps.** The full list (O1 to O8) is in "Owner and manual steps" of
[`.kiro/specs/voice-conversation/tasks.md`](.kiro/specs/voice-conversation/tasks.md). In short:

1. **Lambda concurrency quota.** `voice-session` is deployed with reserved concurrency 3
   (`maxConcurrent`). Lambda always keeps at least 10 unreserved concurrent executions in the
   account. An account still at the default limit must request a quota increase before it deploys
   `VoiceStack`, or the deployment fails. Check the current value with the Service Quotas page for
   Lambda "Concurrent executions".
2. **Opt in.** Set `voiceEnabled` to `true` in `cloud/cdk.context.json`, confirm Bedrock model
   access to `amazon.nova-2-5-sonic` in `ap-northeast-1` (O2), and run `npx cdk deploy --all`. The
   stack outputs add `VoiceHttpHost` and `VoiceRealtimeHost`.
3. **Measure Japanese quality and message ordering (O3).** **Japanese is not officially
   supported by Nova 2.5 Sonic**, so its quality is unverified until you listen to it. Run these
   from your computer with your own AWS credentials. The first needs `boto3` and the Smithy
   Bedrock runtime SDK (`aws_sdk_bedrock_runtime`); the second needs `pip install websockets` and
   a test token. Neither is a dependency of `/device`.

   ```
   python3 scripts/check_sonic_japanese.py [--voice tiffany] [--model amazon.nova-2-5-sonic]
   python3 scripts/check_appsync_ordering.py --http-host <VoiceHttpHost> --realtime-host <VoiceRealtimeHost> --channel <test channel>
   ```

   Listen to the WAV that the first script writes and choose the voice (`tiffany` or `matthew`).
   The second script checks whether AppSync Events keeps audio chunks in order. Record the results
   in `.kiro/specs/voice-conversation/design.md` where it says "pending owner measurement".
   If the Japanese is not good enough, leave `voiceEnabled` off.
4. **Cached lines.** Run `scripts/generate_voice_lines.py` again so the `conversation_trouble` and
   `conversation_bye` lines exist on the doll.
5. **Provision the doll again** with the AppSync host names (stack outputs; give both or neither),
   copy the folder to the Pi and run `scripts/deploy_pi.sh`:

   ```
   scripts/provision_device.sh --thing warashi-01 --out ~/warashi-secrets/warashi-01 \
       --policy <DevicePolicyName> \
       --appsync-realtime-host <VoiceRealtimeHost> --appsync-http-host <VoiceHttpHost>
   ```

6. **Install `websockets` on the Pi (O8b).** The agent uses the OS package, not pip:

   ```
   sudo apt install python3-websockets
   apt policy python3-websockets
   python3 -c "import websockets; print(websockets.version.version)"
   ```

7. **Turn it on for the doll.** Set `conversation_enabled = true` in `config.toml` only after the
   measurements above and the real-doll tests (O8) pass. If the doll echoes its own voice, set
   `conversation_mute_mic_while_speaking = true`.

The host names, tokens and certificates are never committed; they live in `warashi-aws.toml` and
in the stack outputs.

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
