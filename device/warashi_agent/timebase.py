"""Time base for adapters and the Dispatcher: clocks and schedulers (R20.3, R29.2).

Why this module exists:

- Adapters never sleep on the caller's thread and never start their own timers. They take a
  ``Clock`` and a ``Scheduler`` instead, so the Dispatcher keeps processing Ticks and other
  Events while a glide, a fade or a deadline is running (R20.3).
- Production uses ``MonotonicClock`` and ``ThreadScheduler``. The monotonic clock never jumps
  when NTP corrects the wall clock after the Pi regains Wi-Fi, so deadlines stay correct.
- Tests use ``ManualClock`` and ``ManualScheduler``. Time only moves when a test calls
  ``advance(dt)``, which runs every due callback in time order. Fakes and Dispatcher tests
  therefore never sleep and are deterministic, as the property tests require (R29.2).

Times are seconds as floats on the clock's own scale. Only differences between readings of
the same clock are meaningful.
"""

from __future__ import annotations

import heapq
import itertools
import logging
import threading
import time
from collections.abc import Callable
from typing import Protocol

_log = logging.getLogger(__name__)

Callback = Callable[[], None]


# --------------------------------------------------------------------------------------------
# Protocols
# --------------------------------------------------------------------------------------------


class Clock(Protocol):
    """A source of monotonic time in seconds."""

    def now(self) -> float:
        """Return the current time. Readings never decrease."""
        ...


class Handle(Protocol):
    """A scheduled callback that can still be cancelled."""

    def cancel(self) -> None:
        """Stop the callback from running. Safe to call twice or after it ran."""
        ...

    @property
    def cancelled(self) -> bool:
        """True once ``cancel()`` was called."""
        ...


class Scheduler(Protocol):
    """Runs callbacks later without blocking the caller.

    Callbacks due at the same time run in the order they were scheduled. A callback must be
    short (write one servo angle, post one Event); anything slow belongs in an adapter worker.
    """

    def now(self) -> float:
        """Return the scheduler's current time, on the same scale as ``call_at``."""
        ...

    def call_at(self, when: float, callback: Callback) -> Handle:
        """Run ``callback`` at time ``when``, or as soon as possible if ``when`` has passed."""
        ...

    def call_later(self, delay: float, callback: Callback) -> Handle:
        """Run ``callback`` after ``delay`` seconds. A negative delay counts as 0."""
        ...


# --------------------------------------------------------------------------------------------
# Shared pieces
# --------------------------------------------------------------------------------------------


class _Handle:
    """Cancellable handle shared by both schedulers.

    Cancelling only sets a flag; the scheduler skips flagged entries when they come due. This
    keeps ``cancel()`` cheap and safe from any thread, which matters because the Servo_Adapter
    cancels the rest of a glide plan whenever a new target arrives.
    """

    __slots__ = ("_cancelled",)

    def __init__(self) -> None:
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    @property
    def cancelled(self) -> bool:
        return self._cancelled


# Heap entry: (when, sequence number, handle, callback). The sequence number breaks ties so
# callbacks due at the same time run in scheduling order, and the callback is never compared.
_Entry = tuple[float, int, _Handle, Callback]


# --------------------------------------------------------------------------------------------
# Production
# --------------------------------------------------------------------------------------------


class MonotonicClock:
    """Real clock backed by ``time.monotonic``, which is immune to wall clock changes."""

    def now(self) -> float:
        return time.monotonic()


class ThreadScheduler:
    """Production scheduler: one daemon worker thread runs callbacks from a time-ordered heap.

    Why one worker thread instead of a ``threading.Timer`` per callback: a glide plan schedules
    a step every 30 ms or more, and the Pi Zero W has one slow core and 512 MB of RAM, so a
    thread per step would cost far more than the step itself.

    Why a daemon thread: on SIGTERM the agent must detach the servos and switch the lantern off
    immediately (hardware.md). A pending timer must never delay interpreter exit. ``shutdown()``
    additionally drops every pending callback, so no servo write happens after it.

    No thread exists until the first callback is scheduled, so importing or constructing this
    class starts nothing. Scheduling only takes a short lock and never waits for a callback.
    """

    def __init__(self, clock: Clock | None = None, name: str = "warashi-scheduler") -> None:
        self._clock: Clock = clock if clock is not None else MonotonicClock()
        self._name = name
        self._heap: list[_Entry] = []
        self._seq = itertools.count()
        self._cond = threading.Condition()
        self._thread: threading.Thread | None = None
        self._stopped = False

    def now(self) -> float:
        return self._clock.now()

    def call_later(self, delay: float, callback: Callback) -> Handle:
        return self.call_at(self._clock.now() + max(0.0, delay), callback)

    def call_at(self, when: float, callback: Callback) -> Handle:
        handle = _Handle()
        with self._cond:
            if self._stopped:
                # After shutdown nothing may run, in particular no servo or lantern write.
                handle.cancel()
                return handle
            heapq.heappush(self._heap, (when, next(self._seq), handle, callback))
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, name=self._name, daemon=True)
                self._thread.start()
            self._cond.notify()
        return handle

    def shutdown(self) -> None:
        """Drop every pending callback and stop the worker. Returns without waiting for it."""
        with self._cond:
            self._stopped = True
            for _, _, handle, _ in self._heap:
                handle.cancel()
            self._heap.clear()
            self._cond.notify()

    def _run(self) -> None:
        while True:
            with self._cond:
                callback = self._next_due_locked()
                if callback is None:
                    return
            # Run outside the lock so a callback can schedule more callbacks.
            try:
                callback()
            except Exception as exc:  # noqa: BLE001 - one bad callback must not stop the rest
                # Only the exception type is logged: messages and tracebacks could carry
                # message data, and log redaction lives in the adapters (R21.4).
                _log.error("scheduled callback raised %s", type(exc).__name__)

    def _next_due_locked(self) -> Callback | None:
        """Wait until the earliest live entry is due and pop it; None once shut down."""
        while not self._stopped:
            if not self._heap:
                self._cond.wait()
                continue
            when, _, handle, callback = self._heap[0]
            if handle.cancelled:
                heapq.heappop(self._heap)
                continue
            remaining = when - self._clock.now()
            if remaining > 0:
                self._cond.wait(timeout=remaining)
                continue
            heapq.heappop(self._heap)
            return callback
        return None


