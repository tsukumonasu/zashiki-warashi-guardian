"""Lantern LED adapter (R16): soft fades on a PWM pin through an N-MOSFET.

Why it is built this way:

- The fade itself is the pure function ``fade_levels``. It is property-tested on its own
  (Property 21), and the adapter only plays its entries against the ``Scheduler``. A fade
  therefore never sleeps on the Dispatcher thread (R20.3), and tests run it in virtual time.
- Each step is one scheduler callback that writes one level and schedules the next step.
  Step times are anchored at the moment the fade started, so a late callback does not push
  the later steps back, and the target is reached by ``fade_ms`` plus at most one 20 ms step.
- A generation counter, checked under the adapter lock, makes cancelling exact: once a new
  fade or ``off_now()`` bumps it, no step of an older fade can write, even one that is already
  running on the scheduler thread.
- The gpiozero device is created only by ``create_pwm_led``, which imports gpiozero inside
  the function. Importing this module on a laptop or in CI needs no gpiozero and touches no pin.
"""

from __future__ import annotations

import logging
import math
import threading
from collections.abc import Callable
from typing import Protocol

from warashi_agent.model import AdapterError, Event, LanternFade
from warashi_agent.timebase import Handle, Scheduler

_log = logging.getLogger(__name__)

Post = Callable[[Event], None]

FADE_STEP_MS = 20
"""Largest gap between two fade steps (R16.1). 50 Hz of updates looks smooth for an LED."""

FADE_MS_MAX = 10000
"""Longest fade (R16.1). Matches the clamp the contract defines for ``lantern.fadeMs``."""

FadeStep = tuple[float, float]
"""``(offset_ms, level)``: write ``level`` at ``offset_ms`` after the fade started."""


# --------------------------------------------------------------------------------------------
# Pure fade plan
# --------------------------------------------------------------------------------------------


def _clamp(value: float, low: float, high: float) -> float:
    """Clamp to ``[low, high]``; NaN becomes ``low``.

    The codec already rejects non-finite numbers, so NaN should never get here. If it did,
    ``low`` (lantern off, no fade) is the safe reading, and gpiozero would raise on NaN.
    """
    if math.isnan(value):
        return low
    return min(max(value, low), high)


def fade_levels(start: float, target: float, fade_ms: float) -> tuple[FadeStep, ...]:
    """Plan a linear fade from ``start`` to ``target`` over ``fade_ms`` (R16.1).

    ``start`` and ``target`` are Clamped to 0..1 and ``fade_ms`` to 0..10000 first, so any
    ``LanternFade`` gives a plan the LED can show. The plan has ``ceil(fade_ms / 20)`` steps,
    the first at most 20 ms in and each next one at most 20 ms later. The start level itself
    is not repeated, because the LED already shows it. The last entry is exactly
    ``(fade_ms, target)``. Offsets are evenly spaced floats (``k * fade_ms / steps``), so an
    integer ``fade_ms`` may give fractional offsets. A zero fade is the single entry
    ``(0, target)``.

    Every level is also Clamped to the interval between start and target, so float rounding
    in the interpolation can never overshoot either end.
    """
    start = _clamp(start, 0.0, 1.0)
    target = _clamp(target, 0.0, 1.0)
    fade = _clamp(fade_ms, 0, FADE_MS_MAX)
    if fade == 0:
        return ((0, target),)
    steps = math.ceil(fade / FADE_STEP_MS)
    low, high = min(start, target), max(start, target)
    plan: list[FadeStep] = []
    for k in range(1, steps):
        # True division, not floor: every gap is exactly fade / steps (at most 20 ms), and the
        # last gap to ``fade`` is the same size. Flooring made the last gap up to 1 ms too long.
        offset = k * fade / steps
        level = _clamp(start + (target - start) * k / steps, low, high)
        plan.append((offset, level))
    plan.append((fade, target))
    return tuple(plan)


# --------------------------------------------------------------------------------------------
# Device
# --------------------------------------------------------------------------------------------


class PwmDevice(Protocol):
    """The part of gpiozero ``PWMLED`` the adapter uses; ``FakePwmDevice`` implements it too."""

    @property
    def value(self) -> float: ...

    @value.setter
    def value(self, level: float) -> None: ...


