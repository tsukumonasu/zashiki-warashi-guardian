"""Unit tests for ``--selftest`` in warashi_agent.selftest (task 27.4; R27.5-27.10).

The self-test runs against the real Servo_Adapter and Lantern_Adapter on fake devices, and the
fake PIR, camera, audio and Cloud_Link, on a ``ManualScheduler``. ``wait`` is
``scheduler.advance``, so no test sleeps.
"""

from __future__ import annotations

import dataclasses
import queue
import threading
from collections.abc import Callable
from pathlib import Path

from warashi_agent.adapters.fakes import (
    AudioOutcome,
    CameraOutcome,
    FakeAudio,
    FakeCamera,
    FakeCloudLink,
    FakePir,
    FakePwmDevice,
    FakeServoDeviceFactory,
)
from warashi_agent.adapters.lantern import LanternAdapter
from warashi_agent.adapters.ports import ProbeResult
from warashi_agent.adapters.servo import ServoAdapter
from warashi_agent.config import Config, DeviceConfig, MotionConfig, ServoConfig
from warashi_agent.dispatcher import Adapters
from warashi_agent.messages import Envelope, StatusReport
from warashi_agent.model import Category, Event
from warashi_agent.selftest import (
    BATTERY_HINT,
    EXIT_FAILED,
    EXIT_OK,
    MOTION_HINT,
    PIR_WINDOW_S,
    run_selftest,
)
from warashi_agent.timebase import ManualClock, ManualScheduler
from warashi_agent.voice import VoiceLine

SECRET_JA = "ひみつの文言"
SECRET_EN = "secret subtitle text"
LINES = (
    VoiceLine(id="greeting", category=Category.FAMILY, ja=SECRET_JA, en=SECRET_EN, wav="g.wav"),
    VoiceLine(id="uncertain_b", category=Category.UNCERTAIN, ja=SECRET_JA, en=SECRET_EN, wav="b"),
    VoiceLine(id="uncertain_a", category=Category.UNCERTAIN, ja=SECRET_JA, en=SECRET_EN, wav="a"),
)


class _RaisingPwm(FakePwmDevice):
    """A PWM device whose every write fails, so the Lantern_Adapter posts adapter.error."""

    @property
    def value(self) -> float:
        return 0.0

    @value.setter
    def value(self, level: float) -> None:
        raise RuntimeError("scripted pwm failure")


class _RaisingCloud(FakeCloudLink):
    def publish(self, envelope: Envelope) -> None:
        raise RuntimeError("SECRET?token=abc")


