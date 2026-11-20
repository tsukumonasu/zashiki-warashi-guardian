"""Unit tests for the Dispatcher in warashi_agent.dispatcher (task 20.4).

The Dispatcher runs on virtual time: a ``ManualClock`` bound to a ``ManualScheduler``, so the
Tick only fires when a test advances time and no test sleeps. The five hardware ports and the
Cloud_Link are recording stubs defined below. They write every call into one shared journal,
together with the virtual time of the call, so a test can check the order of calls across
ports (R20.2) and the timing of the emergency stop (R20.6).

Most tests drive the loop with ``pump()``. The shutdown tests call ``run()`` with the queue
already filled, and a stub requests the shutdown or raises from inside the loop, so ``run()``
returns without waiting on real time. One test runs ``run()`` on a thread to check that a
shutdown request wakes a loop that is waiting on the queue.

Sections:
- Helpers: constants, the journal, the stubs, the rig
- Stamping and the Tick (R1.5, R20.1)
- Routing (R20.2)
- Envelopes and connectivity (R20.4, R9.6)
- Inbound messages (R21.8, R12.10)
- Restart after a step() exception (R10.5, R10.7)
- Shutdown and escaped exceptions (R20.6, R20.8)
- Reported adapter and audio failures (R20.9)
- Logging (R13.6)
- Startup sequence (R20.5, R25.10, R27.1)
"""

from __future__ import annotations

import io
import json
import logging
import random
import threading
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import pytest

from warashi_agent import __main__ as entry
from warashi_agent.adapters.cloud import CloudPost, InboundRaw
from warashi_agent.adapters.fakes import FakeServoDeviceFactory
from warashi_agent.adapters.ports import ProbeResult
from warashi_agent.adapters.servo import ServoAdapter
from warashi_agent.config import Config, DeviceConfig
from warashi_agent.dispatcher import ERROR_MESSAGES, Adapters, Dispatcher, StepFn
from warashi_agent.messages import (
    EncounterEnded,
    Envelope,
    ErrorCode,
    ErrorReported,
    PresenceDetected,
    StateChanged,
    StatusReport,
    encode,
)
from warashi_agent.model import (
    Action,
    AdapterError,
    AudioFailed,
    Category,
    CloudConnected,
    CloudDisconnected,
    EndReason,
    Event,
    GazeTarget,
    LanternFade,
    Mode,
    ModeSet,
    PirFalling,
    PirRising,
    PlayAudioUrl,
    PlayLine,
    PublishEvent,
    PublishStatus,
    Reason,
    ReleaseServos,
    Speak,
    State,
    TakeSnapshot,
    Tick,
)
from warashi_agent.state_machine import MachineState, initial_state, step
from warashi_agent.timebase import ManualClock, ManualScheduler
from warashi_agent.voice import ManifestResult, VoiceLine

# ============================================================================================
# Helpers
# ============================================================================================

DEVICE_ID = "warashi-07"
CONFIG = Config(device=DeviceConfig(id=DEVICE_ID))
AGENT_VERSION = "0.1.0"
CLOCK_START = 1000.0
START_TIME = CLOCK_START - 100.0  # past pir_warmup_s (60 s), so a pir.rising starts an Encounter
FIXED_TS = datetime(2026, 11, 20, 12, 34, 56, 789000, tzinfo=UTC)
WIRE_TS = "2026-11-20T12:34:56.789Z"
LOGGER = "warashi_agent.dispatcher"

# Markers that must never reach a log line or a published envelope.
SECRET = "SECRET_EXCEPTION_TEXT"
SECRET_TOKEN = "SECRET_TOKEN"
SECRET_NICKNAME = "SECRET_NICKNAME"

LINES = (
    VoiceLine(
        id="greeting_family",
        category=Category.FAMILY,
        ja="おかえり",
        en="Welcome back",
        wav="g.wav",
    ),
    VoiceLine(id="uncertain", category=Category.UNCERTAIN, ja="だれ？", en="Who?", wav="u.wav"),
    VoiceLine(id="warning_stranger", category=Category.STRANGER, ja="……", en="...", wav="w.wav"),
)

EMERGENCY = (("servo", "emergency_detach"), ("lantern", "off_now"))
STOP_ORDER = (
    ("servo", "emergency_detach"),
    ("lantern", "off_now"),
    ("pir", "close"),
    ("camera", "stop"),
    ("audio", "stop"),
    ("cloud", "stop"),
)


