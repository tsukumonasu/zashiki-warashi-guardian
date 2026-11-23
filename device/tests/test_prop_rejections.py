"""Property 20: Command rejection is exact and atomic (design "Correctness Properties").

For reachable Machine_States and `speak`, `gaze` and `lantern` Command_Events, an oracle
written from R12.12 (with R12.3, R12.5, R12.6, R12.11, R13.3 and R13.4) picks the first
applicable code in the order `unknown_line`, `speak_rejected`, `command_rejected_state`,
`audio_busy`. `step()` must then either return the argument state with exactly one
`error.reported` carrying that code and the command's `id`, or emit exactly the single
accepted Action (R12.1, R12.2, R12.4, R13.2) without changing the State, Mode, Encounter or
any deadline.

Generators:

- A reactive trace from a `_Driver` subclass: the cloud may be connected at start, the
  warm-up is crossed and a `pir.rising` starts an Encounter, then harness draws alternate
  with progress steps (snapshot results, confident `family` or `stranger` Verdicts for the
  Current_Snapshot_Id, glide ends, Ticks), so the family and stranger situations and the
  silent stare occur often.
- Probe points are the states after the trace's records, biased toward the silent stare,
  unfinished audio and the resting States. Each probe is stepped on its own and never fed
  back into the trace.
- `lineId` comes from the Available_Lines, from lines removed from the drawn manifest, from a
  fixed unknown id and from random strings. `gaze` and `lantern` take any finite numbers.

The oracle derives "earlier audio is unfinished" (R12.6) and "the stranger Reaction
`PlayLine` has not been emitted" (R12.11) from the trace's Events and Actions, not from the
State_Machine's bookkeeping. The Situation_Category follows the Glossary from the
Encounter's recorded Accepted_Verdict.

`mode.set` is outside the property (the design names only `speak`, `gaze` and `lantern`).
"""

from __future__ import annotations

import dataclasses
from typing import NamedTuple

import pytest
from hypothesis import event, given, settings
from hypothesis import strategies as st

from tests.harness import (
    FAKE_AUDIO_URL,
    FAKE_JPEG,
    START_TIME,
    UNKNOWN_LINE_ID,
    Record,
    _any_finite,
    _Driver,
    _floats,
)
from tests.strategies import line_sets, rands, valid_configs
from warashi_agent.config import Config
from warashi_agent.messages import ErrorCode, ErrorReported
from warashi_agent.model import (
    AcceptedVerdict,
    Action,
    AudioFailed,
    AudioFinished,
    Category,
    CloudConnected,
    Event,
    FaceBox,
    Gaze,
    GazeTarget,
    JudgementResult,
    Lantern,
    LanternFade,
    PirRising,
    PlayAudioUrl,
    PlayLine,
    PublishEvent,
    PublishStatus,
    ServoArrived,
    SnapshotReady,
    Speak,
    State,
    Tick,
    Verdict,
)
from warashi_agent.state_machine import MachineState, step
from warashi_agent.voice import VoiceLine

BUDGET_MIN = 10  # enough draws to carry an Encounter past seeking most of the time
BUDGET = 40
PROBES_PER_EXAMPLE = 4
LANTERN_FADE_MS_MAX = 10000
RESTING = (State.SLEEPING, State.COOLDOWN)
AUDIO_URLS = (
    FAKE_AUDIO_URL,
    "https://audio.example.invalid/a.wav",
    "https://audio.example.invalid/greeting.wav?X-Amz-Signature=abc&X-Amz-Expires=60",
)
_RANDOM_ID_CHARS = "abz019_-"


# --------------------------------------------------------------------------------------------
# Generators
# --------------------------------------------------------------------------------------------