class _World:
    """Real adapters on fakes, one inbox, one virtual clock, and the collected output."""

    def __init__(
        self,
        tmp_path: Path,
        *,
        motion: bool = False,
        lines: tuple[VoiceLine, ...] = LINES,
        servo_cfg: dict[str, float] | None = None,
        timing_cfg: dict[str, float] | None = None,
        camera_delay_s: float = 0.2,
        audio_duration_s: float = 1.0,
        camera_probe: ProbeResult | None = None,
        audio_probe: ProbeResult | None = None,
        pwm_factory: Callable[..., FakePwmDevice] = FakePwmDevice,
        cloud_class: type[FakeCloudLink] = FakeCloudLink,
        fail_servo_write: int | None = None,
    ) -> None:
        base = Config(
            device=DeviceConfig(id="warashi-07"), motion=MotionConfig(motion_enabled=motion)
        )
        self.config = dataclasses.replace(
            base,
            servo=dataclasses.replace(
                base.servo, pose_file=str(tmp_path / "pose.json"), **(servo_cfg or {})
            ),
            timing=dataclasses.replace(base.timing, **(timing_cfg or {})),
        )
        assert isinstance(self.config.servo, ServoConfig)
        self.clock = ManualClock(1000.0)
        self.scheduler = ManualScheduler(self.clock)
        self.inbox: queue.SimpleQueue[Event] = queue.SimpleQueue()
        self.servo_factory = FakeServoDeviceFactory(self.scheduler, fail_at_write=fail_servo_write)
        self.pwm = pwm_factory(self.scheduler)
        self.pir = FakePir(self.inbox.put, self.scheduler)
        self.camera = FakeCamera(
            self.inbox.put,
            self.scheduler,
            default_delay_s=camera_delay_s,
            probe_result=camera_probe,
        )
        self.audio = FakeAudio(
            self.inbox.put,
            self.scheduler,
            default_duration_s=audio_duration_s,
            probe_result=audio_probe,
        )
        self.cloud = cloud_class(self.scheduler, self.config.device.id)
        self.adapters = Adapters(
            servo=ServoAdapter(self.config, self.inbox.put, self.scheduler, self.servo_factory),
            lantern=LanternAdapter(self.inbox.put, self.scheduler, self.pwm),
            pir=self.pir,
            camera=self.camera,
            audio=self.audio,
        )
        self.lines = lines
        self.out: list[str] = []
        self.start = self.scheduler.now()

    def run(
        self,
        *,
        wait: Callable[[float], None] | None = None,
        interrupt: threading.Event | None = None,
    ) -> int:
        return run_selftest(
            config=self.config,
            adapters=self.adapters,
            cloud=self.cloud,
            lines=self.lines,
            inbox=self.inbox,
            scheduler=self.scheduler,
            wait=wait if wait is not None else self.scheduler.advance,
            out=self.out.append,
            agent_version="0.0.0-test",
            interrupt=interrupt,
            new_uid=self._uid,
        )

    _n = 0

    def _uid(self) -> str:
        self._n += 1
        return f"uid-{self._n}"

    def row(self, name: str) -> str:
        rows = [t for t in self.out if t.split(":")[0].split(" ")[-1] == name]
        assert len(rows) == 1, (name, self.out)
        return rows[0]

    def assert_safe(self) -> None:
        """Lantern dark, servos detached, nothing left running."""
        assert self.pwm.value == 0.0
        assert self.audio.playing is None


# --------------------------------------------------------------------------------------------
# All-pass runs
# --------------------------------------------------------------------------------------------


def test_all_pass_with_motion_enabled(tmp_path: Path) -> None:
    world = _World(tmp_path, motion=True)
    assert world.run() == EXIT_OK
    for name in ("lantern", "servos", "pir", "camera", "audio", "cloud"):
        assert world.row(name).startswith(f"PASS {name}")
    assert world.row("camera") == "PASS camera: 70 bytes" or world.row("camera").startswith(
        "PASS camera: "
    )
    assert world.row("audio") == "PASS audio: line uncertain_a"
    assert world.out[-1] == BATTERY_HINT
    assert not any(t.startswith(("FAIL", "SKIP", "INTERRUPTED")) for t in world.out)
    world.assert_safe()
    assert world.servo_factory.detaches  # servos released
    assert world.pwm.levels[-1] == 0.0
    assert 0.5 in world.pwm.levels


def test_servos_skipped_with_hint_when_motion_disabled(tmp_path: Path) -> None:
    world = _World(tmp_path, motion=False)
    assert world.run() == EXIT_OK
    assert world.row("servos") == f"SKIP servos: motion_enabled is false; {MOTION_HINT}"
    assert "motion_enabled = true" in MOTION_HINT
    assert world.servo_factory.writes == []
    assert world.out[-1] == BATTERY_HINT
    assert "battery" in BATTERY_HINT


def test_servo_targets_are_clamped_to_the_limits(tmp_path: Path) -> None:
    world = _World(tmp_path, motion=True, servo_cfg={"pan_limit": 4.0, "tilt_limit": 6.0})
    assert world.run() == EXIT_OK
    pan = [w.angle for w in world.servo_factory.writes_for(world.config.pins.pan_pin)]
    tilt = [w.angle for w in world.servo_factory.writes_for(world.config.pins.tilt_pin)]
    assert max(pan) == 4.0 and min(pan) >= 0.0
    assert max(tilt) == 6.0 and min(tilt) >= 0.0


