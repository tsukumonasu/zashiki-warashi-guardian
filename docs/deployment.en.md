# Deployment manual (English)

Japanese version: [`deployment.ja.md`](deployment.ja.md)

This manual takes you from an empty AWS account and a fresh Raspberry Pi Zero W to a working doll.
Do the AWS part first: the Pi part needs values from the stack outputs.

| Part | Where it runs | Section |
|---|---|---|
| A. AWS (cloud and dashboard) | your laptop, deploying to your own AWS account | [Part A](#part-a-aws) |
| B. Raspberry Pi (warashi-agent) | the Pi Zero W inside the doll's stand | [Part B](#part-b-raspberry-pi) |

Never commit certificates, keys, `config.toml`, `cdk.context.json`, account ids or host names.
The `.gitignore` already covers them.

---

## Part A: AWS

### A1. Prerequisites

- An AWS account you own, with credentials on your laptop (`aws sts get-caller-identity` works).
  The deploying identity needs broad rights (CloudFormation, IAM, Lambda, S3, IoT, Cognito,
  CloudFront, Rekognition, SNS, DynamoDB, API Gateway, Budgets).
- AWS CLI v2, Node.js (current LTS) with npm, Python 3.13 (for the helper scripts).
- Region: everything deploys to **`ap-northeast-1` (Tokyo)**. This is fixed in `cloud/bin/cloud.ts`.
- Two mailboxes you can read: one for stranger notifications, one for budget alerts.

### A2. Check the code on your laptop (no AWS needed)

```
make setup
make test
make lint
```

### A3. Configure the CDK context

```
cd cloud
npm install
cp cdk.context.example.json cdk.context.json     # git-ignored
```

Edit `cdk.context.json`:

| Key | Required | Meaning |
|---|---|---|
| `notificationEmail` | yes | Receives stranger notifications (SNS e-mail subscription). |
| `budgetAmountUsd` | yes | Monthly budget in USD, greater than 0. |
| `budgetEmail` | yes | Receives budget alerts at 50, 80 and 100 percent. |
| `voiceEnabled` | no, default `false` | Kill switch of the voice conversation. Leave `false` for the first deployment. |
| `dashboardUrl` | no | The dashboard URL (stack output `WebUrl`). Set it after the first deployment, see A6. |

Other tunables (`familyMin`, `strangerMax`, `snapshotExpiryDays`, `statusIntervalS`,
`reviewerRealEncounters`, and so on) are optional. An environment variable with the prefix
`WARASHI_` overrides a context value. Defaults and ranges are in `cloud/lambda/_shared/config.ts`.
A missing or invalid required key fails `cdk synth` with a message that names the key.

### A4. Build the dashboard, then deploy

The `WebStack` uploads `dashboard/dist`. If that folder is empty or missing, CDK deploys a
placeholder page instead, so build first.

```
cd dashboard
npm install
npm run build
cd ../cloud
npx cdk bootstrap          # once per account and Region
npx cdk diff               # optional: review what will be created
npx cdk deploy --all
```

Stacks, in dependency order: `DataStack`, `JudgementStack`, `ApiStack`, `VoiceStack`, `WebStack`;
`BudgetStack` is independent. Everything is tagged `project=zashiki-warashi`.

Write down the stack outputs. You need them later:

| Output | Used for |
|---|---|
| `WebUrl` | The dashboard address. |
| `ApiUrl`, `UserPoolId`, `UserPoolClientId` | The dashboard reads them from `/config.json`; also useful for user creation. |
| `IotEndpoint` | The doll's MQTT endpoint (written by `provision_device.sh`). |
| `DevicePolicyName` | Argument of `provision_device.sh --policy`. |
| `DataBucketName` | Argument of `seed_demo_collection.py --bucket`. |
| `StrangerTopicArn`, `HouseholdCollectionId`, `DemoCollectionId` | Reference. |
| `VoiceHttpHost`, `VoiceRealtimeHost` | Only when `voiceEnabled` is true. |

You can print them again at any time:

```
aws cloudformation describe-stacks --region ap-northeast-1 \
  --query "Stacks[].Outputs[].[OutputKey,OutputValue]" --output text
```

### A5. Confirm the notification e-mail (within 48 hours)

SNS sends a confirmation message to `notificationEmail`. Click the link. Until you do, no stranger
notification reaches you, and an unconfirmed subscription expires after 48 hours.

### A6. Set `dashboardUrl` and redeploy

`JudgementStack` takes the dashboard URL from context because reading it from `WebStack` would
create a dependency cycle. After the first deployment, add the `WebUrl` value to
`cdk.context.json` and deploy again:

```
"dashboardUrl": "https://<your-cloudfront-domain>"
```
```
npx cdk deploy --all
```

### A7. Create users

Self sign-up is off. Create each user in the Cognito user pool and put them into a group.
The password needs at least 12 characters with lower case, upper case and a digit.

```
POOL=<UserPoolId>
aws cognito-idp admin-create-user --region ap-northeast-1 --user-pool-id "$POOL" \
  --username <family-user> --user-attributes Name=email,Value=<mail> \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password --region ap-northeast-1 --user-pool-id "$POOL" \
  --username <family-user> --password '<strong password>' --permanent
aws cognito-idp admin-add-user-to-group --region ap-northeast-1 --user-pool-id "$POOL" \
  --username <family-user> --group-name family
```

Repeat with `--group-name reviewer` for the read-only demo account. A user without a group has no
access. If a user is in both groups, `reviewer` applies.

### A8. Seed the demo collection (for the simulation)

`POST /simulate` works only with sample portraits you provide. Put consented portraits as
`<id>.jpg` and a `manifest.json` (ids and labels only, no names) in a folder **outside** the
repository.

```
pip install boto3
python3 scripts/seed_demo_collection.py --bucket <DataBucketName> --samples-dir <folder>
```

Only `family`-labeled portraits are indexed, into the demo collection. The household collection
is not touched. Until you seed it, `POST /simulate` answers `validation_failed`.

### A9. Generate the cached voice lines

Run on your laptop, never on the Pi. It calls Amazon Polly and writes one WAV per line next to
`device/warashi_agent/voice/lines.toml`.

```
python3 scripts/generate_voice_lines.py [--voice Kazuha] [--region ap-northeast-1]
```

The WAV files are git-ignored. Part B copies them to the Pi with `deploy_pi.sh`.

### A10. Verify the cloud

1. Open `WebUrl`, sign in with the family user, run a simulation scenario.
2. Walk through `docs/dashboard-owner-checks.md` (sign-in from the deployed origin, face upload,
   iOS audio, service worker, layout, keyboard use).
3. Optional integration tests against your stack (use a **test** thing, not the real doll):
   `cd cloud && WARASHI_AWS_INTEGRATION=1 npx vitest --run test/integration`
   (variables are described in `README.md`).

### A11. Optional: voice conversation

Off by default. Two switches must be on: `voiceEnabled` in `cdk.context.json` and
`conversation_enabled` in the doll's `config.toml`.

1. **Lambda concurrency quota.** `voice-session` reserves concurrency 3, and Lambda keeps at least
   10 unreserved executions per account. An account still at the default limit must request a
   quota increase (Service Quotas, Lambda, "Concurrent executions") before deploying.
2. **Bedrock model access** to `amazon.nova-2-5-sonic` in `ap-northeast-1`, enabled in the console.
3. Set `"voiceEnabled": true` and run `npx cdk deploy --all`. The outputs add `VoiceHttpHost` and
   `VoiceRealtimeHost`.
4. Japanese is not officially supported by Nova 2.5 Sonic. Listen before you enable it:
   `python3 scripts/check_sonic_japanese.py` and `python3 scripts/check_appsync_ordering.py ...`
   (see `README.md`). If the quality is not acceptable, set `voiceEnabled` back to `false`.
5. Run `scripts/generate_voice_lines.py` again, provision the doll again with both AppSync hosts
   (B3), and set `conversation_enabled = true` on the Pi only after the real-doll tests pass.

### A12. Update and teardown

- Update: change the code, `npm run build` in `dashboard/` if the dashboard changed, then
  `npx cdk deploy --all`.
- Teardown: `cd cloud && npx cdk destroy --all`. The stacks use `RemovalPolicy.DESTROY`, so the data
  bucket, tables and face collections are deleted with them. IoT things and certificates created by
  `provision_device.sh` are not part of the stacks; delete them yourself.

---

## Part B: Raspberry Pi

### B1. Prerequisites

- Hardware built and wired as in `.kiro/steering/hardware.md`: PIR on GPIO 17, pan servo GPIO 18,
  tilt servo GPIO 13, lantern MOSFET gate GPIO 23, servos and LED on the separate 4.8 V battery
  rail with common ground, AT-CSP1 speakerphone in the `USB` port (power in `PWR`), camera attached.
- **180° positional servos only.** A continuous-rotation servo winds the cables around the neck.
- Raspberry Pi OS with the system Python 3.13 written to the SD card, Wi-Fi configured, SSH enabled,
  a non-root first user. The deploy script needs passwordless `sudo` (the OS default for that user).
- On your laptop: `rsync` and `ssh` access to the Pi (`ssh <user>@<hostname>.local` works), the
  AWS CLI v2 and `curl` (for B3).

### B2. Install the OS packages on the Pi

The agent uses the system Python and `apt` packages. Do not use pip on the Pi.

```
sudo apt update
sudo apt install python3-gpiozero python3-lgpio python3-paho-mqtt alsa-utils rpicam-apps
# only for voice conversation:
sudo apt install python3-websockets
```

Check the hardware before the agent runs. Copy `device/tools` to the Pi (or use the copy that
`deploy_pi.sh` places in `~/warashi/device/tools`) and run, in this order:

```
python3 warashi_test.py pir      # wait 30-60 s after power-on
python3 warashi_test.py servo    # fit the servo horns at the center position
python3 warashi_test.py led
python3 warashi_calib.py pan     # then: tilt. Results go to ~/warashi_limits.txt
python3 warashi_check.py         # PIR, servos, LED, speaker, microphone, camera
```

These tools ignore `config.toml` and `motion_enabled`. Details and safety notes:
`device/tools/README.md`. Center the head by hand before each run.

**Raise the PipeWire volume (the doll's voice is too quiet otherwise).** Raspberry Pi OS runs
PipeWire, and it resets the speakerphone to a volume of 0.40 (ALSA `PCM` at 47 %, -23.8 dB) every
time it starts. The speakerphone's own volume can be at maximum and the voice is still quiet.
Setting ALSA with `amixer -c 1 sset PCM 100%` and `sudo alsactl store` does not last, because
PipeWire sets 0.40 again at the next start. Set the volume in PipeWire instead:
```
wpctl status                       # under "Sinks", find the number of "USB Composite Device Analog Stereo"
wpctl set-volume <number> 1.0      # the number may change after a reboot or after you move the USB plug
wpctl get-volume <number>          # should print: Volume: 1.00
```
The 1.00 survives a reboot. Check it once after the first reboot, and again if you replace the
speakerphone or change its USB port.

### B3. Provision the doll in AWS IoT Core (on your laptop)

Needs the stack outputs from A4. The `--out` folder must be outside any git work tree.

```
scripts/provision_device.sh --thing warashi-01 --out ~/warashi-secrets/warashi-01 \
    --policy <DevicePolicyName>
# with voice: add
#   --appsync-realtime-host <VoiceRealtimeHost> --appsync-http-host <VoiceHttpHost>
```

The script is safe to run again. `--rotate` issues a new certificate and retires the old one only
after the new one is attached. It prints the two commands to copy the files; they look like this:

```
ssh <user>@<host> 'mkdir -p -m 700 /home/pi/.warashi'
scp ~/warashi-secrets/warashi-01/{device.pem.crt,device.private.key,AmazonRootCA1.pem,warashi-aws.toml} \
    <user>@<host>:/home/pi/.warashi/
```

If your Pi user is not `pi`, pass `--pi-dir /home/<user>/.warashi`.

### B4. Create `config.toml` on the Pi

`deploy_pi.sh` never copies or overwrites `config.toml`. Create it once on the Pi, in the working
directory of the service (`~/warashi/device` by default):

```
mkdir -p ~/warashi/device
cp ~/warashi/device/config.example.toml ~/warashi/device/config.toml   # after the first deploy (B5)
```

Edit it:

1. Merge the `[aws]` table from `~/.warashi/warashi-aws.toml` (endpoint, certificate paths).
   Make sure it has `enabled = true`.
2. Set `[servo]` center offsets and limits from the calibration, and `pan_invert` / `tilt_invert`
   if the mounting direction requires it. The loader rejects pan beyond ±60° and tilt beyond ±30°.
3. Keep **`motion_enabled = false`** until B7 passes. While it is false, servo actions are only logged.
4. Leave `conversation_enabled` off until A11 is complete.

### B5. Deploy the agent (from your laptop)

**Prerequisite: the cached voice lines (WAV files) must already exist (A9).** If
`device/warashi_agent/voice/` has no WAV files, the doll cannot speak and logs
`voice_file_missing` at startup. Check before deploying:

```
ls device/warashi_agent/voice/*.wav | wc -l     # must equal the number of lines in lines.toml (currently 13)
```

```
PI_HOST=<user>@<hostname>.local scripts/deploy_pi.sh     # or: make deploy
# optional: PI_DIR=~/warashi/device (default)
```

The script copies `device/` with rsync (no `--delete`; it skips `config.toml`, `.venv`, caches and
`last_pose.json`; the generated WAV files are included), installs `/etc/systemd/system/warashi-agent.service`
with the real user and path, enables it and restarts it. It stops at the first failing step and
names that step. Run B4 now if this was the first deployment, then run the script again.

### B6. Check the link and the agent

On the Pi, in `~/warashi/device`:

```
python3 tools/check_cloud.py          # prints PASS or "FAIL <step>" with a hint
python3 -m warashi_agent --selftest   # each adapter once: PASS, FAIL or SKIP
systemctl status warashi-agent
journalctl -u warashi-agent -f
```

Also check that the startup log shows no `voice_file_missing` or `voice_line_invalid`; both mean
cached voice lines are missing.

`check_cloud.py` waits for `cloud.connected` and a command: send any command from the dashboard
while it waits. If the connection fails, check the Pi clock first (`timedatectl`), then the
certificate paths. If the servos and the LED do nothing while the Pi runs, suspect the battery
rail. If the audio device is missing, check that the power cable and the OTG adapter are not
swapped between `PWR` and `USB`.

### B7. Turn on motion

With the head centered by hand, the doll's neck free of cables and the battery pack seated, set
`motion_enabled = true` in `config.toml`, then:

```
sudo systemctl restart warashi-agent
```

The PIR sensor is ignored for `pir_warmup_s` (60 s) after start. Walk in front of the doll: the
lantern fades in, the head turns slowly, and the encounter appears on the dashboard timeline. If
anything turns too far or keeps spinning, stop it at once: `sudo systemctl stop warashi-agent`.

### B8. Operate and update

| Task | Command |
|---|---|
| Update the agent | `PI_HOST=... scripts/deploy_pi.sh` |
| New voice lines | `scripts/generate_voice_lines.py`, then `deploy_pi.sh` |
| Logs | `journalctl -u warashi-agent -f` |
| Stop / start | `sudo systemctl stop|start warashi-agent` |
| Rotate the certificate | `scripts/provision_device.sh ... --rotate`, copy the files, restart |
| Run without hardware | `make fake` on a laptop |

The service stops on SIGTERM by detaching the servos and switching the lantern off. It does not
sweep back to center.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `cdk synth` names a context key | A required key in `cdk.context.json` is missing or invalid. |
| Dashboard shows "has not been built yet" | `dashboard/dist` was empty at deploy time. Run `npm run build`, deploy again. |
| No stranger e-mail | The SNS subscription is not confirmed (A5). |
| `VoiceStack` deployment fails | Lambda concurrency quota too low (A11). |
| `provision_device.sh` refuses `--out` | The folder is inside a git work tree. Choose another. |
| `deploy_pi.sh: step 'user query' failed` | SSH user is root, or SSH failed. Use a normal user. |
| Doll reacts with the "is someone there?" line only | The cloud link is down. Run `check_cloud.py`; the offline loop still works by design. |
| `voice_file_missing` / `voice_line_invalid` at startup, or no voice | The cached voice lines were not generated or not copied. Run A9, then B5 again. On the Pi, check that `~/warashi/device/warashi_agent/voice/` holds the WAV files. |
| The doll's voice is very quiet although the speakerphone is at maximum | PipeWire resets the volume to 0.40 at every start. Run `wpctl set-volume <sink number> 1.0` (B2). |
| Servo logs appear but nothing moves | `motion_enabled` is still `false`. |
