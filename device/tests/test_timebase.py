"""Unit tests for the time base and ``OnceResult`` (device-core-loop task 19.4).

``ManualScheduler`` drives every fake and Dispatcher test, so its ordering, cancellation and
error rules are pinned here with virtual time. ``ThreadScheduler`` gets a few short real-time
tests (each wait stays well under 1 s). ``OnceResult`` is checked with a real thread race,
because that race (interruption against a finishing worker) is why it exists (R18.8, R19.9).
"""

import math
import threading
import time

import pytest

from warashi_agent.adapters.ports import OnceResult
from warashi_agent.timebase import (
    ManualClock,
    ManualScheduler,
    MonotonicClock,
    ThreadScheduler,
)

WAIT_S = 0.5  # upper bound for every real-time wait in this file


# --------------------------------------------------------------------------------------------
# ManualScheduler: ordering
# --------------------------------------------------------------------------------------------


def test_callbacks_run_in_time_order_with_the_clock_at_their_due_time() -> None:
    sched = ManualScheduler()
    seen: list[tuple[str, float]] = []
    for name, when in [("c", 3.0), ("a", 1.0), ("b", 2.0)]:
        sched.call_at(when, lambda name=name: seen.append((name, sched.now())))

    sched.advance(5.0)

    assert seen == [("a", 1.0), ("b", 2.0), ("c", 3.0)]
    assert sched.now() == 5.0
    assert sched.pending() == 0


def test_same_time_callbacks_run_in_scheduling_order() -> None:
    sched = ManualScheduler()
    seen: list[int] = []
    for i in range(10):
        sched.call_at(1.0, lambda i=i: seen.append(i))

    sched.advance(1.0)

    assert seen == list(range(10))


def test_nothing_runs_before_its_due_time() -> None:
    sched = ManualScheduler()
    seen: list[str] = []
    sched.call_later(1.0, lambda: seen.append("x"))

    sched.advance(0.999)
    assert seen == []
    assert sched.pending() == 1

    sched.advance(0.001)
    assert seen == ["x"]


def test_callback_scheduled_inside_the_window_runs_in_the_same_advance() -> None:
    sched = ManualScheduler()
    seen: list[tuple[str, float]] = []

    def first() -> None:
        seen.append(("first", sched.now()))
        sched.call_later(0.5, lambda: seen.append(("inside", sched.now())))
        sched.call_later(5.0, lambda: seen.append(("outside", sched.now())))

    sched.call_at(1.0, first)
    sched.advance(2.0)

    assert seen == [("first", 1.0), ("inside", 1.5)]
    assert sched.pending() == 1
    sched.advance(4.0)
    assert seen[-1] == ("outside", 6.0)


def test_negative_delay_counts_as_zero_and_run_due_runs_it_without_moving_time() -> None:
    sched = ManualScheduler(ManualClock(start=10.0))
    seen: list[float] = []
    sched.call_later(-3.0, lambda: seen.append(sched.now()))
    sched.call_at(4.0, lambda: seen.append(sched.now()))  # already in the past

    sched.run_due()

    assert seen == [10.0, 10.0]  # the clock never moves back to a past due time
    assert sched.now() == 10.0


# --------------------------------------------------------------------------------------------
# ManualScheduler: cancellation
# --------------------------------------------------------------------------------------------


def test_cancelled_callback_never_runs_and_is_not_pending() -> None:
    sched = ManualScheduler()
    seen: list[str] = []
    keep = sched.call_later(1.0, lambda: seen.append("keep"))
    drop = sched.call_later(1.0, lambda: seen.append("drop"))

    drop.cancel()
    drop.cancel()  # safe to call twice

    assert drop.cancelled
    assert not keep.cancelled
    assert sched.pending() == 1
    sched.advance(1.0)
    assert seen == ["keep"]


def test_callback_can_cancel_a_later_callback_in_the_same_advance() -> None:
    sched = ManualScheduler()
    seen: list[str] = []
    later = sched.call_at(2.0, lambda: seen.append("later"))
    sched.call_at(1.0, later.cancel)

    sched.advance(3.0)

    assert seen == []


def test_cancel_after_running_is_harmless() -> None:
    sched = ManualScheduler()
    seen: list[str] = []
    handle = sched.call_later(0.0, lambda: seen.append("ran"))
    sched.run_due()

    handle.cancel()

    assert seen == ["ran"]
    assert handle.cancelled


# --------------------------------------------------------------------------------------------
# ManualScheduler and ManualClock: invalid use
# --------------------------------------------------------------------------------------------


@pytest.mark.parametrize("dt", [-0.001, -1.0, math.nan, math.inf, -math.inf])
def test_negative_or_non_finite_step_is_rejected_and_time_stays(dt: float) -> None:
    sched = ManualScheduler(ManualClock(start=2.0))
    sched.call_later(0.0, lambda: pytest.fail("must not run"))

    with pytest.raises(ValueError):
        sched.advance(dt)
    with pytest.raises(ValueError):
        sched.clock.advance(dt)
    with pytest.raises(ValueError):
        ManualClock().advance(dt)  # unbound clock checks too

    assert sched.now() == 2.0
    assert sched.pending() == 1


def test_nested_advance_raises_and_the_scheduler_stays_usable() -> None:
    sched = ManualScheduler()
    sched.call_at(1.0, lambda: sched.advance(1.0))

    with pytest.raises(RuntimeError):
        sched.advance(2.0)

    seen: list[str] = []
    sched.call_later(0.5, lambda: seen.append("after"))
    sched.advance(1.0)
    assert seen == ["after"]