# --------------------------------------------------------------------------------------------
# PIR
# --------------------------------------------------------------------------------------------


def test_pir_counts_edges_in_the_window(tmp_path: Path) -> None:
    world = _World(tmp_path)
    world.pir.script(
        [(world.start + 3.0, "rise"), (world.start + 4.0, "fall"), (world.start + 5.0, "rise")]
    )
    assert world.run() == EXIT_OK
    assert world.row("pir") == f"PASS pir: 3 edges in {PIR_WINDOW_S:g} s"


def test_pir_passes_with_no_edges(tmp_path: Path) -> None:
    world = _World(tmp_path)
    assert world.run() == EXIT_OK
    assert world.row("pir") == f"PASS pir: 0 edges in {PIR_WINDOW_S:g} s"


# --------------------------------------------------------------------------------------------
# FAIL rows
# --------------------------------------------------------------------------------------------


def test_camera_failure(tmp_path: Path) -> None:
    world = _World(tmp_path)
    world.camera.script(CameraOutcome(failure="camera_failed"))
    assert world.run() == EXIT_FAILED
    assert world.row("camera") == "FAIL camera: camera_failed"
    assert world.row("audio").startswith("PASS")  # later steps still run
    assert world.out[-1] == BATTERY_HINT


def test_camera_timeout(tmp_path: Path) -> None:
    world = _World(tmp_path, camera_delay_s=60.0)
    assert world.run() == EXIT_FAILED
    assert world.row("camera") == "FAIL camera: no snapshot result within 5 s"


def test_audio_probe_failure(tmp_path: Path) -> None:
    probe = ProbeResult.failed("audio_device_missing", "Audio device not found: check the cable")
    world = _World(tmp_path, audio_probe=probe)
    assert world.run() == EXIT_FAILED
    assert world.row("audio") == (
        "FAIL audio: audio_device_missing: Audio device not found: check the cable"
    )
    assert world.audio.requests == []


def test_audio_without_uncertain_line(tmp_path: Path) -> None:
    world = _World(tmp_path, lines=(LINES[0],))
    assert world.run() == EXIT_FAILED
    assert world.row("audio") == "FAIL audio: no uncertain voice line is available"
    assert world.audio.requests == []


def test_audio_failure(tmp_path: Path) -> None:
    world = _World(tmp_path)
    world.audio.script(AudioOutcome(duration_s=0.1, failure="audio_failed"))
    assert world.run() == EXIT_FAILED
    assert world.row("audio") == "FAIL audio: audio_failed"


def test_audio_timeout_plays_lowest_uncertain_id(tmp_path: Path) -> None:
    world = _World(tmp_path, audio_duration_s=60.0)
    assert world.run() == EXIT_FAILED
    assert world.row("audio") == "FAIL audio: no audio result within 12 s"
    assert [r.line_id for r in world.audio.requests] == ["uncertain_a"]  # type: ignore[union-attr]


def test_lantern_adapter_error(tmp_path: Path) -> None:
    world = _World(tmp_path, pwm_factory=_RaisingPwm)
    assert world.run() == EXIT_FAILED
    assert world.row("lantern") == "FAIL lantern: adapter.error adapter_failed"
    assert world.pwm.value == 0.0


def test_servo_timeout(tmp_path: Path) -> None:
    world = _World(tmp_path, motion=True, timing_cfg={"glide_timeout_s": 0.01})
    assert world.run() == EXIT_FAILED
    assert world.row("servos") == "FAIL servos: no servo.arrived within 0.01 s"
    assert world.servo_factory.detaches  # detached at once


def test_servo_adapter_error(tmp_path: Path) -> None:
    world = _World(tmp_path, motion=True, fail_servo_write=0)
    assert world.run() == EXIT_FAILED
    assert world.row("servos") == "FAIL servos: adapter.error adapter_failed"