class _RejectionDriver(_Driver):
    """The harness driver, with progress steps and confident Verdicts mixed in.

    Plain harness draws rarely carry an Encounter through seeking and gazing within the
    budget. A progress step answers the oldest pending snapshot, gives a confident Verdict
    for the Current_Snapshot_Id, ends the oldest glide, or sends a Tick, so the family and
    stranger situations and the silent stare are reached often.
    """

    # Verdicts of the progress steps: both kinds, or one kind for the whole trace so that a
    # stranger trace reaches the silent stare often.
    verdicts: tuple[Verdict, ...] = (Verdict.FAMILY, Verdict.STRANGER)

    def draw_one(self) -> None:
        if self.data.draw(st.sampled_from((True, True, False)), label="progress step"):
            self._progress()
        else:
            super().draw_one()

    def _progress(self) -> None:
        enc = self.ms.encounter
        attempt = enc.attempt if enc is not None else None
        if self.snapshots:
            sid = next(iter(self.snapshots))
            del self.snapshots[sid]
            self.answered.append(sid)
            ready = SnapshotReady(snapshot_id=sid, jpeg=FAKE_JPEG, width=640, height=480)
            self.feed(ready, self.now)
        elif (
            attempt is not None
            and self.ms.state is State.SEEKING
            and not attempt.verdict_processed
        ):
            self.feed(self._confident_verdict(self.uids(), attempt.snapshot_id), self.now)
        elif self.motions:
            mid = next(iter(self.motions))
            end = self.motions.pop(mid)
            self.answered.append(mid)
            self.feed(ServoArrived(motion_id=mid), max(self.now, end))
        else:
            t = self.cfg.tick_s
            gap = self.data.draw(st.one_of(st.just(t), _floats(0.0, 10 * t)), label="tick gap")
            self.feed(Tick(), self.now + gap)

    def _confident_verdict(self, ref_id: str, snapshot_id: str) -> JudgementResult:
        face = self.data.draw(
            st.sampled_from((FaceBox(left=0.4, top=0.4, width=0.2, height=0.2), None)),
            label="face",
        )
        return JudgementResult(
            ref_id=ref_id,
            snapshot_id=snapshot_id,
            verdict=self.data.draw(st.sampled_from(self.verdicts), label="verdict"),
            confidence=1.0,  # at or above every threshold, which lies in (0, 1]
            face=face,
        )

    def _draw_command(self) -> Event:
        command = super()._draw_command()
        enc = self.ms.encounter
        if not isinstance(command, JudgementResult) or enc is None or enc.attempt is None:
            return command
        if not self.data.draw(st.booleans(), label="confident verdict"):
            return command
        return self._confident_verdict(command.ref_id, enc.attempt.snapshot_id)


def run_trace(data: st.DataObject, cfg: Config, lines: tuple[VoiceLine, ...]) -> _RejectionDriver:
    """Drive one reactive trace that starts an Encounter; return the driver with its records."""
    driver = _RejectionDriver(data, cfg, lines, tick_gap_max=None)
    driver.verdicts = data.draw(
        st.sampled_from(
            ((Verdict.FAMILY, Verdict.STRANGER), (Verdict.STRANGER,), (Verdict.FAMILY,))
        ),
        label="verdict mix",
    )
    # Mostly connected, so that Verdicts arrive; the offline path is still drawn.
    if data.draw(st.sampled_from((True, True, True, False)), label="connected at start"):
        driver.feed(CloudConnected(), START_TIME)
    driver.feed(Tick(), START_TIME + cfg.timing.pir_warmup_s)
    driver.feed(PirRising(), driver.now)
    for _ in range(data.draw(st.integers(BUDGET_MIN, BUDGET), label="drawn events")):
        driver.draw_one()
    return driver


@st.composite
def manifests(
    draw: st.DrawFn,
) -> tuple[tuple[VoiceLine, ...], tuple[str, ...]]:
    """Available_Lines and the ids of manifest lines that were removed (not available)."""
    drawn = draw(line_sets())
    removed = draw(st.lists(st.booleans(), min_size=len(drawn), max_size=len(drawn)))
    available = tuple(line for line, gone in zip(drawn, removed, strict=True) if not gone)
    removed_ids = tuple(line.id for line, gone in zip(drawn, removed, strict=True) if gone)
    return available, removed_ids