def test_callback_exceptions_propagate() -> None:
    sched = ManualScheduler()

    def boom() -> None:
        raise KeyError("boom")

    sched.call_at(1.0, boom)
    with pytest.raises(KeyError):
        sched.advance(1.0)


def test_clock_advance_drives_the_bound_scheduler() -> None:
    clock = ManualClock()
    sched = ManualScheduler(clock)
    seen: list[float] = []
    sched.call_at(1.5, lambda: seen.append(clock.now()))

    clock.advance(2.0)

    assert seen == [1.5]
    assert clock.now() == sched.now() == 2.0


def test_a_manual_clock_drives_only_one_scheduler() -> None:
    clock = ManualClock()
    ManualScheduler(clock)
    with pytest.raises(RuntimeError):
        ManualScheduler(clock)


def test_unbound_manual_clock_moves_forward() -> None:
    clock = ManualClock(start=1.0)
    clock.advance(0.25)
    clock.advance(0.0)
    assert clock.now() == 1.25


# --------------------------------------------------------------------------------------------
# MonotonicClock and ThreadScheduler (real time, short waits)
# --------------------------------------------------------------------------------------------


def test_monotonic_clock_never_decreases() -> None:
    """R20.1: `now` read by the Dispatcher never decreases."""
    clock = MonotonicClock()
    readings = [clock.now() for _ in range(10_000)]
    assert all(b >= a for a, b in zip(readings, readings[1:], strict=False))


def test_thread_scheduler_starts_no_thread_until_something_is_scheduled() -> None:
    sched = ThreadScheduler(name="warashi-scheduler-idle-test")
    sched.now()  # reading the clock starts nothing either
    assert "warashi-scheduler-idle-test" not in {t.name for t in threading.enumerate()}
    sched.shutdown()


def test_thread_scheduler_runs_real_callbacks_in_time_order() -> None:
    sched = ThreadScheduler()
    seen: list[str] = []
    done = threading.Event()
    try:
        base = sched.now()
        sched.call_at(base + 0.15, lambda: (seen.append("c"), done.set()))
        sched.call_at(base + 0.05, lambda: seen.append("b"))
        sched.call_at(base, lambda: seen.append("a"))
        sched.call_at(base, lambda: seen.append("a2"))  # same time: scheduling order

        assert done.wait(WAIT_S)
        assert seen == ["a", "a2", "b", "c"]
    finally:
        sched.shutdown()


def test_thread_scheduler_skips_cancelled_and_survives_a_raising_callback() -> None:
    sched = ThreadScheduler()
    seen: list[str] = []
    done = threading.Event()

    def boom() -> None:
        raise RuntimeError("boom")

    try:
        dropped = sched.call_later(0.02, lambda: seen.append("dropped"))
        sched.call_later(0.01, boom)
        sched.call_later(0.05, lambda: (seen.append("after"), done.set()))
        dropped.cancel()

        assert done.wait(WAIT_S)
        assert seen == ["after"]
    finally:
        sched.shutdown()


def test_thread_scheduler_shutdown_cancels_pending_callbacks() -> None:
    sched = ThreadScheduler()
    ran = threading.Event()
    started = threading.Event()
    sched.call_later(0.0, started.set)  # makes sure the worker is running
    assert started.wait(WAIT_S)

    pending = sched.call_later(0.2, ran.set)
    sched.shutdown()

    assert pending.cancelled
    assert not ran.wait(0.4)  # well past the due time

    late = sched.call_later(0.0, ran.set)  # scheduling after shutdown runs nothing
    assert late.cancelled
    time.sleep(0.05)
    assert not ran.is_set()


# --------------------------------------------------------------------------------------------
# OnceResult
# --------------------------------------------------------------------------------------------


def test_once_result_lets_only_the_first_claim_through() -> None:
    once = OnceResult()
    assert once.claim("snap-1") is True
    assert once.claim("snap-1") is False
    assert once.claim("snap-1") is False
    assert once.claim("play-1") is True  # ids are independent


def test_once_result_forgets_the_oldest_id_beyond_capacity() -> None:
    once = OnceResult(capacity=2)
    assert once.claim("a")
    assert once.claim("b")
    assert once.claim("c")  # evicts "a"

    assert not once.claim("b")
    assert not once.claim("c")
    assert once.claim("a")  # forgotten, so it is new again


@pytest.mark.parametrize("capacity", [0, -1])
def test_once_result_rejects_capacity_below_one(capacity: int) -> None:
    with pytest.raises(ValueError):
        OnceResult(capacity=capacity)


def _race(once: OnceResult, key: str, threads_n: int) -> list[bool]:
    """Release ``threads_n`` threads at once on ``claim(key)`` and collect their answers."""
    barrier = threading.Barrier(threads_n)
    wins: list[bool] = []
    wins_lock = threading.Lock()

    def contend() -> None:
        barrier.wait(timeout=WAIT_S)
        won = once.claim(key)
        with wins_lock:
            wins.append(won)

    workers = [threading.Thread(target=contend) for _ in range(threads_n)]
    for w in workers:
        w.start()
    for w in workers:
        w.join(timeout=WAIT_S)
    return wins


def test_once_result_race_has_exactly_one_winner() -> None:
    """An interruption and a finishing worker race on one id; only one may post (R19.9)."""
    once = OnceResult()
    for r in range(50):
        wins = _race(once, f"play-{r}", threads_n=16)
        assert len(wins) == 16
        assert wins.count(True) == 1
