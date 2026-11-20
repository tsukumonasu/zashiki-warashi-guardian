"""Servo_Adapter: runs Glide_Planner plans on the pan and tilt servos (R14.5, R14.6, R15).

Why this module looks the way it does:

- The head servos sit in the doll's neck, with the camera ribbon and the servo leads running
  through it (hardware.md). The adapter decides nothing about angles: every angle it writes is
  a Commanded_Angle of a ``GlidePlan`` from ``glide.plan_glide``, which clamps and slows the
  motion. The adapter only adds timing, detaching and the pose file.
- Servo output devices are created only when the first ``GazeTarget`` arrives and only while
  ``motion_enabled`` is true, and they are created with ``initial_angle=None``. Importing this
  module, building the adapter or starting the agent therefore sends no pulse (R15.6, R15.10).
- With ``motion_enabled = false`` the same schedule runs, but each step is logged instead of
  written. No device is created, no PWM starts and ``pose_file`` is left alone, while
  ``servo.arrived`` still comes at the planned time, so the rest of the loop behaves the same
  on an uncalibrated doll (R15.1, R15.2).
- The work runs as short callbacks on a ``Scheduler`` (one step per callback), so ``handle()``
  never waits for a glide and tests drive the adapter in virtual time with ``ManualScheduler``.
- ``gpiozero`` and ``lgpio`` are imported only inside ``GpiozeroServoFactory``, so this module
  imports on a laptop and in CI, where those packages are missing.
"""

from __future__ import annotations

import json
import logging
import math
import os
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

from warashi_agent.config import Config
from warashi_agent.glide import GlidePlan, plan_glide, to_servo_angle
from warashi_agent.model import AdapterError, Axis, Event, GazeTarget, ReleaseServos, ServoArrived
from warashi_agent.timebase import Handle, Scheduler

_log = logging.getLogger(__name__)

Post = Callable[[Event], None]

# R29.2 tolerance for time comparisons. ``t0 + (k-1)·i + i`` and ``t0 + k·i`` can differ by one
# float ulp; without a tolerance that ulp would push a step past its scheduled time.
_TIME_TOL_S = 1e-9

# AngularServo arguments from hardware.md (R15.3). Positional 180° servos only.
_MIN_ANGLE = -90
_MAX_ANGLE = 90
_MIN_PULSE_WIDTH = 0.0005
_MAX_PULSE_WIDTH = 0.0024


# --------------------------------------------------------------------------------------------
# Device interface
# --------------------------------------------------------------------------------------------


class ServoDevice(Protocol):
    """The part of gpiozero ``AngularServo`` the adapter uses.

    Writing a number to ``angle`` sends pulses for that absolute angle; ``detach()`` stops the
    pulses so the servo stops jittering and drawing current; ``close()`` releases the pin.
    """

    @property
    def angle(self) -> float | None: ...

    @angle.setter
    def angle(self, value: float | None) -> None: ...

    def detach(self) -> None: ...

    def close(self) -> None: ...


class ServoDeviceFactory(Protocol):
    """Creates one servo output device per pin, without sending a pulse (R15.10).

    ``GpiozeroServoFactory`` is the real one; ``fakes.FakeServoDeviceFactory`` records every
    creation, write, detach and PWM start, and is injected into this same adapter (R15.9).
    """

    def create(self, pin: int) -> ServoDevice: ...