def make_initial(*, mode: Mode = Mode.GUARD, cloud_connected: bool = False) -> MachineState:
    return initial_state(
        config=CONFIG,
        lines=LINES,
        agent_version=AGENT_VERSION,
        start_time=START_TIME,
        mode=mode,
        cloud_connected=cloud_connected,
    )


@dataclass(frozen=True)
class Call:
    """One recorded port call: which port, which method, its argument and the virtual time."""

    port: str
    method: str
    arg: object
    at: float


@dataclass
class Journal:
    """Every call to every stub, in call order."""

    clock: ManualClock
    calls: list[Call] = field(default_factory=list)

    def note(self, port: str, method: str, arg: object = None) -> None:
        self.calls.append(Call(port, method, arg, self.clock.now()))

    def names(self, ports: Iterable[str] | None = None) -> list[tuple[str, str]]:
        wanted = None if ports is None else set(ports)
        return [(c.port, c.method) for c in self.calls if wanted is None or c.port in wanted]

    def handled(self, port: str) -> list[object]:
        return [c.arg for c in self.calls if c.port == port and c.method == "handle"]


Hook = Callable[[object], None]


class Stub:
    """Recording stand-in for every port: servo, lantern, PIR, camera and audio.

    One class covers all five because the ports are Protocols and only their method names
    matter. ``hooks`` maps a method name to a side effect (raise, request a shutdown) that runs
    after the call is recorded.
    """

    def __init__(self, name: str, journal: Journal) -> None:
        self.name = name
        self.journal = journal
        self.hooks: dict[str, Hook] = {}

    def _record(self, method: str, arg: object = None) -> None:
        self.journal.note(self.name, method, arg)
        hook = self.hooks.get(method)
        if hook is not None:
            hook(arg)

    def handle(self, action: object) -> None:
        self._record("handle", action)

    def emergency_detach(self) -> None:
        self._record("emergency_detach")

    def off_now(self) -> None:
        self._record("off_now")

    def start(self) -> None:
        self._record("start")

    def close(self) -> None:
        self._record("close")

    def stop(self) -> None:
        self._record("stop")


class CloudStub:
    """Recording Cloud_Link: keeps every published envelope in publish order."""

    def __init__(self, journal: Journal) -> None:
        self.journal = journal
        self.envelopes: list[Envelope] = []

    def start(self, post: CloudPost) -> None:
        self.journal.note("cloud", "start", post)

    def publish(self, envelope: Envelope) -> None:
        self.journal.note("cloud", "publish", envelope)
        self.envelopes.append(envelope)

    def stop(self) -> None:
        self.journal.note("cloud", "stop")

    def of_type(self, type_: str) -> list[Envelope]:
        return [e for e in self.envelopes if e.type == type_]


class RecordingStep:
    """Wraps ``step`` and records each (Event, now); raises while ``fail`` is set."""

    def __init__(self, inner: StepFn = step) -> None:
        self.inner = inner
        self.calls: list[tuple[Event, float]] = []
        self.fail = False

    def __call__(
        self, ms: MachineState, event: Event, now: float
    ) -> tuple[MachineState, tuple[Action, ...]]:
        self.calls.append((event, now))
        if self.fail:
            raise RuntimeError(SECRET)
        return self.inner(ms, event, now)

    @property
    def events(self) -> list[Event]:
        return [event for event, _ in self.calls]


def scripted(actions: tuple[Action, ...]) -> StepFn:
    """A step that keeps the state and returns ``actions`` for every Event."""

    def fn(ms: MachineState, event: Event, now: float) -> tuple[MachineState, tuple[Action, ...]]:
        return ms, actions

    return fn


def no_actions(
    ms: MachineState, event: Event, now: float
) -> tuple[MachineState, tuple[Action, ...]]:
    return ms, ()