# --------------------------------------------------------------------------------------------
# Oracle facts from the trace (R12.6, R12.11) and the oracle itself (R12.12)
# --------------------------------------------------------------------------------------------


class Point(NamedTuple):
    """A reachable Machine_State with the trace facts the oracle needs."""

    ms: MachineState
    now: float
    busy_until: tuple[float, ...]  # windows of earlier PlayLine / PlayAudioUrl without a result
    stare: bool  # in warning and the stranger Reaction PlayLine has not been emitted
    play_ids: frozenset[str]  # every Play_Id emitted so far
    motion_ids: frozenset[str]  # every Motion_Id emitted so far


def points(records: list[Record], cfg: Config) -> list[Point]:
    """The state after each record, with the facts derived from the records up to it."""
    timing = cfg.timing
    pending: dict[str, float] = {}
    play_ids: set[str] = set()
    motion_ids: set[str] = set()
    stare = False
    out: list[Point] = []
    for rec in records:
        if isinstance(rec.event, AudioFinished | AudioFailed):
            pending.pop(rec.event.play_id, None)
        played = False
        for action in rec.actions:
            match action:
                case PlayLine(play_id=pid):
                    pending[pid] = rec.now + timing.audio_timeout_s
                    play_ids.add(pid)
                    played = True
                case PlayAudioUrl(play_id=pid):
                    pending[pid] = rec.now + timing.download_timeout_s + timing.audio_timeout_s
                    play_ids.add(pid)
                case GazeTarget(motion_id=mid):
                    motion_ids.add(mid)
                case _:
                    pass
        if rec.after.state is State.WARNING:
            if rec.before.state is not State.WARNING:
                stare = True
            if played:
                stare = False
        else:
            stare = False
        out.append(
            Point(
                ms=rec.after,
                now=rec.now,
                busy_until=tuple(pending.values()),
                stare=stare,
                play_ids=frozenset(play_ids),
                motion_ids=frozenset(motion_ids),
            )
        )
    return out


def situation_of(ms: MachineState) -> Category:
    """Glossary: family or stranger by the Accepted_Verdict, uncertain in every other case."""
    accepted = ms.encounter.accepted if ms.encounter is not None else None
    if accepted is AcceptedVerdict.FAMILY:
        return Category.FAMILY
    if accepted is AcceptedVerdict.STRANGER:
        return Category.STRANGER
    return Category.UNCERTAIN


def line_permitted(category: Category, situation: Category) -> bool:
    """R13.4: not permitted when the situation is stranger or uncertain and the Category
    differs, or when the situation is family and the Category is stranger."""
    if situation in (Category.STRANGER, Category.UNCERTAIN):
        return category is situation
    return category is not Category.STRANGER


def expected_code(
    cmd: Speak | Gaze | Lantern,
    point: Point,
    now: float,
    categories: dict[str, Category],
) -> ErrorCode | None:
    """The first applicable code in the R12.12 order, or None when the command is accepted."""
    if not isinstance(cmd, Speak):
        # R12.3: gaze and lantern are refused only while resting.
        return ErrorCode.COMMAND_REJECTED_STATE if point.ms.state in RESTING else None
    situation = situation_of(point.ms)
    if cmd.line_id is not None:
        if cmd.line_id not in categories:
            return ErrorCode.UNKNOWN_LINE  # R12.5
        if not line_permitted(categories[cmd.line_id], situation):
            return ErrorCode.SPEAK_REJECTED  # R13.4
    elif situation is not Category.FAMILY:
        return ErrorCode.SPEAK_REJECTED  # R13.3
    if point.stare:
        return ErrorCode.COMMAND_REJECTED_STATE  # R12.11
    if any(now < until for until in point.busy_until):
        return ErrorCode.AUDIO_BUSY  # R12.6
    return None


# --------------------------------------------------------------------------------------------
# Probes
# --------------------------------------------------------------------------------------------


