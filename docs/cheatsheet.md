# Command cheat sheet

Everyday commands for the doll, the cloud and the dashboard. Replace `<user>@<host>.local`
with your Pi login (see `docs/deployment.en.md`). Nothing here holds a secret.

## Deploy to the Pi
```sh
PI_HOST=<user>@<host>.local scripts/deploy_pi.sh   # rsync /device, install the unit, restart
```
`config.toml` on the Pi is never copied or overwritten. The script needs passwordless `sudo`
on the Pi; if `sudo` asks for a password, run the failing `sudo` step by hand on the Pi.

## Service on the Pi
```sh
sudo systemctl restart warashi-agent     # apply a changed config.toml or new code
sudo systemctl stop warashi-agent        # before any bring-up tool (see below)
sudo systemctl start warashi-agent
systemctl is-active warashi-agent
sudo systemctl disable warashi-agent     # no auto-start at boot (enable turns it back on)
sudo shutdown -h now                     # shut the Pi down; wait for the green LED to go out
```
The service starts at boot. After a start the PIR is ignored for `pir_warmup_s` (60 s).

## Logs
```sh
journalctl -u warashi-agent -f -o cat                         # follow
journalctl -u warashi-agent -f -o cat | grep -v "event Pir"   # without PIR noise
journalctl -u warashi-agent --since "-30min" --no-pager -o cat
journalctl -u warashi-agent -o cat | grep -E "error|failed|missing"
```
A normal encounter reads `sleeping -> waking -> seeking -> gazing -> greeting|warning|uncertain
-> cooldown -> sleeping`. PIR events during any state other than `sleeping` are ignored.

## Check the config
```sh
cd ~/warashi/device
python3 -c "from warashi_agent.config import load_config; print(load_config('config.toml', fake=False))"
```
It prints `Config(...)` when valid and `ConfigRejected(...)` with the broken rule otherwise.

## Bring-up tools (stop the service first)
```sh
sudo systemctl stop warashi-agent
cd ~/warashi/device
python3 tools/warashi_calib.py pan | tilt       # find center and limits (hand-center the head first)
python3 tools/warashi_gaze.py demo              # move through the agent's own servo path
python3 tools/warashi_gaze.py move              # type "<pan> <tilt>" in degrees
python3 tools/warashi_test.py led               # lantern fade
python3 tools/warashi_test.py pir               # PIR edges
python3 tools/check_cloud.py --no-command       # cloud link: PASS or FAIL <step>
sudo systemctl start warashi-agent
```
`warashi_test.py servo` tilts to +-30 degrees; do not run it on an assembled doll.
After using a tool, restart the service so its pose record matches the head.

## Voice packages on the Pi (once)
```sh
sudo apt install -y python3-paho-mqtt python3-websockets
```

## Cloud (from `cloud/`)
```sh
npx cdk deploy --all                                   # everything, including the built dashboard
npx cdk deploy WebStack --exclusively                  # one stack only
npx cdk diff
aws cloudformation describe-stacks --stack-name WebStack \
  --query 'Stacks[0].Outputs' --output table           # URLs and ids
```
Rebuild the dashboard before deploying `WebStack` (`npm run build` in `dashboard/`).
`cdk.context.json` is git-ignored; set `dashboardUrl` there to the `WebUrl` output so that
notification e-mails link to the real dashboard.

## Provision a doll (once per device)
```sh
scripts/provision_device.sh --thing <deviceId> --out ~/warashi-secrets/<deviceId> \
  --policy <DevicePolicyName> --pi-dir /home/<user>/.warashi \
  --appsync-realtime-host <host> --appsync-http-host <host>
```
Copy the certificate, private key and CA file to the Pi by hand, then merge the `[aws]` table of
`warashi-aws.toml` into the Pi's `config.toml`. Policy name and hosts are stack outputs.

## Tests and lint (from the repository root)
```sh
make test      # device, cloud, dashboard
make lint      # ruff, eslint, tsc
```

## Settings that change behaviour (Pi `config.toml`)
| Key | Effect |
|---|---|
| `motion_enabled` | `false` logs servo moves instead of making them. |
| `pan_invert`, `tilt_invert` | Flip a servo's direction after mounting. |
| `pan_limit`, `tilt_limit` | Travel from center; stop short of the cable pulling tight. |
| `glide_interval_ms` | Larger is slower. Raise `waking_timeout_s` and `glide_timeout_s` with it. |
| `cooldown_s` | At least `glide_timeout_s` + lantern fade-out time. |
| `[conversation] conversation_enabled` | Voice session after a family verdict. |
| `conversation_mic_gain` | Software gain of the microphone (0.5 to 16). |