class Rig:
    """A Dispatcher on virtual time with recording stubs and deterministic ids."""

    def __init__(
        self,
        *,
        initial: MachineState | None = None,
        step_fn: StepFn | None = None,
        rng: random.Random | None = None,
        deterministic_uid: bool = True,
    ) -> None:
        self.clock = ManualClock(CLOCK_START)
        self.scheduler = ManualScheduler(self.clock)
        self.journal = Journal(self.clock)
        self.servo = Stub("servo", self.journal)
        self.lantern = Stub("lantern", self.journal)
        self.pir = Stub("pir", self.journal)
        self.camera = Stub("camera", self.journal)
        self.audio = Stub("audio", self.journal)
        self.cloud = CloudStub(self.journal)
        self.step = RecordingStep(step_fn if step_fn is not None else step)
        self.actions: list[Action] = []
        self._uid_count = 0
        self.dispatcher = Dispatcher(
            config=CONFIG,
            initial=initial if initial is not None else make_initial(),
            adapters=Adapters(
                servo=self.servo,
                lantern=self.lantern,
                pir=self.pir,
                camera=self.camera,
                audio=self.audio,
            ),
            cloud=self.cloud,
            clock=self.clock,
            scheduler=self.scheduler,
            rng=rng if rng is not None else random.Random(7),
            new_uid=self._next_uid if deterministic_uid else None,
            utc_now=lambda: FIXED_TS,
            step_fn=self.step,
            observer=self.actions.append,
        )

    def _next_uid(self) -> str:
        self._uid_count += 1
        return f"00000000-0000-4000-8000-{self._uid_count:012d}"

    def feed(self, *items: Event | InboundRaw) -> None:
        for item in items:
            self.dispatcher.post(item)
        self.dispatcher.pump()

    @property
    def ms(self) -> MachineState:
        return self.dispatcher.machine_state

    def errors(self) -> list[Envelope]:
        return self.cloud.of_type(ErrorReported.TYPE)


def wire(
    type_: str,
    data: dict[str, object],
    *,
    msg_id: object = "cmd-1",
    device_id: str = DEVICE_ID,
    v: object = 1,
) -> InboundRaw:
    """An encoded Wire_Message as a Cloud_Link would hand it to the Dispatcher."""
    obj = {
        "v": v,
        "id": msg_id,
        "ts": WIRE_TS,
        "deviceId": device_id,
        "encounterId": None,
        "type": type_,
        "data": data,
    }
    return InboundRaw(json.dumps(obj).encode())


def status_data() -> StatusReport:
    return StatusReport(
        state=State.SLEEPING,
        mode=Mode.GUARD,
        pan_deg=0.0,
        tilt_deg=0.0,
        lantern=0.0,
        camera_active=False,
        mic_active=False,
        motion_enabled=False,
        uptime_sec=0,
        agent_version=AGENT_VERSION,
    )


def internal_error() -> ErrorReported:
    return ErrorReported(
        code=ErrorCode.INTERNAL_ERROR,
        message=ERROR_MESSAGES[ErrorCode.INTERNAL_ERROR],
        ref_id=None,
    )


def start_encounter(rig: Rig) -> str:
    """Feed a pir.rising through the real step and return the new Encounter's id."""
    rig.feed(PirRising())
    assert rig.ms.state is State.WAKING
    assert rig.ms.encounter is not None
    return rig.ms.encounter.encounter_id


def hardware_after(journal: Journal, index: int) -> list[tuple[str, str]]:
    """Servo and lantern calls recorded at or after ``index``."""
    return [(c.port, c.method) for c in journal.calls[index:] if c.port in ("servo", "lantern")]


# ============================================================================================
# Stamping and the Tick (R1.5, R20.1)
# ============================================================================================


def test_stamps_rand_and_uid_on_every_event_before_step() -> None:
    rig = Rig(step_fn=no_actions, rng=random.Random(42))
    posted = (PirFalling(), CloudConnected(), Tick())

    rig.feed(*posted)

    expected = random.Random(42)
    assert [type(e) for e in rig.step.events] == [PirFalling, CloudConnected, Tick]
    assert [e.rand for e in rig.step.events] == [expected.random() for _ in posted]
    assert [e.uid for e in rig.step.events] == [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000003",
    ]
    # The posted objects are frozen and keep their placeholders.
    assert all(e.rand == 0.0 and e.uid == "" for e in posted)


def test_default_stamps_are_fresh_uuid4_and_rand_in_unit_interval() -> None:
    rig = Rig(step_fn=no_actions, deterministic_uid=False)

    rig.feed(*(PirFalling() for _ in range(20)))

    uids = [e.uid for e in rig.step.events]
    assert len(set(uids)) == 20
    assert all(uuid.UUID(u).version == 4 for u in uids)
    assert all(0.0 <= e.rand < 1.0 for e in rig.step.events)


def test_now_is_the_clock_reading_when_the_item_is_removed() -> None:
    rig = Rig(step_fn=no_actions)
    rig.dispatcher.post(PirFalling())
    rig.clock.advance(2.5)
    rig.dispatcher.post(PirFalling())

    rig.dispatcher.pump()
    rig.clock.advance(1.0)
    rig.feed(PirFalling())

    assert [now for _, now in rig.step.calls] == [CLOCK_START + 2.5, CLOCK_START + 2.5, 1003.5]


