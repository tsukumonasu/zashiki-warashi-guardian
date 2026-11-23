# device/tools: bring-up scripts

Scripts written while wiring the real doll. Run them on the Raspberry Pi Zero W with
`python3 <script>`. They need gpiozero, lgpio and the hardware, so they are not part of
`make test`.

These scripts drive the GPIO pins directly. **They ignore `config.toml`, including
`motion_enabled` and the calibrated limits.** Only the agent (`warashi_agent`) enforces those.

Suggested order on a new build: `warashi_test.py` → fit the servo horns at center →
`warashi_calib.py` → assemble → `warashi_check.py`.

## warashi_test.py: one component at a time

```
python3 warashi_test.py pir     # PIR sensor (battery not needed)
python3 warashi_test.py servo   # both servos (battery on)
python3 warashi_test.py led     # lantern LED (battery on)
```

- `pir` prints every High/Low change of the PIR output. Wait 30–60 s after power-on first.
- `servo` centers each servo, then sweeps it to +30°, -30° and back to 0°, 2° per 30 ms,
  then detaches it. Fit the servo horns at this center position.
- `led` fades the lantern in and out three times. Check that R1 (5.6 Ω) does not get too hot.

## warashi_calib.py: center and travel limits

```
python3 warashi_calib.py pan
python3 warashi_calib.py tilt
```

Type an angle and the servo glides there at 1° per 40 ms. `c` records the current angle as
the center, `y` after a move records it as a limit, `q` quits. Results are appended to
`~/warashi_limits.txt`; copy them into `config.toml` by hand.

Input is clamped to ±90°, which is wider than the agent allows (pan ±60°, tilt ±30°).
Go up in steps of 5–10° and stop before the camera ribbon or the servo leads pull tight.

## warashi_check.py: full check after assembly

```
python3 warashi_check.py        # PIR, servos, LED, speaker, microphone, camera
python3 warashi_check.py demo   # presence → lantern → turn → snapshot → test sound, in a loop
```

- The step-by-step check asks y/n after each item and prints a summary. One failing item
  does not stop the rest.
- Servos sweep pan ±30° and tilt ±20°. Speaker and microphone use
  `plughw:CARD=Device,DEV=0` (AT-CSP1, selected by name).
- Photos (`check_*.jpg`, `demo_*.jpg`) are saved in the current directory and are
  git-ignored because they may show faces.

## warashi_gaze.py: check calibration through the agent's own servo path
```
sudo systemctl stop warashi-agent
python3 tools/warashi_gaze.py demo    # pan 0 -> +40 -> -40 -> 0, then tilt 0 -> +12 -> -12 -> 0
python3 tools/warashi_gaze.py move    # type "<pan> <tilt>" in degrees from the calibrated center
```
Run it from `~/warashi/device`. Unlike the scripts above, it uses the agent's `ServoAdapter` and
glide planner, so it **does** apply `config.toml`: center offsets, `pan_invert` / `tilt_invert`,
the `pan_limit` / `tilt_limit` clamp (and the optional `tilt_up_limit` / `tilt_down_limit`), at most 2° per 30 ms, and detach after the move. It needs
`motion_enabled = true`, otherwise the moves are only logged. Center the head by hand first: the
first step jumps to the first commanded angle. Positive pan is the doll's right, positive tilt is up.
## check_cloud.py: cloud link check (no hardware needed)

```
python3 check_cloud.py [--config config.toml] [--timeout 10] [--no-command]
```

Uses the real `MqttCloudLink` and the `[aws]` section of `config.toml`. It waits up to 10 s
each for `cloud.connected` and for a command (send any command to the doll while it waits,
for example `mode.set` guard), publishes one `status.report`, and prints `PASS`, or `FAIL <step>`
with a hint (clock sync and certificate checks for a failed connect). Needs `python3-paho-mqtt`.
It never prints the endpoint, file paths, key material or payloads. Its unit test is
`tests/test_check_cloud_tool.py`.

## Safety notes (from `.kiro/steering/hardware.md`)

- **180° positional servos only.** A 360° continuous-rotation servo does not stop at an
  angle and will wind the cables around the neck. Press Ctrl+C at once if a servo keeps turning.
- **Battery rail first.** Servos and LED run from the 4.8 V NiMH pack, not the Pi's 5 V pin.
  If they do nothing while the Pi runs, check that the pack has not come loose.
- **USB ports.** AT-CSP1 in the Pi's `USB` port, power in `PWR`. Swapped, the audio device
  is invisible.
- **The first move is a jump, not a glide.** The scripts create servos with
  `initial_angle=None` (no pulse at creation), but a servo cannot report its position, so the
  first command moves it to the target at full speed. Center the head by hand before you start;
  `warashi_calib.py` asks you to confirm this and limits its first move to ±10°. It detaches
  after every move.
- **`warashi_test.py servo` tilts to ±30°,** beyond the default tilt limit of ±20° and at the
  hard maximum. Do not run it after assembly unless calibration showed ±30° is safe.
- On Ctrl+C the scripts stop without sweeping back to center. `demo` mode switches the lantern off.

These scripts are kept as they were written on the bench (only the language changed). The
agent must not copy their startup behavior. It should create servos with `initial_angle=None`
(no pulse until the first command) and glide slowly to center on the first event.