def draw_point(data: st.DataObject, pts: list[Point]) -> tuple[str, Point]:
    """A probe point, biased toward the stare, unfinished audio and the resting States."""
    groups = {
        "stare": [p for p in pts if p.stare],
        "busy": [p for p in pts if any(p.now < u for u in p.busy_until)],
        "resting": [p for p in pts if p.ms.state in RESTING],
        "any": pts,
    }
    # The stare is the rarest group, so it is listed twice when present.
    names = [name for name, members in groups.items() if members]
    if groups["stare"]:
        names.append("stare")
    group = data.draw(st.sampled_from(names), label="point group")
    return group, data.draw(st.sampled_from(groups[group]), label="point")


def draw_now(data: st.DataObject, point: Point, cfg: Config) -> float:
    """`now` of the probe: the point's own time, an exact busy-window end, or later."""
    timing = cfg.timing
    span = timing.download_timeout_s + timing.audio_timeout_s
    ends = [u for u in point.busy_until if u >= point.now]
    options = [st.just(point.now), _floats(0.0, span).map(lambda d: point.now + d)]
    if ends:
        options.append(st.sampled_from(ends))
    return data.draw(st.one_of(*options), label="probe now")


def draw_command(
    data: st.DataObject,
    ref_id: str,
    available: tuple[VoiceLine, ...],
    removed_ids: tuple[str, ...],
    point: Point,
) -> Speak | Gaze | Lantern:
    """One `speak`, `gaze` or `lantern` command as the inbound pipeline delivers it.

    During the silent stare a `speak` with a line of the situation's Category is drawn more
    often: it is the only command that reaches the R12.11 check there.
    """
    kinds = ["speak_line", "speak_url", "gaze", "lantern"]
    if point.stare:
        kinds += ["speak_line"] * 4
    kind = data.draw(st.sampled_from(kinds), label="kind")
    if kind == "speak_line":
        sources = [st.just(UNKNOWN_LINE_ID), st.text(_RANDOM_ID_CHARS, min_size=1, max_size=6)]
        if removed_ids:
            sources.insert(0, st.sampled_from(removed_ids))
        if available:
            sources.insert(0, st.sampled_from([line.id for line in available]))
        situation = situation_of(point.ms)
        own = [line.id for line in available if line.category is situation]
        if own:
            # During the stare this source is drawn most of the time.
            sources[:0] = [st.sampled_from(own)] * (4 if point.stare else 1)
        line_id = data.draw(st.one_of(*sources), label="lineId")
        return Speak(ref_id=ref_id, line_id=line_id, audio_url=None)
    if kind == "speak_url":
        url = data.draw(st.sampled_from(AUDIO_URLS), label="audioUrl")
        return Speak(ref_id=ref_id, line_id=None, audio_url=url)
    if kind == "gaze":
        return Gaze(
            ref_id=ref_id,
            pan_deg=data.draw(_any_finite(), label="pan"),
            tilt_deg=data.draw(_any_finite(), label="tilt"),
        )
    return Lantern(
        ref_id=ref_id,
        level=data.draw(st.one_of(_floats(0.0, 1.0), _any_finite()), label="level"),
        fade_ms=data.draw(
            st.one_of(
                st.sampled_from((0, LANTERN_FADE_MS_MAX)),
                st.integers(0, LANTERN_FADE_MS_MAX),
                st.integers(-(10**9), 10**9),
            ),
            label="fadeMs",
        ),
    )


def _clamp(value: float, lo: float, hi: float) -> float:
    return min(max(value, lo), hi)


# --------------------------------------------------------------------------------------------
# Checks
# --------------------------------------------------------------------------------------------


def check_rejected(
    before: MachineState,
    after: MachineState,
    actions: tuple[Action, ...],
    cmd: Speak | Gaze | Lantern,
    code: ErrorCode,
) -> None:
    """R12.12: the argument state and exactly one error.reported(code, refId = command id)."""
    assert after == before, f"{code}: the rejection changed the Machine_State"
    assert len(actions) == 1, f"{code}: expected one Action, got {actions!r}"
    (action,) = actions
    assert isinstance(action, PublishEvent) and isinstance(action.data, ErrorReported), (
        f"{code}: expected error.reported, got {action!r}"
    )
    assert action.data.code is code, f"expected {code}, got {action.data.code}"
    assert action.data.ref_id == cmd.ref_id, "refId must be the command id"