def test_tick_is_posted_every_interval_only_after_start() -> None:
    rig = Rig(step_fn=no_actions)
    rig.scheduler.advance(1.0)
    rig.dispatcher.pump()
    assert rig.step.calls == []

    rig.dispatcher.start()
    rig.dispatcher.start()  # idempotent: one PIR start, one Tick chain
    rig.scheduler.advance(3 * CONFIG.tick_s + CONFIG.tick_s / 2)
    rig.dispatcher.pump()

    assert [type(e) for e in rig.step.events] == [Tick, Tick, Tick]
    assert rig.journal.names(["pir"]) == [("pir", "start")]
    # The Dispatcher does not start the Cloud_Link; the startup sequence does.
    assert ("cloud", "start") not in rig.journal.names()


# ============================================================================================
# Routing (R20.2)
# ============================================================================================


def test_routes_each_action_to_its_port_in_step_order() -> None:
    publish = PublishEvent(data=PresenceDetected(source="pir"), encounter_id="enc-1")
    actions: tuple[Action, ...] = (
        LanternFade(level=0.8, fade_ms=1500),
        GazeTarget(pan_deg=5.0, tilt_deg=-2.0, motion_id="m-1"),
        TakeSnapshot(snapshot_id="s-1"),
        publish,
        PlayLine(line_id="uncertain", play_id="p-1"),
        PlayAudioUrl(url="https://audio.example.invalid/a.wav", play_id="p-2"),
        ReleaseServos(),
        PublishStatus(data=status_data()),
    )
    rig = Rig(step_fn=scripted(actions))

    rig.feed(PirFalling())

    assert rig.journal.names() == [
        ("lantern", "handle"),
        ("servo", "handle"),
        ("camera", "handle"),
        ("cloud", "publish"),
        ("audio", "handle"),
        ("audio", "handle"),
        ("servo", "handle"),
        ("cloud", "publish"),
    ]
    handed = [c.arg for c in rig.journal.calls if c.method == "handle"]
    assert handed == [a for a in actions if not isinstance(a, PublishEvent | PublishStatus)]
    assert rig.actions == list(actions)  # the observer sees every Action, in order


# ============================================================================================
# Envelopes and connectivity (R20.4, R9.6)
# ============================================================================================


def test_wraps_publish_actions_in_envelopes() -> None:
    event_data = PresenceDetected(source="pir")
    status = status_data()
    rig = Rig(
        step_fn=scripted(
            (PublishEvent(data=event_data, encounter_id="enc-1"), PublishStatus(data=status))
        )
    )

    rig.feed(PirFalling())

    first, second = rig.cloud.envelopes
    # uid 1 is the Event's own stamp; the envelopes get fresh ids after it.
    assert (first.id, second.id) == (
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000003",
    )
    for env in (first, second):
        assert env.v == 1
        assert env.ts == FIXED_TS
        assert env.ts.utcoffset() is not None and env.ts.utcoffset().total_seconds() == 0
        assert env.device_id == DEVICE_ID
    assert (first.data, first.encounter_id) == (event_data, "enc-1")
    assert (second.data, second.encounter_id) == (status, None)
    wire_status = json.loads(encode(second))
    assert wire_status["encounterId"] is None
    assert wire_status["deviceId"] == DEVICE_ID
    assert wire_status["ts"] == WIRE_TS


def test_encounter_start_envelopes_carry_the_encounter_id_and_status_carries_null() -> None:
    rig = Rig()

    encounter_id = start_encounter(rig)

    types = [e.type for e in rig.cloud.envelopes]
    assert types == [StateChanged.TYPE, PresenceDetected.TYPE, StatusReport.TYPE]
    for env in rig.cloud.envelopes:
        expected = None if env.type == StatusReport.TYPE else encounter_id
        assert env.encounter_id == expected
    assert len({e.id for e in rig.cloud.envelopes}) == 3


@pytest.mark.parametrize(
    "connectivity",
    [(), (CloudConnected(),), (CloudConnected(), CloudDisconnected())],
    ids=["never-connected", "connected", "disconnected-again"],
)
def test_publishes_in_both_connectivity_states(connectivity: tuple[Event, ...]) -> None:
    rig = Rig()
    rig.feed(*connectivity)
    assert rig.cloud.envelopes == []  # connectivity changes emit no Action (R9.7)

    encounter_id = start_encounter(rig)

    assert [e.type for e in rig.cloud.envelopes] == [
        StateChanged.TYPE,
        PresenceDetected.TYPE,
        StatusReport.TYPE,
    ]
    assert rig.cloud.envelopes[0].encounter_id == encounter_id
    assert rig.ms.cloud_connected == (len(connectivity) == 1)


# ============================================================================================
# Inbound messages (R21.8, R12.10)
# ============================================================================================


