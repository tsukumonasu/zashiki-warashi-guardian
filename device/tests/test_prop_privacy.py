"""Property 8: Privacy at Dispatcher level (design "Correctness Properties").

Encoded Wire_Messages enter a real Dispatcher through ``FakeCloudLink``: ``speak`` commands
whose ``ja``, ``en``, ``audioUrl`` user info, ``audioUrl`` query string and one extra
undefined ``data`` field each hold a marker (``ZQXJ`` + letters and digits), and
``judgement.result`` commands with an extra undefined ``data`` field. The Dispatcher runs on
virtual time (``ManualClock``) with the real Servo and Lantern adapters on fake devices and
the fake camera, audio, PIR and cloud link. Per example the test checks:

- no marker appears in any published envelope (encoded form), any captured log record
  (message, arguments and formatted text) or anything printed to stdout or stderr;
- every ``PlayAudioUrl`` is emitted while the Encounter's Accepted_Verdict is ``family``;
- every ``PlayLine`` that a ``speak`` caused in the situation ``stranger`` or ``uncertain``
  names a line of that Category;
- every published ``error.reported`` has a code from the R24.1 list.

The oracle does not read the State_Machine's verdict bookkeeping. It rebuilds the
Accepted_Verdict from the commands it sent: a ``judgement.result`` counts when the doll is in
``seeking`` and names the snapshot of the latest ``TakeSnapshot`` request, and it is the first
one for that snapshot id (R3.3, R3.4, R6.6). The first counted verdict that is not ``no_face``
fixes the Accepted_Verdict (R4.6); the thresholds come from the Config. The driver reads the
machine state only to decide *when* to send something and when an Encounter has ended.
"""

from __future__ import annotations

import contextlib
import dataclasses
import io
import json
import logging
import random
import tempfile
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
from hypothesis import event, given, settings
from hypothesis import strategies as st

from tests.strategies import line_sets, valid_configs
from warashi_agent.adapters.fakes import (
    FakeAudio,
    FakeCamera,
    FakeCloudLink,
    FakePir,
    FakePwmDevice,
    FakeServoDeviceFactory,
)
from warashi_agent.adapters.lantern import LanternAdapter
from warashi_agent.adapters.servo import ServoAdapter
from warashi_agent.config import Config
from warashi_agent.dispatcher import Adapters, Dispatcher
from warashi_agent.messages import ErrorReported, JudgementResultData, ModeSetData
from warashi_agent.model import (
    Action,
    Category,
    Mode,
    PlayAudioUrl,
    PlayLine,
    State,
    Verdict,
)
from warashi_agent.state_machine import initial_state
from warashi_agent.timebase import ManualClock, ManualScheduler
from warashi_agent.voice import VoiceLine

MARKER_PREFIX = "ZQXJ"
FIXED_TS = datetime(2026, 11, 20, 12, 34, 56, 789000, tzinfo=UTC)
WIRE_TS = "2026-11-20T12:34:56.789Z"
CLOCK_START = 5000.0
OPS_MAX = 14
WAIT_MAX_S = 5.0
SEEK_WAIT_MAX_S = 20.0
TAIL_MAX_S = 120.0

# The codes of docs/schema.md, "`error.reported` codes" (R24.1), written out independently of
# `messages.ErrorCode`.
R24_1_CODES = frozenset(
    {
        "unknown_type",
        "unsupported_version",
        "malformed_message",
        "wrong_device",
        "speak_rejected",
        "audio_busy",
        "command_rejected_state",
        "unknown_line",
        "voice_line_missing",
        "voice_line_invalid",
        "voice_file_missing",
        "audio_failed",
        "download_failed",
        "audio_device_missing",
        "camera_missing",
        "camera_failed",
        "snapshot_too_large",
        "internal_error",
        "adapter_failed",
    }
)

# --------------------------------------------------------------------------------------------
# Strategies
# --------------------------------------------------------------------------------------------

_ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"


def _marker() -> st.SearchStrategy[str]:
    return st.text(alphabet=_ALNUM, min_size=8, max_size=16).map(lambda s: MARKER_PREFIX + s)


_SPEAK_KINDS = ("family", "stranger", "uncertain", "unknown", "url", "url")
_CONF_KINDS = ("family_min", "stranger_min", "one", "zero", "mid")
_VERDICTS = (
    Verdict.FAMILY,
    Verdict.FAMILY,
    Verdict.STRANGER,
    Verdict.STRANGER,
    Verdict.NO_FACE,
    Verdict.UNCERTAIN,
)


