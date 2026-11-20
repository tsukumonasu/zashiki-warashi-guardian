"""Unit tests for the Lantern_Adapter (R16.1-R16.4) in virtual time.

The real ``LanternAdapter`` runs against ``FakePwmDevice`` and a ``ManualScheduler``, so every
level the LED would show is recorded with its scheduler time and no test sleeps. The general
fade properties live in ``test_prop_lantern_fade.py``; these tests pin down start, interrupt,
deadline, immediate off and the failure paths with concrete examples.
"""

from __future__ import annotations

import logging
import subprocess
import sys
import types
from pathlib import Path

import pytest

from warashi_agent.adapters import lantern
from warashi_agent.adapters.fakes import FakePwmDevice
from warashi_agent.adapters.lantern import LanternAdapter, create_pwm_led
from warashi_agent.model import AdapterError, Event, LanternFade
from warashi_agent.timebase import ManualScheduler

STEP_S = 0.020
"""Largest gap between fade steps, and the slack allowed on the fade deadline (R16.1)."""

EPS = 1e-9
"""Float tolerance for comparing scheduler times computed as ``started + offset / 1000``."""


def make_adapter(
    initial_value: float = 0.0,
) -> tuple[LanternAdapter, FakePwmDevice, ManualScheduler, list[Event]]:
    scheduler = ManualScheduler()
    device = FakePwmDevice(scheduler, initial_value=initial_value)
    posted: list[Event] = []
    adapter = LanternAdapter(posted.append, scheduler, device)
    return adapter, device, scheduler, posted


def writes_after(device: FakePwmDevice, index: int) -> list[tuple[float, float]]:
    """The device writes made after the first ``index`` writes."""
    return device.writes[index:]


# --------------------------------------------------------------------------------------------
# R16.3: off at start
# --------------------------------------------------------------------------------------------


def test_start_level_is_zero_without_an_extra_write() -> None:
    adapter, device, scheduler, posted = make_adapter(initial_value=0.0)

    assert adapter.level == 0.0
    assert device.value == 0.0
    # FakePwmDevice records its initial value as the first write; the adapter adds none.
    assert device.writes == [(0.0, 0.0)]
    assert scheduler.pending() == 0
    assert posted == []


def test_start_writes_zero_when_device_was_created_lit() -> None:
    adapter, device, scheduler, posted = make_adapter(initial_value=0.7)

    assert adapter.level == 0.0
    assert device.value == 0.0
    assert device.writes == [(0.0, 0.7), (0.0, 0.0)]
    assert scheduler.pending() == 0
    assert posted == []


# --------------------------------------------------------------------------------------------
# R16.1: target reached by fade_ms + 20 ms, steps at most 20 ms apart
# --------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("level", "fade_ms", "target", "clamped_ms"),
    [
        (1.0, 0, 1.0, 0),
        (0.5, 15, 0.5, 15),
        (1.0, 100, 1.0, 100),
        (0.8, 1000, 0.8, 1000),
        (2.0, 250, 1.0, 250),  # level clamped to 1
        (1.0, 20000, 1.0, 10000),  # fade clamped to 10 s
    ],
)
def test_fade_reaches_target_by_fade_ms_plus_one_step(
    level: float, fade_ms: int, target: float, clamped_ms: int
) -> None:
    adapter, device, scheduler, posted = make_adapter()
    scheduler.advance(1.0)  # start the fade at a non-zero time
    started = scheduler.now()
    first = len(device.writes)

    adapter.handle(LanternFade(level=level, fade_ms=fade_ms))
    assert len(device.writes) == first  # handle() only schedules; nothing is written yet
    scheduler.advance(clamped_ms / 1000 + STEP_S)

    fade = writes_after(device, first)
    deadline = started + clamped_ms / 1000 + STEP_S
    reached = [t for t, value in fade if value == target]
    assert reached, fade
    assert reached[0] <= deadline + EPS
    assert device.value == target
    assert adapter.level == target
    # Every level lies between start (0) and target, and the steps are at most 20 ms apart.
    assert all(0.0 <= value <= target for _, value in fade)
    times = [started] + [t for t, _ in fade]
    assert all(b - a <= STEP_S + EPS for a, b in zip(times, times[1:], strict=False))
    assert scheduler.pending() == 0
    assert posted == []


