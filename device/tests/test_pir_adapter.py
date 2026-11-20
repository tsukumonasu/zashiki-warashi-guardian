"""PirAdapter with FakeInputDevice (R17.1, R17.2, R17.3, R17.5). No hardware, no sleeping."""

from __future__ import annotations

import subprocess
import sys
import types

import pytest

from warashi_agent.adapters.fakes import FakeInputDevice
from warashi_agent.adapters.pir import PirAdapter, gpiozero_input_device
from warashi_agent.model import Event, PirFalling, PirRising


def _make(initial: bool = False) -> tuple[PirAdapter, FakeInputDevice, list[Event], list[int]]:
    posted: list[Event] = []
    pins: list[int] = []
    device = FakeInputDevice(initial=initial)

    def factory(pin: int) -> FakeInputDevice:
        pins.append(pin)
        return device

    return PirAdapter(17, posted.append, device_factory=factory), device, posted, pins


def test_edges_are_posted_in_order() -> None:
    adapter, device, posted, _ = _make()
    adapter.start()
    device.drive_high()
    device.drive_low()
    device.drive_high()
    assert posted == [PirRising(), PirFalling(), PirRising()]


def test_rapid_high_low_high_is_not_smoothed() -> None:
    adapter, device, posted, _ = _make()
    adapter.start()
    for drive in (device.drive_high, device.drive_low, device.drive_high):
        drive()
    assert len(posted) == 3


def test_input_high_at_start_posts_nothing_until_low_then_high() -> None:
    adapter, device, posted, _ = _make(initial=True)
    adapter.start()
    assert posted == []
    device.drive_low()
    assert posted == [PirFalling()]
    device.drive_high()
    assert posted == [PirFalling(), PirRising()]


def test_factory_receives_configured_pin_only_on_start() -> None:
    adapter, _, _, pins = _make()
    assert pins == []
    adapter.start()
    assert pins == [17]


def test_second_start_is_a_noop() -> None:
    adapter, device, posted, pins = _make()
    adapter.start()
    adapter.start()
    assert pins == [17]
    device.drive_high()
    assert posted == [PirRising()]


def test_close_detaches_and_posts_nothing_afterwards() -> None:
    adapter, device, posted, _ = _make()
    adapter.start()
    callback = device.when_activated
    adapter.close()
    assert device.closed
    assert device.when_activated is None
    assert device.when_deactivated is None
    assert callback is not None
    callback()  # a late callback from the gpio thread
    assert posted == []


def test_close_is_safe_twice_and_before_start() -> None:
    adapter, _, posted, _ = _make()
    adapter.close()
    adapter.start()
    adapter.close()
    adapter.close()
    assert posted == []


def test_gpiozero_input_device_disables_debounce_and_pull_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    class FakeDigitalInputDevice:
        def __init__(self, *args: object, **kwargs: object) -> None:
            calls.append((args, kwargs))

    module = types.ModuleType("gpiozero")
    module.DigitalInputDevice = FakeDigitalInputDevice  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "gpiozero", module)

    device = gpiozero_input_device(17)

    assert isinstance(device, FakeDigitalInputDevice)
    assert calls == [((17,), {"pull_up": False, "bounce_time": None})]


def test_importing_pir_module_does_not_import_gpiozero() -> None:
    code = (
        "import sys; import warashi_agent.adapters.pir; "
        "sys.exit(1 if 'gpiozero' in sys.modules else 0)"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