def _verdict_op() -> st.SearchStrategy[tuple]:
    return st.tuples(
        st.just("verdict"),
        st.sampled_from(_VERDICTS),
        st.sampled_from(_CONF_KINDS),
        st.booleans(),  # a judgement.result with an extra undefined data field
        _marker(),
    )


def _speak_op(gap: st.SearchStrategy[float]) -> st.SearchStrategy[tuple]:
    markers = st.tuples(_marker(), _marker(), _marker(), _marker(), _marker())
    return st.tuples(
        st.just("speak"),
        st.sampled_from(_SPEAK_KINDS),
        st.integers(0, 10),  # picks a line inside its Category
        markers,
        gap,  # time passed before the command arrives
    )


def _ops() -> st.SearchStrategy[tuple]:
    """One driver step; the tuple's first item names the kind."""
    markers = st.tuples(_marker(), _marker(), _marker(), _marker(), _marker())
    return st.one_of(
        st.tuples(st.just("wait"), st.floats(0.0, WAIT_MAX_S)),
        st.tuples(st.just("wait"), st.floats(0.0, 0.5)),
        _verdict_op(),
        st.tuples(
            st.just("speak"),
            st.sampled_from(_SPEAK_KINDS),
            st.integers(0, 10),  # picks a line inside its Category
            markers,
            st.floats(0.0, 0.3),  # time passed before the command arrives
        ),
        st.tuples(
            st.just("speak"),
            st.sampled_from(_SPEAK_KINDS),
            st.integers(0, 10),
            markers,
            st.floats(0.3, 8.0),
        ),
        st.tuples(st.just("pir")),
        st.tuples(st.just("offline")),
        st.tuples(st.just("online")),
        st.tuples(st.just("mode"), st.sampled_from((Mode.GUARD, Mode.GUARD, Mode.SLEEP))),
    )


# --------------------------------------------------------------------------------------------
# Log and output capture
# --------------------------------------------------------------------------------------------


class _Capture(logging.Handler):
    """Keeps every text a log record can show: message, raw message, arguments, formatted."""

    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.texts: list[str] = []
        self._formatter = logging.Formatter("%(name)s %(levelname)s %(message)s")

    def emit(self, record: logging.LogRecord) -> None:
        self.texts.append(self._formatter.format(record))
        self.texts.append(str(record.msg))
        self.texts.append(repr(record.args))
        self.texts.append(record.getMessage())


# --------------------------------------------------------------------------------------------
# The world: Dispatcher, fakes, oracle
# --------------------------------------------------------------------------------------------