class GpiozeroServoFactory:
    """Real factory: gpiozero ``AngularServo`` on the fine-duty lgpio pin factory (Q1).

    The imports happen here and not at module level, so only a build that really drives
    servos needs gpiozero and lgpio. The pin factory itself is opened on the first
    ``create()``, so constructing this object claims no GPIO line.
    """

    def __init__(self) -> None:
        import lgpio
        from gpiozero import AngularServo
        from gpiozero.exc import PinInvalidState
        from gpiozero.pins.lgpio import LGPIOFactory, LGPIOPin

        self._angular_servo = AngularServo
        self._pin_factory_class = _fine_lgpio_factory_class(
            lgpio, LGPIOFactory, LGPIOPin, PinInvalidState
        )
        self._pin_factory: Any = None

    def create(self, pin: int) -> ServoDevice:
        """Create a positional servo on ``pin`` with no initial pulse (R15.3, R15.10)."""
        if self._pin_factory is None:
            self._pin_factory = self._pin_factory_class()
        return self._angular_servo(
            pin,
            initial_angle=None,
            min_angle=_MIN_ANGLE,
            max_angle=_MAX_ANGLE,
            min_pulse_width=_MIN_PULSE_WIDTH,
            max_pulse_width=_MAX_PULSE_WIDTH,
            pin_factory=self._pin_factory,
        )


def _fine_lgpio_factory_class(
    lgpio: Any, lgpio_factory: type, lgpio_pin: type, pin_invalid_state: type[Exception]
) -> type:
    """Build ``FineLGPIOFactory``, whose pins pass the PWM duty cycle to lgpio as a float.

    gpiozero 2.0.1 ``LGPIOPin._set_state`` sends ``int(value * 100)`` to ``lgpio.tx_pwm``. At
    50 Hz a whole percent of duty is 200 µs, about 19° on these servos, so a 2° glide step
    would not move the head at all and then jump. ``tx_pwm`` accepts a float duty cycle, so
    passing ``value * 100`` unrounded restores the step size the Glide_Planner intends.

    The classes are built in a function because their base classes exist only after the lazy
    gpiozero import.
    """

    class FineLGPIOPin(lgpio_pin):  # type: ignore[misc, valid-type]
        def _set_state(self, value: float) -> None:
            if not self._pwm:
                super()._set_state(value)
                return
            frequency, _ = self._pwm
            duty = value * 100
            self._pwm = (frequency, duty)
            try:
                lgpio.tx_pwm(self.factory._handle, self._number, frequency, duty)
            except lgpio.error as exc:
                raise pin_invalid_state(f'invalid state "{value}" for pin {self!r}') from exc

    class FineLGPIOFactory(lgpio_factory):  # type: ignore[misc, valid-type]
        def __init__(self) -> None:
            super().__init__()
            self.pin_class = FineLGPIOPin

    return FineLGPIOFactory


# --------------------------------------------------------------------------------------------
# Adapter
# --------------------------------------------------------------------------------------------


