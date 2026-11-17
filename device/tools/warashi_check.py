#!/usr/bin/env python3
"""Zashiki-Warashi Guardian — full hardware check (run after assembly)

Usage:
    python3 warashi_check.py          # Step through all checks (press Enter before each)
    python3 warashi_check.py demo     # Run a continuous encounter demo (presence → lantern →
                                      # head turn → snapshot → audio), press Ctrl+C to stop

Checks performed:
    1. PIR sensor   2. Head servos (pan + tilt)   3. Lantern LED
    4. Speaker      5. Microphone                  6. Camera

Prerequisites:
    - Battery switch ON (servos and LED rail)
    - AT-CSP1 USB speakerphone plugged into the Pi's USB port;
      power cable in the PWR port (do not swap them — see hardware.md)
"""

import subprocess
import sys
import time
from datetime import datetime

from gpiozero import PWMLED, AngularServo, MotionSensor

PIN_PIR, PIN_PAN, PIN_TILT, PIN_LED = 17, 18, 13, 23
AUDIO = "plughw:CARD=Device,DEV=0"  # AT-CSP1 — select by card name, not number
PAN_LIMIT, TILT_LIMIT = 30, 20  # Cable-safe travel limits (degrees from centre)

results = {}


def ask(msg):
    return input(f"{msg} [y/n] ").strip().lower().startswith("y")


def run(cmd):
    print("  $ " + " ".join(cmd))
    return subprocess.run(cmd).returncode == 0


def make_servo(pin):
    return AngularServo(
        pin,
        min_angle=-90,
        max_angle=90,
        min_pulse_width=0.0005,
        max_pulse_width=0.0024,
    )


def glide(servo, start, end, step=2, wait=0.03):
    """Move slowly — prevents voltage dips and reduces mechanical stress on the neck."""
    d = step if end >= start else -step
    for a in range(start, end + d, d):
        servo.angle = max(-90, min(90, a))
        time.sleep(wait)


# ---------------------------------------------------------------- checks
def check_pir():
    print("\n[1] PIR sensor: wave your hand in front of the sensor (waits up to 20 s).")
    pir = MotionSensor(PIN_PIR)
    ok = pir.wait_for_motion(timeout=20)
    if ok:
        print("  → Motion detected")
    else:
        print("  → No response (check the sensor is not blocked by the shoji panel)")
    pir.close()
    return bool(ok)


def check_servos():
    print(f"\n[2] Head servos: sweeping pan ±{PAN_LIMIT}° and tilt ±{TILT_LIMIT}° slowly.")
    for name, pin, lim in (
        ("Pan  (left/right)", PIN_PAN, PAN_LIMIT),
        ("Tilt (up/down)", PIN_TILT, TILT_LIMIT),
    ):
        print(f"  {name}")
        s = make_servo(pin)
        s.angle = 0
        time.sleep(0.8)
        glide(s, 0, lim)
        glide(s, lim, -lim)
        glide(s, -lim, 0)
        time.sleep(0.3)
        s.detach()
        s.close()
    return ask("  Movement smooth?  No cable pulling or obstruction?")


def check_led():
    print("\n[3] Lantern LED: fading in and out once.")
    led = PWMLED(PIN_LED)
    for i in list(range(0, 101, 4)) + list(range(100, -1, -4)):
        led.value = i / 100
        time.sleep(0.04)
    led.off()
    led.close()
    return ask("  Lantern lit up?  (Also check the 5.6 Ω resistor is not too hot.)")


def check_speaker():
    print("\n[4] Speaker: playing a test tone (front left / front right).")
    run(["speaker-test", "-D", AUDIO, "-c", "2", "-t", "wav", "-l", "1"])
    return ask("  Could you hear the voice clearly through the lattice?")


def check_mic():
    print("\n[5] Microphone: recording 3 s then playing back.  Speak within 1 m of the doll.")
    input("  Press Enter when ready → ")
    run(
        [
            "arecord",
            "-D",
            AUDIO,
            "-f",
            "S16_LE",
            "-r",
            "16000",
            "-c",
            "1",
            "-d",
            "3",
            "/tmp/warashi_mic.wav",
        ]
    )
    run(["aplay", "-D", AUDIO, "/tmp/warashi_mic.wav"])
    return ask("  Could you hear your own voice?  (Check the mic is not blocked by the case.)")


def check_camera():
    name = f"check_{datetime.now():%H%M%S}.jpg"
    print(f"\n[6] Camera: capturing a photo of the doll's view → {name}")
    ok = run(
        ["rpicam-still", "-n", "-t", "1000", "--width", "1296", "--height", "972", "-o", name]
    )
    if ok:
        print(f"  Copy to Mac to review:  scp pi@<pi-hostname>.local:~/{name} ~/Desktop/")
    return ok


# ---------------------------------------------------------------- demo
def demo():
    print("Demo loop: wave your hand in front of the sensor to trigger an encounter.")
    print("Sequence: lantern → head turns → snapshot → audio.  Press Ctrl+C to stop.")
    pir = MotionSensor(PIN_PIR)
    led = PWMLED(PIN_LED)
    pan = make_servo(PIN_PAN)
    tilt = make_servo(PIN_TILT)
    pan.angle, tilt.angle = 0, 0
    time.sleep(0.8)
    pan.detach()
    tilt.detach()
    try:
        while True:
            pir.wait_for_motion()
            print(f"[{datetime.now():%H:%M:%S}] Presence detected")
            for i in range(0, 101, 5):
                led.value = i / 100
                time.sleep(0.03)
            glide(pan, 0, PAN_LIMIT, wait=0.05)  # Slow turn — slow is part of the character.
            glide(tilt, 0, -10, wait=0.06)  # Slight downward look, then gaze up.
            subprocess.run(
                [
                    "rpicam-still",
                    "-n",
                    "-t",
                    "500",
                    "--width",
                    "640",
                    "--height",
                    "480",
                    "-o",
                    f"demo_{datetime.now():%H%M%S}.jpg",
                ],
            )
            # Placeholder audio — replace with the doll's voice line in production.
            subprocess.run(
                ["speaker-test", "-D", AUDIO, "-c", "1", "-t", "wav", "-l", "1"],
                stdout=subprocess.DEVNULL,
            )
            time.sleep(1)
            glide(tilt, -10, 0, wait=0.06)
            glide(pan, PAN_LIMIT, 0, wait=0.05)
            pan.detach()
            tilt.detach()
            for i in range(100, -1, -5):
                led.value = i / 100
                time.sleep(0.03)
            pir.wait_for_no_motion()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        led.off()


# ---------------------------------------------------------------- main
def main():
    if len(sys.argv) > 1 and sys.argv[1] == "demo":
        demo()
        return
    checks = [
        ("PIR sensor", check_pir),
        ("Head servos", check_servos),
        ("Lantern LED", check_led),
        ("Speaker", check_speaker),
        ("Microphone", check_mic),
        ("Camera", check_camera),
    ]
    print(__doc__)
    for name, fn in checks:
        input(f"\n▶ Next: {name!r}.  Press Enter to start (Ctrl+C to abort).")
        try:
            results[name] = fn()
        except Exception as e:  # One failure must not abort the whole check.
            print(f"  Error: {e}")
            results[name] = False
    print("\n========== Results ==========")
    for name, ok in results.items():
        print(f"  {'✓' if ok else '✗'} {name}")
    print("=============================")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nAborted.")