class _World:
    def __init__(self, cfg: Config, lines: tuple[VoiceLine, ...], pose_file: Path, seed: int):
        cfg = dataclasses.replace(
            cfg, servo=dataclasses.replace(cfg.servo, pose_file=str(pose_file))
        )
        self.cfg = cfg
        self.lines = lines
        self.by_category = {
            c: sorted(line.id for line in lines if line.category is c) for c in Category
        }
        self.line_category = {line.id: line.category for line in lines}
        self.clock = ManualClock(CLOCK_START)
        self.scheduler = ManualScheduler(self.clock)
        self.cloud = FakeCloudLink(self.scheduler, cfg.device.id)
        self.actions: list[Action] = []
        self._uid = 0
        self.dispatcher: Dispatcher | None = None

        def post(item: object) -> None:
            assert self.dispatcher is not None
            self.dispatcher.post(item)  # type: ignore[arg-type]

        servo = ServoAdapter(cfg, post, self.scheduler, FakeServoDeviceFactory(self.scheduler))
        lantern = LanternAdapter(post, self.scheduler, FakePwmDevice(self.scheduler))
        self.camera = FakeCamera(post, self.scheduler)
        self.audio = FakeAudio(post, self.scheduler, default_duration_s=0.1 + (seed % 30) / 10)
        self.pir = FakePir(post, self.scheduler)
        initial = initial_state(
            config=cfg,
            lines=lines,
            agent_version="0.0.0-test",
            start_time=CLOCK_START - cfg.timing.pir_warmup_s - 1.0,
            mode=Mode.GUARD,
            cloud_connected=False,
        )
        self.dispatcher = Dispatcher(
            config=cfg,
            initial=initial,
            adapters=Adapters(
                servo=servo, lantern=lantern, pir=self.pir, camera=self.camera, audio=self.audio
            ),
            cloud=self.cloud,
            clock=self.clock,
            scheduler=self.scheduler,
            rng=random.Random(seed),
            new_uid=self._next_uid,
            utc_now=lambda: FIXED_TS,
            observer=self.actions.append,
        )
        self.cloud.start(self.dispatcher.post)
        self.dispatcher.start()
        # Oracle state of the current Encounter.
        self.processed: set[str] = set()
        self.accepted: Verdict | None = None

    def _next_uid(self) -> str:
        self._uid += 1
        return f"00000000-0000-4000-8000-{self._uid:012d}"

    # -- oracle ---------------------------------------------------------------------------

    @property
    def situation(self) -> Category:
        if self.accepted is Verdict.FAMILY:
            return Category.FAMILY
        if self.accepted is Verdict.STRANGER:
            return Category.STRANGER
        return Category.UNCERTAIN

    def _accepted_kind(self, verdict: str, confidence: float) -> Verdict:
        judgement = self.cfg.judgement
        if verdict == "family":
            ok = confidence >= judgement.family_confidence_min
            return Verdict.FAMILY if ok else Verdict.UNCERTAIN
        if verdict == "stranger":
            ok = confidence >= judgement.stranger_confidence_min
            return Verdict.STRANGER if ok else Verdict.UNCERTAIN
        return Verdict(verdict)

    def note_verdict_sent(self, snapshot_id: str, verdict: str, confidence: float) -> None:
        """Update the Accepted_Verdict for a judgement.result sent in the current state."""
        assert self.dispatcher is not None
        current = self.camera.requests[-1].snapshot_id if self.camera.requests else None
        if (
            self.dispatcher.machine_state.state is State.SEEKING
            and snapshot_id == current
            and snapshot_id not in self.processed
        ):
            self.processed.add(snapshot_id)
            kind = self._accepted_kind(verdict, confidence)
            if self.accepted is None and kind is not Verdict.NO_FACE:
                self.accepted = kind

    # -- driving --------------------------------------------------------------------------

    def pump(self, *, from_speak: bool = False) -> None:
        assert self.dispatcher is not None
        start = len(self.actions)
        errors_before = len(self.cloud.envelopes)
        situation = self.situation
        self.dispatcher.pump()
        for action in self.actions[start:]:
            if isinstance(action, PlayAudioUrl):
                event("PlayAudioUrl emitted")
                assert situation is Category.FAMILY, (
                    f"PlayAudioUrl in situation {situation.value} (accepted={self.accepted})"
                )
            elif isinstance(action, PlayLine) and from_speak:
                category = self.line_category[action.line_id]
                event(f"speak PlayLine in {situation.value}")
                if situation in (Category.STRANGER, Category.UNCERTAIN):
                    assert category is situation, (
                        f"PlayLine of {category.value} line in situation {situation.value}"
                    )
        for env in self.cloud.envelopes[errors_before:]:
            if isinstance(env.data, ErrorReported) and from_speak:
                event(f"speak error: {env.data.code.value}")
        if self.dispatcher.machine_state.state is State.SLEEPING:
            self.processed = set()
            self.accepted = None

    def advance(self, dt: float) -> None:
        """Move virtual time in Tick-sized chunks, processing the queue after each."""
        chunk = self.cfg.tick_s
        remaining = dt
        while remaining > 0:
            step_s = min(chunk, remaining)
            self.scheduler.advance(step_s)
            self.pump()
            remaining -= step_s

    def advance_until_state(self, state: State, max_s: float) -> None:
        assert self.dispatcher is not None
        waited = 0.0
        while self.dispatcher.machine_state.state is not state and waited < max_s:
            self.advance(self.cfg.tick_s)
            waited += self.cfg.tick_s

    # -- inputs ---------------------------------------------------------------------------

    def envelope_bytes(self, type_: str, data: dict[str, object]) -> bytes:
        obj = {
            "v": 1,
            "id": str(uuid.uuid4()),
            "ts": WIRE_TS,
            "deviceId": self.cfg.device.id,
            "encounterId": None,
            "type": type_,
            "data": data,
        }
        return json.dumps(obj).encode()

    def send_verdict(self, op: tuple) -> None:
        _, verdict, conf_kind, extra, marker = op
        self.advance_until_state(State.SEEKING, SEEK_WAIT_MAX_S)
        judgement = self.cfg.judgement
        confidence = {
            "family_min": judgement.family_confidence_min,
            "stranger_min": judgement.stranger_confidence_min,
            "one": 1.0,
            "zero": 0.0,
            "mid": 0.5,
        }[conf_kind]
        snapshot_id = (
            self.camera.requests[-1].snapshot_id if self.camera.requests else "no-snapshot"
        )
        self.note_verdict_sent(snapshot_id, verdict.value, confidence)
        if extra:
            data: dict[str, object] = {
                "snapshotId": snapshot_id,
                "verdict": verdict.value,
                "confidence": confidence,
                "face": None,
                "nickname": marker,
            }
            self.cloud.script_raw(self.envelope_bytes("judgement.result", data))
        else:
            self.cloud.type_command(
                JudgementResultData(
                    snapshot_id=snapshot_id, verdict=verdict, confidence=confidence, face=None
                )
            )
        self.pump()

    def send_speak(self, op: tuple) -> bool:
        """Send one speak; returns True when it names an audioUrl."""
        _, kind, pick, markers, gap = op
        self.advance(gap)
        ja, en, query, userinfo, extra = markers
        line_id: str | None = None
        audio_url: str | None = None
        if kind == "url":
            audio_url = f"https://{userinfo}@example.invalid/a.wav?k={query}"
        elif kind == "unknown":
            line_id = "no_such_line"
        else:
            ids = self.by_category[Category(kind)]
            line_id = ids[pick % len(ids)]
        data: dict[str, object] = {"lineId": line_id, "audioUrl": audio_url, "ja": ja, "en": en}
        # Built by hand: `SpeakData` has no field for the extra undefined one.
        data["nickname"] = extra
        self.cloud.script_raw(self.envelope_bytes("speak", data))
        self.pump(from_speak=True)
        return audio_url is not None

    def run(self, ops: list[tuple]) -> None:
        self.cloud.go_online()
        self.pump()
        self.advance(self.cfg.timing.pir_warmup_s + 2 * self.cfg.tick_s)
        self.pir.rise()
        self.pump()
        for op in ops:
            kind = op[0]
            if kind == "wait":
                self.advance(op[1])
            elif kind == "verdict":
                self.send_verdict(op)
            elif kind == "speak":
                if self.send_speak(op):
                    event(f"audioUrl speak in {self.situation.value}")
            elif kind == "pir":
                self.pir.fall()
                self.pir.rise()
                self.pump()
            elif kind == "offline":
                self.cloud.go_offline()
                self.pump()
            elif kind == "online":
                self.cloud.go_online()
                self.pump()
            else:
                self.cloud.type_command(ModeSetData(mode=op[1]))
                self.pump()
        waited = 0.0
        assert self.dispatcher is not None
        while self.dispatcher.machine_state.state is not State.SLEEPING and waited < TAIL_MAX_S:
            self.advance(self.cfg.tick_s)
            waited += self.cfg.tick_s


