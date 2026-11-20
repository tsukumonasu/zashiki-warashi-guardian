"""Unit tests for the Camera_Adapter (device-core-loop task 24.4; R18.1, R18.2, R18.4 to R18.6).

The real ``CameraAdapter`` runs on a ``ScriptedRunner`` (tests/scripted.py) and a
``ManualScheduler``. The adapter's worker is a real thread, so each test calls ``handle()`` and
then ``wait_idle()``; nothing sleeps. Script durations are virtual seconds on the scheduler's
clock. The JPEGs are real: ``FAKE_JPEG_1X1`` padded with COM segments to chosen sizes.
Defaults: ``camera_timeout_s`` 5, ``probe_timeout_s`` 5, ``jpeg_max_bytes`` 90000.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from tests.scripted import ScriptedRunner, Step, jpeg_of_size, writes_file_after
from warashi_agent.adapters.camera import CAMERA_HINT, CameraAdapter
from warashi_agent.adapters.fakes import FAKE_JPEG_1X1
from warashi_agent.config import Config
from warashi_agent.model import Event, SnapshotFailed, SnapshotReady, TakeSnapshot
from warashi_agent.timebase import ManualScheduler

MAX_BYTES = Config().camera.jpeg_max_bytes
SMALL = jpeg_of_size(20_000)
BIG = jpeg_of_size(MAX_BYTES + 1)
IDLE_TIMEOUT_S = 5.0  # real-time safety net for wait_idle; a passing test returns at once


class Rig:
    """A camera adapter on a scripted runner, with the posted events and temp-dir checks."""

    def __init__(self, steps: list[Step]) -> None:
        self.scheduler = ManualScheduler()
        self.runner = ScriptedRunner(self.scheduler, steps)
        self.posted: list[Event] = []
        self.dir_existed_at_post: list[bool] = []
        self.adapter = CameraAdapter(self._post, self.scheduler, Config(), runner=self.runner)

    def _post(self, event: Event) -> None:
        self.posted.append(event)
        if self.runner.calls:
            # R18.6: the temporary directory is gone before the State_Machine sees the result.
            self.dir_existed_at_post.append(self.temp_dir(0).exists())

    def temp_dir(self, index: int) -> Path:
        return Path(self.runner.calls[index][self.runner.calls[index].index("-o") + 1]).parent

    def snapshot(self, snapshot_id: str = "s1") -> list[Event]:
        self.adapter.handle(TakeSnapshot(snapshot_id=snapshot_id))
        assert self.adapter.wait_idle(IDLE_TIMEOUT_S)
        return self.posted

    def qualities(self) -> list[str]:
        return [call[call.index("-q") + 1] for call in self.runner.calls]


def jpeg_step(data: bytes, duration: float = 0.0, **kw: object) -> Step:
    return Step(duration=duration, on_finish=writes_file_after("-o", data), **kw)  # type: ignore[arg-type]


# --------------------------------------------------------------------------------------------
# Command line and success (R18.1)
# --------------------------------------------------------------------------------------------


def test_command_line_and_ready_result() -> None:
    rig = Rig([jpeg_step(SMALL)])
    (event,) = rig.snapshot()
    argv = rig.runner.calls[0]
    assert argv[:-1] == [
        "rpicam-still", "-n", "-t", "500", "--width", "640", "--height", "480", "-q", "80", "-o",
    ]  # fmt: skip
    assert argv[-1].endswith("q80.jpg")
    assert event == SnapshotReady(snapshot_id="s1", jpeg=SMALL, width=1, height=1)


def test_helper_builds_exact_sizes_with_readable_header() -> None:
    from warashi_agent.adapters.camera import jpeg_size

    for size in (len(FAKE_JPEG_1X1), len(FAKE_JPEG_1X1) + 4, 20_000, 70_000, 140_001):
        data = jpeg_of_size(size)
        assert len(data) == size
        assert jpeg_size(data) == (1, 1)


# --------------------------------------------------------------------------------------------
# Quality retries (R18.2)
# --------------------------------------------------------------------------------------------


def test_exactly_at_the_limit_is_accepted_at_quality_80() -> None:
    rig = Rig([jpeg_step(jpeg_of_size(MAX_BYTES))])
    (event,) = rig.snapshot()
    assert isinstance(event, SnapshotReady)
    assert rig.qualities() == ["80"]


def test_oversize_jpegs_retry_at_60_then_40() -> None:
    rig = Rig([jpeg_step(BIG), jpeg_step(BIG), jpeg_step(SMALL)])
    (event,) = rig.snapshot()
    assert rig.qualities() == ["80", "60", "40"]
    assert isinstance(event, SnapshotReady)
    assert len(event.jpeg) <= MAX_BYTES


def test_still_too_large_after_quality_40_is_snapshot_too_large() -> None:
    rig = Rig([jpeg_step(BIG), jpeg_step(BIG), jpeg_step(BIG)])
    (event,) = rig.snapshot()
    assert rig.qualities() == ["80", "60", "40"]
    assert event == SnapshotFailed(snapshot_id="s1", code="snapshot_too_large")


# --------------------------------------------------------------------------------------------
# Failures and timeouts (R18.1, R18.4)
# --------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "step",
    [
        pytest.param(jpeg_step(SMALL, exit_code=1), id="non-zero exit"),
        pytest.param(Step(), id="no file written"),
        pytest.param(jpeg_step(b""), id="empty file"),
        pytest.param(jpeg_step(b"not a jpeg"), id="no readable JPEG header"),
        pytest.param(Step(start_error=FileNotFoundError("rpicam-still")), id="cannot start"),
    ],
)
def test_failed_capture_posts_one_camera_failed(step: Step) -> None:
    rig = Rig([step])
    assert rig.snapshot() == [SnapshotFailed(snapshot_id="s1", code="camera_failed")]


def test_failed_retry_stops_the_retries() -> None:
    rig = Rig([jpeg_step(BIG), jpeg_step(SMALL, exit_code=2)])
    assert rig.snapshot() == [SnapshotFailed(snapshot_id="s1", code="camera_failed")]
    assert rig.qualities() == ["80", "60"]


def test_timeout_during_a_retry_terminates_the_process() -> None:
    # Quality 80 uses 3 of the 5 s; quality 60 gets 2 s but needs 3.
    rig = Rig([jpeg_step(BIG, duration=3.0), jpeg_step(SMALL, duration=3.0)])
    assert rig.snapshot() == [SnapshotFailed(snapshot_id="s1", code="camera_failed")]
    assert rig.qualities() == ["80", "60"]
    first, second = rig.runner.processes
    assert (first.terminate_calls, first.kill_calls) == (0, 0)
    assert (second.terminate_calls, second.kill_calls) == (1, 0)
    assert rig.scheduler.now() == pytest.approx(5.0)


def test_process_that_ignores_sigterm_is_killed_after_the_grace() -> None:
    rig = Rig([jpeg_step(SMALL, duration=10.0, ignore_terminate=True)])
    assert rig.snapshot() == [SnapshotFailed(snapshot_id="s1", code="camera_failed")]
    (proc,) = rig.runner.processes
    assert (proc.terminate_calls, proc.kill_calls) == (1, 1)
    assert rig.scheduler.now() == pytest.approx(5.5)  # 5 s deadline + 0.5 s grace


def test_one_result_per_snapshot_id_and_the_queue_is_served_in_order() -> None:
    rig = Rig([jpeg_step(SMALL), Step(exit_code=1)])
    rig.adapter.handle(TakeSnapshot(snapshot_id="a"))
    rig.adapter.handle(TakeSnapshot(snapshot_id="b"))
    assert rig.adapter.wait_idle(IDLE_TIMEOUT_S)
    assert rig.posted == [
        SnapshotReady(snapshot_id="a", jpeg=SMALL, width=1, height=1),
        SnapshotFailed(snapshot_id="b", code="camera_failed"),
    ]


def test_stop_fails_requests_that_arrive_afterwards() -> None:
    rig = Rig([])
    rig.adapter.stop()
    assert rig.snapshot() == [SnapshotFailed(snapshot_id="s1", code="camera_failed")]
    assert rig.runner.calls == []


# --------------------------------------------------------------------------------------------
# File deletion (R18.6)
# --------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "steps",
    [
        pytest.param([jpeg_step(SMALL)], id="success"),
        pytest.param([jpeg_step(BIG)] * 3, id="too large"),
        pytest.param([jpeg_step(SMALL, exit_code=1)], id="exit code"),
        pytest.param([jpeg_step(SMALL, duration=9.0)], id="timeout"),
    ],
)
def test_temporary_directory_is_gone_before_the_result_is_posted(steps: list[Step]) -> None:
    rig = Rig(list(steps))
    assert len(rig.snapshot()) == 1
    assert rig.dir_existed_at_post == [False]
    assert not rig.temp_dir(0).exists()


def test_all_quality_steps_share_one_directory_that_is_deleted() -> None:
    rig = Rig([jpeg_step(BIG), jpeg_step(BIG), jpeg_step(SMALL)])
    rig.snapshot()
    assert {rig.temp_dir(i) for i in range(3)} == {rig.temp_dir(0)}
    assert not rig.temp_dir(0).exists()


# --------------------------------------------------------------------------------------------
# Probe (R18.5)
# --------------------------------------------------------------------------------------------

LISTING = "Available cameras\n-----------------\n0 : ov5647 [2592x1944 10-bit GBRG] (/base/soc)\n"


def probe(step: Step) -> tuple[Rig, object]:
    rig = Rig([step])
    return rig, rig.adapter.probe()


def test_probe_passes_when_a_camera_is_listed() -> None:
    rig, result = probe(Step(stdout=LISTING))
    assert rig.runner.calls == [["rpicam-still", "--list-cameras"]]
    assert result.ok is True and result.code is None  # type: ignore[attr-defined]


@pytest.mark.parametrize(
    "step",
    [
        pytest.param(Step(stdout="No cameras available!\n"), id="no camera listed"),
        pytest.param(Step(stdout=""), id="empty output"),
        pytest.param(Step(stdout="0 :\n"), id="index without a name"),
        pytest.param(Step(stdout=LISTING, exit_code=1), id="non-zero exit"),
        pytest.param(Step(stdout=LISTING, duration=6.0), id="timeout"),
        pytest.param(Step(start_error=FileNotFoundError("rpicam-still")), id="cannot start"),
    ],
)
def test_probe_failure_has_the_code_and_the_ribbon_cable_hint(step: Step) -> None:
    _, result = probe(step)
    assert result.ok is False  # type: ignore[attr-defined]
    assert result.code == "camera_missing"  # type: ignore[attr-defined]
    assert result.hint == CAMERA_HINT == "Camera not found: check the camera ribbon cable"  # type: ignore[attr-defined]


def test_probe_timeout_terminates_the_process() -> None:
    rig, _ = probe(Step(stdout=LISTING, duration=6.0))
    (proc,) = rig.runner.processes
    assert proc.terminate_calls == 1
    assert rig.scheduler.now() == pytest.approx(5.0)


def test_scripted_process_raises_timeout_expired() -> None:
    rig = Rig([Step(duration=3.0)])
    proc = rig.runner(["x"])
    with pytest.raises(subprocess.TimeoutExpired):
        proc.communicate(timeout=1.0)
    assert proc.returncode is None
