"""Unit tests for the fakes (device-core-loop task 19.5; R15.9, R16.5, R17.4, R18.7, R19.8).

Every adapter test and Dispatcher test relies on these fakes, so what they record and post is
pinned here. Time is virtual (``ManualScheduler``) and ``post`` is a plain list, so nothing
sleeps. The camera and audio fakes must post exactly one result per id, also when a snapshot
is stopped or a playback is interrupted (R18.8, R19.9).
"""

import ast
from pathlib import Path

import pytest

from warashi_agent.adapters import fakes
from warashi_agent.adapters.fakes import (
    FAKE_JPEG_1X1,
    FAKE_JPEG_HEIGHT,
    FAKE_JPEG_WIDTH,
    AudioOutcome,
    CameraOutcome,
    FakeAudio,
    FakeCamera,
    FakeInputDevice,
    FakePir,
    FakePwmDevice,
    FakeServoDeviceFactory,
    ServoCreation,
    ServoPinEvent,
    ServoWrite,
)
from warashi_agent.adapters.ports import ProbeResult
from warashi_agent.model import (
    AudioFailed,
    AudioFinished,
    PirFalling,
    PirRising,
    PlayAudioUrl,
    PlayLine,
    SnapshotFailed,
    SnapshotReady,
    TakeSnapshot,
)
from warashi_agent.timebase import ManualClock, ManualScheduler

PAN_PIN = 18
TILT_PIN = 13


@pytest.fixture
def scheduler() -> ManualScheduler:
    return ManualScheduler(ManualClock())


# --------------------------------------------------------------------------------------------
# FAKE_JPEG_1X1
# --------------------------------------------------------------------------------------------


def _sof0_size(jpeg: bytes) -> tuple[int, int]:
    """Walk the marker segments up to SOS and return (width, height) from SOF0.

    Written here on purpose, independent of any parser in the package, so a bug in a shared
    parser cannot hide a broken constant.
    """
    pos = 2  # after SOI
    while pos + 4 <= len(jpeg):
        assert jpeg[pos] == 0xFF, f"expected a marker at offset {pos}"
        marker = jpeg[pos + 1]
        length = int.from_bytes(jpeg[pos + 2 : pos + 4], "big")
        if marker == 0xC0:
            height = int.from_bytes(jpeg[pos + 5 : pos + 7], "big")
            width = int.from_bytes(jpeg[pos + 7 : pos + 9], "big")
            return width, height
        if marker == 0xDA:  # SOS: entropy-coded data follows, no SOF0 found before it
            break
        pos += 2 + length
    raise AssertionError("no SOF0 segment before SOS")


def test_fake_jpeg_has_soi_eoi_and_a_1x1_sof0() -> None:
    assert FAKE_JPEG_1X1[:2] == b"\xff\xd8"
    assert FAKE_JPEG_1X1[-2:] == b"\xff\xd9"
    assert _sof0_size(FAKE_JPEG_1X1) == (1, 1)
    assert (FAKE_JPEG_WIDTH, FAKE_JPEG_HEIGHT) == (1, 1)


