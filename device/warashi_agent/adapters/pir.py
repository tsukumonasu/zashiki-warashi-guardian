"""PIR_Adapter: reports the HC-SR501 output as edges (R17).

Why it is this small:
- The State_Machine owns every PIR rule (warm-up, retrigger, debounce), because those rules
  must be property-tested with time passed in. The adapter therefore only turns level changes
  into ``pir.rising`` / ``pir.falling`` Events, in the order they happen (R17.3).
- It uses gpiozero ``DigitalInputDevice`` and not ``MotionSensor``: ``MotionSensor`` averages
  the input in a polling thread, which would hide and delay edges.
- gpiozero fires ``when_activated`` / ``when_deactivated`` only on a change, never for the
  level found at creation. An input that is already high at start posts nothing until it goes
  low and high again (R17.5), so a person standing in front of a rebooting doll does not start
  an Encounter on a stale level.
- The input device comes from a factory. Production passes ``gpiozero_input_device``, which
  imports gpiozero only when called, so importing this module on a laptop or in CI needs no
  gpiozero and touches no pin. Tests pass ``FakeInputDevice`` from ``fakes.py``.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Protocol

from warashi_agent.model import Event, PirFalling, PirRising

Post = Callable[[Event], None]
"""Hands an Event to the Dispatcher queue; safe to call from any thread."""


class InputDevice(Protocol):
    """The part of gpiozero ``DigitalInputDevice`` the adapter uses.

    gpiozero accepts callbacks with no argument, and ``FakeInputDevice`` calls them with none,
    so the callbacks are typed as ``Callable[[], None]``.
    """

    when_activated: Callable[[], None] | None
    when_deactivated: Callable[[], None] | None

    def close(self) -> None: ...


InputDeviceFactory = Callable[[int], InputDevice]
"""Creates the input device on a BCM pin; called once, from ``PirAdapter.start()``."""


def gpiozero_input_device(pin: int) -> InputDevice:
    """Create the real PIR input on ``pin`` (BCM).

    gpiozero is imported here, not at module level, so the package imports where gpiozero or
    a GPIO chip is missing. ``pull_up=False`` adds a pull-down, which is harmless for the
    HC-SR501's push-pull output and keeps a loose wire from floating high.
    ``bounce_time=None`` turns gpiozero's debounce off, because debouncing is the
    State_Machine's job (R17.3).
    """
    from gpiozero import DigitalInputDevice

    return DigitalInputDevice(pin, pull_up=False, bounce_time=None)


class PirAdapter:
    """PirPort for the HC-SR501 on ``pir_pin`` (R17.1 to R17.3, R17.5).

    The input device is created in ``start()``, not in the constructor, so the pin is claimed
    only when the startup sequence starts the loop (design, "Startup sequence", step 7).
    Callbacks run on gpiozero's own thread; ``post`` only enqueues, so they never block it.
    """

    def __init__(
        self,
        pin: int,
        post: Post,
        device_factory: InputDeviceFactory = gpiozero_input_device,
    ) -> None:
        self._pin = pin
        self._post = post
        self._device_factory = device_factory
        self._lock = threading.Lock()
        self._device: InputDevice | None = None
        self._open = False

    def start(self) -> None:
        """Create the input device and attach the edge callbacks.

        Nothing is posted for the current level (R17.5). A second call does nothing, so the
        pin is never claimed twice.
        """
        with self._lock:
            if self._device is not None:
                return
            device = self._device_factory(self._pin)
            self._device = device
            self._open = True
            device.when_activated = self._rising
            device.when_deactivated = self._falling

    def close(self) -> None:
        """Detach the callbacks and release the pin; safe to call twice or before ``start()``.

        ``_open`` is cleared under the same lock that guards posting, so no edge is posted
        after ``close()`` returns.
        """
        with self._lock:
            self._open = False
            device, self._device = self._device, None
        if device is None:
            return
        device.when_activated = None
        device.when_deactivated = None
        device.close()

    def _rising(self) -> None:
        self._edge(PirRising())

    def _falling(self) -> None:
        self._edge(PirFalling())

    def _edge(self, event: PirRising | PirFalling) -> None:
        # Posting under the lock makes close() wait for an edge already in flight, so nothing
        # is posted after close() returns. post() only enqueues, so the wait is short.
        # device.close() runs outside the lock, so gpiozero can finish a pending callback.
        with self._lock:
            if self._open:
                self._post(event)