@pytest.mark.parametrize(
    ("raw", "code", "ref_id"),
    [
        (InboundRaw(b"{not json"), ErrorCode.MALFORMED_MESSAGE, None),
        (InboundRaw(b"\xff\xfe"), ErrorCode.MALFORMED_MESSAGE, None),
        (wire("gaze", {"tiltDeg": 0}, msg_id="cmd-2"), ErrorCode.MALFORMED_MESSAGE, "cmd-2"),
        (
            wire("mode.set", {"mode": "sleep"}, v=2, msg_id="cmd-3"),
            ErrorCode.UNSUPPORTED_VERSION,
            "cmd-3",
        ),
        (wire("no.such.type", {}, msg_id="cmd-4"), ErrorCode.UNKNOWN_TYPE, "cmd-4"),
        (
            wire("presence.detected", {"source": "pir"}, msg_id="cmd-5"),
            ErrorCode.UNKNOWN_TYPE,
            "cmd-5",
        ),
        (
            wire("mode.set", {"mode": "sleep"}, device_id="warashi-99", msg_id="cmd-6"),
            ErrorCode.WRONG_DEVICE,
            "cmd-6",
        ),
    ],
    ids=["not-json", "not-utf8", "missing-field", "v2", "unknown", "event-type", "wrong-device"],
)
def test_dropped_inbound_message_is_reported_with_its_ref_id(
    raw: InboundRaw, code: ErrorCode, ref_id: str | None
) -> None:
    rig = Rig()

    rig.feed(raw)

    assert rig.step.calls == []  # nothing reached the State_Machine
    (env,) = rig.cloud.envelopes
    assert env.data == ErrorReported(code=code, message=ERROR_MESSAGES[code], ref_id=ref_id)
    assert env.encounter_id is None
    assert env.device_id == DEVICE_ID


def test_inbound_error_during_an_encounter_carries_its_encounter_id() -> None:
    rig = Rig()
    encounter_id = start_encounter(rig)
    rig.cloud.envelopes.clear()

    rig.feed(InboundRaw(b"[]"))

    (env,) = rig.errors()
    assert env.data.code is ErrorCode.MALFORMED_MESSAGE
    assert env.encounter_id == encounter_id


def test_accepted_command_is_queued_behind_earlier_items_and_duplicates_are_dropped() -> None:
    rig = Rig()
    command = wire("mode.set", {"mode": "sleep"}, msg_id="cmd-9")

    rig.feed(command, PirFalling(), command)

    assert [type(e) for e in rig.step.events] == [PirFalling, ModeSet]
    mode_set = rig.step.events[1]
    assert isinstance(mode_set, ModeSet)
    assert (mode_set.ref_id, mode_set.mode) == ("cmd-9", Mode.SLEEP)
    assert rig.errors() == []  # the duplicate is dropped silently
    assert rig.ms.mode is Mode.SLEEP


# ============================================================================================
# Restart after a step() exception (R10.5, R10.7)
# ============================================================================================


def test_restart_without_an_encounter_releases_hardware_and_reports_internal_error(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)
    initial = make_initial(mode=Mode.SLEEP, cloud_connected=True)
    rig = Rig(initial=initial)
    rig.step.fail = True

    rig.feed(PirFalling())

    assert rig.journal.names() == [
        ("servo", "handle"),
        ("lantern", "handle"),
        ("cloud", "publish"),
    ]
    assert rig.journal.handled("servo") == [ReleaseServos()]
    assert rig.journal.handled("lantern") == [LanternFade(level=0.0, fade_ms=0)]
    (env,) = rig.cloud.envelopes
    assert (env.data, env.encounter_id) == (internal_error(), None)
    assert rig.ms == initial
    # The loop keeps running with the restarted state.
    rig.step.fail = False
    rig.feed(CloudDisconnected())
    assert rig.ms.cloud_connected is False
    # The log shows the exception type and its stack, never its message.
    assert "RuntimeError" in caplog.text
    assert "test_dispatcher.py" in caplog.text
    assert SECRET not in caplog.text