# --------------------------------------------------------------------------------------------
# The Property 8 test
# --------------------------------------------------------------------------------------------


def _assert_no_marker(label: str, texts: list[str]) -> None:
    for text in texts:
        assert MARKER_PREFIX not in text, f"marker in {label}: {text[:300]!r}"


# Feature: device-core-loop, Property 8: Privacy at Dispatcher level
@pytest.mark.timeout(900)
@settings(deadline=None)
@given(
    cfg=valid_configs(),
    lines=line_sets(require=tuple(Category)),
    first=_verdict_op(),  # every run reaches a verdict, so the situations vary
    burst=st.lists(_speak_op(st.floats(0.0, 0.2)), min_size=1, max_size=4),  # right after it
    ops=st.lists(_ops(), min_size=3, max_size=OPS_MAX),
    seed=st.integers(0, 2**32 - 1),
)
def test_privacy_at_dispatcher_level(
    cfg: Config,
    lines: tuple[VoiceLine, ...],
    first: tuple,
    burst: list[tuple],
    ops: list[tuple],
    seed: int,
) -> None:
    """Markers in speak and judgement fields never leave the device; audio obeys the situation.

    **Validates: Requirements 13.2, 13.3, 13.5, 13.6, 13.7, 24.5, 29.10**
    """
    capture = _Capture()
    root = logging.getLogger()
    old_level = root.level
    out, err = io.StringIO(), io.StringIO()
    root.addHandler(capture)
    root.setLevel(logging.DEBUG)
    try:
        with (
            tempfile.TemporaryDirectory() as tmp,
            contextlib.redirect_stdout(out),
            contextlib.redirect_stderr(err),
        ):
            world = _World(cfg, lines, Path(tmp) / "last_pose.json", seed)
            world.run([first, *burst, *ops])
    finally:
        root.removeHandler(capture)
        root.setLevel(old_level)

    published = world.cloud.published
    assert all(raw is not None for _, raw in published), "an envelope could not be encoded"
    _assert_no_marker("a published envelope", [raw.decode() for _, raw in published if raw])
    _assert_no_marker("a log record", capture.texts)
    _assert_no_marker("stdout", [out.getvalue()])
    _assert_no_marker("stderr", [err.getvalue()])
    for env, _ in published:
        if isinstance(env.data, ErrorReported):
            assert env.data.code.value in R24_1_CODES, env.data.code