def test_fade_down_from_a_lit_level() -> None:
    adapter, device, scheduler, _ = make_adapter()
    adapter.handle(LanternFade(level=1.0, fade_ms=0))
    scheduler.run_due()
    first = len(device.writes)

    adapter.handle(LanternFade(level=0.0, fade_ms=200))
    scheduler.advance(0.2 + STEP_S)

    fade = writes_after(device, first)
    values = [value for _, value in fade]
    assert values == sorted(values, reverse=True)
    assert values[-1] == 0.0
    assert device.value == 0.0


# --------------------------------------------------------------------------------------------
# R16.2: a new fade interrupts the running one and starts from the current level
# --------------------------------------------------------------------------------------------


def test_new_fade_interrupts_running_fade_from_current_level() -> None:
    adapter, device, scheduler, posted = make_adapter()
    adapter.handle(LanternFade(level=1.0, fade_ms=200))
    scheduler.advance(0.1)  # halfway up
    current = adapter.level
    assert 0.0 < current < 1.0
    assert device.value == current
    interrupted_at = scheduler.now()
    first = len(device.writes)

    adapter.handle(LanternFade(level=0.0, fade_ms=100))
    scheduler.advance(1.0)

    second = writes_after(device, first)
    values = [value for _, value in second]
    # The second fade starts from the current level and goes down; no step of the old fade
    # (which would climb towards 1.0) writes after the interrupt.
    assert values, second
    assert all(0.0 <= value <= current for value in values)
    assert values == sorted(values, reverse=True)
    assert 1.0 not in values
    reached = [t for t, value in second if value == 0.0]
    assert reached[0] <= interrupted_at + 0.1 + STEP_S + EPS
    assert device.value == 0.0
    assert scheduler.pending() == 0
    assert posted == []


def test_interrupting_with_the_same_target_does_not_restart_from_zero() -> None:
    adapter, device, scheduler, _ = make_adapter()
    adapter.handle(LanternFade(level=1.0, fade_ms=200))
    scheduler.advance(0.1)
    current = adapter.level
    first = len(device.writes)

    adapter.handle(LanternFade(level=1.0, fade_ms=200))
    scheduler.advance(1.0)

    values = [value for _, value in writes_after(device, first)]
    assert all(current <= value <= 1.0 for value in values)
    assert device.value == 1.0


# --------------------------------------------------------------------------------------------
# R16.4: immediate off
# --------------------------------------------------------------------------------------------


def test_off_now_writes_zero_at_once_and_cancels_the_fade() -> None:
    adapter, device, scheduler, posted = make_adapter()
    adapter.handle(LanternFade(level=1.0, fade_ms=500))
    scheduler.advance(0.2)
    assert device.value > 0.0
    called_at = scheduler.now()

    adapter.off_now()

    # The write happens on the calling thread, so it is done before off_now() returns,
    # well within the 50 ms bound.
    last_time, last_level = device.writes[-1]
    assert last_level == 0.0
    assert last_time - called_at <= 0.050
    assert device.value == 0.0
    assert adapter.level == 0.0
    assert scheduler.pending() == 0
    first = len(device.writes)

    scheduler.advance(2.0)

    assert writes_after(device, first) == []  # stays at 0 until a later LanternFade
    assert device.value == 0.0
    assert posted == []


def test_off_now_without_a_fade_and_twice_is_safe() -> None:
    adapter, device, scheduler, posted = make_adapter()

    adapter.off_now()
    adapter.off_now()
    scheduler.advance(1.0)

    assert device.value == 0.0
    assert set(device.levels) == {0.0}
    assert posted == []


def test_fade_after_off_now_lights_the_lantern_again() -> None:
    adapter, device, scheduler, _ = make_adapter()
    adapter.handle(LanternFade(level=1.0, fade_ms=300))
    scheduler.advance(0.1)
    adapter.off_now()

    adapter.handle(LanternFade(level=0.6, fade_ms=100))
    scheduler.advance(0.1 + STEP_S)

    assert device.value == 0.6
    assert adapter.level == 0.6