def test_restart_during_an_encounter_ends_it_and_keeps_start_time_mode_and_connectivity() -> None:
    rig = Rig()
    rig.feed(CloudConnected())
    encounter_id = start_encounter(rig)
    assert rig.ms.pir_high is True
    published_before = len(rig.cloud.envelopes)
    calls_before = len(rig.journal.calls)
    rig.step.fail = True

    rig.feed(Tick())

    assert rig.journal.names()[calls_before:] == [
        ("servo", "handle"),
        ("lantern", "handle"),
        ("cloud", "publish"),
        ("cloud", "publish"),
        ("cloud", "publish"),
    ]
    assert rig.journal.calls[calls_before].arg == ReleaseServos()
    assert rig.journal.calls[calls_before + 1].arg == LanternFade(level=0.0, fade_ms=0)
    published = rig.cloud.envelopes[published_before:]
    assert [e.data for e in published] == [
        internal_error(),
        StateChanged(from_=State.WAKING, to=State.SLEEPING, reason=Reason.ERROR),
        EncounterEnded(reason=EndReason.ERROR),
    ]
    assert all(e.encounter_id == encounter_id for e in published)
    assert rig.ms == make_initial(mode=Mode.GUARD, cloud_connected=True)


def test_adapter_error_with_a_code_outside_the_contract_restarts_the_machine() -> None:
    rig = Rig()

    rig.feed(AdapterError(code="no_such_code"))

    assert [e.data for e in rig.cloud.envelopes] == [internal_error()]
    assert rig.journal.handled("servo") == [ReleaseServos()]


# ============================================================================================
# Shutdown and escaped exceptions (R20.6, R20.8)
# ============================================================================================


def test_shutdown_request_stops_hardware_at_once_and_exits_0() -> None:
    rig = Rig()
    requested_at: list[float] = []

    def request(_: object) -> None:
        requested_at.append(rig.clock.now())
        rig.dispatcher.request_shutdown()

    rig.lantern.hooks["handle"] = request
    rig.dispatcher.post(PirRising())

    code = rig.dispatcher.run()

    assert code == 0
    # run() finished the item in hand, then stopped everything in the safe order.
    stops = [c for c in rig.journal.calls if (c.port, c.method) in STOP_ORDER]
    assert [(c.port, c.method) for c in stops] == list(STOP_ORDER)
    (t_request,) = requested_at
    assert all(c.at - t_request <= 1.0 for c in stops[:2])
    first_stop = rig.journal.calls.index(stops[0])
    assert hardware_after(rig.journal, first_stop) == list(EMERGENCY)  # no glide to center
    assert rig.scheduler.pending() == 0  # the Tick is cancelled


def test_no_action_reaches_servo_or_lantern_after_the_gate_closes() -> None:
    rig = Rig()
    rig.dispatcher.request_shutdown()
    assert rig.dispatcher.run() == 0
    calls_after_stop = len(rig.journal.calls)
    steps_after_stop = len(rig.step.calls)

    rig.dispatcher.start()
    rig.dispatcher.post(PirRising())
    rig.dispatcher.post(wire("gaze", {"panDeg": 10, "tiltDeg": 0}, msg_id="cmd-1"))
    rig.scheduler.advance(5.0)
    rig.dispatcher.pump()

    assert len(rig.step.calls) == steps_after_stop
    assert rig.journal.calls[calls_after_stop:] == []


def test_shutdown_request_wakes_a_loop_waiting_on_the_queue() -> None:
    rig = Rig()
    result: list[int] = []
    loop = threading.Thread(target=lambda: result.append(rig.dispatcher.run()), daemon=True)

    loop.start()
    rig.dispatcher.post(PirFalling())
    rig.dispatcher.request_shutdown()
    loop.join(timeout=5.0)

    assert not loop.is_alive()
    assert result == [0]
    assert [n for n in rig.journal.names() if n in STOP_ORDER] == list(STOP_ORDER)


def test_escaped_exception_stops_hardware_logs_type_and_exits_1(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)
    gaze = GazeTarget(pan_deg=5.0, tilt_deg=0.0, motion_id="m-1")
    rig = Rig(
        step_fn=scripted(
            (gaze, TakeSnapshot(snapshot_id="s-1"), LanternFade(level=1, fade_ms=500))
        )
    )

    def boom(_: object) -> None:
        raise RuntimeError(SECRET)

    rig.camera.hooks["handle"] = boom
    rig.dispatcher.post(PirFalling())
    rig.dispatcher.post(PirFalling())

    code = rig.dispatcher.run()

    assert code == 1
    assert rig.journal.handled("servo") == [gaze]
    assert rig.journal.handled("lantern") == []  # the LanternFade after the failure never ran
    assert hardware_after(rig.journal, 0) == [("servo", "handle"), *EMERGENCY]
    assert [n for n in rig.journal.names() if n in STOP_ORDER] == list(STOP_ORDER)
    assert len(rig.step.calls) == 1  # the second item is never processed
    rig.dispatcher.pump()
    assert len(rig.step.calls) == 1
    assert "RuntimeError" in caplog.text
    assert "test_dispatcher.py" in caplog.text
    assert SECRET not in caplog.text


