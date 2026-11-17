#!/usr/bin/env python3
"""Zashiki-Warashi Guardian — hardware smoke test (Raspberry Pi Zero W)

Usage:
    python3 warashi_test.py pir     # PIR sensor (battery not required)
    python3 warashi_test.py servo   # Both servos (connect battery first)
    python3 warashi_test.py led     # Lantern LED (connect battery first)

Press Ctrl+C to stop.

Pin assignments (BCM numbering):
    PIR OUT      GPIO17 (physical 11)
    Head pan     GPIO18 (physical 12)
    Head tilt    GPIO13 (physical 33)
    LED gate     GPIO23 (physical 16)
"""

import sys
from time import sleep

from gpiozero import PWMLED, AngularServo, MotionSensor

PIN_PIR, PIN_PAN, PIN_TILT, PIN_LED = 17, 18, 13, 23


def test_pir():
    print("PIR test: the sensor takes 30–60 s to stabilise after power-on — wait before testing.")
    pir = MotionSensor(PIN_PIR)
    count = 0
    while True:
        pir.wait_for_motion()
        count += 1
        print(f"[{count}] Presence detected (OUT=High)")
        pir.wait_for_no_motion()
        print("     Motion stopped (OUT=Low)")


def make_servo(pin):
    # Pulse widths for SG90 / MG90S.
    # If the servo buzzes at the ends of travel, narrow to 0.0006 / 0.0023.
    return AngularServo(
        pin,
        min_angle=-90,
        max_angle=90,
        min_pulse_width=0.0005,
        max_pulse_width=0.0024,
    )


def sweep(servo, start, end, step=2, wait=0.03):
    """Move slowly — fast movement causes voltage dips that can reboot the Pi."""
    rng = range(start, end + (1 if end >= start else -1), step if end >= start else -step)
    for a in rng:
        servo.angle = a
        sleep(wait)


def test_servo():
    print("Servo test: switch the battery on before running this.")
    for name, pin in (("Head pan  (GPIO18)", PIN_PAN), ("Head tilt (GPIO13)", PIN_TILT)):
        print(f"--- {name} ---")
        s = make_servo(pin)
        print("Centre (0°)")
        s.angle = 0
        sleep(1)
        print("Right / up  30°")
        sweep(s, 0, 30)
        sleep(0.5)
        print("Left / down -30°")
        sweep(s, 30, -30)
        sleep(0.5)
        print("Back to centre")
        sweep(s, -30, 0)
        sleep(0.5)
        s.detach()  # Stop the PWM pulse — prevents jitter and saves battery.
        s.close()
        sleep(1)
    print("Servo test done.  If the horns are not attached yet, fit them at this centre position.")


def test_led():
    print("LED test: switch the battery on before running this.")
    led = PWMLED(PIN_LED)
    print("Fading in and out 3 times — check that R1 (5.6 Ω) does not get too hot.")
    for _ in range(3):
        for i in range(0, 101, 2):
            led.value = i / 100
            sleep(0.03)
        sleep(1)
        for i in range(100, -1, -2):
            led.value = i / 100
            sleep(0.03)
        sleep(0.5)
    led.off()
    print("LED test done.")


if __name__ == "__main__":
    tests = {"pir": test_pir, "servo": test_servo, "led": test_led}
    if len(sys.argv) != 2 or sys.argv[1] not in tests:
        print(__doc__)
        sys.exit(1)
    try:
        tests[sys.argv[1]]()
    except KeyboardInterrupt:
        print("\nStopped.")
