# device/tools — bring-up scripts

These three scripts are meant to be run directly on the Raspberry Pi Zero W,
not imported as a library and not part of the automated test suite.
They require gpiozero, lgpio, and the physical hardware.

---

## warashi_test.py — individual component smoke test

Tests one peripheral at a time. Use this during initial wiring, before the
doll is assembled.

```
python3 warashi_test.py pir     # PIR sensor — no battery needed
python3 warashi_test.py servo   # Both servos — connect battery first
python3 warashi_test.py led     # Lantern LED — connect battery first
```

**Safety notes**
- **Connect the battery before running `servo` or `led`.** Servos and the LED
  run from a separate 4.8 V NiMH battery rail, not the Pi's 5 V pin.
- **Positional servos only.** If a 360° continuous-rotation servo is fitted
  by mistake, `servo` mode will make it spin continuously. The script assumes
  180° positional servos (SG90 / MG90S class). Stop immediately with Ctrl+C
  if any servo does not stop at the commanded angle.
- The PIR sensor takes **30–60 seconds to stabilise** after power-on.
  Wait before testing or you will get false triggers.

---

## warashi_calib.py — servo centre and travel-limit finder

Finds the calibrated centre and the safe travel range for each axis. Run this
*before* fitting the servo horns and before setting values in `config.toml`.

```
python3 warashi_calib.py pan     # left / right axis
python3 warashi_calib.py tilt    # up / down axis
```

Results are appended to `~/warashi_limits.txt`.

**Safety notes**
- Increase angles in small steps (5–10°) and watch the camera ribbon cable
  and servo leads inside the neck. Stop before they pull taut.
- The script clamps input to ±90°, but `config.toml` enforces tighter limits
  at runtime: **pan ±60° / tilt ±30° maximum** (beyond that the cables are at risk).
- The recommended defaults until calibrated are **pan ±30° / tilt ±20°**.
- On quit the servo detaches immediately without sweeping back to centre, to
  avoid tangling cables during exit.

---

## warashi_check.py — post-assembly full check and encounter demo

Run after the doll is fully assembled. Steps through all six peripherals in
sequence and records a pass/fail result for each one.

```
python3 warashi_check.py          # interactive step-by-step check
python3 warashi_check.py demo     # continuous encounter demo loop
```

**Safety notes**
- Plug the AT-CSP1 USB speakerphone into the **USB** port and the power
  supply into the **PWR** port. Swapping them makes USB devices invisible.
- Switch the battery on before starting. If servos and the LED do nothing
  while the Pi is running, the battery rail is the first thing to suspect.
- The head moves to **pan ±30° / tilt ±20°** during the check — the same
  default limits used at runtime. Do not hold the head during the sweep.
- In demo mode the head returns to centre and detaches after each encounter.
  Press Ctrl+C to stop; the script turns the lantern off on exit.