def test_keyboard_interrupt_stops_hardware_and_exits_0() -> None:
    rig = Rig(step_fn=scripted((ReleaseServos(),)))

    def interrupt(_: object) -> None:
        raise KeyboardInterrupt

    rig.servo.hooks["handle"] = interrupt
    rig.dispatcher.post(PirFalling())

    assert rig.dispatcher.run() == 0
    assert [n for n in rig.journal.names() if n in STOP_ORDER] == list(STOP_ORDER)


def test_failing_servo_detach_does_not_keep_the_lantern_on(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)
    rig = Rig()

    def boom(_: object) -> None:
        raise RuntimeError(SECRET)

    rig.servo.hooks["emergency_detach"] = boom
    rig.dispatcher.request_shutdown()

    assert rig.dispatcher.run() == 0
    assert [n for n in rig.journal.names() if n in STOP_ORDER] == list(STOP_ORDER)
    assert "servo detach failed during shutdown: RuntimeError" in caplog.text
    assert SECRET not in caplog.text


# ============================================================================================
# Reported adapter and audio failures (R20.9)
# ============================================================================================


def test_adapter_error_is_published_with_its_code() -> None:
    rig = Rig()

    rig.feed(AdapterError(code=ErrorCode.ADAPTER_FAILED.value))

    (env,) = rig.cloud.envelopes
    assert isinstance(env.data, ErrorReported)
    assert (env.data.code, env.data.ref_id, env.encounter_id) == (
        ErrorCode.ADAPTER_FAILED,
        None,
        None,
    )


@pytest.mark.parametrize(
    ("code", "reported"),
    [
        ("audio_failed", ErrorCode.AUDIO_FAILED),
        ("download_failed", ErrorCode.DOWNLOAD_FAILED),
        ("interrupted", None),
    ],
)
def test_audio_failed_is_published_unless_interrupted(
    code: str, reported: ErrorCode | None
) -> None:
    rig = Rig()

    rig.feed(AudioFailed(play_id="p-stale", code=code))  # type: ignore[arg-type]

    codes = [e.data.code for e in rig.errors()]
    assert codes == ([] if reported is None else [reported])


# ============================================================================================
# Logging (R13.6)
# ============================================================================================


def test_logs_one_redacted_line_per_non_tick_event_and_per_action(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)
    rig = Rig()
    rig.dispatcher.start()
    speak = wire(
        "speak",
        {
            "lineId": None,
            "audioUrl": f"https://audio.example.invalid/a.wav?sig={SECRET_TOKEN}",
            "ja": SECRET_NICKNAME,
            "en": SECRET_NICKNAME,
        },
        msg_id="cmd-7",
    )

    rig.feed(PirRising(), speak)
    rig.scheduler.advance(5 * CONFIG.tick_s)
    rig.dispatcher.pump()

    records = [r for r in caplog.records if r.name == LOGGER]
    event_lines = [r.getMessage() for r in records if r.getMessage().startswith("event ")]
    action_lines = [r.getMessage() for r in records if r.getMessage().startswith("action ")]
    non_tick = [e for e in rig.step.events if not isinstance(e, Tick)]
    assert any(isinstance(e, Tick) for e in rig.step.events)
    assert [type(e) for e in non_tick] == [PirRising, Speak]
    assert len(event_lines) == len(non_tick)
    assert not any("Tick(" in line for line in event_lines)
    assert len(action_lines) == len(rig.actions)
    assert all("\n" not in r.getMessage() for r in records)
    assert any("audio.example.invalid/a.wav" in line for line in event_lines)
    for text in (SECRET_TOKEN, SECRET_NICKNAME):
        assert text not in caplog.text
        assert all(text.encode() not in encode(env) for env in rig.cloud.envelopes)
    # The rejected speak is reported with the command id as refId (R12.12).
    assert [e.data.ref_id for e in rig.errors()] == ["cmd-7"]


# ============================================================================================
# Startup sequence (R20.5, R25.10, R27.1)
# ============================================================================================


class ProbingStub(Stub):
    """A Stub with a startup probe, for the camera and the audio port."""

    def __init__(self, name: str, journal: Journal, result: ProbeResult) -> None:
        super().__init__(name, journal)
        self.result = result

    def probe(self) -> ProbeResult:
        self._record("probe")
        return self.result