def test_fakes_module_imports_no_gpio_library() -> None:
    tree = ast.parse(Path(fakes.__file__).read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            imported.add(node.module.split(".")[0])
    assert not imported & {"gpiozero", "lgpio"}


# --------------------------------------------------------------------------------------------
# FakeServoDeviceFactory / FakeServoDevice (R15.9)
# --------------------------------------------------------------------------------------------


def test_servo_factory_records_creations_writes_detaches_and_pwm_starts(
    scheduler: ManualScheduler,
) -> None:
    factory = FakeServoDeviceFactory(scheduler)
    scheduler.advance(1.0)
    pan = factory(PAN_PIN)
    assert pan.angle is None  # no pulse at creation
    assert factory.creations == [ServoCreation(1.0, PAN_PIN)]
    assert factory.pwm_starts == []

    pan.angle = 2.0
    scheduler.advance(0.03)
    pan.angle = 4.0
    scheduler.advance(0.5)
    pan.angle = None  # detach, as in gpiozero
    scheduler.advance(1.0)
    pan.angle = 6.0  # first write after a detach starts PWM again

    assert factory.writes == [
        ServoWrite(1.0, PAN_PIN, 2.0),
        ServoWrite(pytest.approx(1.03), PAN_PIN, 4.0),
        ServoWrite(pytest.approx(2.53), PAN_PIN, 6.0),
    ]
    assert factory.detaches == [ServoPinEvent(pytest.approx(1.53), PAN_PIN)]
    assert factory.pwm_starts == [
        ServoPinEvent(1.0, PAN_PIN),
        ServoPinEvent(pytest.approx(2.53), PAN_PIN),
    ]
    assert pan.angle == 6.0


def test_servo_factory_keeps_pins_apart(scheduler: ManualScheduler) -> None:
    factory = FakeServoDeviceFactory(scheduler)
    pan = factory.create(PAN_PIN)
    tilt = factory.create(TILT_PIN)
    pan.angle = 1.0
    tilt.angle = -1.0
    tilt.detach()

    assert [d.pin for d in factory.devices] == [PAN_PIN, TILT_PIN]
    assert factory.writes_for(PAN_PIN) == [ServoWrite(0.0, PAN_PIN, 1.0)]
    assert factory.writes_for(TILT_PIN) == [ServoWrite(0.0, TILT_PIN, -1.0)]
    assert factory.detaches == [ServoPinEvent(0.0, TILT_PIN)]
    assert pan.angle == 1.0 and tilt.angle is None


def test_servo_factory_fails_the_scripted_write_without_recording_it(
    scheduler: ManualScheduler,
) -> None:
    factory = FakeServoDeviceFactory(scheduler, fail_at_write=1)
    pan = factory(PAN_PIN)
    pan.angle = 1.0
    with pytest.raises(RuntimeError):
        pan.angle = 2.0
    assert factory.writes == [ServoWrite(0.0, PAN_PIN, 1.0)]
    assert pan.angle == 1.0


# --------------------------------------------------------------------------------------------
# FakePwmDevice (R16.5)
# --------------------------------------------------------------------------------------------


def test_pwm_device_records_initial_value_and_every_level_with_time(
    scheduler: ManualScheduler,
) -> None:
    led = FakePwmDevice(scheduler)
    scheduler.advance(0.1)
    led.value = 0.5
    scheduler.advance(0.1)
    led.value = 1.0
    scheduler.advance(0.1)
    led.off()

    assert led.writes == [
        (0.0, 0.0),
        (pytest.approx(0.1), 0.5),
        (pytest.approx(0.2), 1.0),
        (pytest.approx(0.3), 0.0),
    ]
    assert led.levels == [0.0, 0.5, 1.0, 0.0]
    assert led.value == 0.0


# --------------------------------------------------------------------------------------------
# FakeInputDevice (R17.4, R17.5)
# --------------------------------------------------------------------------------------------


def test_input_device_calls_back_only_on_level_changes() -> None:
    calls: list[str] = []
    pin = FakeInputDevice()
    pin.when_activated = lambda: calls.append("high")
    pin.when_deactivated = lambda: calls.append("low")

    pin.drive_high()
    pin.drive_high()  # no change, no callback
    pin.drive_low()
    pin.drive_low()
    pin.drive_high()

    assert calls == ["high", "low", "high"]
    assert pin.is_active and pin.value == 1


def test_input_device_already_high_fires_nothing_until_it_goes_low_and_high() -> None:
    calls: list[str] = []
    pin = FakeInputDevice(initial=True)
    pin.when_activated = lambda: calls.append("high")
    pin.drive_high()
    assert calls == []
    pin.drive_low()
    pin.drive_high()
    assert calls == ["high"]


def test_input_device_is_silent_after_close() -> None:
    calls: list[str] = []
    pin = FakeInputDevice()
    pin.when_activated = lambda: calls.append("high")
    pin.close()
    pin.drive_high()
    assert calls == []


# --------------------------------------------------------------------------------------------
# FakePir (R17.4)
# --------------------------------------------------------------------------------------------


def test_pir_posts_typed_edges_in_order_only_after_start(scheduler: ManualScheduler) -> None:
    posted: list[object] = []
    pir = FakePir(posted.append, scheduler)
    pir.rise()  # before start(): dropped
    pir.start()
    pir.rise()
    pir.fall()
    pir.rise()

    assert posted == [PirRising(), PirFalling(), PirRising()]
    assert pir.edges == [(0.0, "rise"), (0.0, "fall"), (0.0, "rise")]


def test_pir_posts_scripted_edges_at_their_times_and_none_after_close(
    scheduler: ManualScheduler,
) -> None:
    posted: list[object] = []
    pir = FakePir(posted.append, scheduler)
    pir.start()
    pir.script([(1.0, "rise"), (3.0, "fall"), (5.0, "rise")])

    scheduler.advance(0.5)
    assert posted == []
    scheduler.advance(3.0)
    assert posted == [PirRising(), PirFalling()]
    assert pir.edges == [(1.0, "rise"), (3.0, "fall")]

    pir.close()
    pir.rise()
    scheduler.advance(10.0)
    assert posted == [PirRising(), PirFalling()]
    assert scheduler.pending() == 0


# --------------------------------------------------------------------------------------------
# FakeCamera (R18.7, R18.8)
# --------------------------------------------------------------------------------------------


def test_camera_default_succeeds_after_0_2_s_with_the_fixed_jpeg(
    scheduler: ManualScheduler,
) -> None:
    posted: list[object] = []
    camera = FakeCamera(posted.append, scheduler)
    camera.handle(TakeSnapshot(snapshot_id="s1"))

    scheduler.advance(0.19)
    assert posted == []
    scheduler.advance(0.01)
    assert posted == [
        SnapshotReady(snapshot_id="s1", jpeg=FAKE_JPEG_1X1, width=1, height=1),
    ]
    assert camera.requests == [TakeSnapshot(snapshot_id="s1")]
    scheduler.advance(10.0)
    assert len(posted) == 1


def test_camera_uses_scripted_outcomes_in_order_then_the_default(
    scheduler: ManualScheduler,
) -> None:
    posted: list[object] = []
    camera = FakeCamera(posted.append, scheduler)
    camera.script(
        CameraOutcome(delay_s=1.0, failure="snapshot_too_large"),
        CameraOutcome(delay_s=0.5, failure="camera_failed"),
    )
    for snapshot_id in ("s1", "s2", "s3"):
        camera.handle(TakeSnapshot(snapshot_id=snapshot_id))
    scheduler.advance(5.0)

    assert posted == [
        SnapshotReady(snapshot_id="s3", jpeg=FAKE_JPEG_1X1, width=1, height=1),
        SnapshotFailed(snapshot_id="s2", code="camera_failed"),
        SnapshotFailed(snapshot_id="s1", code="snapshot_too_large"),
    ]
    assert [r.snapshot_id for r in camera.requests] == ["s1", "s2", "s3"]


def test_camera_stop_fails_in_flight_snapshots_exactly_once(
    scheduler: ManualScheduler,
) -> None:
    posted: list[object] = []
    camera = FakeCamera(posted.append, scheduler)
    camera.handle(TakeSnapshot(snapshot_id="done"))
    scheduler.advance(0.2)
    camera.handle(TakeSnapshot(snapshot_id="busy"))
    scheduler.advance(0.1)

    camera.stop()
    scheduler.advance(10.0)
    camera.stop()

    assert posted == [
        SnapshotReady(snapshot_id="done", jpeg=FAKE_JPEG_1X1, width=1, height=1),
        SnapshotFailed(snapshot_id="busy", code="camera_failed"),
    ]


def test_camera_probe_returns_the_configured_result(scheduler: ManualScheduler) -> None:
    assert FakeCamera([].append, scheduler).probe() == ProbeResult.passed()
    missing = ProbeResult.failed("camera_missing", "Camera not found")
    assert FakeCamera([].append, scheduler, probe_result=missing).probe() == missing


# --------------------------------------------------------------------------------------------
# FakeAudio (R19.8, R19.9)
# --------------------------------------------------------------------------------------------


def test_audio_records_requests_and_finishes_after_the_default_1_s(
    scheduler: ManualScheduler,
) -> None:
    posted: list[object] = []
    audio = FakeAudio(posted.append, scheduler)
    request = PlayLine(line_id="greet_01", play_id="p1")
    audio.handle(request)
    assert audio.playing == "p1"

    scheduler.advance(0.99)
    assert posted == []
    scheduler.advance(0.01)
    assert posted == [AudioFinished(play_id="p1")]
    assert audio.playing is None
    assert audio.requests == [request]

    audio.stop()  # nothing playing: no extra result
    scheduler.advance(10.0)
    assert posted == [AudioFinished(play_id="p1")]


def test_audio_posts_scripted_failure_after_its_duration(scheduler: ManualScheduler) -> None:
    posted: list[object] = []
    audio = FakeAudio(posted.append, scheduler)
    audio.script(AudioOutcome(duration_s=0.3, failure="download_failed"))
    request = PlayAudioUrl(url="https://example.invalid/a.wav", play_id="p1")
    audio.handle(request)
    scheduler.advance(0.3)

    assert posted == [AudioFailed(play_id="p1", code="download_failed")]
    assert audio.requests == [request]


def test_audio_new_request_interrupts_the_old_play_id_immediately(
    scheduler: ManualScheduler,
) -> None:
    posted: list[object] = []
    audio = FakeAudio(posted.append, scheduler)
    audio.handle(PlayLine(line_id="a", play_id="p1"))
    scheduler.advance(0.5)
    audio.handle(PlayLine(line_id="b", play_id="p2"))

    assert posted == [AudioFailed(play_id="p1", code="interrupted")]
    assert audio.playing == "p2"

    scheduler.advance(10.0)  # p1's original finish time passes too
    assert posted == [
        AudioFailed(play_id="p1", code="interrupted"),
        AudioFinished(play_id="p2"),
    ]


def test_audio_stop_interrupts_the_running_play_id_exactly_once(
    scheduler: ManualScheduler,
) -> None:
    posted: list[object] = []
    audio = FakeAudio(posted.append, scheduler)
    audio.handle(PlayLine(line_id="a", play_id="p1"))
    scheduler.advance(0.2)
    audio.stop()
    audio.stop()
    scheduler.advance(10.0)

    assert posted == [AudioFailed(play_id="p1", code="interrupted")]
    assert audio.playing is None


def test_audio_probe_returns_the_configured_result(scheduler: ManualScheduler) -> None:
    assert FakeAudio([].append, scheduler).probe() == ProbeResult.passed()
    missing = ProbeResult.failed("audio_device_missing", "Speaker not found")
    assert FakeAudio([].append, scheduler, probe_result=missing).probe() == missing
