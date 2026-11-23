---
inclusion: always
---

# Hardware rules — the physical doll

Every rule here comes from a real failure during the build. Treat them as hard constraints
for anything under `/device`, and for any command the cloud or the dashboard sends to the doll.

## Pin map (BCM numbering)
| Function | GPIO | Physical pin | Notes |
|---|---|---|---|
| PIR sensor OUT (HC-SR501) | 17 | 11 | 3.3 V logic. Needs 30–60 s warm-up. Output stays high for seconds and retriggers. |
| Pan servo signal (head left / right) | 18 | 12 | |
| Tilt servo signal (nod) | 13 | 33 | |
| Lantern LED through an N-MOSFET gate | 23 | 16 | PWM dimming allowed. |

Power: the Pi's 5 V pin feeds only the PIR sensor. The servos and the LED run from a separate
4.8 V NiMH battery rail that shares ground with the Pi.

## Servos — the dangerous part
- The head uses **180° positional servos** (SG90 / MG90S class). A 360° continuous-rotation
  servo was fitted by mistake once: "go to 0°" made it spin and wind every cable around the
  neck. Code assumes positional servos and never implements time-based spinning.
- **`motion_enabled` in `config.toml` defaults to `false`.** When it is off, servo actions are
  logged instead of executed. The owner turns it on only after the servos are verified and
  calibrated on the real doll.
- **Clamp every angle** to the calibrated range before it reaches a servo: `center ± limit`
  per axis, from `config.toml`. Defaults until calibrated: pan ±30°, tilt ±20°. The config
  loader rejects limits beyond pan ±60° / tilt ±30°, because the camera ribbon cable and the
  servo leads run through the neck.
- **Move slowly:** at most 2° per step and at least 30 ms between steps. Slow turning is part
  of the character and avoids voltage dips that reboot the Pi.
- **Detach after moving** (stop the PWM pulse) to prevent jitter and save battery.
- **No motion on import or at startup.** The first movement happens only in response to an
  event, and it is a slow glide to the calibrated center.
- **End each encounter at center,** then detach, so the next start does not jump.
- **On exit, crash or SIGTERM: detach immediately and switch the lantern off.** Do not sweep
  back to center during shutdown.
- Mounting direction differs per build: `pan_invert` / `tilt_invert` in the config flip the sign.
- gpiozero: `AngularServo(pin, min_angle=-90, max_angle=90, min_pulse_width=0.0005, max_pulse_width=0.0024)`.

## Camera
- ov5647 sensor (Camera Module v1 class): 5 MP, fixed focus, about 54° horizontal field of view.
- It is mounted on the tilt plate inside the head and looks through a hole under the bangs,
  so **the camera sees exactly where the doll is looking.** A face at the image center means
  the doll is facing that person; a face centered at x (0..1) is roughly `(x − 0.5) × 54°`
  off axis.
- Capture: `rpicam-still -n -t 500 --width 640 --height 480 -o <file>`. Keep JPEGs small
  (see the size limit in `docs/schema.md`); the Pi Zero W uplink is slow.
- It is weak in the dark: bring the lantern up before taking a snapshot.

## Audio — Audio-Technica AT-CSP1 USB speakerphone (speaker and microphone in one)
- ALSA device `plughw:CARD=Device,DEV=0`. Select it by card **name**; card numbers change.
- The ALSA mixer is already set and stored on the Pi: `PCM` 100 %, `Mic` 100 % capture,
  `Auto Gain Control` on.
- **PipeWire sets its own volume on top of ALSA, and that one counts.** At every start it put
  the speakerphone sink back to 0.40 (ALSA `PCM` 47 %, -23.8 dB), so the doll's voice was quiet
  even with the unit at maximum. `amixer ... sset PCM 100%` and `alsactl store` do not stick.
  Fix: `wpctl status`, read the number of the Sink "USB Composite Device Analog Stereo", then
  `wpctl set-volume <number> 1.0`; it stays 1.00 after a reboot. This is a step of the Pi setup
  (`docs/deployment.en.md`, B2).
- Playback: 16-bit PCM WAV through `aplay` (assume no MP3 decoder on the Pi). The speaker
  rolls off near 10 kHz, which is fine for voice.
- Recording: mono 16 kHz S16_LE through `arecord`. The microphone is quiet: apply software
  gain with clipping and assume people speak within 1 m. The unit has built-in echo cancellation.

## Reliability lessons
- USB devices are invisible if the power cable and the OTG adapter are swapped between the
  Pi's `PWR` and `USB` ports. Detect "audio device missing" at startup and say so clearly.
- The battery pack has come loose inside the stand before. If the servos and the LED do
  nothing while the Pi runs, suspect the battery rail first and log a clear hint.
- The Pi can lose Wi-Fi at any time. The core loop still reacts: lantern, gaze, cached voice line.
- Never block the main loop on network, camera or audio calls. Each has a timeout.
