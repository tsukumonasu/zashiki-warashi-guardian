#!/usr/bin/env python3
"""Find the head's centre position and safe travel range (pan and tilt).

Usage:
    python3 warashi_calib.py pan     # left / right
    python3 warashi_calib.py tilt    # up / down

Enter an angle to glide slowly to that position.
  Example: start at 0, then try 10, 20 … until the cable starts to pull,
           then repeat on the negative side (-10, -20 …).
  c   = record the current angle as the centre reference
  q   = quit (detach servo — no return sweep, to avoid tangling cables)

Results are appended to ~/warashi_limits.txt.
"""

import sys
import time
from pathlib import Path

from gpiozero import AngularServo

PINS = {"pan": 18, "tilt": 13}
HARD_LIMIT = 90  # Clamp ceiling — no input can exceed this value.


def glide(servo, start, end, step=1, wait=0.04):
    d = step if end >= start else -step
    for a in range(int(start), int(end) + d, d):
        servo.angle = a
        time.sleep(wait)


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in PINS:
        print(__doc__)
        sys.exit(1)
    axis = sys.argv[1]
    s = AngularServo(
        PINS[axis],
        min_angle=-90,
        max_angle=90,
        min_pulse_width=0.0005,
        max_pulse_width=0.0024,
    )
    s.detach()  # Do not move on startup — wait for the first input.
    cur = 0
    print(f"{axis}: no movement yet.  Enter 0 first to check the doll is facing forward.")
    print("WARNING: if this is a 360° continuous-rotation servo it will spin without stopping.")
    print("         This script is for 180° positional servos only.")
    print("Enter an angle (e.g. 10, -10), c = record centre, q = quit")
    log = Path.home() / "warashi_limits.txt"
    try:
        while True:
            cmd = input(f"[{axis}  current {cur:+d}°] > ").strip().lower()
            if cmd == "q":
                break
            if cmd == "c":
                msg = f"{axis}: centre is {cur:+d}°  (use CENTER={cur} in config.toml)"
                print(msg)
                log.open("a").write(msg + "\n")
                continue
            try:
                target = max(-HARD_LIMIT, min(HARD_LIMIT, int(cmd)))
            except ValueError:
                print("Enter a number, c, or q")
                continue
            glide(s, cur, target)
            cur = target
            if (
                input("  Cable OK?  Record this angle as the travel limit? [y/n] ")
                .lower()
                .startswith("y")
            ):
                msg = f"{axis}: limit {cur:+d}°"
                print(msg)
                log.open("a").write(msg + "\n")
    except KeyboardInterrupt:
        print()
    finally:
        # Detach without sweeping back — avoids tangling cables on exit.
        s.detach()
        s.close()
        print(f"Log: {log}")


if __name__ == "__main__":
    main()
