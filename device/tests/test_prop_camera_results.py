"""Property 14: Exactly one camera result (device-core-loop task 24.5).

**Validates: Requirements 18.1, 18.2, 18.4, 18.6, 18.8, 29.15**

One test function runs against both camera implementations:

- ``real``: the ``CameraAdapter`` on a ``ScriptedRunner`` and a ``ManualScheduler``. Every request
  gets a fresh script (a few oversize JPEGs for the quality retries, then a terminal run that
  succeeds, fails or hangs past the deadline). The test calls ``handle()`` then ``wait_idle()``
  and only then advances the clock, because the worker thread and the test would otherwise both
  move the ManualScheduler. Temporary files are checked through a dedicated base directory that
  ``tempfile.tempdir`` points to, which must be empty after every request.
- ``fake``: the ``FakeCamera`` with scripted outcomes on a ``ManualScheduler``.

Requests are at least ``camera_timeout_s`` apart. A repeated ``TakeSnapshot`` with the same
Snapshot_Id may follow a request, and it must not produce a second result (``OnceResult``).
"""

from __future__ import annotations

import tempfile
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from tests.scripted import ScriptedRunner, Step, jpeg_of_size, writes_file_after
from warashi_agent.adapters.camera import CameraAdapter
from warashi_agent.adapters.fakes import CameraOutcome, FakeCamera
from warashi_agent.config import Config
from warashi_agent.model import Event, SnapshotFailed, SnapshotReady, TakeSnapshot
from warashi_agent.timebase import ManualScheduler

CONFIG = Config()
TIMEOUT_S = CONFIG.timing.camera_timeout_s
MAX_BYTES = CONFIG.camera.jpeg_max_bytes
MIN_BYTES = 1_000  # any size from a small padded JPEG up to the limit
IDLE_TIMEOUT_S = 5.0  # real-time safety net for wait_idle
ALLOWED_CODES = {"camera_failed", "snapshot_too_large"}

_TERMINALS = (
    "ok_small",
    "ok_exact",
    "exit_code",
    "no_file",
    "empty",
    "timeout",
    "hang",
    "start_error",
)

gaps = st.floats(min_value=TIMEOUT_S, max_value=2 * TIMEOUT_S, allow_nan=False)
over_sizes = st.integers(min_value=MAX_BYTES + 1, max_value=MAX_BYTES + 3_000)
ok_sizes = st.integers(min_value=MIN_BYTES, max_value=MAX_BYTES)


@st.composite
def real_plans(draw: st.DrawFn) -> tuple[list[Step], str, bool]:
    """One request: its steps, the expected result kind and whether to repeat the request."""
    overs = draw(st.lists(over_sizes, max_size=3))
    repeat = draw(st.booleans())
    steps = [Step(on_finish=writes_file_after("-o", jpeg_of_size(size))) for size in overs]
    if len(overs) == 3:
        return steps, "too_large", repeat
    terminal = draw(st.sampled_from(_TERMINALS))
    if terminal == "ok_small":
        size = draw(ok_sizes)
        steps.append(Step(on_finish=writes_file_after("-o", jpeg_of_size(size))))
        return steps, "ready", repeat
    if terminal == "ok_exact":
        steps.append(Step(on_finish=writes_file_after("-o", jpeg_of_size(MAX_BYTES))))
        return steps, "ready", repeat
    if terminal == "exit_code":
        code = draw(st.integers(min_value=1, max_value=255))
        steps.append(
            Step(exit_code=code, on_finish=writes_file_after("-o", jpeg_of_size(MIN_BYTES)))
        )
    elif terminal == "no_file":
        steps.append(Step())
    elif terminal == "empty":
        steps.append(Step(on_finish=writes_file_after("-o", b"")))
    elif terminal in ("timeout", "hang"):
        over = draw(st.floats(min_value=0.1, max_value=3 * TIMEOUT_S, allow_nan=False))
        steps.append(
            Step(
                duration=TIMEOUT_S + over,
                on_finish=writes_file_after("-o", jpeg_of_size(MIN_BYTES)),
                ignore_terminate=terminal == "hang",
            )
        )
    else:
        steps.append(Step(start_error=FileNotFoundError("rpicam-still")))
    return steps, "failed", repeat