class ServoAdapter:
    """ServoPort implementation: one glide plan at a time, executed step by step.

    Thread model: ``handle()`` and ``emergency_detach()`` run on the Dispatcher thread, step
    and detach callbacks on the Scheduler thread. One lock guards the plan, the devices and
    the last written angles. A step callback holds it only for its (at most two) angle
    assignments, so ``ReleaseServos`` and ``emergency_detach()`` get it within microseconds and
    detach well within 50 ms (R15.5). Events are posted after the lock is released.

    Every failure inside the adapter cancels the plan, detaches both servos and posts
    ``adapter.error(adapter_failed)``; ``handle()`` never raises (R15.11, R20.10, R20.11).
    """

    def __init__(
        self,
        config: Config,
        post: Post,
        scheduler: Scheduler,
        factory: ServoDeviceFactory,
    ) -> None:
        self._cfg = config
        self._post = post
        self._scheduler = scheduler
        self._factory = factory
        self._enabled = config.motion.motion_enabled
        self._pose_path = Path(config.servo.pose_file)
        self._lock = threading.Lock()
        # Created on the first plan while motion is enabled (R15.6); (pan, tilt).
        self._devices: tuple[ServoDevice, ServoDevice] | None = None
        # True while a pulse may be running: set by a write, cleared by a detach.
        self._attached = False
        # Last Commanded_Angles written per axis (logged instead of written when motion is
        # disabled). None until the first plan reads the pose file (R15.8).
        self._position: tuple[float, float] | None = None
        self._last_write_at: float | None = None
        self._plan: GlidePlan | None = None
        self._step_handle: Handle | None = None
        self._step_due = 0.0
        self._detach_handle: Handle | None = None
        self._detach_token: object | None = None
        self._stopped = False
        if not self._enabled:
            _log.info("motion_enabled is false: servo moves are logged, not executed")

    # ---- ServoPort -----------------------------------------------------------------------

    def handle(self, action: GazeTarget | ReleaseServos) -> None:
        """Start a glide or release the servos. Returns at once and never raises."""
        try:
            if isinstance(action, GazeTarget):
                self._start_plan(action)
            elif isinstance(action, ReleaseServos):
                with self._lock:
                    self._cancel_locked()
                    self._detach_locked()
            else:
                _log.warning("servo adapter ignores %s", type(action).__name__)
        except Exception as exc:  # noqa: BLE001 - R20.10: a failure becomes adapter.error
            self._fail(exc)

    def emergency_detach(self) -> None:
        """Cancel the plan and detach both servos now, with no glide to center (R20.6).

        Called once at shutdown. Later Actions are ignored, so nothing can move the head
        after the Dispatcher's hardware gate has closed.
        """
        with self._lock:
            self._stopped = True
            self._cancel_locked()
            self._detach_locked()

    # ---- Plans ---------------------------------------------------------------------------

    def _start_plan(self, action: GazeTarget) -> None:
        """Replace the running plan with one from the last written angles (R14.5, R14.6)."""
        arrived: ServoArrived | None = None
        with self._lock:
            if self._stopped:
                return
            now = self._scheduler.now()
            start = self._angles_locked()
            target = (action.pan_deg, action.tilt_deg)
            plan = plan_glide(start, target, now, action.motion_id, self._cfg)
            if plan is None:
                # R14.9: the running plan continues and this Motion_Id never arrives.
                _log.warning("servo ignores non-finite target (motion %s)", action.motion_id)
                return
            self._cancel_locked()
            if self._enabled and self._devices is None:
                self._devices = self._create_devices_locked()
            if plan.steps == 0:
                # An empty plan completes when it starts (R15.4).
                arrived = ServoArrived(motion_id=plan.motion_id)
                if self._attached:
                    self._arm_detach_locked(now)
            else:
                self._plan = plan
                self._schedule_step_locked(plan, 1)
        if arrived is not None:
            self._post(arrived)

    def _schedule_step_locked(self, plan: GlidePlan, k: int) -> None:
        """Schedule step k at its planned time, but never within one interval of the last write.

        On the Pi the scheduler thread can run a step late; the next step then moves later
        too, so two writes on an axis are never closer than ``glide_interval_ms`` (R15.3).
        """
        due = plan.scheduled_time(k)
        if self._last_write_at is not None:
            earliest = self._last_write_at + plan.interval_s
            if earliest - due > _TIME_TOL_S:
                due = earliest
        self._step_due = due
        self._step_handle = self._scheduler.call_at(due, lambda: self._step(plan, k))

    def _step(self, plan: GlidePlan, k: int) -> None:
        """Scheduler callback: write (or log) step k of ``plan``; post arrival after the last."""
        try:
            arrived = self._step_locked(plan, k)
        except Exception as exc:  # noqa: BLE001 - R15.11: cancel, detach, adapter.error
            self._fail(exc)
            return
        if arrived is not None:
            self._post(arrived)

    def _step_locked(self, plan: GlidePlan, k: int) -> ServoArrived | None:
        with self._lock:
            if self._plan is not plan or self._stopped:
                return None  # cancelled while this callback was queued
            now = self._scheduler.now()
            if now < self._step_due:
                # Never write before the scheduled time (R15.3), whatever the scheduler does.
                self._step_handle = self._scheduler.call_at(
                    self._step_due, lambda: self._step(plan, k)
                )
                return None
            pan = plan.pan[k - 1] if k <= len(plan.pan) else None
            tilt = plan.tilt[k - 1] if k <= len(plan.tilt) else None
            if self._enabled:
                if pan is not None:
                    self._write_locked(Axis.PAN, pan)
                if tilt is not None:
                    self._write_locked(Axis.TILT, tilt)
            else:
                # Track the intended angles, so the next plan starts where this one would
                # have left the head and the schedule matches the enabled case.
                self._log_disabled_step(plan, k, pan, tilt)
                pan0, tilt0 = self._position_or_zero()
                self._position = (
                    pan if pan is not None else pan0,
                    tilt if tilt is not None else tilt0,
                )
            self._last_write_at = now
            if k < plan.steps:
                self._schedule_step_locked(plan, k + 1)
                return None
            self._plan = None
            self._step_handle = None
            if self._attached:
                self._arm_detach_locked(now)
            return ServoArrived(motion_id=plan.motion_id)

    def _write_locked(self, axis: Axis, angle: float) -> None:
        """Write one Commanded_Angle as an absolute servo angle (R14.7, R15.3)."""
        if self._devices is None:  # created before the first step; a raise means a bug
            raise RuntimeError("servo write before the devices were created")
        pan_device, tilt_device = self._devices
        device = pan_device if axis is Axis.PAN else tilt_device
        device.angle = to_servo_angle(axis, angle, self._cfg.servo)
        self._attached = True
        pan, tilt = self._position_or_zero()
        self._position = (angle, tilt) if axis is Axis.PAN else (pan, angle)

    def _log_disabled_step(
        self, plan: GlidePlan, k: int, pan: float | None, tilt: float | None
    ) -> None:
        """One line per scheduled time with the angles that would be written (R15.1)."""
        _log.info(
            "motion disabled, not moving: motion %s step %d/%d pan %s tilt %s",
            plan.motion_id,
            k,
            plan.steps,
            "-" if pan is None else f"{pan:.2f}",
            "-" if tilt is None else f"{tilt:.2f}",
        )

    # ---- Cancel, detach, failure ---------------------------------------------------------

    def _cancel_locked(self) -> None:
        """Drop the running plan (no ``servo.arrived`` for it) and any pending auto-detach."""
        if self._step_handle is not None:
            self._step_handle.cancel()
        if self._detach_handle is not None:
            self._detach_handle.cancel()
        self._plan = None
        self._step_handle = None
        self._detach_handle = None
        self._detach_token = None

    def _arm_detach_locked(self, last_write_at: float) -> None:
        """Detach ``servo_settle_ms`` after the last write unless a new plan starts (R15.4)."""
        token = object()
        self._detach_token = token
        self._detach_handle = self._scheduler.call_at(
            last_write_at + self._cfg.servo.servo_settle_ms / 1000,
            lambda: self._auto_detach(token),
        )

    def _auto_detach(self, token: object) -> None:
        try:
            with self._lock:
                if self._detach_token is not token or self._plan is not None:
                    return
                self._detach_handle = None
                self._detach_token = None
                self._detach_locked()
        except Exception as exc:  # noqa: BLE001 - R20.10
            self._fail(exc)

    def _detach_locked(self) -> None:
        """Stop the pulses on both axes, then save the pose while motion is enabled (R15.7).

        Never raises: a detach failure on one axis must not keep the other axis powered.
        Calling ``detach()`` on a servo that is already detached is harmless, so this runs
        even when ``_attached`` is false, as a safety net for shutdown.
        """
        if self._devices is None:
            return
        for device in self._devices:
            try:
                device.detach()
            except Exception as exc:  # noqa: BLE001
                _log.error("servo detach failed: %s", type(exc).__name__)
        self._attached = False
        if self._enabled:
            self._write_pose_locked()

    def _fail(self, exc: Exception) -> None:
        """Worker failure (R15.11): cancel the plan, detach both servos, post adapter_failed."""
        # Only the type is logged: the adapter has no secrets, but log lines stay uniform with
        # the other adapters, whose exceptions may carry message data (R21.4).
        _log.error(
            "servo adapter failed (%s); plan cancelled, servos detached", type(exc).__name__
        )
        with self._lock:
            self._cancel_locked()
            self._detach_locked()
        self._post(AdapterError(code="adapter_failed"))

    def _create_devices_locked(self) -> tuple[ServoDevice, ServoDevice]:
        """Create the pan and tilt devices; on a partial failure release the first one."""
        pins = self._cfg.pins
        pan = self._factory.create(pins.pan_pin)
        try:
            tilt = self._factory.create(pins.tilt_pin)
        except Exception:
            try:
                pan.close()
            except Exception as exc:  # noqa: BLE001
                _log.error("servo close failed: %s", type(exc).__name__)
            raise
        _log.info(
            "servo devices created on pins %d (pan) and %d (tilt)", pins.pan_pin, pins.tilt_pin
        )
        return pan, tilt

    # ---- Pose file (R15.7, R15.8, R15.12) ------------------------------------------------

    def _angles_locked(self) -> tuple[float, float]:
        """Last written angles; the first plan after startup reads them from ``pose_file``."""
        if self._position is None:
            self._position = self._read_pose()
        return self._position

    def _position_or_zero(self) -> tuple[float, float]:
        return self._position if self._position is not None else (0.0, 0.0)

    def _read_pose(self) -> tuple[float, float]:
        """Angles saved at the last detach, or (0, 0) if the file is unusable (R15.8).

        Planning from the real head position keeps the first glide within the step limit.
        A missing, unreadable, non-finite or out-of-range file falls back to center, which
        the Glide_Planner then treats as the start.
        """
        path = self._pose_path
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            _log.info("no pose file at %s; assuming the head is at center", path)
            return (0.0, 0.0)
        except Exception as exc:  # noqa: BLE001 - unreadable for any reason means fallback
            _log.warning("pose file %s unreadable (%s); assuming center", path, type(exc).__name__)
            return (0.0, 0.0)
        pose = self._parse_pose(text)
        if pose is None:
            _log.warning("pose file %s is invalid; assuming the head is at center", path)
            return (0.0, 0.0)
        return pose

    def _parse_pose(self, text: str) -> tuple[float, float] | None:
        """``{"panDeg": number, "tiltDeg": number}`` inside the Calibrated_Range, else None."""
        try:
            data = json.loads(text)
        except Exception:  # noqa: BLE001 - garbage of any kind is invalid
            return None
        if not isinstance(data, dict):
            return None
        s = self._cfg.servo
        angles = []
        for key, limit in (("panDeg", s.pan_limit), ("tiltDeg", s.tilt_limit)):
            value = data.get(key)
            if isinstance(value, bool) or not isinstance(value, int | float):
                return None
            try:
                number = float(value)
            except OverflowError:
                return None
            if not math.isfinite(number) or abs(number) > limit:
                return None
            angles.append(number)
        return (angles[0], angles[1])

    def _write_pose_locked(self) -> None:
        """Save the last written angles; a failure is logged and ignored (R15.12).

        The file is written next to its final path and then renamed, so a power cut during
        the write leaves either the old pose or the new one, never half a file.
        """
        if self._position is None:
            return
        pan, tilt = self._position
        path = self._pose_path
        tmp = path.with_name(path.name + ".tmp")
        try:
            tmp.write_text(json.dumps({"panDeg": pan, "tiltDeg": tilt}), encoding="utf-8")
            os.replace(tmp, path)
        except Exception as exc:  # noqa: BLE001 - R15.12: keep accepting Actions
            _log.warning("could not write pose file %s (%s)", path, type(exc).__name__)