def run_startup(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    manifest_text: str | None,
    camera: ProbeResult,
    audio: ProbeResult,
) -> tuple[int, Journal, CloudStub, FakeServoDeviceFactory]:
    """Run ``run_agent`` with stubs and a shutdown requested before it starts."""
    clock = ManualClock(CLOCK_START)
    scheduler = ManualScheduler(clock)
    journal = Journal(clock)
    cloud = CloudStub(journal)
    servo_devices = FakeServoDeviceFactory(scheduler)
    if manifest_text is not None:
        (tmp_path / "lines.toml").write_text(manifest_text, encoding="utf-8")
        monkeypatch.setattr(entry, "VOICE_DIR", tmp_path)
    else:
        monkeypatch.setattr(
            entry,
            "load_voice",
            lambda config, *, fake: ManifestResult(available=LINES, problems=()),
        )
    stubs: dict[str, Stub] = {}

    def noting(name: str, stub: Stub) -> Callable[..., Stub]:
        def build(*args: object) -> Stub:
            journal.note("factory", name)
            stubs[name] = stub
            return stub

        return build

    factories = entry.Factories(
        scheduler=lambda: scheduler,
        cloud=lambda config, sched: cloud,
        servo=lambda config, post, sched: (
            journal.note("factory", "servo") or ServoAdapter(config, post, sched, servo_devices)
        ),
        lantern=noting("lantern", Stub("lantern", journal)),
        pir=noting("pir", Stub("pir", journal)),
        camera=noting("camera", ProbingStub("camera", journal, camera)),
        audio=noting("audio", ProbingStub("audio", journal, audio)),
    )
    relay = entry.ShutdownRelay()
    relay.request()  # the loop exits as soon as it starts
    code = entry.run_agent(
        CONFIG,
        fake=False,
        factories=factories,
        relay=relay,
        stdin=io.StringIO(),
        stdout=io.StringIO(),
        agent_version=AGENT_VERSION,
    )
    return code, journal, cloud, servo_devices


def test_startup_order_and_published_probe_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    code, journal, cloud, servo_devices = run_startup(
        tmp_path,
        monkeypatch,
        manifest_text=None,
        camera=ProbeResult.failed("camera_missing", "Camera not found: check the ribbon cable"),
        audio=ProbeResult.failed("audio_device_missing", "Audio device missing: PWR and USB?"),
    )

    assert code == 0
    names = journal.names()
    # Cloud_Link first, lantern at 0 before the other adapters, probes before the first
    # error, every startup error before the PIR starts (the loop begins after them).
    assert names.index(("cloud", "start")) < names.index(("factory", "lantern"))
    assert names.index(("factory", "lantern")) < names.index(("lantern", "off_now"))
    assert names.index(("lantern", "off_now")) < names.index(("factory", "servo"))
    assert names.index(("lantern", "off_now")) < names.index(("factory", "pir"))
    first_publish = names.index(("cloud", "publish"))
    assert names.index(("camera", "probe")) < first_publish
    assert names.index(("audio", "probe")) < first_publish
    assert names.index(("cloud", "publish")) < names.index(("pir", "start"))
    # The published probe errors: camera, then audio, with no Encounter and no refId.
    errors = cloud.of_type(ErrorReported.TYPE)
    assert [e.data.code for e in errors] == [
        ErrorCode.CAMERA_MISSING,
        ErrorCode.AUDIO_DEVICE_MISSING,
    ]
    assert all(e.encounter_id is None and e.data.ref_id is None for e in errors)
    # R16.3 / hardware.md: the lantern is made 0 and no servo device exists at startup.
    assert servo_devices.creations == []
    assert servo_devices.writes == []


def test_startup_publishes_manifest_problems_before_probe_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    broken = '[[lines]]\nid = "no_category"\nja = "x"\nen = "x"\n'  # no category: rejected

    code, _, cloud, servo_devices = run_startup(
        tmp_path,
        monkeypatch,
        manifest_text=broken,
        camera=ProbeResult.failed("camera_missing", "Camera not found"),
        audio=ProbeResult.passed(),
    )

    assert code == 0
    codes = [e.data.code for e in cloud.of_type(ErrorReported.TYPE)]
    assert codes[0] is ErrorCode.VOICE_LINE_INVALID
    assert codes[-1] is ErrorCode.CAMERA_MISSING
    assert ErrorCode.AUDIO_DEVICE_MISSING not in codes
    assert servo_devices.creations == []


def test_passing_probes_publish_no_startup_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    code, _, cloud, _ = run_startup(
        tmp_path,
        monkeypatch,
        manifest_text=None,
        camera=ProbeResult.passed(),
        audio=ProbeResult.passed(),
    )

    assert code == 0
    assert cloud.of_type(ErrorReported.TYPE) == []