# --------------------------------------------------------------------------------------------
# Tests and virtual time
# --------------------------------------------------------------------------------------------


class ManualClock:
    """Virtual clock for tests: time moves only when a test calls ``advance``.

    A ``ManualScheduler`` built on this clock binds itself to it, so ``clock.advance(dt)`` and
    ``scheduler.advance(dt)`` are the same operation and both run the due callbacks. Tests can
    then advance whichever object they hold without callbacks being skipped.
    """

    def __init__(self, start: float = 0.0) -> None:
        self._now = float(start)
        self._scheduler: ManualScheduler | None = None

    def now(self) -> float:
        return self._now

    def advance(self, dt: float) -> None:
        """Move time forward by ``dt`` seconds, running due callbacks of the bound scheduler."""
        if self._scheduler is not None:
            self._scheduler.advance(dt)
        else:
            self._set(self._now + _check_dt(dt))

    def _set(self, when: float) -> None:
        # Never move backwards: R20.1 requires a non-decreasing `now`.
        self._now = max(self._now, when)

    def _bind(self, scheduler: ManualScheduler) -> None:
        if self._scheduler is not None and self._scheduler is not scheduler:
            raise RuntimeError("a ManualClock drives exactly one ManualScheduler")
        self._scheduler = scheduler


class ManualScheduler:
    """Virtual-time scheduler for fakes and Dispatcher tests; nothing runs until ``advance``.

    ``advance(dt)`` runs the due callbacks one at a time in time order, with ties in scheduling
    order, and sets the clock to each callback's due time before calling it. A callback that
    schedules another callback inside the advanced window sees it run in the same ``advance``.
    Callback exceptions propagate so a failing test shows them instead of hiding them.
    """

    def __init__(self, clock: ManualClock | None = None) -> None:
        self.clock = clock if clock is not None else ManualClock()
        self.clock._bind(self)
        self._heap: list[_Entry] = []
        self._seq = itertools.count()
        self._lock = threading.Lock()
        self._advancing = False

    def now(self) -> float:
        return self.clock.now()

    def call_later(self, delay: float, callback: Callback) -> Handle:
        return self.call_at(self.clock.now() + max(0.0, delay), callback)

    def call_at(self, when: float, callback: Callback) -> Handle:
        handle = _Handle()
        with self._lock:
            heapq.heappush(self._heap, (when, next(self._seq), handle, callback))
        return handle

    def pending(self) -> int:
        """Number of callbacks that are scheduled and not cancelled."""
        with self._lock:
            return sum(1 for _, _, handle, _ in self._heap if not handle.cancelled)

    def run_due(self) -> None:
        """Run callbacks that are already due without moving time (``advance(0)``)."""
        self.advance(0.0)

    def advance(self, dt: float) -> None:
        """Move time forward by ``dt`` seconds, running every callback due up to the new time."""
        target = self.clock.now() + _check_dt(dt)
        if self._advancing:
            raise RuntimeError("advance() must not be called from a scheduled callback")
        self._advancing = True
        try:
            while (callback := self._pop_due(target)) is not None:
                callback()
        finally:
            self._advancing = False
        self.clock._set(target)

    def _pop_due(self, target: float) -> Callback | None:
        with self._lock:
            while self._heap and self._heap[0][0] <= target:
                when, _, handle, callback = heapq.heappop(self._heap)
                if handle.cancelled:
                    continue
                self.clock._set(when)
                return callback
            return None


def _check_dt(dt: float) -> float:
    """Reject negative or non-finite steps, which would break monotonic time."""
    dt = float(dt)
    if not (0.0 <= dt < float("inf")):
        raise ValueError(f"time step must be finite and >= 0, got {dt!r}")
    return dt
