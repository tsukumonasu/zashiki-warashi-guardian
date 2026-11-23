#!/usr/bin/env python3
"""Move the head through the agent's own servo path, to check calibration on the real doll.

Usage (on the Pi, from ~/warashi/device, with the service stopped):
    sudo systemctl stop warashi-agent
    python3 tools/warashi_gaze.py [--config config.toml] demo
    python3 tools/warashi_gaze.py [--config config.toml] move

Unlike ``warashi_calib.py``, this uses ``ServoAdapter`` and the glide planner, so it checks what
the agent will really do: the config's center offsets, ``pan_invert`` / ``tilt_invert`` and the
clamp to ``pan_limit`` / ``tilt_limit``, at most 2 degrees per 30 ms step, detach after the move.

  demo   pan 0 -> +40 -> -40 -> 0, then tilt 0 -> +12 -> -12 -> 0 (clamped to your limits).
  move   type "<pan> <tilt>" in degrees from the calibrated center (positive pan = the doll's
         right, positive tilt = up); "q" quits.

It needs ``motion_enabled = true`` in the config, otherwise the moves are only logged. Turn the
head to the center by hand first: a servo cannot report where it is, so the first step jumps
to the first commanded angle. On exit or Ctrl+C the servos are detached with no sweep back.
"""

from __future__ import annotations

import argparse
import logging
import sys
import threading
import time
from pathlib import Path

# Make ``warashi_agent`` importable when this file is run as ``python3 tools/warashi_gaze.py``.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from warashi_agent.adapters.servo import GpiozeroServoFactory, ServoAdapter  # noqa: E402
from warashi_agent.config import Config, load_config  # noqa: E402
from warashi_agent.model import GazeTarget, ServoArrived  # noqa: E402
from warashi_agent.timebase import ThreadScheduler  # noqa: E402

DEMO_POSES = [
    (0.0, 0.0),
    (40.0, 0.0),
    (-40.0, 0.0),
    (0.0, 0.0),
    (0.0, 12.0),
    (0.0, -12.0),
    (0.0, 0.0),
]
MOVE_TIMEOUT_S = 30.0


class _Runner:
    """Sends GazeTarget actions and waits for each ServoArrived."""

    def __init__(self, config: Config) -> None:
        self._arrived: dict[str, threading.Event] = {}
        self._scheduler = ThreadScheduler()
        self._adapter = ServoAdapter(config, self._post, self._scheduler, GpiozeroServoFactory())
        self._count = 0

    def _post(self, event: object) -> None:
        if isinstance(event, ServoArrived):
            done = self._arrived.get(event.motion_id)
            if done is not None:
                done.set()
        else:
            print(f"  adapter event: {event}")

    def move(self, pan: float, tilt: float) -> bool:
        self._count += 1
        motion_id = f"gaze-tool-{self._count}"
        done = self._arrived[motion_id] = threading.Event()
        print(f"  -> pan {pan:+.1f}  tilt {tilt:+.1f}")
        self._adapter.handle(GazeTarget(pan_deg=pan, tilt_deg=tilt, motion_id=motion_id))
        return done.wait(MOVE_TIMEOUT_S)

    def close(self) -> None:
        # Detach at once, with no sweep back to center (hardware rules).
        self._adapter.emergency_detach()
        self._scheduler.shutdown()


def _run(runner: _Runner, mode: str) -> None:
    if mode == "demo":
        for pan, tilt in DEMO_POSES:
            if not runner.move(pan, tilt):
                print("  the move did not finish in time; stopping")
                return
            time.sleep(1.0)  # a pause between poses, so each one can be seen
        print("demo done")
        return
    print('Type "<pan> <tilt>" in degrees (for example "15 0"), or q to quit.')
    while True:
        text = input("> ").strip().lower()
        if text in ("q", "quit"):
            return
        try:
            pan_s, tilt_s = text.split()
            pan, tilt = float(pan_s), float(tilt_s)
        except ValueError:
            print('  enter two numbers, for example "15 0"')
            continue
        if not runner.move(pan, tilt):
            print("  the move did not finish in time")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("mode", choices=("demo", "move"))
    parser.add_argument("--config", default="config.toml")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    config = load_config(args.config, fake=False)
    if not isinstance(config, Config):
        print(f"config rejected: {config}", file=sys.stderr)
        return 1
    if not config.motion.motion_enabled:
        print("motion_enabled is false in the config: moves are only logged, nothing moves.")
    s = config.servo
    print(f"limits: pan +-{s.pan_limit} deg, tilt up {s.tilt_up} deg, down {s.tilt_down} deg")
    print("Stop the warashi-agent service first. Turn the head to the center BY HAND:")
    print("the first step jumps to the first commanded angle.")
    input("Head at the center, battery on, hands clear? Press Enter (Ctrl+C aborts) ")

    runner = _Runner(config)
    try:
        _run(runner, args.mode)
    except KeyboardInterrupt:
        print("\ninterrupted")
    finally:
        runner.close()
        print("servos detached")
    return 0


if __name__ == "__main__":
    sys.exit(main())