fake_outcomes = st.builds(
    CameraOutcome,
    delay_s=st.floats(min_value=0.0, max_value=TIMEOUT_S, allow_nan=False),
    failure=st.sampled_from((None, "camera_failed", "snapshot_too_large")),
)


@contextmanager
def private_temp_base() -> Iterator[Path]:
    """Point ``tempfile`` at a dedicated directory so leftovers can be listed."""
    previous = tempfile.tempdir
    with tempfile.TemporaryDirectory(prefix="prop14-") as base:
        tempfile.tempdir = base
        try:
            yield Path(base)
        finally:
            tempfile.tempdir = previous


def check_results(posted: list[Event], ids: list[str]) -> None:
    results = [e for e in posted if isinstance(e, SnapshotReady | SnapshotFailed)]
    counts = Counter(e.snapshot_id for e in results)
    assert counts == Counter(ids), "each Snapshot_Id must get exactly one result"
    for event in results:
        if isinstance(event, SnapshotReady):
            assert len(event.jpeg) <= MAX_BYTES
        else:
            assert event.code in ALLOWED_CODES


def run_real(plans: list[tuple[list[Step], str, bool]], waits: list[float]) -> None:
    with private_temp_base() as base:
        scheduler = ManualScheduler()
        runner = ScriptedRunner(scheduler)
        posted: list[Event] = []
        adapter = CameraAdapter(posted.append, scheduler, CONFIG, runner=runner)
        ids: list[str] = []
        for index, ((steps, expected, repeat), gap) in enumerate(zip(plans, waits, strict=True)):
            snapshot_id = f"snap-{index}"
            ids.append(snapshot_id)
            runner.steps = list(steps) + [Step(exit_code=1)]  # last step: only for a repeat
            before = len(posted)
            adapter.handle(TakeSnapshot(snapshot_id=snapshot_id))
            if repeat:
                adapter.handle(TakeSnapshot(snapshot_id=snapshot_id))
            assert adapter.wait_idle(IDLE_TIMEOUT_S)
            new = [e for e in posted[before:] if isinstance(e, SnapshotReady | SnapshotFailed)]
            assert len(new) == 1
            (result,) = new
            if expected == "ready":
                assert isinstance(result, SnapshotReady)
            elif expected == "too_large":
                assert result == SnapshotFailed(snapshot_id=snapshot_id, code="snapshot_too_large")
            else:
                assert result == SnapshotFailed(snapshot_id=snapshot_id, code="camera_failed")
            assert list(base.iterdir()) == [], "a temporary file or directory was left behind"
            scheduler.advance(gap)
        adapter.stop()
        check_results(posted, ids)
        assert list(base.iterdir()) == []


def run_fake(outcomes: list[CameraOutcome], repeats: list[bool], waits: list[float]) -> None:
    scheduler = ManualScheduler()
    posted: list[Event] = []
    camera = FakeCamera(posted.append, scheduler)
    camera.script(*outcomes)
    ids: list[str] = []
    for index, (repeat, gap) in enumerate(zip(repeats, waits, strict=True)):
        snapshot_id = f"snap-{index}"
        ids.append(snapshot_id)
        camera.handle(TakeSnapshot(snapshot_id=snapshot_id))
        if repeat:
            # The repeat takes the next scripted outcome (or the default); it must add no result.
            camera.handle(TakeSnapshot(snapshot_id=snapshot_id))
        scheduler.advance(gap)
    scheduler.advance(10 * TIMEOUT_S)  # pass every deadline
    check_results(posted, ids)


# Feature: device-core-loop, Property 14: Exactly one camera result
@pytest.mark.timeout(300)
@settings(deadline=None)
@pytest.mark.parametrize("implementation", ["real", "fake"])
@given(data=st.data())
def test_exactly_one_camera_result(implementation: str, data: st.DataObject) -> None:
    count = data.draw(st.integers(min_value=1, max_value=5), label="requests")
    waits = data.draw(st.lists(gaps, min_size=count, max_size=count), label="gaps")
    if implementation == "real":
        plans = data.draw(st.lists(real_plans(), min_size=count, max_size=count), label="plans")
        run_real(plans, waits)
    else:
        outcomes = data.draw(
            st.lists(fake_outcomes, min_size=count, max_size=count), label="outcomes"
        )
        repeats = data.draw(st.lists(st.booleans(), min_size=count, max_size=count))
        run_fake(outcomes, repeats, waits)