def create_pwm_led(lantern_pin: int) -> PwmDevice:
    """Create the real lantern output on ``lantern_pin`` (BCM numbering).

    ``initial_value=0`` drives the pin low at creation, so the lantern is off from the first
    moment (R16.3). 100 Hz is far above visible flicker and a light load for lgpio's software
    PWM on the one-core Pi Zero W. gpiozero is imported here, not at module level, so laptops
    and CI import this module without it.
    """
    from gpiozero import PWMLED

    return PWMLED(lantern_pin, initial_value=0, frequency=100)


# --------------------------------------------------------------------------------------------
# Adapter
# --------------------------------------------------------------------------------------------


class LanternAdapter:
    """LanternPort on a PWM device: fades on the Scheduler, immediate off (R16).

    ``handle()`` and ``off_now()`` return at once and never raise. A device write that raises
    cancels the running fade and posts ``adapter.error(adapter_failed)`` (R20.10, R20.11). The
    next ``LanternFade`` is accepted as usual and starts from the level last written.
    """

    def __init__(self, post: Post, scheduler: Scheduler, device: PwmDevice) -> None:
        self._post = post
        self._scheduler = scheduler
        self._device = device
        self._lock = threading.Lock()
        self._generation = 0
        self._handle: Handle | None = None
        self._level = 0.0
        # R16.3: the lantern is off at start. PWMLED(initial_value=0) already wrote 0; a device
        # created with another value gets one explicit write, so 0 never depends on the caller.
        if device.value != 0:
            self._write(0.0)

    @property
    def level(self) -> float:
        """The level last written to the device."""
        with self._lock:
            return self._level

    def handle(self, action: LanternFade) -> None:
        """Cancel any running fade and start a new one from the level last written (R16.2)."""
        try:
            with self._lock:
                self._cancel_locked()
                generation = self._generation
                plan = fade_levels(self._level, action.level, action.fade_ms)
                started = self._scheduler.now()
                self._schedule_locked(generation, started, plan, 0)
        except Exception as exc:  # noqa: BLE001 - handle() must never raise (R20.10)
            self._fail("starting a fade", exc)

    def off_now(self) -> None:
        """Cancel any fade and write 0 on the calling thread (R16.4, R20.6).

        The write is synchronous, so the level is 0 long before the 50 ms bound. No later step
        can write, because the cancel bumped the generation; only a later ``LanternFade``
        lights the lantern again.
        """
        try:
            with self._lock:
                self._cancel_locked()
                self._write_locked(0.0)
        except Exception as exc:  # noqa: BLE001 - shutdown must continue past a failed write
            self._fail("switching off", exc)

    # ---------------------------------------------------------------------------------------
    # Internals
    # ---------------------------------------------------------------------------------------

    def _cancel_locked(self) -> None:
        """Invalidate every step of the current fade; caller holds the lock."""
        self._generation += 1
        if self._handle is not None:
            self._handle.cancel()
            self._handle = None

    def _schedule_locked(
        self, generation: int, started: float, plan: tuple[FadeStep, ...], index: int
    ) -> None:
        """Schedule step ``index`` at its offset from ``started``; caller holds the lock."""
        offset_ms, _ = plan[index]
        self._handle = self._scheduler.call_at(
            started + offset_ms / 1000,
            lambda: self._step(generation, started, plan, index),
        )

    def _step(
        self, generation: int, started: float, plan: tuple[FadeStep, ...], index: int
    ) -> None:
        """Scheduler callback: write one level, then schedule the next step of the fade."""
        try:
            with self._lock:
                if generation != self._generation:
                    return  # cancelled by a newer fade or by off_now()
                self._write_locked(plan[index][1])
                if index + 1 < len(plan):
                    self._schedule_locked(generation, started, plan, index + 1)
                else:
                    self._handle = None
        except Exception as exc:  # noqa: BLE001 - one failed write must not stop the adapter
            with self._lock:
                if generation == self._generation:
                    self._cancel_locked()
            self._fail("fading", exc)

    def _write(self, level: float) -> None:
        with self._lock:
            self._write_locked(level)

    def _write_locked(self, level: float) -> None:
        """Write to the device and remember the level only if the write succeeded."""
        self._device.value = level
        self._level = level

    def _fail(self, doing: str, exc: Exception) -> None:
        """Log and report a failure without raising (R20.10, R20.11).

        Only the exception type is logged, as in the scheduler, so log lines stay free of
        message data.
        """
        _log.error("lantern failed while %s: %s", doing, type(exc).__name__)
        try:
            self._post(AdapterError(code="adapter_failed"))
        except Exception as post_exc:  # noqa: BLE001 - reporting must not raise either
            _log.error("could not post adapter.error: %s", type(post_exc).__name__)