# --------------------------------------------------------------------------------------------
# R20.10, R20.11: a failing device write
# --------------------------------------------------------------------------------------------


class FailingPwmDevice:
    """PWM device stub whose ``fail_at``-th write (0-based) raises ``RuntimeError``."""

    SECRET = "scripted lantern failure"

    def __init__(self, scheduler: ManualScheduler, fail_at: int) -> None:
        self._scheduler = scheduler
        self._fail_at = fail_at
        self._count = 0
        self._value = 0.0
        self.writes: list[tuple[float, float]] = []

    @property
    def value(self) -> float:
        return self._value

    @value.setter
    def value(self, level: float) -> None:
        index = self._count
        self._count += 1
        if index == self._fail_at:
            raise RuntimeError(self.SECRET)
        self._value = float(level)
        self.writes.append((self._scheduler.now(), float(level)))


def test_write_failure_aborts_fade_posts_adapter_failed_and_next_fade_works(
    caplog: pytest.LogCaptureFixture,
) -> None:
    scheduler = ManualScheduler()
    device = FailingPwmDevice(scheduler, fail_at=2)
    posted: list[Event] = []
    adapter = LanternAdapter(posted.append, scheduler, device)
    assert device.writes == []  # the stub starts at 0, so no start write

    with caplog.at_level(logging.ERROR, logger=lantern.__name__):
        adapter.handle(LanternFade(level=1.0, fade_ms=200))
        scheduler.advance(1.0)

    # Writes 0 and 1 succeeded, write 2 raised and the rest of the fade was cancelled.
    assert len(device.writes) == 2
    last_good = device.writes[-1][1]
    assert 0.0 < last_good < 1.0
    assert adapter.level == last_good
    assert scheduler.pending() == 0
    assert len(posted) == 1
    assert isinstance(posted[0], AdapterError)
    assert posted[0].code == "adapter_failed"
    # Only the exception type is logged, never its message.
    assert "RuntimeError" in caplog.text
    assert FailingPwmDevice.SECRET not in caplog.text

    adapter.handle(LanternFade(level=0.0, fade_ms=100))
    scheduler.advance(0.1 + STEP_S)

    later = [value for _, value in device.writes[2:]]
    assert later and all(0.0 <= value <= last_good for value in later)
    assert device.value == 0.0
    assert len(posted) == 1


def test_off_now_failure_posts_adapter_failed_and_does_not_raise() -> None:
    scheduler = ManualScheduler()
    device = FailingPwmDevice(scheduler, fail_at=0)
    posted: list[Event] = []
    adapter = LanternAdapter(posted.append, scheduler, device)

    adapter.off_now()

    assert len(posted) == 1
    assert isinstance(posted[0], AdapterError)
    assert posted[0].code == "adapter_failed"


# --------------------------------------------------------------------------------------------
# Real device creation and the lazy gpiozero import
# --------------------------------------------------------------------------------------------


def test_create_pwm_led_starts_off_at_100_hz(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    class FakePwmLed:
        def __init__(self, *args: object, **kwargs: object) -> None:
            calls.append((args, kwargs))

    fake_gpiozero = types.ModuleType("gpiozero")
    fake_gpiozero.PWMLED = FakePwmLed  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "gpiozero", fake_gpiozero)

    led = create_pwm_led(23)

    assert isinstance(led, FakePwmLed)
    assert calls == [((23,), {"initial_value": 0, "frequency": 100})]


def test_importing_lantern_module_does_not_import_gpiozero() -> None:
    # A fresh interpreter, because this test process may already have gpiozero (or the fake
    # above) in sys.modules.
    code = (
        "import sys\n"
        "import warashi_agent.adapters.lantern\n"
        "assert 'gpiozero' not in sys.modules, 'gpiozero imported'\n"
        "assert 'lgpio' not in sys.modules, 'lgpio imported'\n"
    )
    device_dir = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=device_dir,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stderr