def check_accepted(
    point: Point,
    after: MachineState,
    actions: tuple[Action, ...],
    cmd: Speak | Gaze | Lantern,
    cfg: Config,
) -> None:
    """The single accepted Action; State, Mode, Encounter and deadlines unchanged."""
    before = point.ms
    relevant = [a for a in actions if not isinstance(a, PublishStatus)]
    assert len(relevant) == 1, f"accepted {type(cmd).__name__}: got {actions!r}"
    (action,) = relevant
    match cmd:
        case Speak(line_id=str() as line_id):
            assert isinstance(action, PlayLine) and action.line_id == line_id, repr(action)
            assert action.play_id not in point.play_ids, "the Play_Id must be new"
        case Speak(audio_url=url):
            assert situation_of(before) is Category.FAMILY  # R13.2, R13.3
            assert isinstance(action, PlayAudioUrl) and action.url == url, repr(action)
            assert action.play_id not in point.play_ids, "the Play_Id must be new"
        case Gaze(pan_deg=pan, tilt_deg=tilt):
            servo = cfg.servo
            assert isinstance(action, GazeTarget), repr(action)
            assert action.pan_deg == _clamp(pan, -servo.pan_limit, servo.pan_limit)
            assert action.tilt_deg == _clamp(tilt, -servo.tilt_down, servo.tilt_up)
            assert action.motion_id not in point.motion_ids, "the Motion_Id must be new"
        case Lantern(level=level, fade_ms=fade_ms):
            expected = LanternFade(
                level=_clamp(level, 0.0, 1.0), fade_ms=_clamp(fade_ms, 0, LANTERN_FADE_MS_MAX)
            )
            assert action == expected, f"{action!r} != {expected!r}"
    # Deadlines live in the phase record, the Encounter's snapshot attempt and the camera watch.
    assert after.state is before.state
    assert after.phase == before.phase, "the State or a deadline changed"
    assert after.encounter == before.encounter, "the Encounter changed"
    assert after.camera == before.camera, "the camera deadline changed"
    assert after.mode is before.mode, "the Mode changed"


# --------------------------------------------------------------------------------------------
# The Property 20 test function
# --------------------------------------------------------------------------------------------


# Feature: device-core-loop, Property 20: Command rejection is exact and atomic
@pytest.mark.timeout(300)
@settings(deadline=None)
@given(data=st.data(), cfg=valid_configs(), manifest=manifests())
def test_command_rejection_is_exact_and_atomic(
    data: st.DataObject,
    cfg: Config,
    manifest: tuple[tuple[VoiceLine, ...], tuple[str, ...]],
) -> None:
    """Property 20.

    **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.11, 12.12, 13.2, 13.3, 13.4**
    """
    available, removed_ids = manifest
    categories = {line.id: line.category for line in available}
    driver = run_trace(data, cfg, available)
    pts = points(driver.records, cfg)
    assert pts, "the trace always has the warm-up Tick and the pir.rising"
    for _ in range(PROBES_PER_EXAMPLE):
        group, point = draw_point(data, pts)
        now = draw_now(data, point, cfg)
        ref_id = driver.uids()
        cmd = draw_command(data, ref_id, available, removed_ids, point)
        stamped = dataclasses.replace(cmd, rand=data.draw(rands()), uid=driver.uids())
        code = expected_code(stamped, point, now, categories)
        kind = type(cmd).__name__
        if isinstance(cmd, Speak):
            kind += "(lineId)" if cmd.line_id is not None else "(audioUrl)"
        event(f"{kind}: {code or 'accepted'}")
        event(f"point group: {group}")
        after, actions = step(point.ms, stamped, now)
        if code is not None:
            check_rejected(point.ms, after, actions, stamped, code)
        else:
            check_accepted(point, after, actions, stamped, cfg)