def test_cloud_publish_raising_prints_only_the_type(tmp_path: Path) -> None:
    world = _World(tmp_path, cloud_class=_RaisingCloud)
    assert world.run() == EXIT_FAILED
    assert world.row("cloud") == "FAIL cloud: raised RuntimeError"
    assert not any("SECRET" in t or "token" in t for t in world.out)


def test_cloud_publishes_one_status_report(tmp_path: Path) -> None:
    world = _World(tmp_path, motion=True)
    assert world.run() == EXIT_OK
    [envelope] = world.cloud.envelopes
    assert isinstance(envelope.data, StatusReport)
    assert envelope.data.agent_version == "0.0.0-test"
    assert envelope.data.motion_enabled is True
    assert envelope.device_id == "warashi-07"
    assert envelope.encounter_id is None


# --------------------------------------------------------------------------------------------
# Interruption
# --------------------------------------------------------------------------------------------


def _interrupting_wait(
    world: _World, at_s: float, how: Callable[[], None]
) -> Callable[[float], None]:
    """A ``wait`` that advances time and calls ``how`` once virtual time passes ``at_s``."""
    fired = False

    def wait(seconds: float) -> None:
        nonlocal fired
        world.scheduler.advance(seconds)
        if not fired and world.scheduler.now() - world.start >= at_s:
            fired = True
            how()

    return wait


def _assert_interrupted(world: _World, code: int) -> None:
    assert code == EXIT_FAILED
    assert any(t.startswith("INTERRUPTED:") for t in world.out)
    assert world.out[-1] == BATTERY_HINT
    assert not any(t.startswith("PASS pir") for t in world.out)
    world.assert_safe()


def test_interrupt_event_during_servo_glide_detaches_and_lights_off(tmp_path: Path) -> None:
    world = _World(tmp_path, motion=True)
    event = threading.Event()
    wait = _interrupting_wait(world, 2.3, event.set)  # lantern takes 2.1 s; servos next
    code = world.run(wait=wait, interrupt=event)
    _assert_interrupted(world, code)
    assert world.servo_factory.writes  # the glide had started
    assert world.servo_factory.detaches  # detached without gliding back
    assert world.pwm.value == 0.0


def test_interrupt_event_while_lantern_is_lit(tmp_path: Path) -> None:
    world = _World(tmp_path)
    event = threading.Event()
    wait = _interrupting_wait(world, 0.5, event.set)  # inside the first fade
    code = world.run(wait=wait, interrupt=event)
    _assert_interrupted(world, code)
    assert world.pwm.value == 0.0
    assert not any(t.startswith("PASS lantern") for t in world.out)


def test_keyboard_interrupt_is_handled(tmp_path: Path) -> None:
    world = _World(tmp_path, motion=True)

    def raise_keyboard_interrupt() -> None:
        raise KeyboardInterrupt

    wait = _interrupting_wait(world, 2.3, raise_keyboard_interrupt)
    code = world.run(wait=wait)
    _assert_interrupted(world, code)
    assert world.servo_factory.detaches


def test_interrupt_stops_within_one_poll(tmp_path: Path) -> None:
    world = _World(tmp_path)
    event = threading.Event()
    event.set()
    assert world.run(interrupt=event) == EXIT_FAILED
    assert world.scheduler.now() == world.start  # no waiting at all


# --------------------------------------------------------------------------------------------
# Output hygiene
# --------------------------------------------------------------------------------------------


def test_output_has_no_line_text_url_or_image_bytes(tmp_path: Path) -> None:
    world = _World(tmp_path, motion=True)
    world.run()
    text = "\n".join(world.out)
    assert SECRET_JA not in text and SECRET_EN not in text
    assert "http" not in text and "?" not in text
    assert "\\x" not in text and "b'" not in text
    for row in world.out:
        assert row.startswith(("PASS ", "FAIL ", "SKIP ")) or row == BATTERY_HINT
