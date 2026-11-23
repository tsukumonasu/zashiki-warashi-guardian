"""Unit tests for the pure State_Machine in warashi_agent.state_machine.

The file grows flow by flow with the spec's tasks 9 to 17. Each flow gets its own section
below, marked with a banner comment, and the shared helpers live in the "Helpers" section at the
top. Flow tests compare Actions with ``without_status(actions)``, so the trailing
``PublishStatus`` that task 17.1 adds to ``finalize()`` does not break them; the status rule has
its own tests in the "Status reports" section.

Sections:

- Helpers
- Skeleton: initial state, purity, unhandled Events, identifiers, StepContext (task 8.2)
- Waking and seeking: Encounter start, leaving waking, snapshot attempts (task 9.2)
- Verdict and gazing: thresholds, ignored Verdicts, head tracking, leaving gazing (task 10.2)
- Scanning: scan positions, the next snapshot, ignored Verdicts, giving up (task 11.2)
- Reactions: entry Actions, the nod, the stare, missing lines, ending the line (task 12.2)
- Cooldown: the glide to center, the release, sleeping and the R8.4 backstop (task 13.2)
- Offline behaviour: the Offline_Reactions, their reasons and the offline bounds (task 14.2)
- PIR debounce: bursts, edges outside sleeping, warm-up and Mode, the end of cooldown (task 15.2)
- Manual commands: rejections, the stare, audio_busy, audioUrl, mode.set, manual gaze (task 16.2)
- Status reports: triggers, one per call, the data, the camera indicator (task 17.2)
"""

from __future__ import annotations

import ast
import base64
import dataclasses
import math
from collections.abc import Callable, Iterable
from pathlib import Path

import pytest

from warashi_agent import state_machine
from warashi_agent.config import Config, JudgementConfig, MotionConfig, ServoConfig
from warashi_agent.messages import (
    EncounterEnded,
    ErrorCode,
    ErrorReported,
    EventData,
    PresenceDetected,
    ReactionPerformed,
    SnapshotCaptured,
    StateChanged,
    StatusReport,
)
from warashi_agent.model import (
    AcceptedVerdict,
    Action,
    AdapterError,
    AudioFailed,
    AudioFinished,
    Category,
    CloudConnected,
    CloudDisconnected,
    EndReason,
    Event,
    FaceBox,
    Gaze,
    GazeTarget,
    JudgementResult,
    Lantern,
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
    ServoArrived,
    SnapshotFailed,
    SnapshotReady,
    Speak,
    State,
    TakeSnapshot,
    Tick,
    Verdict,
)
from warashi_agent.state_machine import (
    CameraWatch,
    Cooldown,
    Encounter,
    Gazing,
    Greeting,
    MachineState,
    PendingAudio,
    ReactionLine,
    ScanMove,
    Seeking,
    SnapshotAttempt,
    StepContext,
    Uncertain,
    Waking,
    WarningPhase,
    accept,
    initial_state,
    step,
)
from warashi_agent.voice import VoiceLine

# ============================================================================================
# Helpers (shared by every section of this file)
# ============================================================================================

CONFIG = Config()
START = 1000.0  # Start_Time of every hand-built state
NOW = START + 90.0  # past pir_warmup_s (60 s) with the default Config
AGENT_VERSION = "0.1.0"

# Distinct UUID v4 strings, as the Dispatcher would stamp them (R1.5).
UID_A = "00000000-0000-4000-8000-00000000000a"
UID_B = "00000000-0000-4000-8000-00000000000b"
ENCOUNTER_ID = "00000000-0000-4000-8000-0000000000e1"


def voice_line(line_id: str, category: Category) -> VoiceLine:
    """A valid Available_Line; the texts are placeholders that pass every R26 rule."""
    return VoiceLine(
        id=line_id, category=category, ja="……だれか、いるの？", en="...?", wav=f"{line_id}.wav"
    )


# One line per Category, deliberately not sorted by id.
LINES = (
    voice_line("uncertain", Category.UNCERTAIN),
    voice_line("greeting_family", Category.FAMILY),
    voice_line("warning_stranger", Category.STRANGER),
)


def base_state(**changes: object) -> MachineState:
    """The R1.7 initial state with the default Config, optionally changed."""
    ms = initial_state(config=CONFIG, lines=LINES, agent_version=AGENT_VERSION, start_time=START)
    return dataclasses.replace(ms, **changes) if changes else ms


def in_phase(
    phase: object, *, encounter: Encounter | None = None, **changes: object
) -> MachineState:
    """A state inside an Encounter, with the head attached and the lantern lit."""
    return base_state(
        phase=phase,
        encounter=encounter if encounter is not None else Encounter(encounter_id=ENCOUNTER_ID),
        servos_released=False,
        lantern_level=CONFIG.lantern.lantern_wake_level,
        **changes,
    )


def without_status(actions: Iterable[Action]) -> tuple[Action, ...]:
    """The Actions without ``PublishStatus``.

    Flow tests compare Actions through this helper, so the status rule of task 17.1 (one
    trailing ``PublishStatus`` on State changes, camera changes and Ticks) does not change
    their expected values.
    """
    return tuple(action for action in actions if not isinstance(action, PublishStatus))


def published(actions: Iterable[Action]) -> tuple[PublishEvent, ...]:
    """The ``PublishEvent`` Actions, in order."""
    return tuple(action for action in actions if isinstance(action, PublishEvent))


def test_without_status_drops_only_status_reports() -> None:
    status = PublishStatus(
        data=StatusReport(
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
    )
    snap = TakeSnapshot(snapshot_id="snap-1-x")
    release = ReleaseServos()
    assert without_status([snap, status, release]) == (snap, release)


# ============================================================================================
# Skeleton (task 8.2): initial state, purity, unhandled Events, identifiers, StepContext
# ============================================================================================

# --- Initial state (R1.7, R10.7) -------------------------------------------------------------


def test_initial_state_matches_r1_7() -> None:
    ms = initial_state(config=CONFIG, lines=LINES, agent_version=AGENT_VERSION, start_time=START)

    assert ms.state is State.SLEEPING
    assert ms.mode is Mode.GUARD
    assert ms.cloud_connected is False
    assert ms.lantern_level == 0.0
    assert ms.servos_released is True
    assert ms.pir_high is False
    assert ms.encounter is None
    assert ms.start_time == START
    # Nothing emitted yet: status reports 0, 0 and no camera, no audio (R23.4, R23.2).
    assert ms.gaze == (0.0, 0.0)
    assert ms.audio == ()
    assert ms.camera is None
    assert ms.first_tick_seen is False
    assert ms.last_status_at is None
    assert ms.config is CONFIG
    assert ms.agent_version == AGENT_VERSION


def test_initial_state_sorts_lines_by_id_in_code_point_order() -> None:
    # '0'-'9' < '_' < 'a'-'z' in code points, so "a1" < "a_1" < "b" (R1.3).
    lines = (
        voice_line("b", Category.FAMILY),
        voice_line("a_1", Category.FAMILY),
        voice_line("a1", Category.FAMILY),
    )
    ms = initial_state(config=CONFIG, lines=lines, agent_version=AGENT_VERSION, start_time=START)
    assert [line.id for line in ms.lines] == ["a1", "a_1", "b"]


def test_initial_state_for_a_restart_keeps_mode_and_connectivity() -> None:
    # R10.7: the Dispatcher passes the failing state's Start_Time, Mode and connectivity.
    ms = initial_state(
        config=CONFIG,
        lines=LINES,
        agent_version=AGENT_VERSION,
        start_time=START,
        mode=Mode.SLEEP,
        cloud_connected=True,
    )
    assert ms.mode is Mode.SLEEP
    assert ms.cloud_connected is True
    assert ms.start_time == START
    # Everything else is the R1.7 initial state.
    assert ms.state is State.SLEEPING
    assert ms.encounter is None
    assert ms.pir_high is False
    assert ms.lantern_level == 0.0
    assert ms.servos_released is True


# --- Purity (R1.1) ---------------------------------------------------------------------------

# Modules that would give step() a clock, a random source, the file system or hardware.
FORBIDDEN_IMPORTS = frozenset(
    {
        "time",
        "random",
        "uuid",
        "os",
        "secrets",
        "warashi_agent.adapters",
        "warashi_agent.dispatcher",
        "warashi_agent.timebase",
    }
)


def _imported_modules(source: str) -> set[str]:
    """Every module named by an import statement anywhere in ``source``, including nested ones."""
    names: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            names.add(node.module)
            # "from warashi_agent import adapters" names the module through the alias.
            names.update(f"{node.module}.{alias.name}" for alias in node.names)
    return names


def _is_forbidden(module: str) -> bool:
    return any(module == bad or module.startswith(f"{bad}.") for bad in FORBIDDEN_IMPORTS)


def test_state_machine_imports_no_clock_random_os_or_adapter_module() -> None:
    source = Path(state_machine.__file__).read_text(encoding="utf-8")
    forbidden = sorted(name for name in _imported_modules(source) if _is_forbidden(name))
    assert forbidden == []


def test_import_check_detects_forbidden_imports() -> None:
    # Guards the check itself: each import form must be caught.
    source = (
        "import time\n"
        "import os.path\n"
        "from random import random\n"
        "from warashi_agent import adapters\n"
        "def f():\n"
        "    import uuid\n"
    )
    found = {name for name in _imported_modules(source) if _is_forbidden(name)}
    assert found == {
        "time",
        "os.path",
        "random",
        "random.random",
        "warashi_agent.adapters",
        "uuid",
    }


def test_handler_tables_are_read_only() -> None:
    # No handler can register or replace another one at run time (R1.1).
    with pytest.raises(TypeError):
        state_machine.STATE_HANDLERS[(State.SLEEPING, Tick)] = lambda ctx: ctx.ms  # type: ignore[index]
    with pytest.raises(TypeError):
        state_machine.GLOBAL_HANDLERS[Tick] = lambda ctx: ctx.ms  # type: ignore[index]


# --- Undefined inputs (R1.6) -----------------------------------------------------------------


@pytest.mark.parametrize(
    "not_an_event",
    [object(), "tick", GazeTarget(pan_deg=0.0, tilt_deg=0.0, motion_id="motion-1-x")],
    ids=["object", "string", "action"],
)
def test_step_rejects_values_that_are_not_events(not_an_event: object) -> None:
    with pytest.raises(TypeError):
        step(base_state(), not_an_event, NOW)  # type: ignore[arg-type]


# --- Events without a specified response (R1.9) ----------------------------------------------
#
# Each case is an Event for which requirements.md specifies no response in that State (the
# "—" cells of the design's transition table, and stale feedback of R5.8, R3.4 and R3.8).
# They stay unhandled when the flow tasks add handlers, so these tests stay valid.

ATTEMPT = SnapshotAttempt(
    snapshot_id="snap-1-current", pan_deg=0.0, tilt_deg=0.0, deadline=NOW + 8
)
SEEKING_STATE = in_phase(
    Seeking(), encounter=Encounter(encounter_id=ENCOUNTER_ID, attempt=ATTEMPT)
)
WAKING_STATE = in_phase(
    Waking(motion_id="motion-1-waking", fade_done_at=NOW + 1.5, deadline=NOW + 3)
)
GAZING_STATE = in_phase(Gazing(motion_id="motion-1-gazing", deadline=NOW + 3))
WARNING_STATE = in_phase(WarningPhase(stare_until=NOW + 2))
UNCERTAIN_STATE = in_phase(Uncertain(line=ReactionLine(play_id="play-1-line", deadline=NOW + 12)))
COOLDOWN_STATE = in_phase(
    Cooldown(motion_id="motion-1-cooldown", glide_deadline=NOW + 3, until=NOW + 20, manual=False)
)

STALE_ARRIVAL = ServoArrived(motion_id="motion-9-stale", uid=UID_A)
STALE_SNAPSHOT = SnapshotReady(
    snapshot_id="snap-9-stale", jpeg=b"\xff\xd8\xff\xd9", width=640, height=480, uid=UID_A
)
STALE_VERDICT = JudgementResult(
    ref_id="cmd-1",
    snapshot_id="snap-9-stale",
    verdict=Verdict.FAMILY,
    confidence=0.99,
    face=FaceBox(left=0.4, top=0.4, width=0.2, height=0.2),
    uid=UID_A,
)

UNHANDLED_CASES: list[tuple[str, MachineState, Event]] = [
    ("sleeping-servo-arrived", base_state(), STALE_ARRIVAL),
    ("sleeping-snapshot-ready", base_state(), STALE_SNAPSHOT),  # R3.8
    ("sleeping-judgement", base_state(), STALE_VERDICT),  # R3.4
    ("sleeping-pir-falling-already-low", base_state(), PirFalling(uid=UID_A)),  # R11.3
    ("sleeping-unknown-audio", base_state(), AudioFinished(play_id="play-9-x", uid=UID_A)),
    ("sleeping-disconnected-again", base_state(), CloudDisconnected(uid=UID_A)),  # R9.7
    ("waking-stale-arrival", WAKING_STATE, STALE_ARRIVAL),  # R5.8
    ("waking-judgement", WAKING_STATE, STALE_VERDICT),  # R3.4
    ("seeking-stale-arrival", SEEKING_STATE, STALE_ARRIVAL),  # R5.8, no scan move pending
    ("seeking-stale-snapshot", SEEKING_STATE, STALE_SNAPSHOT),  # R3.8
    ("seeking-wrong-snapshot-id", SEEKING_STATE, STALE_VERDICT),  # R3.4
    ("gazing-stale-arrival", GAZING_STATE, STALE_ARRIVAL),  # R5.8
    ("gazing-snapshot-ready", GAZING_STATE, STALE_SNAPSHOT),  # R3.8
    ("warning-servo-arrived", WARNING_STATE, STALE_ARRIVAL),
    ("warning-judgement", WARNING_STATE, STALE_VERDICT),  # R3.4
    ("uncertain-servo-arrived", UNCERTAIN_STATE, STALE_ARRIVAL),
    ("cooldown-stale-arrival", COOLDOWN_STATE, STALE_ARRIVAL),  # R5.8
    ("cooldown-judgement", COOLDOWN_STATE, STALE_VERDICT),  # R3.4
]


@pytest.mark.parametrize(
    ("ms", "event"),
    [(ms, event) for _, ms, event in UNHANDLED_CASES],
    ids=[name for name, _, _ in UNHANDLED_CASES],
)
def test_unhandled_event_returns_an_equal_state_and_no_actions(
    ms: MachineState, event: Event
) -> None:
    before = dataclasses.replace(ms)  # an equal copy, to detect mutation of the argument
    nxt, actions = step(ms, event, NOW)
    assert actions == ()
    assert nxt == ms
    assert ms == before


# --- Identifiers (R1.4) ----------------------------------------------------------------------


def _context(uid: str = UID_A, ms: MachineState | None = None) -> StepContext:
    return StepContext(ms if ms is not None else base_state(), Tick(uid=uid), NOW)


def test_new_id_format_is_kind_counter_uid() -> None:
    ctx = _context()
    assert ctx.new_id("snap") == f"snap-1-{UID_A}"
    assert ctx.new_id("motion") == f"motion-1-{UID_A}"
    assert ctx.new_id("play") == f"play-1-{UID_A}"


def test_ids_of_one_kind_in_one_call_are_distinct() -> None:
    ctx = _context()
    motions = [ctx.new_id("motion") for _ in range(4)]
    assert motions == [f"motion-{n}-{UID_A}" for n in range(1, 5)]
    assert len(set(motions)) == len(motions)
    # Counters are per kind: a motion id does not advance the play counter.
    assert ctx.new_id("play") == f"play-1-{UID_A}"


def test_ids_from_different_uids_differ() -> None:
    first, second = _context(UID_A), _context(UID_B)
    for kind in ("snap", "motion", "play"):
        assert first.new_id(kind) != second.new_id(kind)
    assert first.new_encounter_id() != second.new_encounter_id()


def test_encounter_id_is_the_event_uid() -> None:
    # Keeps encounterId a UUID on the wire, as docs/schema.md shows.
    ctx = _context()
    assert ctx.new_encounter_id() == UID_A
    encounter = ctx.begin_encounter()
    assert encounter == Encounter(encounter_id=UID_A)
    # Every later PublishEvent of the call carries the new id (R1.8).
    assert ctx.report_error(ErrorCode.VOICE_LINE_MISSING, "x").encounter_id == UID_A


def test_encounter_id_of_publish_events_follows_the_current_encounter() -> None:
    assert _context().report_error(ErrorCode.ADAPTER_FAILED, "x").encounter_id is None
    inside = _context(ms=GAZING_STATE)
    assert inside.report_error(ErrorCode.ADAPTER_FAILED, "x").encounter_id == ENCOUNTER_ID


# --- StepContext emit helpers (R1.8, R5.7, R12.2) --------------------------------------------


def test_gaze_to_clamps_to_the_calibrated_range_and_tracks_the_output() -> None:
    cfg = dataclasses.replace(CONFIG, servo=ServoConfig(pan_limit=30.0, tilt_limit=20.0))
    ctx = _context(ms=base_state(config=cfg))
    action = ctx.gaze_to(1e300, -45.0)
    assert action == GazeTarget(pan_deg=30.0, tilt_deg=-20.0, motion_id=f"motion-1-{UID_A}")
    assert ctx.actions == [action]
    assert ctx.gaze == (30.0, -20.0)
    assert ctx.servos_released is False


def test_release_servos_sets_the_released_flag() -> None:
    ctx = _context(ms=GAZING_STATE)
    assert ctx.release_servos() == ReleaseServos()
    assert ctx.servos_released is True


@pytest.mark.parametrize(
    ("level", "fade_ms", "expected"),
    [
        (0.5, 1500, LanternFade(level=0.5, fade_ms=1500)),
        (2.0, 20_000, LanternFade(level=1.0, fade_ms=10_000)),
        (-1.0, -5, LanternFade(level=0.0, fade_ms=0)),
    ],
)
def test_fade_lantern_clamps_level_and_fade(
    level: float, fade_ms: int, expected: LanternFade
) -> None:
    ctx = _context()
    assert ctx.fade_lantern(level, fade_ms) == expected
    assert ctx.lantern_level == expected.level


@pytest.mark.parametrize(
    "action",
    [
        GazeTarget(pan_deg=90.0, tilt_deg=0.0, motion_id="motion-1-x"),
        ReleaseServos(),
        LanternFade(level=1.0, fade_ms=0),
    ],
    ids=["gaze", "release", "lantern"],
)
def test_emit_refuses_actions_that_need_a_helper(action: Action) -> None:
    ctx = _context()
    with pytest.raises(TypeError):
        ctx.emit(action)
    assert ctx.actions == []


def test_change_state_announces_from_to_and_reason_with_the_encounter_id() -> None:
    ctx = _context(ms=GAZING_STATE)
    first = ctx.change_state(State.WARNING, Reason.TIMEOUT)
    second = ctx.change_state(State.COOLDOWN, Reason.ERROR)
    assert first == PublishEvent(
        data=StateChanged(from_=State.GAZING, to=State.WARNING, reason=Reason.TIMEOUT),
        encounter_id=ENCOUNTER_ID,
    )
    # A chained change reports the State of the previous change as "from".
    assert second.data == StateChanged(from_=State.WARNING, to=State.COOLDOWN, reason=Reason.ERROR)
    assert published(ctx.actions) == (first, second)


def test_change_state_to_the_same_state_is_an_error() -> None:
    ctx = _context()
    with pytest.raises(ValueError):
        ctx.change_state(State.SLEEPING, Reason.ERROR)
    assert ctx.actions == []


def test_report_error_carries_code_message_and_ref_id() -> None:
    action = _context().report_error(ErrorCode.UNKNOWN_LINE, "unknown line", ref_id="cmd-7")
    assert action.data == ErrorReported(
        code=ErrorCode.UNKNOWN_LINE, message="unknown line", ref_id="cmd-7"
    )


def test_commit_returns_the_handler_state_itself_when_no_output_changed() -> None:
    ms = base_state()
    ctx = _context(ms=ms)
    ctx.report_error(ErrorCode.ADAPTER_FAILED, "x")  # publishing changes no tracked output
    assert ctx.commit(ms) is ms


def test_commit_copies_the_tracked_outputs_into_the_returned_state() -> None:
    ms = base_state()
    ctx = _context(ms=ms)
    ctx.gaze_to(5.0, -3.0)
    ctx.fade_lantern(0.8, 1500)
    nxt = ctx.commit(ms)
    assert (nxt.gaze, nxt.lantern_level, nxt.servos_released) == ((5.0, -3.0), 0.8, False)
    # Only the three tracked outputs differ from the handler's state.
    assert dataclasses.replace(nxt, gaze=ms.gaze, lantern_level=0.0, servos_released=True) == ms


# ============================================================================================
# Waking and seeking (task 9.2): Encounter start, leaving waking, snapshot attempts
# ============================================================================================
#
# Every test that leaves waking has the cloud connected. The disconnected branch (R2.6) and
# the seeking-side Offline_Reactions (R3.5 to R3.7) are tested in the "Offline behaviour"
# section (task 14.2).
# Assertions compare the phase, the Encounter and the tracked outputs instead of whole states
# where a Tick or a TakeSnapshot is involved, because task 17.1 adds status and camera
# bookkeeping to those calls.

WAKE_AT = NOW  # now of the pir.rising that starts the Encounter in woken()
FADE_DONE = WAKE_AT + CONFIG.lantern.lantern_fade_in_ms / 1000  # 1.5 s after entry
WAKING_DEADLINE = WAKE_AT + CONFIG.timing.waking_timeout_s  # 3 s after entry
JPEG = b"\xff\xd8\xff\xe0 not a real picture \x00\x01\xfe\xff\xd9"


def woken(*, connected: bool = True) -> tuple[MachineState, Waking]:
    """Enter waking through a real ``pir.rising`` at WAKE_AT and return the state and phase."""
    ms, _ = step(base_state(cloud_connected=connected), PirRising(uid=UID_A), WAKE_AT)
    return ms, _as_waking(ms)


def _as_waking(ms: MachineState) -> Waking:
    assert isinstance(ms.phase, Waking)
    return ms.phase


def entered_seeking(reason: Reason, snapshot_uid: str, encounter_id: str) -> tuple[Action, ...]:
    """The exact Actions of waking -> seeking: the announcement, then the first snapshot."""
    return (
        PublishEvent(
            data=StateChanged(from_=State.WAKING, to=State.SEEKING, reason=reason),
            encounter_id=encounter_id,
        ),
        TakeSnapshot(snapshot_id=f"snap-1-{snapshot_uid}"),
    )


def seeking_with(attempt: SnapshotAttempt, **changes: object) -> MachineState:
    return in_phase(
        Seeking(), encounter=Encounter(encounter_id=ENCOUNTER_ID, attempt=attempt), **changes
    )


# --- sleeping -> waking (R2.1, R2.2) ---------------------------------------------------------


def test_pir_rising_after_warmup_enters_waking_with_exact_actions_in_order() -> None:
    ms = base_state()
    nxt, actions = step(ms, PirRising(uid=UID_A), WAKE_AT)

    # The Encounter id is the Event uid, and every event of the call already carries it.
    assert without_status(actions) == (
        PublishEvent(
            data=StateChanged(from_=State.SLEEPING, to=State.WAKING, reason=Reason.PRESENCE),
            encounter_id=UID_A,
        ),
        PublishEvent(data=PresenceDetected(source="pir"), encounter_id=UID_A),
        LanternFade(level=CONFIG.lantern.lantern_wake_level, fade_ms=1500),
        GazeTarget(pan_deg=0.0, tilt_deg=0.0, motion_id=f"motion-1-{UID_A}"),
    )
    assert nxt.phase == Waking(
        motion_id=f"motion-1-{UID_A}", fade_done_at=FADE_DONE, deadline=WAKING_DEADLINE
    )
    assert nxt.encounter == Encounter(encounter_id=UID_A)
    assert nxt.pir_high is True
    assert (nxt.gaze, nxt.lantern_level, nxt.servos_released) == (
        (0.0, 0.0),
        CONFIG.lantern.lantern_wake_level,
        False,
    )


@pytest.mark.parametrize(
    ("now", "starts"),
    [
        (START + CONFIG.timing.pir_warmup_s, True),  # exactly pir_warmup_s: warm
        (START + CONFIG.timing.pir_warmup_s - 0.001, False),  # just before: still warming up
    ],
    ids=["at-warmup", "before-warmup"],
)
def test_warmup_boundary(now: float, starts: bool) -> None:
    nxt, actions = step(base_state(), PirRising(uid=UID_A), now)
    assert nxt.pir_high is True  # the level is recorded either way (R11.3)
    if starts:
        assert nxt.state is State.WAKING
        assert nxt.encounter == Encounter(encounter_id=UID_A)
    else:
        assert without_status(actions) == ()
        assert nxt.state is State.SLEEPING
        assert nxt.encounter is None
        assert (nxt.lantern_level, nxt.servos_released) == (0.0, True)


def test_mode_sleep_from_initial_state_ignores_presence() -> None:
    # A restart can hand Mode sleep to initial_state (R10.7); presence is then ignored (R2.1).
    ms = initial_state(
        config=CONFIG, lines=LINES, agent_version=AGENT_VERSION, start_time=START, mode=Mode.SLEEP
    )
    nxt, actions = step(ms, PirRising(uid=UID_A), NOW)
    assert without_status(actions) == ()
    assert nxt == dataclasses.replace(ms, pir_high=True)


# --- Leaving waking (R2.3, R2.4, R2.5) -------------------------------------------------------


def test_servo_arrived_before_the_fade_waits_then_the_first_tick_after_the_fade_leaves() -> None:
    ms, phase = woken()
    arrival = ServoArrived(motion_id=phase.motion_id, uid=UID_B)

    early, actions = step(ms, arrival, FADE_DONE - 0.5)
    assert without_status(actions) == ()
    assert early.phase == dataclasses.replace(phase, arrived=True)
    assert early.encounter == ms.encounter

    # A Tick still inside the fade keeps waiting.
    still, actions = step(early, Tick(uid=UID_B), FADE_DONE - 0.01)
    assert without_status(actions) == ()
    assert still.phase == early.phase

    # The first Tick at the end of the fade leaves waking, with reason arrived.
    nxt, actions = step(still, Tick(uid=UID_B), FADE_DONE)
    assert without_status(actions) == entered_seeking(Reason.ARRIVED, UID_B, UID_A)
    assert nxt.phase == Seeking()


def test_servo_arrived_at_the_end_of_the_fade_leaves_waking_in_that_call() -> None:
    ms, phase = woken()
    nxt, actions = step(ms, ServoArrived(motion_id=phase.motion_id, uid=UID_B), FADE_DONE)

    assert without_status(actions) == entered_seeking(Reason.ARRIVED, UID_B, UID_A)
    assert nxt.phase == Seeking()
    # The first snapshot attempt starts in the same call (R2.5, R3.1).
    assert nxt.encounter == Encounter(
        encounter_id=UID_A,
        attempt=SnapshotAttempt(
            snapshot_id=f"snap-1-{UID_B}",
            pan_deg=0.0,
            tilt_deg=0.0,
            deadline=FADE_DONE + CONFIG.timing.verdict_timeout_s,
        ),
    )


def test_stale_servo_arrived_after_the_fade_does_not_leave_waking() -> None:
    ms, _ = woken()
    nxt, actions = step(ms, ServoArrived(motion_id="motion-9-stale", uid=UID_B), FADE_DONE + 0.1)
    assert actions == ()
    assert nxt == ms


def test_ticks_after_the_fade_without_an_arrival_wait_for_the_waking_deadline() -> None:
    ms, phase = woken()
    waiting, actions = step(ms, Tick(uid=UID_B), WAKING_DEADLINE - 0.01)
    assert without_status(actions) == ()
    assert waiting.phase == phase

    nxt, actions = step(waiting, Tick(uid=UID_B), WAKING_DEADLINE)
    assert without_status(actions) == entered_seeking(Reason.TIMEOUT, UID_B, UID_A)
    assert nxt.phase == Seeking()
    assert nxt.encounter is not None and nxt.encounter.attempt is not None
    assert nxt.encounter.attempt.deadline == WAKING_DEADLINE + CONFIG.timing.verdict_timeout_s


def test_a_late_tick_that_sees_the_arrival_and_the_deadline_reports_arrived() -> None:
    # The first matching row of the R24.4 table is the arrival row.
    ms, phase = woken()
    arrived, _ = step(ms, ServoArrived(motion_id=phase.motion_id, uid=UID_B), FADE_DONE - 0.5)
    _, actions = step(arrived, Tick(uid=UID_B), WAKING_DEADLINE + 1.0)
    assert without_status(actions) == entered_seeking(Reason.ARRIVED, UID_B, UID_A)


def test_snapshot_angles_are_the_last_emitted_gaze_target() -> None:
    # R3.1: the attempt records the Gaze_Target as last emitted, not a fixed center.
    phase = Waking(motion_id="motion-1-waking", fade_done_at=NOW + 1.5, deadline=NOW + 3)
    ms = in_phase(phase, gaze=(5.0, -3.0), cloud_connected=True)
    nxt, _ = step(ms, Tick(uid=UID_B), NOW + 3)
    assert nxt.encounter is not None
    assert nxt.encounter.attempt == SnapshotAttempt(
        snapshot_id=f"snap-1-{UID_B}",
        pan_deg=5.0,
        tilt_deg=-3.0,
        deadline=NOW + 3 + CONFIG.timing.verdict_timeout_s,
    )


# --- snapshot.captured (R3.2) ----------------------------------------------------------------


def test_snapshot_ready_for_the_current_snapshot_publishes_base64_size_and_angles() -> None:
    attempt = SnapshotAttempt(
        snapshot_id="snap-1-current", pan_deg=12.5, tilt_deg=-4.0, deadline=NOW + 8
    )
    ms = seeking_with(attempt)
    ready = SnapshotReady(
        snapshot_id="snap-1-current", jpeg=JPEG, width=320, height=240, uid=UID_A
    )

    nxt, actions = step(ms, ready, NOW + 1)

    assert without_status(actions) == (
        PublishEvent(
            data=SnapshotCaptured(
                snapshot_id="snap-1-current",
                width=320,
                height=240,
                pan_deg=12.5,
                tilt_deg=-4.0,
                jpeg_base64=base64.b64encode(JPEG).decode("ascii"),
            ),
            encounter_id=ENCOUNTER_ID,
        ),
    )
    captured = published(actions)[0].data
    assert isinstance(captured, SnapshotCaptured)
    assert base64.b64decode(captured.jpeg_base64, validate=True) == JPEG
    # The State, the deadline and the Encounter stay as they are while the cloud works.
    assert (nxt.phase, nxt.encounter) == (ms.phase, ms.encounter)


def test_snapshot_from_waking_is_captured_with_the_waking_angles() -> None:
    ms, phase = woken()
    seeking, actions = step(ms, ServoArrived(motion_id=phase.motion_id, uid=UID_B), FADE_DONE)
    snap = without_status(actions)[-1]
    assert isinstance(snap, TakeSnapshot)

    ready = SnapshotReady(
        snapshot_id=snap.snapshot_id, jpeg=JPEG, width=640, height=480, uid=UID_A
    )
    _, actions = step(seeking, ready, FADE_DONE + 0.6)
    (event,) = published(actions)
    assert event.data == SnapshotCaptured(
        snapshot_id=snap.snapshot_id,
        width=640,
        height=480,
        pan_deg=0.0,
        tilt_deg=0.0,
        jpeg_base64=base64.b64encode(JPEG).decode("ascii"),
    )
    assert event.encounter_id == UID_A


# --- Stale snapshot results (R3.8, R3.9) -----------------------------------------------------

CURRENT = SnapshotAttempt(
    snapshot_id="snap-1-current", pan_deg=0.0, tilt_deg=0.0, deadline=NOW + 8
)
CURRENT_ENCOUNTER = Encounter(encounter_id=ENCOUNTER_ID, attempt=CURRENT)

# States where a result for snap-1-current or for another id is stale. The gazing and uncertain
# states still hold the attempt in their Encounter: the id matches, but the State is not
# seeking, so the result is stale all the same.
STALE_RESULT_CASES: list[tuple[str, MachineState, str]] = [
    ("seeking-other-id", seeking_with(CURRENT), "snap-9-stale"),
    ("sleeping", base_state(), "snap-1-current"),
    (
        "gazing-same-id",
        in_phase(GAZING_STATE.phase, encounter=CURRENT_ENCOUNTER),
        "snap-1-current",
    ),
    (
        "uncertain-same-id",
        in_phase(UNCERTAIN_STATE.phase, encounter=CURRENT_ENCOUNTER),
        "snap-1-current",
    ),
]


@pytest.mark.parametrize(
    ("ms", "snapshot_id"),
    [(ms, sid) for _, ms, sid in STALE_RESULT_CASES],
    ids=[name for name, _, _ in STALE_RESULT_CASES],
)
def test_stale_snapshot_ready_publishes_nothing_and_changes_nothing(
    ms: MachineState, snapshot_id: str
) -> None:
    ready = SnapshotReady(snapshot_id=snapshot_id, jpeg=JPEG, width=640, height=480, uid=UID_A)
    nxt, actions = step(ms, ready, NOW + 1)
    assert actions == ()
    assert nxt == ms


@pytest.mark.parametrize("code", ["camera_failed", "snapshot_too_large"])
@pytest.mark.parametrize(
    ("ms", "snapshot_id"),
    [(ms, sid) for _, ms, sid in STALE_RESULT_CASES],
    ids=[name for name, _, _ in STALE_RESULT_CASES],
)
def test_stale_snapshot_failed_publishes_only_error_reported_with_its_code(
    ms: MachineState, snapshot_id: str, code: str
) -> None:
    failed = SnapshotFailed(snapshot_id=snapshot_id, code=code, uid=UID_A)  # type: ignore[arg-type]
    nxt, actions = step(ms, failed, NOW + 1)

    (only,) = without_status(actions)
    assert isinstance(only, PublishEvent)
    assert isinstance(only.data, ErrorReported)
    assert only.data.code == ErrorCode(code)
    assert only.data.ref_id is None  # no incoming message caused it (docs/schema.md)
    assert only.data.message  # a fixed, non-empty text
    expected_encounter_id = ms.encounter.encounter_id if ms.encounter is not None else None
    assert only.encounter_id == expected_encounter_id
    assert (nxt.phase, nxt.encounter) == (ms.phase, ms.encounter)


# --- Connectivity (R2.7, R9.7) ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("connected", "event"),
    [(False, CloudConnected(uid=UID_B)), (True, CloudDisconnected(uid=UID_B))],
    ids=["connected", "disconnected"],
)
def test_connectivity_change_in_waking_is_recorded_and_nothing_else_changes(
    connected: bool, event: Event
) -> None:
    ms, _ = woken(connected=connected)
    nxt, actions = step(ms, event, FADE_DONE - 0.5)
    assert without_status(actions) == ()
    # A reconnect also sends a status.report (remote-mode M5), which moves last_status_at.
    nxt = dataclasses.replace(nxt, last_status_at=ms.last_status_at)
    assert nxt == dataclasses.replace(ms, cloud_connected=not connected)


def test_cloud_connected_in_seeking_is_recorded_and_nothing_else_changes() -> None:
    ms = seeking_with(CURRENT, cloud_connected=False)
    nxt, actions = step(ms, CloudConnected(uid=UID_B), NOW + 1)
    assert without_status(actions) == ()
    nxt = dataclasses.replace(nxt, last_status_at=ms.last_status_at)
    assert nxt == dataclasses.replace(ms, cloud_connected=True)


# ============================================================================================
# Verdict and gazing (task 10.2): thresholds, ignored Verdicts, head tracking, leaving gazing
# ============================================================================================
#
# The Reaction states (greeting, warning, uncertain) get their Actions in task 12.1, and
# no_face gets its scan moves in task 11.1. Tests here therefore check only what task 10.1
# fixes: the state.changed announcements of the call, the resulting State, the Accepted_Verdict
# and, for gazing, the exact head movement. They never pin the Reaction's phase fields or the
# absence of Reaction Actions.

SNAP_ID = "snap-1-current"
SNAP_PAN, SNAP_TILT = 5.0, -3.0  # the angles recorded with the snapshot (R3.1)
VERDICT_ATTEMPT = SnapshotAttempt(
    snapshot_id=SNAP_ID, pan_deg=SNAP_PAN, tilt_deg=SNAP_TILT, deadline=NOW + 8
)
# A face right of and above the image center. The fields are binary fractions, so the
# expected angles below are computed with the same float operations as R5.1 to R5.3.
FACE = FaceBox(left=0.625, top=0.125, width=0.25, height=0.25)  # center (0.75, 0.25)


def verdict(
    v: Verdict,
    confidence: float = 0.99,
    face: FaceBox | None = None,
    *,
    snapshot_id: str = SNAP_ID,
) -> JudgementResult:
    return JudgementResult(
        ref_id="cmd-1",
        snapshot_id=snapshot_id,
        verdict=v,
        confidence=confidence,
        face=face,
        uid=UID_B,
    )


def awaiting_verdict(**changes: object) -> MachineState:
    """seeking with the current snapshot attempt and no Verdict yet; the head looks elsewhere."""
    return seeking_with(VERDICT_ATTEMPT, gaze=(20.0, 10.0), cloud_connected=True, **changes)


def state_changes(actions: Iterable[Action]) -> tuple[StateChanged, ...]:
    """The ``state.changed`` data of the call, in order."""
    return tuple(
        event.data for event in published(actions) if isinstance(event.data, StateChanged)
    )


def gazing_after(v: Verdict, *, connected: bool = True) -> MachineState:
    """Enter gazing through a real Verdict with a face at NOW."""
    ms, _ = step(awaiting_verdict(), verdict(v, face=FACE), NOW)
    assert isinstance(ms.phase, Gazing)
    return dataclasses.replace(ms, cloud_connected=connected)


# --- Confidence thresholds (R4.1 to R4.5) ----------------------------------------------------

# Distinct thresholds, so each Verdict is shown to use its own one.
THRESHOLDS = JudgementConfig(family_confidence_min=0.9, stranger_confidence_min=0.6)


@pytest.mark.parametrize(
    ("v", "confidence", "expected"),
    [
        (Verdict.FAMILY, 0.9, AcceptedVerdict.FAMILY),  # exactly at the minimum (R4.1)
        (Verdict.FAMILY, math.nextafter(0.9, 0.0), AcceptedVerdict.UNCERTAIN),  # R4.3
        (Verdict.FAMILY, 0.7, AcceptedVerdict.UNCERTAIN),  # above the stranger minimum only
        (Verdict.STRANGER, 0.6, AcceptedVerdict.STRANGER),  # R4.2
        (Verdict.STRANGER, math.nextafter(0.6, 0.0), AcceptedVerdict.UNCERTAIN),  # R4.3
        (Verdict.UNCERTAIN, 1.0, AcceptedVerdict.UNCERTAIN),  # R4.4, whatever the confidence
        (Verdict.NO_FACE, 0.0, AcceptedVerdict.NO_FACE),  # R4.5, whatever the confidence
    ],
    ids=[
        "family-at",
        "family-just-below",
        "family-between",
        "stranger-at",
        "stranger-just-below",
        "uncertain",
        "no-face",
    ],
)
def test_accept_applies_the_inclusive_threshold_of_each_verdict(
    v: Verdict, confidence: float, expected: AcceptedVerdict
) -> None:
    assert accept(v, confidence, THRESHOLDS) is expected


@pytest.mark.parametrize(
    ("v", "confidence", "state", "accepted"),
    [
        (Verdict.FAMILY, 0.9, State.GREETING, AcceptedVerdict.FAMILY),
        (Verdict.FAMILY, math.nextafter(0.9, 0.0), State.UNCERTAIN, AcceptedVerdict.UNCERTAIN),
        (Verdict.STRANGER, 0.6, State.WARNING, AcceptedVerdict.STRANGER),
        (Verdict.STRANGER, math.nextafter(0.6, 0.0), State.UNCERTAIN, AcceptedVerdict.UNCERTAIN),
        (Verdict.UNCERTAIN, 0.99, State.UNCERTAIN, AcceptedVerdict.UNCERTAIN),
    ],
    ids=["family-at", "family-below", "stranger-at", "stranger-below", "uncertain"],
)
def test_threshold_boundaries_decide_the_next_state_with_reason_verdict(
    v: Verdict, confidence: float, state: State, accepted: AcceptedVerdict
) -> None:
    # face is null, so family and stranger enter the Reaction directly (R5.5); a demoted
    # Verdict and an uncertain one enter uncertain (R3.3, R4.3, R4.4).
    cfg = dataclasses.replace(CONFIG, judgement=THRESHOLDS)
    nxt, actions = step(awaiting_verdict(config=cfg), verdict(v, confidence), NOW + 1)

    assert state_changes(actions) == (
        StateChanged(from_=State.SEEKING, to=state, reason=Reason.VERDICT),
    )
    assert nxt.state is state
    assert nxt.encounter is not None
    assert nxt.encounter.accepted is accepted
    assert nxt.encounter.encounter_id == ENCOUNTER_ID
    assert nxt.encounter.attempt == dataclasses.replace(VERDICT_ATTEMPT, verdict_processed=True)


# --- Accepted_Verdict is final (R4.6) --------------------------------------------------------


@pytest.mark.parametrize(
    "kept", [AcceptedVerdict.FAMILY, AcceptedVerdict.STRANGER, AcceptedVerdict.UNCERTAIN]
)
@pytest.mark.parametrize("later", list(AcceptedVerdict))
def test_a_final_accepted_verdict_is_never_replaced(
    kept: AcceptedVerdict, later: AcceptedVerdict
) -> None:
    encounter = Encounter(encounter_id=ENCOUNTER_ID, accepted=kept)
    assert encounter.with_verdict(later) is encounter


@pytest.mark.parametrize("before", [None, AcceptedVerdict.NO_FACE])
@pytest.mark.parametrize("later", list(AcceptedVerdict))
def test_an_unset_or_no_face_accepted_verdict_takes_the_new_value(
    before: AcceptedVerdict | None, later: AcceptedVerdict
) -> None:
    encounter = Encounter(encounter_id=ENCOUNTER_ID, accepted=before)
    assert encounter.with_verdict(later) == dataclasses.replace(encounter, accepted=later)


# --- Late Verdicts (R3.3, R10.3) -------------------------------------------------------------


@pytest.mark.parametrize(
    "at", [VERDICT_ATTEMPT.deadline, VERDICT_ATTEMPT.deadline + 0.5], ids=["at", "after"]
)
def test_a_verdict_after_the_attempt_deadline_before_the_observing_tick_is_processed(
    at: float,
) -> None:
    # No Tick has observed the deadline yet, so the attempt still waits for its Verdict.
    nxt, actions = step(awaiting_verdict(), verdict(Verdict.FAMILY, face=FACE), at)

    assert state_changes(actions) == (
        StateChanged(from_=State.SEEKING, to=State.GAZING, reason=Reason.VERDICT),
    )
    assert nxt.phase == Gazing(
        motion_id=f"motion-1-{UID_B}", deadline=at + CONFIG.timing.glide_timeout_s
    )


# --- Ignored Verdicts (R3.4, R6.6) -----------------------------------------------------------

PROCESSED = dataclasses.replace(VERDICT_ATTEMPT, verdict_processed=True)
WITH_ATTEMPT = Encounter(encounter_id=ENCOUNTER_ID, attempt=VERDICT_ATTEMPT)
GREETING_PHASE = Greeting(
    pan=0.0,
    tilt=0.0,
    nod_motion_id="motion-1-nod",
    nod_deadline=NOW + 3,
    line=ReactionLine(play_id="play-1-line", deadline=NOW + 12),
)

# Each state holds the attempt for SNAP_ID in its Encounter where it can, so only the named
# rule makes the Verdict stale.
IGNORED_VERDICT_CASES: list[tuple[str, MachineState, JudgementResult]] = [
    ("seeking-wrong-snapshot-id", awaiting_verdict(), verdict(Verdict.FAMILY, snapshot_id="x")),
    ("seeking-already-processed", seeking_with(PROCESSED), verdict(Verdict.STRANGER)),
    (
        "seeking-scan-move-pending",  # R6.6
        in_phase(
            Seeking(scan=ScanMove(motion_id="motion-1-scan", deadline=NOW + 3)),
            encounter=WITH_ATTEMPT,
        ),
        verdict(Verdict.FAMILY),
    ),
    ("sleeping", base_state(), verdict(Verdict.FAMILY)),
    ("waking", in_phase(WAKING_STATE.phase, encounter=WITH_ATTEMPT), verdict(Verdict.FAMILY)),
    ("gazing", in_phase(GAZING_STATE.phase, encounter=WITH_ATTEMPT), verdict(Verdict.STRANGER)),
    ("greeting", in_phase(GREETING_PHASE, encounter=WITH_ATTEMPT), verdict(Verdict.STRANGER)),
    ("warning", in_phase(WARNING_STATE.phase, encounter=WITH_ATTEMPT), verdict(Verdict.FAMILY)),
    (
        "uncertain",
        in_phase(UNCERTAIN_STATE.phase, encounter=WITH_ATTEMPT),
        verdict(Verdict.FAMILY),
    ),
    ("cooldown", in_phase(COOLDOWN_STATE.phase, encounter=WITH_ATTEMPT), verdict(Verdict.FAMILY)),
]


@pytest.mark.parametrize(
    ("ms", "event"),
    [(ms, event) for _, ms, event in IGNORED_VERDICT_CASES],
    ids=[name for name, _, _ in IGNORED_VERDICT_CASES],
)
def test_ignored_verdict_returns_an_equal_state_and_no_actions(
    ms: MachineState, event: JudgementResult
) -> None:
    nxt, actions = step(ms, event, NOW + 1)
    assert actions == ()
    assert nxt == ms


def test_a_redelivered_verdict_changes_nothing() -> None:
    # QoS 1 can deliver the same judgement.result twice; only the first one counts.
    first = verdict(Verdict.FAMILY, face=FACE)
    gazing, _ = step(awaiting_verdict(), first, NOW)
    nxt, actions = step(gazing, first, NOW + 0.5)
    assert actions == ()
    assert nxt == gazing
    # A different Verdict for the same snapshot is a repeat as well (R3.4, R4.6).
    nxt, actions = step(gazing, verdict(Verdict.STRANGER, face=FACE), NOW + 0.5)
    assert actions == ()
    assert nxt == gazing


# --- Face present: head tracking into gazing (R5.3, R5.4, R5.7) ------------------------------


@pytest.mark.parametrize("v", [Verdict.FAMILY, Verdict.STRANGER])
def test_a_verdict_with_a_face_turns_the_head_relative_to_the_snapshot_angles(v: Verdict) -> None:
    ms = awaiting_verdict()
    nxt, actions = step(ms, verdict(v, face=FACE), NOW + 1)

    # cx = 0.75 and cy = 0.25: right of and above center, from the snapshot angles (5, -3),
    # not from the current head angles (20, 10).
    pan = SNAP_PAN + (0.75 - 0.5) * CONFIG.camera.camera_hfov_deg
    tilt = SNAP_TILT + (0.5 - 0.25) * CONFIG.camera.camera_vfov_deg
    motion_id = f"motion-1-{UID_B}"
    assert without_status(actions) == (
        PublishEvent(
            data=StateChanged(from_=State.SEEKING, to=State.GAZING, reason=Reason.VERDICT),
            encounter_id=ENCOUNTER_ID,
        ),
        GazeTarget(pan_deg=pan, tilt_deg=tilt, motion_id=motion_id),
    )
    assert nxt.phase == Gazing(
        motion_id=motion_id, deadline=NOW + 1 + CONFIG.timing.glide_timeout_s
    )
    assert (nxt.gaze, nxt.servos_released) == ((pan, tilt), False)
    assert nxt.encounter is not None
    assert nxt.encounter.accepted is AcceptedVerdict(v.value)


def test_the_gazing_target_is_clamped_to_the_calibrated_range() -> None:
    # The snapshot already looked far right and up; the face at the top-right corner would
    # need more than the neck allows (R5.7, hardware.md).
    attempt = dataclasses.replace(VERDICT_ATTEMPT, pan_deg=25.0, tilt_deg=15.0)
    corner = FaceBox(left=0.9, top=0.0, width=0.5, height=0.1)
    _, actions = step(
        seeking_with(attempt, cloud_connected=True),
        verdict(Verdict.STRANGER, face=corner),
        NOW + 1,
    )
    (target,) = [a for a in actions if isinstance(a, GazeTarget)]
    assert (target.pan_deg, target.tilt_deg) == (
        CONFIG.servo.pan_limit,
        CONFIG.servo.tilt_limit,
    )


# --- Face absent: straight into the Reaction (R5.5) ------------------------------------------


@pytest.mark.parametrize(
    ("v", "state"), [(Verdict.FAMILY, State.GREETING), (Verdict.STRANGER, State.WARNING)]
)
def test_a_verdict_without_a_face_enters_the_reaction_directly(v: Verdict, state: State) -> None:
    nxt, actions = step(awaiting_verdict(), verdict(v, face=None), NOW + 1)
    assert state_changes(actions) == (
        StateChanged(from_=State.SEEKING, to=state, reason=Reason.VERDICT),
    )
    assert nxt.state is state
    assert nxt.encounter is not None
    assert nxt.encounter.accepted is AcceptedVerdict(v.value)


# --- Leaving gazing (R5.6, R5.8) -------------------------------------------------------------

REACTION_OF = {Verdict.FAMILY: State.GREETING, Verdict.STRANGER: State.WARNING}


@pytest.mark.parametrize("connected", [True, False], ids=["connected", "disconnected"])
@pytest.mark.parametrize("v", [Verdict.FAMILY, Verdict.STRANGER])
def test_the_gazing_arrival_enters_the_reaction_with_reason_arrived(
    v: Verdict, connected: bool
) -> None:
    ms = gazing_after(v, connected=connected)
    assert isinstance(ms.phase, Gazing)
    arrival = ServoArrived(motion_id=ms.phase.motion_id, uid=UID_A)

    nxt, actions = step(ms, arrival, NOW + 1)

    assert state_changes(actions) == (
        StateChanged(from_=State.GAZING, to=REACTION_OF[v], reason=Reason.ARRIVED),
    )
    assert nxt.state is REACTION_OF[v]
    assert nxt.encounter is not None and ms.encounter is not None
    # the Accepted_Verdict and the attempt are kept
    assert (nxt.encounter.accepted, nxt.encounter.attempt) == (
        ms.encounter.accepted,
        ms.encounter.attempt,
    )


@pytest.mark.parametrize("connected", [True, False], ids=["connected", "disconnected"])
@pytest.mark.parametrize("v", [Verdict.FAMILY, Verdict.STRANGER])
def test_the_gazing_deadline_tick_enters_the_reaction_with_reason_timeout(
    v: Verdict, connected: bool
) -> None:
    ms = gazing_after(v, connected=connected)
    assert isinstance(ms.phase, Gazing)
    deadline = ms.phase.deadline
    assert deadline == NOW + CONFIG.timing.glide_timeout_s

    waiting, actions = step(ms, Tick(uid=UID_A), deadline - 0.01)
    assert without_status(actions) == ()
    assert (waiting.phase, waiting.encounter) == (ms.phase, ms.encounter)

    nxt, actions = step(waiting, Tick(uid=UID_A), deadline)
    assert state_changes(actions) == (
        StateChanged(from_=State.GAZING, to=REACTION_OF[v], reason=Reason.TIMEOUT),
    )
    assert nxt.state is REACTION_OF[v]


@pytest.mark.parametrize("at", [NOW + 1, NOW + 10], ids=["before-deadline", "after-deadline"])
def test_a_stale_arrival_in_gazing_changes_nothing(at: float) -> None:
    # Stale ids: one never issued, and one of an earlier glide (waking). Even past
    # the deadline only a Tick may leave gazing, so the arrival changes nothing (R5.8).
    ms = gazing_after(Verdict.FAMILY)
    for motion_id in ("motion-9-stale", "motion-1-waking"):
        nxt, actions = step(ms, ServoArrived(motion_id=motion_id, uid=UID_A), at)
        assert actions == ()
        assert nxt == ms


# ============================================================================================
# Scanning (task 11.2): scan positions, the next snapshot, ignored Verdicts, giving up
# ============================================================================================
#
# Scans start from awaiting_verdict() and are driven through real step() calls. Each call gets
# its own uid, as the Dispatcher would stamp it, so every Motion_Id and Snapshot_Id is unique.
# Ticks are sent only while a scan move is pending: the attempt deadline of the branch without a
# scan move (R3.6) is tested in the "Offline behaviour" section. The uncertain Reaction is
# checked only for its State and reason; its Actions are tested in the "Reactions" section.


def scan_uid(n: int) -> str:
    """The uid of the n-th call of a scan test; distinct from UID_A and UID_B."""
    return f"00000000-0000-4000-8000-{0x100 + n:012x}"


def no_face(snapshot_id: str, n: int) -> JudgementResult:
    return dataclasses.replace(
        verdict(Verdict.NO_FACE, 0.5, snapshot_id=snapshot_id), uid=scan_uid(n)
    )


def current_attempt(ms: MachineState) -> SnapshotAttempt:
    assert ms.encounter is not None and ms.encounter.attempt is not None
    return ms.encounter.attempt


def pending_scan(ms: MachineState) -> ScanMove:
    assert isinstance(ms.phase, Seeking) and ms.phase.scan is not None
    return ms.phase.scan


def scan_started(ms: MachineState, n: int, at: float) -> tuple[MachineState, GazeTarget]:
    """Answer the current snapshot with no_face; exactly one scan move must start (R6.1)."""
    before = ms.encounter
    assert before is not None
    nxt, actions = step(ms, no_face(current_attempt(ms).snapshot_id, n), at)

    # Only the scan GazeTarget: seeking is kept, so no state.changed is published.
    (target,) = without_status(actions)
    assert isinstance(target, GazeTarget)
    assert (target.tilt_deg, target.motion_id) == (0.0, f"motion-1-{scan_uid(n)}")
    assert nxt.phase == Seeking(
        scan=ScanMove(motion_id=target.motion_id, deadline=at + CONFIG.timing.glide_timeout_s)
    )
    # The scan counts as run from this call; the processed attempt stays until the next one.
    assert nxt.encounter == dataclasses.replace(
        before,
        accepted=AcceptedVerdict.NO_FACE,
        attempt=dataclasses.replace(current_attempt(ms), verdict_processed=True),
        scans_run=before.scans_run + 1,
    )
    assert (nxt.gaze, nxt.servos_released) == ((target.pan_deg, 0.0), False)
    return nxt, target


def scan_ended(ms: MachineState, n: int, at: float, *, end: str) -> MachineState:
    """End the pending scan move by its arrival or by a Tick; the next snapshot starts (R6.2)."""
    scan = pending_scan(ms)
    event: Event = (
        ServoArrived(motion_id=scan.motion_id, uid=scan_uid(n))
        if end == "arrival"
        else Tick(uid=scan_uid(n))
    )
    nxt, actions = step(ms, event, at)

    snapshot_id = f"snap-1-{scan_uid(n)}"
    assert without_status(actions) == (TakeSnapshot(snapshot_id=snapshot_id),)
    assert nxt.phase == Seeking()
    # The new attempt records the scan angles, the last emitted Gaze_Target (R3.1).
    assert current_attempt(nxt) == SnapshotAttempt(
        snapshot_id=snapshot_id,
        pan_deg=ms.gaze[0],
        tilt_deg=0.0,
        deadline=at + CONFIG.timing.verdict_timeout_s,
    )
    return nxt


@dataclasses.dataclass(frozen=True)
class ScanRun:
    ms: MachineState  # seeking, waiting for the Verdict of the last scan's snapshot
    targets: list[GazeTarget]  # the scan GazeTargets, in order
    attempts: list[SnapshotAttempt]  # the snapshot attempt started after each scan
    now: float  # a time for the next step() call


def scanned(cfg: Config = CONFIG, *, count: int | None = None, end: str = "arrival") -> ScanRun:
    """Run ``count`` scan rounds (default: ``scan_attempts_max``) from awaiting_verdict()."""
    ms = awaiting_verdict(config=cfg)
    rounds = cfg.camera.scan_attempts_max if count is None else count
    now, n = NOW, 0
    targets: list[GazeTarget] = []
    attempts: list[SnapshotAttempt] = []
    for _ in range(rounds):
        ms, target = scan_started(ms, n, now)
        at = now + 1 if end == "arrival" else pending_scan(ms).deadline
        ms = scan_ended(ms, n + 1, at, end=end)
        targets.append(target)
        attempts.append(current_attempt(ms))
        now, n = at + 1, n + 2
    return ScanRun(ms=ms, targets=targets, attempts=attempts, now=now)


# Scan positions beyond the pan limit of 10 degrees: the first two are Clamped (R6.1, R5.7).
CLAMPED_SCAN_CONFIG = dataclasses.replace(
    CONFIG,
    servo=dataclasses.replace(CONFIG.servo, pan_limit=10.0),
    camera=dataclasses.replace(CONFIG.camera, scan_pan_positions_deg=(-25.0, 40.0, 5.0)),
)


# --- Scan positions and the next snapshot (R6.1, R6.2, R6.5) ---------------------------------


@pytest.mark.parametrize("end", ["arrival", "deadline"])
@pytest.mark.parametrize(
    ("cfg", "expected"),
    [(CONFIG, [-15.0, 15.0, 0.0]), (CLAMPED_SCAN_CONFIG, [-10.0, 10.0, 5.0])],
    ids=["default", "clamped"],
)
def test_scans_use_the_positions_in_order_and_snapshot_at_the_scan_angles(
    cfg: Config, expected: list[float], end: str
) -> None:
    run = scanned(cfg, end=end)
    assert [target.pan_deg for target in run.targets] == expected
    assert [(a.pan_deg, a.tilt_deg) for a in run.attempts] == [(p, 0.0) for p in expected]
    assert run.ms.encounter is not None
    assert run.ms.encounter.scans_run == len(expected)


def test_the_first_tick_at_or_after_the_scan_deadline_ends_the_scan_move() -> None:
    ms, target = scan_started(awaiting_verdict(), 0, NOW)
    deadline = pending_scan(ms).deadline

    waiting, actions = step(ms, Tick(uid=scan_uid(1)), deadline - 0.01)
    assert without_status(actions) == ()
    assert (waiting.phase, waiting.encounter) == (ms.phase, ms.encounter)

    # A late Tick ends the move as well; the new attempt's deadline counts from that Tick.
    nxt = scan_ended(waiting, 2, deadline + 0.5, end="deadline")
    assert current_attempt(nxt).pan_deg == target.pan_deg


def test_only_the_scan_motion_id_ends_the_scan_move() -> None:
    ms, _ = scan_started(awaiting_verdict(), 0, NOW)
    for motion_id in ("motion-9-stale", "motion-1-waking"):
        nxt, actions = step(ms, ServoArrived(motion_id=motion_id, uid=scan_uid(1)), NOW + 1)
        assert actions == ()
        assert nxt == ms


# --- A judgement.result during a scan move (R6.6) --------------------------------------------


@pytest.mark.parametrize(
    "snapshot_id", [SNAP_ID, "snap-9-other"], ids=["processed-snapshot", "other-snapshot"]
)
@pytest.mark.parametrize("v", list(Verdict))
def test_a_judgement_during_a_scan_move_changes_nothing(v: Verdict, snapshot_id: str) -> None:
    ms, _ = scan_started(awaiting_verdict(), 0, NOW)
    face = FACE if v in (Verdict.FAMILY, Verdict.STRANGER) else None
    nxt, actions = step(ms, verdict(v, face=face, snapshot_id=snapshot_id), NOW + 0.5)
    assert actions == ()
    assert nxt == ms
    # The scan move is still pending and ends as usual.
    scan_ended(nxt, 1, NOW + 1, end="arrival")


# --- A Verdict other than no_face after a scan (R6.4) ----------------------------------------


@pytest.mark.parametrize(
    ("v", "face", "state"),
    [
        (Verdict.FAMILY, FACE, State.GAZING),
        (Verdict.STRANGER, None, State.WARNING),
        (Verdict.UNCERTAIN, None, State.UNCERTAIN),
    ],
    ids=["family-with-face", "stranger-without-face", "uncertain"],
)
def test_a_verdict_other_than_no_face_after_a_scan_starts_no_further_scan(
    v: Verdict, face: FaceBox | None, state: State
) -> None:
    run = scanned(count=1)
    snapshot_id = current_attempt(run.ms).snapshot_id
    nxt, actions = step(run.ms, verdict(v, face=face, snapshot_id=snapshot_id), run.now)

    assert state_changes(actions) == (
        StateChanged(from_=State.SEEKING, to=state, reason=Reason.VERDICT),
    )
    assert nxt.state is state
    assert nxt.encounter is not None
    assert nxt.encounter.scans_run == 1
    assert nxt.encounter.accepted is AcceptedVerdict(v.value)
    if state is State.GAZING:
        # The head tracks relative to the scan angles (-15, 0) of the snapshot (R5.3).
        (target,) = [a for a in actions if isinstance(a, GazeTarget)]
        assert (target.pan_deg, target.tilt_deg) == (
            -15.0 + (0.75 - 0.5) * CONFIG.camera.camera_hfov_deg,
            0.0 + (0.5 - 0.25) * CONFIG.camera.camera_vfov_deg,
        )


# --- Giving up (R6.3, R6.5) ------------------------------------------------------------------


@pytest.mark.parametrize("max_scans", [0, 1, 3])
def test_no_face_after_the_last_scan_enters_uncertain_with_reason_no_face(max_scans: int) -> None:
    # With scan_attempts_max = 0 the first snapshot's no_face already gives up.
    cfg = dataclasses.replace(
        CONFIG, camera=dataclasses.replace(CONFIG.camera, scan_attempts_max=max_scans)
    )
    run = scanned(cfg)
    assert len(run.targets) == max_scans

    snapshot_id = current_attempt(run.ms).snapshot_id
    nxt, actions = step(run.ms, no_face(snapshot_id, 99), run.now)

    assert state_changes(actions) == (
        StateChanged(from_=State.SEEKING, to=State.UNCERTAIN, reason=Reason.NO_FACE),
    )
    assert nxt.state is State.UNCERTAIN
    assert nxt.encounter is not None
    assert nxt.encounter.scans_run == max_scans
    assert nxt.encounter.accepted is AcceptedVerdict.NO_FACE


# ============================================================================================
# Reactions (task 12.2): entry Actions, the nod, the stare, missing lines, ending the line
# ============================================================================================
#
# Reactions are entered through real step() calls from awaiting_verdict(): a family or
# stranger Verdict without a face enters greeting or warning directly (R5.5), and an uncertain
# Verdict enters uncertain. The Verdict carries UID_B, so the entry Play_Id and Motion_Id end
# in UID_B; later calls use UID_A. Task 13.1 completes cooldown, so a transition into it is
# checked only for the State and the state.changed reason (and for what precedes the
# announcement), never for the cooldown entry Actions or its phase.

REACTION_AT = NOW + 1  # now of the Verdict that enters the Reaction
NOD_DEADLINE = REACTION_AT + CONFIG.timing.glide_timeout_s
STARE_UNTIL = REACTION_AT + CONFIG.timing.stare_s
ENTRY_PLAY_ID = f"play-1-{UID_B}"  # a line played on entry (greeting, uncertain)
STARE_PLAY_ID = f"play-1-{UID_A}"  # the stranger line, played on the Tick that ends the stare
HEAD = (20.0, 10.0)  # the gaze of awaiting_verdict(): the nod base
LINE_OF = {line.category: line for line in LINES}
STATE_OF = {
    Category.FAMILY: State.GREETING,
    Category.STRANGER: State.WARNING,
    Category.UNCERTAIN: State.UNCERTAIN,
}
VERDICT_OF = {
    Category.FAMILY: Verdict.FAMILY,
    Category.STRANGER: Verdict.STRANGER,
    Category.UNCERTAIN: Verdict.UNCERTAIN,
}
LINE_MISSING = ErrorReported(
    code=ErrorCode.VOICE_LINE_MISSING,
    message=state_machine.VOICE_LINE_MISSING_MESSAGE,
    ref_id=None,
)


def in_encounter(data: EventData) -> PublishEvent:
    """``PublishEvent`` of ``data`` inside the hand-built Encounter."""
    return PublishEvent(data=data, encounter_id=ENCOUNTER_ID)


def reaction_entered(kind: Category, **changes: object) -> tuple[MachineState, tuple[Action, ...]]:
    """Enter the Reaction of ``kind`` at REACTION_AT through a Verdict without a face."""
    return step(awaiting_verdict(**changes), verdict(VERDICT_OF[kind]), REACTION_AT)


def playing(kind: Category) -> tuple[MachineState, str, float]:
    """The Reaction of ``kind`` with its line playing: the state, its Play_Id and line deadline."""
    ms, _ = reaction_entered(kind)
    if kind is not Category.STRANGER:
        return ms, ENTRY_PLAY_ID, REACTION_AT + CONFIG.timing.audio_timeout_s
    ms, _ = step(ms, Tick(uid=UID_A), STARE_UNTIL)
    return ms, STARE_PLAY_ID, STARE_UNTIL + CONFIG.timing.audio_timeout_s


def as_greeting(ms: MachineState) -> Greeting:
    assert isinstance(ms.phase, Greeting)
    return ms.phase


# --- greeting: the family line and the nod (R7.1, R7.2) --------------------------------------


def test_entering_greeting_plays_the_family_line_nods_and_announces_in_order() -> None:
    nxt, actions = reaction_entered(Category.FAMILY)

    line_id = LINE_OF[Category.FAMILY].id
    assert without_status(actions) == (
        in_encounter(StateChanged(from_=State.SEEKING, to=State.GREETING, reason=Reason.VERDICT)),
        PlayLine(line_id=line_id, play_id=ENTRY_PLAY_ID),
        GazeTarget(
            pan_deg=HEAD[0],
            tilt_deg=HEAD[1] - CONFIG.servo.nod_deg,  # positive tilt looks up
            motion_id=f"motion-1-{UID_B}",
        ),
        in_encounter(ReactionPerformed(kind=Category.FAMILY, line_id=line_id, offline=False)),
    )
    line_deadline = REACTION_AT + CONFIG.timing.audio_timeout_s
    assert nxt.phase == Greeting(
        pan=HEAD[0],
        tilt=HEAD[1],
        nod_motion_id=f"motion-1-{UID_B}",
        nod_deadline=NOD_DEADLINE,
        line=ReactionLine(play_id=ENTRY_PLAY_ID, deadline=line_deadline),
    )
    assert nxt.audio == (PendingAudio(play_id=ENTRY_PLAY_ID, busy_until=line_deadline),)
    assert nxt.encounter is not None and nxt.encounter.reacted
    assert nxt.gaze == (HEAD[0], HEAD[1] - CONFIG.servo.nod_deg)


def test_the_nod_is_clamped_to_the_calibrated_range() -> None:
    # The head already looks down near the limit, so the nod stops at the limit (R5.7).
    ms = seeking_with(VERDICT_ATTEMPT, gaze=(0.0, -15.0), cloud_connected=True)
    nxt, actions = step(ms, verdict(Verdict.FAMILY), REACTION_AT)
    (nod,) = [a for a in actions if isinstance(a, GazeTarget)]
    assert (nod.pan_deg, nod.tilt_deg) == (0.0, -CONFIG.servo.tilt_limit)
    # The return goes to the recorded base, not to the Clamped nod angle.
    assert (as_greeting(nxt).pan, as_greeting(nxt).tilt) == (0.0, -15.0)


def test_the_nod_base_is_the_gazing_target() -> None:
    gazing = gazing_after(Verdict.FAMILY)
    assert isinstance(gazing.phase, Gazing)
    nxt, actions = step(gazing, ServoArrived(motion_id=gazing.phase.motion_id, uid=UID_A), NOW + 1)
    phase = as_greeting(nxt)
    assert (phase.pan, phase.tilt) == gazing.gaze
    (nod,) = [a for a in actions if isinstance(a, GazeTarget)]
    assert (nod.pan_deg, nod.tilt_deg) == (gazing.gaze[0], gazing.gaze[1] - CONFIG.servo.nod_deg)


def test_the_nod_arrival_returns_the_head_once() -> None:
    ms, _ = reaction_entered(Category.FAMILY)
    nod_arrival = ServoArrived(motion_id=as_greeting(ms).nod_motion_id, uid=UID_A)

    returned, actions = step(ms, nod_arrival, REACTION_AT + 1)
    back = GazeTarget(pan_deg=HEAD[0], tilt_deg=HEAD[1], motion_id=f"motion-1-{UID_A}")
    assert without_status(actions) == (back,)
    assert returned.phase == dataclasses.replace(as_greeting(ms), nod_returned=True)
    assert returned.gaze == HEAD

    # A repeated nod arrival, the return's own arrival and the nod deadline do nothing more.
    for event in (nod_arrival, ServoArrived(motion_id=back.motion_id, uid=UID_B)):
        nxt, actions = step(returned, event, REACTION_AT + 2)
        assert without_status(actions) == ()
        assert nxt == returned
    nxt, actions = step(returned, Tick(uid=UID_B), NOD_DEADLINE)
    assert without_status(actions) == ()
    assert nxt.phase == returned.phase


def test_a_stale_arrival_in_greeting_does_not_return_the_head() -> None:
    ms, _ = reaction_entered(Category.FAMILY)
    nxt, actions = step(ms, ServoArrived(motion_id="motion-9-stale", uid=UID_A), REACTION_AT + 1)
    assert without_status(actions) == ()
    assert nxt == ms


def test_the_nod_deadline_tick_returns_the_head_once() -> None:
    ms, _ = reaction_entered(Category.FAMILY)

    waiting, actions = step(ms, Tick(uid=UID_A), NOD_DEADLINE - 0.01)
    assert without_status(actions) == ()
    assert waiting.phase == ms.phase

    returned, actions = step(waiting, Tick(uid=UID_A), NOD_DEADLINE)
    assert without_status(actions) == (
        GazeTarget(pan_deg=HEAD[0], tilt_deg=HEAD[1], motion_id=f"motion-1-{UID_A}"),
    )
    assert as_greeting(returned).nod_returned

    nxt, actions = step(returned, Tick(uid=UID_B), NOD_DEADLINE + 1)
    assert without_status(actions) == ()
    # The late nod arrival is stale now.
    nod_arrival = ServoArrived(motion_id=as_greeting(ms).nod_motion_id, uid=UID_B)
    nxt, actions = step(nxt, nod_arrival, NOD_DEADLINE + 1)
    assert without_status(actions) == ()


def test_a_gapped_tick_past_both_deadlines_returns_the_head_before_entering_cooldown() -> None:
    ms, _ = reaction_entered(Category.FAMILY)
    line_deadline = REACTION_AT + CONFIG.timing.audio_timeout_s

    nxt, actions = step(ms, Tick(uid=UID_A), line_deadline + 0.5)

    assert without_status(actions)[:2] == (
        GazeTarget(pan_deg=HEAD[0], tilt_deg=HEAD[1], motion_id=f"motion-1-{UID_A}"),
        in_encounter(StateChanged(from_=State.GREETING, to=State.COOLDOWN, reason=Reason.TIMEOUT)),
    )
    assert state_changes(actions) == (
        StateChanged(from_=State.GREETING, to=State.COOLDOWN, reason=Reason.TIMEOUT),
    )
    assert nxt.state is State.COOLDOWN


# --- warning: the silent stare, then the stranger line (R7.3, R7.4) ---------------------------


def test_entering_warning_is_silent() -> None:
    nxt, actions = reaction_entered(Category.STRANGER)

    assert without_status(actions) == (
        in_encounter(StateChanged(from_=State.SEEKING, to=State.WARNING, reason=Reason.VERDICT)),
    )
    assert nxt.phase == WarningPhase(stare_until=STARE_UNTIL)
    assert nxt.audio == ()
    assert nxt.encounter is not None and not nxt.encounter.reacted


@pytest.mark.parametrize(
    "at", [REACTION_AT + 0.1, STARE_UNTIL - 0.01], ids=["early", "just-before"]
)
def test_ticks_during_the_stare_emit_nothing(at: float) -> None:
    ms, _ = reaction_entered(Category.STRANGER)
    nxt, actions = step(ms, Tick(uid=UID_A), at)
    assert without_status(actions) == ()
    assert (nxt.phase, nxt.encounter, nxt.audio) == (ms.phase, ms.encounter, ms.audio)


@pytest.mark.parametrize("at", [STARE_UNTIL, STARE_UNTIL + 0.5], ids=["at", "late"])
def test_the_first_tick_at_or_after_stare_until_plays_the_stranger_line(at: float) -> None:
    ms, _ = reaction_entered(Category.STRANGER)

    nxt, actions = step(ms, Tick(uid=UID_A), at)

    line_id = LINE_OF[Category.STRANGER].id
    assert without_status(actions) == (
        PlayLine(line_id=line_id, play_id=STARE_PLAY_ID),
        in_encounter(ReactionPerformed(kind=Category.STRANGER, line_id=line_id, offline=False)),
    )
    # The line deadline counts from the Tick that played the line (R7.6).
    line_deadline = at + CONFIG.timing.audio_timeout_s
    assert nxt.phase == WarningPhase(
        stare_until=STARE_UNTIL,
        line=ReactionLine(play_id=STARE_PLAY_ID, deadline=line_deadline),
    )
    assert nxt.audio == (PendingAudio(play_id=STARE_PLAY_ID, busy_until=line_deadline),)
    assert nxt.encounter is not None and nxt.encounter.reacted

    # The line is played once (R7.8).
    later, actions = step(nxt, Tick(uid=UID_B), at + 1)
    assert without_status(actions) == ()
    assert later.phase == nxt.phase


# --- uncertain: the cautious line (R7.5) -----------------------------------------------------


def test_entering_uncertain_plays_the_uncertain_line_and_announces_it() -> None:
    nxt, actions = reaction_entered(Category.UNCERTAIN)

    line_id = LINE_OF[Category.UNCERTAIN].id
    assert without_status(actions) == (
        in_encounter(StateChanged(from_=State.SEEKING, to=State.UNCERTAIN, reason=Reason.VERDICT)),
        PlayLine(line_id=line_id, play_id=ENTRY_PLAY_ID),
        in_encounter(ReactionPerformed(kind=Category.UNCERTAIN, line_id=line_id, offline=False)),
    )
    line_deadline = REACTION_AT + CONFIG.timing.audio_timeout_s
    assert nxt.phase == Uncertain(line=ReactionLine(play_id=ENTRY_PLAY_ID, deadline=line_deadline))
    assert nxt.audio == (PendingAudio(play_id=ENTRY_PLAY_ID, busy_until=line_deadline),)
    assert nxt.encounter is not None and nxt.encounter.reacted


def test_an_offline_uncertain_entry_announces_offline_true() -> None:
    # The entry helper is called directly here, as the waking and seeking handlers call it.
    # The step() paths into the Offline_Reaction are tested in the "Offline behaviour" section.
    ms = in_phase(Waking(motion_id="motion-1-waking", fade_done_at=NOW, deadline=NOW + 3))
    ctx = StepContext(ms, Tick(uid=UID_A), NOW)

    nxt = state_machine.enter_uncertain(ctx, ms, offline=True, reason=Reason.OFFLINE)

    line_id = LINE_OF[Category.UNCERTAIN].id
    assert ctx.actions == [
        in_encounter(StateChanged(from_=State.WAKING, to=State.UNCERTAIN, reason=Reason.OFFLINE)),
        PlayLine(line_id=line_id, play_id=f"play-1-{UID_A}"),
        in_encounter(ReactionPerformed(kind=Category.UNCERTAIN, line_id=line_id, offline=True)),
    ]
    assert nxt.state is State.UNCERTAIN


# --- A missing line (R7.7, R7.10) ------------------------------------------------------------


@pytest.mark.parametrize("kind", list(Category))
def test_a_missing_line_still_reacts_reports_and_the_next_tick_enters_cooldown(
    kind: Category,
) -> None:
    # Only the Reaction's own Category is empty; the other Categories keep their lines.
    lines = tuple(line for line in LINES if line.category is not kind)
    ms, actions = reaction_entered(kind, lines=lines)
    entered = in_encounter(
        StateChanged(from_=State.SEEKING, to=STATE_OF[kind], reason=Reason.VERDICT)
    )
    missing = (
        in_encounter(ReactionPerformed(kind=kind, line_id=None, offline=False)),
        in_encounter(LINE_MISSING),
    )
    now = REACTION_AT
    if kind is Category.FAMILY:
        nod = GazeTarget(
            pan_deg=HEAD[0], tilt_deg=HEAD[1] - CONFIG.servo.nod_deg, motion_id=f"motion-1-{UID_B}"
        )
        assert without_status(actions) == (entered, nod, *missing)
    elif kind is Category.UNCERTAIN:
        assert without_status(actions) == (entered, *missing)
    else:
        assert without_status(actions) == (entered,)  # the stare is silent anyway
        now = STARE_UNTIL
        ms, actions = step(ms, Tick(uid=UID_A), now)
        assert without_status(actions) == missing

    # No PlayLine and nothing to wait for; the Reaction does not end in the same call.
    assert not any(isinstance(a, PlayLine) for a in actions)
    assert ms.state is STATE_OF[kind]
    assert ms.audio == ()
    assert state_machine.reaction_line_of(ms.phase) == ReactionLine(play_id=None, deadline=None)
    assert ms.encounter is not None and ms.encounter.reacted

    nxt, actions = step(ms, Tick(uid=UID_B), now + 0.1)
    assert state_changes(actions) == (
        StateChanged(from_=STATE_OF[kind], to=State.COOLDOWN, reason=Reason.ERROR),
    )
    assert nxt.state is State.COOLDOWN


# --- Ending the line: audio_done and timeout (R7.6, R20.9) -----------------------------------


@pytest.mark.parametrize(
    "code", [None, "audio_failed", "interrupted"], ids=["finished", "failed", "interrupted"]
)
@pytest.mark.parametrize("kind", list(Category))
def test_the_reaction_line_result_enters_cooldown_with_reason_audio_done(
    kind: Category, code: str | None
) -> None:
    ms, play_id, _ = playing(kind)
    event: Event = (
        AudioFinished(play_id=play_id, uid=UID_B)
        if code is None
        else AudioFailed(play_id=play_id, code=code, uid=UID_B)  # type: ignore[arg-type]
    )

    nxt, actions = step(ms, event, STARE_UNTIL + 1)

    changed = StateChanged(from_=STATE_OF[kind], to=State.COOLDOWN, reason=Reason.AUDIO_DONE)
    assert state_changes(actions) == (changed,)
    expected: tuple[PublishEvent, ...] = (in_encounter(changed),)
    if code == "audio_failed":
        # The failure is reported before the announcement (R20.9).
        failed = ErrorReported(
            code=ErrorCode.AUDIO_FAILED,
            message=state_machine.AUDIO_FAILED_MESSAGES[ErrorCode.AUDIO_FAILED],
            ref_id=None,
        )
        expected = (in_encounter(failed), *expected)
    # interrupted is never reported: the device itself stopped the playback.
    assert published(actions)[: len(expected)] == expected
    assert sum(isinstance(p.data, ErrorReported) for p in published(actions)) == (
        1 if code == "audio_failed" else 0
    )
    assert nxt.state is State.COOLDOWN
    assert nxt.audio == ()


@pytest.mark.parametrize("kind", list(Category))
def test_the_line_deadline_tick_enters_cooldown_with_reason_timeout(kind: Category) -> None:
    ms, _, deadline = playing(kind)

    waiting, actions = step(ms, Tick(uid=UID_A), deadline - 0.01)
    assert state_changes(actions) == ()
    assert waiting.state is STATE_OF[kind]

    nxt, actions = step(waiting, Tick(uid=UID_B), deadline)
    assert state_changes(actions) == (
        StateChanged(from_=STATE_OF[kind], to=State.COOLDOWN, reason=Reason.TIMEOUT),
    )
    assert nxt.state is State.COOLDOWN


@pytest.mark.parametrize("kind", list(Category))
def test_stale_audio_feedback_in_a_reaction_changes_only_the_report(kind: Category) -> None:
    ms, _, _ = playing(kind)

    nxt, actions = step(ms, AudioFinished(play_id="play-9-stale", uid=UID_B), STARE_UNTIL + 1)
    assert without_status(actions) == ()
    assert nxt == ms

    stale_failure = AudioFailed(play_id="play-9-stale", code="audio_failed", uid=UID_B)
    nxt, actions = step(ms, stale_failure, STARE_UNTIL + 1)
    assert without_status(actions) == (
        in_encounter(
            ErrorReported(
                code=ErrorCode.AUDIO_FAILED,
                message=state_machine.AUDIO_FAILED_MESSAGES[ErrorCode.AUDIO_FAILED],
                ref_id=None,
            )
        ),
    )
    assert nxt == ms


def test_any_audio_result_forgets_its_play_id() -> None:
    # Another unfinished playback (for example a speak line) ends during the greeting: its
    # entry is forgotten and the Reaction goes on (R12.6).
    ms, play_id, deadline = playing(Category.FAMILY)
    other = PendingAudio(play_id="play-1-speak", busy_until=deadline)
    ms = dataclasses.replace(ms, audio=(*ms.audio, other))

    nxt, actions = step(ms, AudioFinished(play_id=other.play_id, uid=UID_B), REACTION_AT + 1)
    assert without_status(actions) == ()
    assert nxt.state is State.GREETING
    assert nxt.audio == (PendingAudio(play_id=play_id, busy_until=deadline),)

    # Outside a Reaction the global handler forgets the entry as well.
    sleeping = base_state(audio=(other,))
    nxt, actions = step(sleeping, AudioFinished(play_id=other.play_id, uid=UID_B), NOW)
    assert without_status(actions) == ()
    assert nxt == base_state()


@pytest.mark.parametrize("code", ["audio_failed", "download_failed", "interrupted"])
@pytest.mark.parametrize("where", ["sleeping", "seeking"])
def test_audio_failed_outside_a_reaction_is_reported_unless_interrupted(
    where: str, code: str
) -> None:
    ms = base_state() if where == "sleeping" else awaiting_verdict()
    event = AudioFailed(play_id="play-1-old", code=code, uid=UID_B)  # type: ignore[arg-type]

    nxt, actions = step(ms, event, NOW + 1)

    if code == "interrupted":
        assert without_status(actions) == ()
    else:
        encounter_id = ms.encounter.encounter_id if ms.encounter is not None else None
        error = ErrorReported(
            code=ErrorCode(code),
            message=state_machine.AUDIO_FAILED_MESSAGES[ErrorCode(code)],
            ref_id=None,
        )
        assert without_status(actions) == (PublishEvent(data=error, encounter_id=encounter_id),)
    assert nxt == ms


# --- adapter.error (R20.9) -------------------------------------------------------------------


@pytest.mark.parametrize(
    "code", [ErrorCode.ADAPTER_FAILED, ErrorCode.AUDIO_DEVICE_MISSING, ErrorCode.CAMERA_FAILED]
)
@pytest.mark.parametrize("where", ["sleeping", "seeking", "greeting", "warning"])
def test_adapter_error_is_reported_with_its_code_and_changes_nothing_else(
    where: str, code: ErrorCode
) -> None:
    if where == "sleeping":
        ms = base_state()
    elif where == "seeking":
        ms = awaiting_verdict()
    else:
        kind = Category.FAMILY if where == "greeting" else Category.STRANGER
        ms, _ = reaction_entered(kind)

    nxt, actions = step(ms, AdapterError(code=code.value, uid=UID_A), REACTION_AT + 0.5)

    encounter_id = ms.encounter.encounter_id if ms.encounter is not None else None
    error = ErrorReported(code=code, message=state_machine.ADAPTER_ERROR_MESSAGE, ref_id=None)
    assert without_status(actions) == (PublishEvent(data=error, encounter_id=encounter_id),)
    assert nxt == ms


# ============================================================================================
# Cooldown (task 13.2): the glide to center, the release, sleeping and the R8.4 backstop
# ============================================================================================
#
# The entry test goes through a real step() call (the uncertain line finishes at COOL_AT, the
# Event carries UID_B). The other tests start from a hand-built cooldown state whose deadlines
# count from COOL_AT; later calls use UID_A. mode.set (task 16.1) is not covered here. An
# Offline_Reaction enters cooldown through the same uncertain rules as any other Reaction, so
# it needs no test of its own here; the offline paths are in the "Offline behaviour" section.

COOL_AT = REACTION_AT + 2  # now of the step() call that enters cooldown
COOL_MOTION = f"motion-1-{UID_B}"  # the glide to center emitted on entry
GLIDE_DEADLINE = COOL_AT + CONFIG.timing.glide_timeout_s
COOL_UNTIL = COOL_AT + CONFIG.timing.cooldown_s
RELEASE = (
    ReleaseServos(),
    LanternFade(level=0.0, fade_ms=round(CONFIG.lantern.lantern_fade_out_ms)),
)
BACKSTOP = (ReleaseServos(), LanternFade(level=0.0, fade_ms=0))


def cooling(
    *,
    released: bool = False,
    manual: bool = False,
    servos_released: bool | None = None,
    lantern_level: float | None = None,
) -> MachineState:
    """A hand-built cooldown state entered at COOL_AT, inside the hand-built Encounter.

    By default the head is attached and the lantern lit, as on entry. ``released=True`` alone
    gives the state after the normal release: servos detached and lantern level 0.
    """
    phase = Cooldown(
        motion_id=COOL_MOTION,
        glide_deadline=GLIDE_DEADLINE,
        released=released,
        until=COOL_UNTIL,
        manual=manual,
    )
    ms = in_phase(phase)
    if servos_released is None:
        servos_released = released
    if lantern_level is None:
        lantern_level = 0.0 if released else ms.lantern_level
    return dataclasses.replace(ms, servos_released=servos_released, lantern_level=lantern_level)


def ended(end_reason: EndReason) -> tuple[PublishEvent, PublishEvent]:
    """The ``state.changed`` and ``encounter.ended`` of the normal end of a cooldown."""
    return (
        in_encounter(
            StateChanged(from_=State.COOLDOWN, to=State.SLEEPING, reason=Reason.COOLDOWN_DONE)
        ),
        in_encounter(EncounterEnded(reason=end_reason)),
    )


def as_cooldown(ms: MachineState) -> Cooldown:
    assert isinstance(ms.phase, Cooldown)
    return ms.phase


# --- Entering cooldown (R8.1) ----------------------------------------------------------------


def test_entering_cooldown_glides_to_center_and_keeps_the_encounter() -> None:
    ms, play_id, _ = playing(Category.UNCERTAIN)
    assert ms.gaze == HEAD

    nxt, actions = step(ms, AudioFinished(play_id=play_id, uid=UID_B), COOL_AT)

    assert without_status(actions) == (
        in_encounter(
            StateChanged(from_=State.UNCERTAIN, to=State.COOLDOWN, reason=Reason.AUDIO_DONE)
        ),
        GazeTarget(pan_deg=0.0, tilt_deg=0.0, motion_id=COOL_MOTION),
    )
    assert nxt.phase == Cooldown(
        motion_id=COOL_MOTION,
        glide_deadline=GLIDE_DEADLINE,
        until=COOL_UNTIL,
        manual=False,
    )
    # The lantern stays lit while the head moves; the Encounter stays for encounter.ended.
    assert (nxt.gaze, nxt.servos_released) == ((0.0, 0.0), False)
    assert nxt.lantern_level == ms.lantern_level != 0.0
    assert nxt.encounter == ms.encounter


# --- The release: on arrival or on the glide deadline, once (R8.2) ---------------------------


def test_the_cooldown_arrival_releases_then_fades_out_once() -> None:
    arrival = ServoArrived(motion_id=COOL_MOTION, uid=UID_A)

    released, actions = step(cooling(), arrival, COOL_AT + 1)

    assert without_status(actions) == RELEASE
    assert released.phase == dataclasses.replace(cooling().phase, released=True)
    assert (released.servos_released, released.lantern_level) == (True, 0.0)
    assert released.encounter == cooling().encounter

    # A repeated arrival and the glide deadline emit nothing more.
    nxt, actions = step(released, arrival, COOL_AT + 2)
    assert without_status(actions) == ()
    assert nxt == released
    nxt, actions = step(released, Tick(uid=UID_A), GLIDE_DEADLINE)
    assert without_status(actions) == ()
    assert nxt.phase == released.phase


def test_a_stale_arrival_in_cooldown_does_not_release() -> None:
    ms = cooling()
    nxt, actions = step(ms, ServoArrived(motion_id="motion-9-stale", uid=UID_A), COOL_AT + 1)
    assert without_status(actions) == ()
    assert nxt == ms


@pytest.mark.parametrize("at", [GLIDE_DEADLINE, GLIDE_DEADLINE + 0.5], ids=["at", "late"])
def test_the_glide_deadline_tick_releases_then_fades_out_once(at: float) -> None:
    ms = cooling()

    waiting, actions = step(ms, Tick(uid=UID_A), GLIDE_DEADLINE - 0.01)
    assert without_status(actions) == ()
    assert waiting.phase == ms.phase

    released, actions = step(waiting, Tick(uid=UID_A), at)
    assert without_status(actions) == RELEASE
    assert as_cooldown(released).released
    assert (released.servos_released, released.lantern_level) == (True, 0.0)

    # The late glide arrival and the next Tick emit nothing more.
    nxt, actions = step(released, ServoArrived(motion_id=COOL_MOTION, uid=UID_B), at + 0.1)
    assert without_status(actions) == ()
    nxt, actions = step(nxt, Tick(uid=UID_B), at + 0.2)
    assert without_status(actions) == ()
    assert nxt.phase == released.phase


# --- Back to sleeping (R8.3, R8.5) -----------------------------------------------------------


@pytest.mark.parametrize(
    ("manual", "end_reason"),
    [(False, EndReason.COOLDOWN), (True, EndReason.MANUAL)],
    ids=["cooldown", "manual"],
)
@pytest.mark.parametrize("at", [COOL_UNTIL, COOL_UNTIL + 0.5], ids=["at", "late"])
def test_the_first_tick_at_or_after_until_enters_sleeping_and_ends_the_encounter(
    at: float, manual: bool, end_reason: EndReason
) -> None:
    ms = cooling(released=True, manual=manual)

    waiting, actions = step(ms, Tick(uid=UID_A), COOL_UNTIL - 0.01)
    assert without_status(actions) == ()
    assert waiting.phase == ms.phase

    nxt, actions = step(waiting, Tick(uid=UID_A), at)

    # Already released and dark, so no backstop Actions (R8.4).
    assert without_status(actions) == ended(end_reason)
    assert nxt.phase == state_machine.Sleeping(quiet_until=at + CONFIG.timing.pir_quiet_s)
    assert nxt.encounter is None
    assert (nxt.servos_released, nxt.lantern_level) == (True, 0.0)


def test_one_tick_past_both_deadlines_releases_before_entering_sleeping() -> None:
    nxt, actions = step(cooling(), Tick(uid=UID_A), COOL_UNTIL + 1)

    # The normal release comes first, so the R8.4 backstop is not needed.
    assert without_status(actions) == (*RELEASE, *ended(EndReason.COOLDOWN))
    assert nxt.state is State.SLEEPING
    assert nxt.encounter is None
    assert (nxt.servos_released, nxt.lantern_level) == (True, 0.0)


def test_publish_events_after_sleeping_carry_a_null_encounter_id() -> None:
    sleeping, actions = step(cooling(released=True), Tick(uid=UID_A), COOL_UNTIL)
    assert {event.encounter_id for event in published(actions)} == {ENCOUNTER_ID}

    nxt, actions = step(sleeping, AdapterError(code="adapter_failed", uid=UID_B), COOL_UNTIL + 1)

    error = ErrorReported(
        code=ErrorCode.ADAPTER_FAILED, message=state_machine.ADAPTER_ERROR_MESSAGE, ref_id=None
    )
    assert without_status(actions) == (PublishEvent(data=error, encounter_id=None),)
    assert nxt.encounter is None


# --- The R8.4 backstop: rest the doll whatever path led here ---------------------------------


@pytest.mark.parametrize(
    ("servos_released", "lantern_level"),
    [(False, 0.0), (True, 0.5), (False, 0.5)],
    ids=["servos-attached", "lantern-lit", "both"],
)
def test_entering_sleeping_releases_and_darkens_when_the_doll_is_not_at_rest(
    servos_released: bool, lantern_level: float
) -> None:
    # The cooldown release already happened, but a later GazeTarget or LanternFade (for
    # example a manual command) left the head attached or the lantern lit.
    ms = cooling(released=True, servos_released=servos_released, lantern_level=lantern_level)

    nxt, actions = step(ms, Tick(uid=UID_A), COOL_UNTIL)

    assert without_status(actions) == (*ended(EndReason.COOLDOWN), *BACKSTOP)
    assert nxt.state is State.SLEEPING
    assert nxt.encounter is None
    assert (nxt.servos_released, nxt.lantern_level) == (True, 0.0)


# ============================================================================================
# Offline behaviour (task 14.2): the Offline_Reactions, their reasons and the offline bounds
# ============================================================================================
#
# Every Offline_Reaction enters uncertain with the same three Actions: the state.changed
# announcement with its reason (R24.4, R9.8), the uncertain PlayLine and reaction.performed
# with offline: true (R9.4), in that order and in one step() call. snapshot.failed for the
# current snapshot publishes its error.reported first (R3.5). The timing tests drive whole
# Encounters with Ticks at most T apart and no Verdict, and check the line against the
# Offline_Bound_Disconnected and Offline_Bound_Silent of the default Config (R9.2, R9.3).

T = CONFIG.tick_s  # Tick_Lag, 0.1 s with the defaults
UNCERTAIN_LINE_ID = LINE_OF[Category.UNCERTAIN].id
TOLERANCE = 1e-9  # time comparisons, as in the property tests


def offline_reaction(
    from_state: State, reason: Reason, play_uid: str, encounter_id: str = ENCOUNTER_ID
) -> tuple[Action, ...]:
    """The exact Actions of an Offline_Reaction entered from ``from_state``."""
    return (
        PublishEvent(
            data=StateChanged(from_=from_state, to=State.UNCERTAIN, reason=reason),
            encounter_id=encounter_id,
        ),
        PlayLine(line_id=UNCERTAIN_LINE_ID, play_id=f"play-1-{play_uid}"),
        PublishEvent(
            data=ReactionPerformed(
                kind=Category.UNCERTAIN, line_id=UNCERTAIN_LINE_ID, offline=True
            ),
            encounter_id=encounter_id,
        ),
    )


def assert_offline_uncertain(ms: MachineState, play_uid: str, at: float) -> None:
    """``ms`` is uncertain, playing the line started at ``at`` with Play_Id ``play-1-<uid>``."""
    play_id = f"play-1-{play_uid}"
    line_deadline = at + CONFIG.timing.audio_timeout_s
    assert ms.phase == Uncertain(line=ReactionLine(play_id=play_id, deadline=line_deadline))
    assert ms.audio == (PendingAudio(play_id=play_id, busy_until=line_deadline),)
    assert ms.encounter is not None and ms.encounter.reacted


def snapshot_failed_error(code: str) -> PublishEvent:
    error_code = ErrorCode(code)
    return in_encounter(
        ErrorReported(
            code=error_code,
            message=state_machine.SNAPSHOT_FAILED_MESSAGES[error_code],
            ref_id=None,
        )
    )


def tick_uid(k: int) -> str:
    """The uid of the k-th Tick of an offline timing run; distinct from every other uid here."""
    return f"00000000-0000-4000-8000-{0x400 + k:012x}"


def ready_uid(k: int) -> str:
    """The uid of the ``snapshot.ready`` answering the k-th Tick's ``TakeSnapshot``."""
    return f"00000000-0000-4000-8000-{0x800 + k:012x}"


@dataclasses.dataclass(frozen=True)
class OfflineRun:
    ms: MachineState  # the state after the call that played the line
    line_at: float  # now of that call
    line_uid: str  # uid of that call
    line_actions: tuple[Action, ...]  # its Actions, without PublishStatus
    actions: tuple[Action, ...]  # every Action of the run after pir.rising, without status


def run_until_line(ms: MachineState, offset: float) -> OfflineRun:
    """Send Ticks at ``WAKE_AT + offset + k * T`` until a call emits ``PlayLine``.

    The cloud never sends a Verdict. A ``TakeSnapshot`` is answered with ``snapshot.ready``
    right away, so the cloud gets its picture and stays silent all the same. No
    ``servo.arrived`` is sent, so waking ends only on its deadline, the slowest way out.
    """
    collected: list[Action] = []
    horizon = WAKE_AT + CONFIG.offline_bound_silent_s + 1.0
    k = 0
    while True:
        at = WAKE_AT + offset + k * T
        assert at <= horizon, "no PlayLine within the horizon"
        uid = tick_uid(k)
        ms, actions = step(ms, Tick(uid=uid), at)
        collected.extend(without_status(actions))
        if any(isinstance(a, PlayLine) for a in actions):
            return OfflineRun(ms, at, uid, without_status(actions), tuple(collected))
        for snap in [a for a in actions if isinstance(a, TakeSnapshot)]:
            ready = SnapshotReady(
                snapshot_id=snap.snapshot_id, jpeg=JPEG, width=640, height=480, uid=ready_uid(k)
            )
            ms, more = step(ms, ready, at)
            collected.extend(without_status(more))
        k += 1


# Tick phases relative to the pir.rising: aligned with it, half a period off, and just under a
# full period off, where the Tick before each deadline misses it by a hair (the worst case).
TICK_OFFSETS = [T, T / 2, T - 1e-6]
TICK_OFFSET_IDS = ["aligned", "half", "worst"]


# --- The offline bounds (R9.1, R9.2, R9.3, R9.5) ---------------------------------------------


@pytest.mark.parametrize("offset", TICK_OFFSETS, ids=TICK_OFFSET_IDS)
def test_disconnected_at_start_the_line_comes_within_offline_bound_disconnected(
    offset: float,
) -> None:
    # The cloud counts as disconnected from startup (R9.1): base_state() never saw
    # cloud.connected.
    ms, _ = woken(connected=False)

    run = run_until_line(ms, offset)

    assert CONFIG.offline_bound_disconnected_s == pytest.approx(3.1)
    assert run.line_at - WAKE_AT <= CONFIG.offline_bound_disconnected_s + TOLERANCE
    assert run.line_actions == offline_reaction(State.WAKING, Reason.OFFLINE, run.line_uid, UID_A)
    assert_offline_uncertain(run.ms, run.line_uid, run.line_at)
    # waking is left straight for uncertain: no seeking, and no snapshot at all (R9.5).
    assert state_changes(run.actions) == (
        StateChanged(from_=State.WAKING, to=State.UNCERTAIN, reason=Reason.OFFLINE),
    )
    assert not any(isinstance(a, TakeSnapshot) for a in run.actions)


@pytest.mark.parametrize("offset", TICK_OFFSETS, ids=TICK_OFFSET_IDS)
def test_connected_but_silent_the_line_comes_within_offline_bound_silent(offset: float) -> None:
    ms, _ = woken(connected=True)

    run = run_until_line(ms, offset)

    assert CONFIG.offline_bound_silent_s == pytest.approx(11.2)
    assert run.line_at - WAKE_AT <= CONFIG.offline_bound_silent_s + TOLERANCE
    assert run.line_actions == offline_reaction(State.SEEKING, Reason.TIMEOUT, run.line_uid, UID_A)
    assert_offline_uncertain(run.ms, run.line_uid, run.line_at)
    assert state_changes(run.actions) == (
        StateChanged(from_=State.WAKING, to=State.SEEKING, reason=Reason.TIMEOUT),
        StateChanged(from_=State.SEEKING, to=State.UNCERTAIN, reason=Reason.TIMEOUT),
    )
    # One snapshot, captured and published; the cloud just never answers.
    assert sum(isinstance(a, TakeSnapshot) for a in run.actions) == 1
    captured = [e for e in published(run.actions) if isinstance(e.data, SnapshotCaptured)]
    assert len(captured) == 1


# --- Leaving waking while disconnected (R2.6, R9.8) ------------------------------------------


@pytest.mark.parametrize("cause", ["arrival", "tick-after-arrival", "deadline"])
def test_leaving_waking_disconnected_enters_uncertain_offline_whatever_the_cause(
    cause: str,
) -> None:
    ms, phase = woken(connected=False)
    arrival = ServoArrived(motion_id=phase.motion_id, uid=UID_B)
    if cause == "arrival":
        at = FADE_DONE
        nxt, actions = step(ms, arrival, at)
    elif cause == "tick-after-arrival":
        ms, _ = step(ms, arrival, FADE_DONE - 0.5)
        at = FADE_DONE
        nxt, actions = step(ms, Tick(uid=UID_B), at)
    else:
        at = WAKING_DEADLINE
        nxt, actions = step(ms, Tick(uid=UID_B), at)

    # The reason is offline, never arrived or timeout (first matching row of R24.4).
    assert without_status(actions) == offline_reaction(State.WAKING, Reason.OFFLINE, UID_B, UID_A)
    assert_offline_uncertain(nxt, UID_B, at)
    assert nxt.encounter is not None and nxt.encounter.attempt is None  # no snapshot (R9.5)
    assert nxt.cloud_connected is False


@pytest.mark.parametrize(
    ("connected_at_start", "change", "expected"),
    [
        (True, CloudDisconnected(uid=UID_A), State.UNCERTAIN),
        (False, CloudConnected(uid=UID_A), State.SEEKING),
    ],
    ids=["lost-during-waking", "found-during-waking"],
)
def test_the_connectivity_of_the_leaving_call_decides_where_waking_goes(
    connected_at_start: bool, change: Event, expected: State
) -> None:
    ms, _ = woken(connected=connected_at_start)
    ms, _ = step(ms, change, FADE_DONE - 1.0)  # recorded only (R2.7)

    nxt, actions = step(ms, Tick(uid=UID_B), WAKING_DEADLINE)

    assert nxt.state is expected
    if expected is State.UNCERTAIN:
        assert without_status(actions) == offline_reaction(
            State.WAKING, Reason.OFFLINE, UID_B, UID_A
        )
    else:
        assert without_status(actions) == entered_seeking(Reason.TIMEOUT, UID_B, UID_A)


# --- cloud.disconnected during seeking (R3.7, R9.8) ------------------------------------------


def test_cloud_disconnected_while_waiting_for_a_verdict_enters_uncertain_offline() -> None:
    ms = awaiting_verdict()
    at = NOW + 1

    nxt, actions = step(ms, CloudDisconnected(uid=UID_B), at)

    assert without_status(actions) == offline_reaction(State.SEEKING, Reason.OFFLINE, UID_B)
    assert_offline_uncertain(nxt, UID_B, at)
    assert nxt.cloud_connected is False
    # A Verdict that still arrives for the snapshot is ignored outside seeking (R3.4).
    late, actions = step(nxt, verdict(Verdict.FAMILY, face=FACE), at + 0.5)
    assert actions == ()
    assert late == nxt


def test_cloud_disconnected_during_a_scan_move_enters_uncertain_and_takes_no_snapshot() -> None:
    ms, target = scan_started(awaiting_verdict(), 0, NOW)
    at = NOW + 0.5

    nxt, actions = step(ms, CloudDisconnected(uid=UID_B), at)

    assert without_status(actions) == offline_reaction(State.SEEKING, Reason.OFFLINE, UID_B)
    assert_offline_uncertain(nxt, UID_B, at)
    # The scan move's arrival now changes nothing, so no TakeSnapshot follows (R9.5).
    later, actions = step(nxt, ServoArrived(motion_id=target.motion_id, uid=UID_A), at + 0.5)
    assert actions == ()
    assert later == nxt


# --- snapshot.failed for the current snapshot (R3.5) -----------------------------------------


@pytest.mark.parametrize("code", ["camera_failed", "snapshot_too_large"])
def test_snapshot_failed_for_the_current_snapshot_reports_it_then_reacts(code: str) -> None:
    ms = awaiting_verdict()
    at = NOW + 1
    failed = SnapshotFailed(snapshot_id=SNAP_ID, code=code, uid=UID_B)  # type: ignore[arg-type]

    nxt, actions = step(ms, failed, at)

    assert without_status(actions) == (
        snapshot_failed_error(code),
        *offline_reaction(State.SEEKING, Reason.ERROR, UID_B),
    )
    assert_offline_uncertain(nxt, UID_B, at)
    # The cloud is still connected; the doll just has no picture to send.
    assert nxt.cloud_connected is True


@pytest.mark.parametrize("code", ["camera_failed", "snapshot_too_large"])
def test_the_first_snapshot_failing_after_waking_reacts_in_the_same_call(code: str) -> None:
    ms, phase = woken(connected=True)
    seeking, actions = step(ms, ServoArrived(motion_id=phase.motion_id, uid=UID_B), FADE_DONE)
    snap = without_status(actions)[-1]
    assert isinstance(snap, TakeSnapshot)
    failed = SnapshotFailed(snapshot_id=snap.snapshot_id, code=code, uid=UID_A)  # type: ignore[arg-type]

    nxt, actions = step(seeking, failed, FADE_DONE + 0.6)

    error = snapshot_failed_error(code)
    assert without_status(actions) == (
        dataclasses.replace(error, encounter_id=UID_A),
        *offline_reaction(State.SEEKING, Reason.ERROR, UID_A, UID_A),
    )
    assert nxt.state is State.UNCERTAIN


@pytest.mark.parametrize("code", ["camera_failed", "snapshot_too_large"])
def test_snapshot_failed_during_a_scan_move_is_only_reported(code: str) -> None:
    # The processed attempt is not current while the scan move is pending (R3.9).
    ms, _ = scan_started(awaiting_verdict(), 0, NOW)
    failed = SnapshotFailed(snapshot_id=SNAP_ID, code=code, uid=UID_B)  # type: ignore[arg-type]

    nxt, actions = step(ms, failed, NOW + 0.5)

    assert without_status(actions) == (snapshot_failed_error(code),)
    assert (nxt.phase, nxt.encounter) == (ms.phase, ms.encounter)
    # The scan goes on and takes the next snapshot as usual.
    scan_ended(nxt, 1, NOW + 1, end="arrival")


# --- The attempt deadline without a Verdict (R3.6) -------------------------------------------


@pytest.mark.parametrize("late", [0.0, 0.05], ids=["at-deadline", "late-tick"])
def test_the_attempt_deadline_tick_enters_uncertain_offline_with_reason_timeout(
    late: float,
) -> None:
    ms = awaiting_verdict()
    deadline = VERDICT_ATTEMPT.deadline

    waiting, actions = step(ms, Tick(uid=UID_B), deadline - 0.01)
    assert without_status(actions) == ()
    assert (waiting.phase, waiting.encounter) == (ms.phase, ms.encounter)

    at = deadline + late
    nxt, actions = step(waiting, Tick(uid=UID_A), at)

    assert without_status(actions) == offline_reaction(State.SEEKING, Reason.TIMEOUT, UID_A)
    assert_offline_uncertain(nxt, UID_A, at)
    assert nxt.cloud_connected is True


def test_the_deadline_of_the_snapshot_after_a_scan_also_times_out() -> None:
    run = scanned(count=1)
    deadline = current_attempt(run.ms).deadline

    nxt, actions = step(run.ms, Tick(uid=UID_A), deadline)

    assert without_status(actions) == offline_reaction(State.SEEKING, Reason.TIMEOUT, UID_A)
    assert_offline_uncertain(nxt, UID_A, deadline)
    assert nxt.encounter is not None
    assert nxt.encounter.scans_run == 1


# ============================================================================================
# PIR debounce (task 15.2): bursts, edges outside sleeping, warm-up and Mode, end of cooldown
# ============================================================================================

# The HC-SR501 holds its output high for seconds and retriggers, so one visit produces many
# edges. The States are reached through real step() calls where the earlier sections have a
# builder: greeting, warning and uncertain through a Verdict, cooldown through the end of the
# uncertain line. A PIR edge is neither a Tick nor a State change, so the status rule of task
# 17.1 adds nothing to such a call and whole-state equality stays valid; Actions are still
# compared through without_status(). mode.set (task 16.1) is not used: Mode sleep is set on
# hand-built states.


def edge_uid(k: int) -> str:
    """The uid of the k-th PIR edge of a test; distinct from every other uid here."""
    return f"00000000-0000-4000-8000-{0xC00 + k:012x}"


def edge(rising: bool, k: int = 0) -> Event:
    return PirRising(uid=edge_uid(k)) if rising else PirFalling(uid=edge_uid(k))


def presences(actions: Iterable[Action]) -> list[PublishEvent]:
    """The ``presence.detected`` events of ``actions``."""
    return [event for event in published(actions) if isinstance(event.data, PresenceDetected)]


def cooldown_entered() -> MachineState:
    """Enter cooldown at COOL_AT through the real end of the uncertain line."""
    ms, play_id, _ = playing(Category.UNCERTAIN)
    ms, _ = step(ms, AudioFinished(play_id=play_id, uid=UID_B), COOL_AT)
    assert ms.state is State.COOLDOWN
    return ms


# Each non-sleeping State, its builder, and a now inside it before any of its deadlines.
IN_ENCOUNTER: list[tuple[State, Callable[[], MachineState], float]] = [
    (State.WAKING, lambda: woken()[0], WAKE_AT + 0.2),
    (State.SEEKING, awaiting_verdict, NOW + 0.2),
    (State.GAZING, lambda: gazing_after(Verdict.FAMILY), NOW + 0.2),
    (State.GREETING, lambda: reaction_entered(Category.FAMILY)[0], REACTION_AT + 0.2),
    (State.WARNING, lambda: reaction_entered(Category.STRANGER)[0], REACTION_AT + 0.2),
    (State.UNCERTAIN, lambda: reaction_entered(Category.UNCERTAIN)[0], REACTION_AT + 0.2),
    (State.COOLDOWN, cooldown_entered, COOL_AT + 0.2),
]


# --- Bursts with equal now (R11.1, R11.3) ----------------------------------------------------


def test_a_burst_of_pir_rising_with_equal_now_starts_one_encounter() -> None:
    first, first_actions = step(base_state(), edge(True, 0), WAKE_AT)
    assert first.state is State.WAKING
    assert len(presences(first_actions)) == 1

    ms = first
    for k in range(1, 6):
        ms, actions = step(ms, edge(True, k), WAKE_AT)
        assert without_status(actions) == ()
    # Same Encounter, same deadlines: the burst left the first call's state as it was.
    assert ms == first
    assert ms.encounter == Encounter(encounter_id=edge_uid(0))


def test_a_mixed_burst_with_equal_now_only_tracks_the_last_level() -> None:
    first, _ = step(base_state(), edge(True, 0), WAKE_AT)

    ms = first
    for k, rising in enumerate([False, True, False, True, False], start=1):
        ms, actions = step(ms, edge(rising, k), WAKE_AT)
        assert without_status(actions) == ()
        assert ms == dataclasses.replace(first, pir_high=rising)


# --- Edges in every State other than sleeping (R11.1, R11.2, R11.3) --------------------------


@pytest.mark.parametrize("level_before", [False, True], ids=["was-low", "was-high"])
@pytest.mark.parametrize("rising", [True, False], ids=["rising", "falling"])
@pytest.mark.parametrize(
    ("build", "at"),
    [(build, at) for _, build, at in IN_ENCOUNTER],
    ids=[state.value for state, _, _ in IN_ENCOUNTER],
)
def test_a_pir_edge_outside_sleeping_only_records_the_level(
    build: Callable[[], MachineState], at: float, rising: bool, level_before: bool
) -> None:
    ms = dataclasses.replace(build(), pir_high=level_before)

    nxt, actions = step(ms, edge(rising), at)

    # Same State, phase deadlines, Encounter and outputs; only the level changes.
    assert without_status(actions) == ()
    assert nxt == dataclasses.replace(ms, pir_high=rising)


def test_pir_edges_in_cooldown_do_not_delay_or_restart_the_cycle() -> None:
    plain = cooldown_entered()
    retriggered = plain
    for k, at in enumerate([COOL_AT + 1, COOL_AT + 5, COOL_UNTIL - 0.01]):
        retriggered, actions = step(retriggered, edge(True, k), at)
        assert without_status(actions) == ()

    # The release and the return to sleeping come at the same times as without the edges.
    for at in (GLIDE_DEADLINE, COOL_UNTIL):
        plain, plain_actions = step(plain, Tick(uid=UID_A), at)
        retriggered, actions = step(retriggered, Tick(uid=UID_A), at)
        assert without_status(actions) == without_status(plain_actions)
        assert (retriggered.phase, retriggered.encounter) == (plain.phase, plain.encounter)
    assert retriggered.state is State.SLEEPING


# --- Warm-up and Mode sleep in sleeping (R11.3, R11.5, R11.6) --------------------------------

WARM_AT = START + CONFIG.timing.pir_warmup_s


@pytest.mark.parametrize(
    ("ms", "at"),
    [
        (base_state(), START),  # the very first instant
        (base_state(), WARM_AT - 0.001),  # just before the warm-up ends
        (base_state(mode=Mode.SLEEP), WARM_AT + 10),  # warm, but Mode sleep
        (base_state(mode=Mode.SLEEP), START),  # both
    ],
    ids=["start", "just-before-warm", "mode-sleep", "mode-sleep-cold"],
)
def test_ignored_pir_edges_in_sleeping_only_record_the_level(ms: MachineState, at: float) -> None:
    for k, rising in enumerate([True, True, False, True]):
        before = ms
        ms, actions = step(ms, edge(rising, k), at)
        assert without_status(actions) == ()
        assert ms == dataclasses.replace(before, pir_high=rising)
    assert ms.state is State.SLEEPING
    assert ms.encounter is None


def test_edges_during_warm_up_do_not_hold_back_the_first_encounter() -> None:
    ms = base_state()
    for k, (rising, at) in enumerate([(True, START + 1), (False, START + 5), (True, WARM_AT - 1)]):
        ms, _ = step(ms, edge(rising, k), at)
    assert ms == dataclasses.replace(base_state(), pir_high=True)

    # The first rising edge once warm starts the Encounter, although the level was already high.
    nxt, actions = step(ms, edge(True, 9), WARM_AT)
    assert nxt.state is State.WAKING
    assert nxt.encounter == Encounter(encounter_id=edge_uid(9))
    assert [event.encounter_id for event in presences(actions)] == [edge_uid(9)]


@pytest.mark.parametrize("rising", [True, False], ids=["rising", "falling"])
def test_pir_edges_in_cooldown_with_mode_sleep_only_record_the_level(rising: bool) -> None:
    # The state a manual sleep would leave behind: Mode sleep, cooldown marked manual.
    ms = dataclasses.replace(cooling(manual=True), mode=Mode.SLEEP, pir_high=not rising)
    nxt, actions = step(ms, edge(rising), COOL_AT + 1)
    assert without_status(actions) == ()
    assert nxt == dataclasses.replace(ms, pir_high=rising)


# --- A PIR level that stays high through the end of cooldown (R11.4) -------------------------


@pytest.mark.parametrize(
    "high_since",
    ["encounter-start", "rising-in-cooldown"],
)
def test_a_pir_still_high_when_cooldown_ends_starts_nothing(high_since: str) -> None:
    if high_since == "encounter-start":
        # No falling edge since the pir.rising that started the Encounter.
        ms = dataclasses.replace(cooling(), pir_high=True)
    else:
        ms, actions = step(cooldown_entered(), edge(True), COOL_AT + 1)
        assert without_status(actions) == ()
    assert ms.pir_high is True

    ms, _ = step(ms, Tick(uid=UID_A), GLIDE_DEADLINE)
    nxt, actions = step(ms, Tick(uid=UID_A), COOL_UNTIL)

    # The call that enters sleeping ends the Encounter and starts no new one.
    assert nxt.state is State.SLEEPING
    assert nxt.encounter is None
    assert nxt.pir_high is True
    assert presences(actions) == []
    assert [change.to for change in state_changes(actions)] == [State.SLEEPING]

    # Later Ticks with the level still high start nothing either.
    for k, at in enumerate([COOL_UNTIL + 0.1, COOL_UNTIL + 5, COOL_UNTIL + 60]):
        nxt, actions = step(nxt, Tick(uid=edge_uid(10 + k)), at)
        assert without_status(actions) == ()
        assert nxt.state is State.SLEEPING
        assert nxt.encounter is None


def test_a_fresh_pir_rising_after_the_quiet_time_starts_the_next_encounter() -> None:
    sleeping, _ = step(cooling(released=True), Tick(uid=UID_A), COOL_UNTIL)
    assert sleeping.state is State.SLEEPING

    # A later step() call is enough, even with the level still recorded high.
    sleeping = dataclasses.replace(sleeping, pir_high=True)
    nxt, actions = step(sleeping, edge(True, 1), COOL_UNTIL + CONFIG.timing.pir_quiet_s)

    assert nxt.state is State.WAKING
    assert nxt.encounter == Encounter(encounter_id=edge_uid(1))
    assert [event.encounter_id for event in presences(actions)] == [edge_uid(1)]


@pytest.mark.parametrize("after", [0.0, 5.0, CONFIG.timing.pir_quiet_s - 0.01])
def test_a_pir_rising_within_the_quiet_time_starts_nothing(after: float) -> None:
    """The HC-SR501 retriggers every few seconds; a visit must not follow a visit at once."""
    sleeping, _ = step(cooling(released=True), Tick(uid=UID_A), COOL_UNTIL)
    nxt, actions = step(sleeping, edge(True, 1), COOL_UNTIL + after)
    assert nxt.state is State.SLEEPING
    assert nxt.encounter is None
    assert nxt.pir_high is True
    assert without_status(actions) == ()


def test_a_restart_has_no_quiet_time() -> None:
    """Only the end of an Encounter starts the quiet time; the warm-up covers a restart."""
    assert state_machine.Sleeping().quiet_until == 0.0


# ============================================================================================
# Manual commands (task 16.2): rejections, the stare, audio_busy, audioUrl, mode.set, gaze
# ============================================================================================

# Commands carry CMD_ID as their command id, which every rejection echoes as refId, and
# CMD_UID as the uid the Dispatcher stamps, so a Play_Id or Motion_Id they create ends in
# CMD_UID. A command is neither a Tick nor (except mode.set sleep) a State change, so the
# status rule of task 17.1 adds nothing to such a call; whole-state equality is used where no
# audio entry has passed its busy window, so the pruning of task 17.1 cannot change the result
# either. The Situation_Category comes from hand-built states without unfinished audio:
# gazing with a family or stranger Accepted_Verdict, and seeking before any Verdict.

CMD_ID = "00000000-0000-4000-8000-0000000000c1"
CMD_UID = "00000000-0000-4000-8000-0000000000d1"
CMD_PLAY_ID = f"play-1-{CMD_UID}"
CMD_MOTION_ID = f"motion-1-{CMD_UID}"
AUDIO_URL = "https://audio.example.com/hello.wav?token=secret-token-123"
UNKNOWN_LINE_ID = "not_cached_line"
CMD_AT = NOW + 1  # now of a command sent to a hand-built state
LINE_BUSY_S = CONFIG.timing.audio_timeout_s
URL_BUSY_S = CONFIG.timing.download_timeout_s + CONFIG.timing.audio_timeout_s
PAN_LIMIT = CONFIG.servo.pan_limit
TILT_LIMIT = CONFIG.servo.tilt_limit


def speak_line(line_id: str, *, uid: str = CMD_UID) -> Speak:
    return Speak(ref_id=CMD_ID, line_id=line_id, audio_url=None, uid=uid)


def speak_url(url: str = AUDIO_URL, *, uid: str = CMD_UID) -> Speak:
    return Speak(ref_id=CMD_ID, line_id=None, audio_url=url, uid=uid)


def gaze_cmd(pan_deg: float, tilt_deg: float) -> Gaze:
    return Gaze(ref_id=CMD_ID, pan_deg=pan_deg, tilt_deg=tilt_deg, uid=CMD_UID)


def lantern_cmd(level: float, fade_ms: int) -> Lantern:
    return Lantern(ref_id=CMD_ID, level=level, fade_ms=fade_ms, uid=CMD_UID)


def mode_cmd(mode: Mode) -> ModeSet:
    return ModeSet(ref_id=CMD_ID, mode=mode, uid=CMD_UID)


def rejection(code: ErrorCode, encounter_id: str | None = ENCOUNTER_ID) -> PublishEvent:
    """The single ``error.reported`` of a rejected command (R12.12)."""
    message = state_machine.REJECTION_MESSAGES[code]
    return PublishEvent(
        data=ErrorReported(code=code, message=message, ref_id=CMD_ID),
        encounter_id=encounter_id,
    )


def decided(accepted: AcceptedVerdict, **changes: object) -> MachineState:
    """gazing inside the hand-built Encounter with this Accepted_Verdict and no audio."""
    encounter = Encounter(encounter_id=ENCOUNTER_ID, accepted=accepted)
    phase = Gazing(motion_id="motion-1-gazing", deadline=NOW + 3)
    return in_phase(phase, encounter=encounter, cloud_connected=True, **changes)


def staring(*, busy: bool = False) -> MachineState:
    """warning during the stare, optionally with an earlier manual line still playing."""
    audio = (PendingAudio(play_id="play-1-earlier", busy_until=NOW + 12),) if busy else ()
    encounter = Encounter(encounter_id=ENCOUNTER_ID, accepted=AcceptedVerdict.STRANGER)
    return in_phase(WarningPhase(stare_until=NOW + 2), encounter=encounter, audio=audio)


SITUATIONS: dict[Category, Callable[[], MachineState]] = {
    Category.FAMILY: lambda: decided(AcceptedVerdict.FAMILY),
    Category.STRANGER: lambda: decided(AcceptedVerdict.STRANGER),
    Category.UNCERTAIN: awaiting_verdict,
}

# R13.4: family hears family and uncertain lines; stranger and uncertain only their own.
PERMITTED: dict[Category, frozenset[Category]] = {
    Category.FAMILY: frozenset({Category.FAMILY, Category.UNCERTAIN}),
    Category.STRANGER: frozenset({Category.STRANGER}),
    Category.UNCERTAIN: frozenset({Category.UNCERTAIN}),
}


def test_the_situation_builders_give_their_situation_category() -> None:
    for situation, build in SITUATIONS.items():
        ms = build()
        assert state_machine.situation_category(ms) is situation
        assert ms.audio == ()


# --- Each rejection, its code, its refId and its order (R12.3, R12.5, R12.6, R12.11, R12.12) -

FAMILY_ID = LINE_OF[Category.FAMILY].id
STRANGER_ID = LINE_OF[Category.STRANGER].id
UNCERTAIN_ID = LINE_OF[Category.UNCERTAIN].id

# (build, command, now, code, encounterId of the error). Several cases break more than one
# rule; the code is the first applicable one in the R12.12 order.
REJECTIONS: list[tuple[Callable[[], MachineState], Event, float, ErrorCode, str | None]] = [
    # unknown_line (R12.5), also ahead of every later rule.
    (
        SITUATIONS[Category.FAMILY],
        speak_line(UNKNOWN_LINE_ID),
        CMD_AT,
        ErrorCode.UNKNOWN_LINE,
        ENCOUNTER_ID,
    ),
    (
        lambda: staring(busy=True),
        speak_line(UNKNOWN_LINE_ID),
        CMD_AT,
        ErrorCode.UNKNOWN_LINE,
        ENCOUNTER_ID,
    ),
    (base_state, speak_line(UNKNOWN_LINE_ID), CMD_AT, ErrorCode.UNKNOWN_LINE, None),
    # speak_rejected for a line Category (R13.4) and for audioUrl (R13.3).
    (
        SITUATIONS[Category.FAMILY],
        speak_line(STRANGER_ID),
        CMD_AT,
        ErrorCode.SPEAK_REJECTED,
        ENCOUNTER_ID,
    ),
    (SITUATIONS[Category.UNCERTAIN], speak_url(), CMD_AT, ErrorCode.SPEAK_REJECTED, ENCOUNTER_ID),
    (base_state, speak_url(), CMD_AT, ErrorCode.SPEAK_REJECTED, None),
    # speak_rejected ahead of command_rejected_state during the stare.
    (
        lambda: staring(busy=True),
        speak_line(FAMILY_ID),
        CMD_AT,
        ErrorCode.SPEAK_REJECTED,
        ENCOUNTER_ID,
    ),
    (staring, speak_url(), CMD_AT, ErrorCode.SPEAK_REJECTED, ENCOUNTER_ID),
    # command_rejected_state for speak during the stare (R12.11), ahead of audio_busy.
    (staring, speak_line(STRANGER_ID), CMD_AT, ErrorCode.COMMAND_REJECTED_STATE, ENCOUNTER_ID),
    (
        lambda: staring(busy=True),
        speak_line(STRANGER_ID),
        CMD_AT,
        ErrorCode.COMMAND_REJECTED_STATE,
        ENCOUNTER_ID,
    ),
    # command_rejected_state for gaze and lantern while resting (R12.3).
    (base_state, gaze_cmd(5.0, 5.0), CMD_AT, ErrorCode.COMMAND_REJECTED_STATE, None),
    (base_state, lantern_cmd(0.5, 100), CMD_AT, ErrorCode.COMMAND_REJECTED_STATE, None),
    (cooling, gaze_cmd(5.0, 5.0), COOL_AT + 1, ErrorCode.COMMAND_REJECTED_STATE, ENCOUNTER_ID),
    (cooling, lantern_cmd(0.5, 100), COOL_AT + 1, ErrorCode.COMMAND_REJECTED_STATE, ENCOUNTER_ID),
    # audio_busy while the Reaction line plays (R12.6).
    (
        lambda: playing(Category.FAMILY)[0],
        speak_line(UNCERTAIN_ID),
        REACTION_AT + 1,
        ErrorCode.AUDIO_BUSY,
        ENCOUNTER_ID,
    ),
    (
        lambda: playing(Category.UNCERTAIN)[0],
        speak_line(UNCERTAIN_ID),
        REACTION_AT + 1,
        ErrorCode.AUDIO_BUSY,
        ENCOUNTER_ID,
    ),
    (
        lambda: playing(Category.STRANGER)[0],
        speak_line(STRANGER_ID),
        STARE_UNTIL + 1,
        ErrorCode.AUDIO_BUSY,
        ENCOUNTER_ID,
    ),
    (
        lambda: playing(Category.FAMILY)[0],
        speak_url(),
        REACTION_AT + 1,
        ErrorCode.AUDIO_BUSY,
        ENCOUNTER_ID,
    ),
]
REJECTION_IDS = [
    "unknown-line",
    "unknown-line-first",
    "unknown-line-sleeping",
    "stranger-line-to-family",
    "url-uncertain",
    "url-sleeping",
    "family-line-in-stare",
    "url-in-stare",
    "stare",
    "stare-before-busy",
    "gaze-sleeping",
    "lantern-sleeping",
    "gaze-cooldown",
    "lantern-cooldown",
    "busy-greeting",
    "busy-uncertain",
    "busy-warning",
    "busy-url-greeting",
]


@pytest.mark.parametrize(
    ("build", "command", "at", "code", "encounter_id"), REJECTIONS, ids=REJECTION_IDS
)
def test_a_rejected_command_reports_one_error_with_its_ref_id_and_changes_nothing(
    build: Callable[[], MachineState],
    command: Event,
    at: float,
    code: ErrorCode,
    encounter_id: str | None,
) -> None:
    ms = build()

    nxt, actions = step(ms, command, at)

    assert without_status(actions) == (rejection(code, encounter_id),)
    # No State, Mode, deadline, Encounter, output or audio entry changes (R12.12).
    assert nxt == ms


def test_rejection_messages_name_no_line_text_url_or_line_id() -> None:
    forbidden = [AUDIO_URL, "audio.example.com", "secret-token", "https", UNKNOWN_LINE_ID]
    for line in LINES:
        forbidden += [line.id, line.ja, line.en, line.wav]
    for code in (
        ErrorCode.UNKNOWN_LINE,
        ErrorCode.SPEAK_REJECTED,
        ErrorCode.COMMAND_REJECTED_STATE,
        ErrorCode.AUDIO_BUSY,
    ):
        message = state_machine.REJECTION_MESSAGES[code]
        assert 0 < len(message) <= 200
        assert not [text for text in forbidden if text in message], code


# --- speak during the stare (R7.3, R12.11) ---------------------------------------------------


def test_speak_is_refused_for_the_whole_stare_and_then_waits_for_the_stranger_line() -> None:
    ms, _ = reaction_entered(Category.STRANGER)
    stranger = speak_line(STRANGER_ID)

    # Also at and after stare_until, until the Tick that plays the stranger line arrives.
    for at in (REACTION_AT, REACTION_AT + 1, STARE_UNTIL, STARE_UNTIL + 0.05):
        nxt, actions = step(ms, stranger, at)
        assert without_status(actions) == (rejection(ErrorCode.COMMAND_REJECTED_STATE),)
        assert nxt == ms

    # Once the stranger line plays, the stare rule no longer applies; the line keeps audio busy.
    ms, _ = step(ms, Tick(uid=UID_A), STARE_UNTIL)
    nxt, actions = step(ms, stranger, STARE_UNTIL + 0.05)
    assert without_status(actions) == (rejection(ErrorCode.AUDIO_BUSY),)
    assert nxt == ms


# --- Permitted lines (R12.4, R13.4, R13.5) ---------------------------------------------------


@pytest.mark.parametrize("line_category", list(Category))
@pytest.mark.parametrize("situation", list(Category))
def test_a_cached_line_plays_only_when_its_category_is_permitted(
    situation: Category, line_category: Category
) -> None:
    ms = SITUATIONS[situation]()
    line_id = LINE_OF[line_category].id

    nxt, actions = step(ms, speak_line(line_id), CMD_AT)

    if line_category in PERMITTED[situation]:
        assert without_status(actions) == (PlayLine(line_id=line_id, play_id=CMD_PLAY_ID),)
        # Only the busy entry is added: State, phase, deadlines and Encounter stay (R12.4).
        pending = PendingAudio(play_id=CMD_PLAY_ID, busy_until=CMD_AT + LINE_BUSY_S)
        assert nxt == dataclasses.replace(ms, audio=(pending,))
    else:
        assert without_status(actions) == (rejection(ErrorCode.SPEAK_REJECTED),)
        assert nxt == ms


# --- audioUrl only for family (R13.2, R13.3) -------------------------------------------------


def ms_encounter_id(ms: MachineState) -> str | None:
    return ms.encounter.encounter_id if ms.encounter is not None else None


@pytest.mark.parametrize(
    "build",
    [
        base_state,
        awaiting_verdict,
        lambda: decided(AcceptedVerdict.STRANGER),
        lambda: in_phase(
            Seeking(),
            encounter=Encounter(encounter_id=ENCOUNTER_ID, accepted=AcceptedVerdict.NO_FACE),
        ),
        lambda: in_phase(
            Uncertain(line=state_machine.NO_REACTION_LINE),
            encounter=Encounter(encounter_id=ENCOUNTER_ID, accepted=AcceptedVerdict.UNCERTAIN),
        ),
    ],
    ids=["no-encounter", "no-verdict", "stranger", "no-face", "uncertain"],
)
def test_audio_url_is_rejected_unless_the_accepted_verdict_is_family(
    build: Callable[[], MachineState],
) -> None:
    ms = build()

    nxt, actions = step(ms, speak_url(), CMD_AT)

    assert without_status(actions) == (rejection(ErrorCode.SPEAK_REJECTED, ms_encounter_id(ms)),)
    assert not [a for a in actions if isinstance(a, PlayAudioUrl)]
    assert nxt == ms


def test_audio_url_plays_for_family_and_keeps_the_state() -> None:
    ms = decided(AcceptedVerdict.FAMILY)

    nxt, actions = step(ms, speak_url(), CMD_AT)

    assert without_status(actions) == (PlayAudioUrl(url=AUDIO_URL, play_id=CMD_PLAY_ID),)
    pending = PendingAudio(play_id=CMD_PLAY_ID, busy_until=CMD_AT + URL_BUSY_S)
    assert nxt == dataclasses.replace(ms, audio=(pending,))


# --- audio_busy windows (R12.6) --------------------------------------------------------------


@pytest.mark.parametrize(
    ("first", "situation", "busy_s", "busy_at"),
    [
        (speak_line(UNCERTAIN_ID, uid=UID_A), Category.UNCERTAIN, LINE_BUSY_S, [0.0, 6.0]),
        # The download time extends the window past the playback bound alone.
        (speak_url(uid=UID_A), Category.FAMILY, URL_BUSY_S, [0.0, 6.0, LINE_BUSY_S]),
    ],
    ids=["PlayLine", "PlayAudioUrl"],
)
def test_speak_is_audio_busy_until_the_window_of_the_earlier_speak_ends(
    first: Speak, situation: Category, busy_s: float, busy_at: list[float]
) -> None:
    ms, _ = step(SITUATIONS[situation](), first, CMD_AT)
    end = CMD_AT + busy_s
    assert ms.audio == (PendingAudio(play_id=f"play-1-{UID_A}", busy_until=end),)
    follow = speak_line(UNCERTAIN_ID)  # permitted in both situations

    for at in [CMD_AT + offset for offset in busy_at] + [math.nextafter(end, 0.0)]:
        nxt, actions = step(ms, follow, at)
        assert without_status(actions) == (rejection(ErrorCode.AUDIO_BUSY),), at
        assert nxt == ms

    # At the end of the window the next speak plays, although no audio.* answer arrived.
    nxt, actions = step(ms, follow, end)
    assert without_status(actions) == (PlayLine(line_id=UNCERTAIN_ID, play_id=CMD_PLAY_ID),)
    assert PendingAudio(play_id=CMD_PLAY_ID, busy_until=end + LINE_BUSY_S) in nxt.audio
    assert nxt.phase == ms.phase


@pytest.mark.parametrize(
    "result",
    [
        AudioFinished(play_id=f"play-1-{UID_A}", uid=UID_B),
        AudioFailed(play_id=f"play-1-{UID_A}", code="audio_failed", uid=UID_B),
        AudioFailed(play_id=f"play-1-{UID_A}", code="interrupted", uid=UID_B),
    ],
    ids=["finished", "failed", "interrupted"],
)
def test_an_audio_result_ends_the_busy_window_early(result: Event) -> None:
    ms, _ = step(awaiting_verdict(), speak_line(UNCERTAIN_ID, uid=UID_A), CMD_AT)
    ms, _ = step(ms, result, CMD_AT + 1)
    assert ms.audio == ()

    _, actions = step(ms, speak_line(UNCERTAIN_ID), CMD_AT + 1)

    assert without_status(actions) == (PlayLine(line_id=UNCERTAIN_ID, play_id=CMD_PLAY_ID),)


def test_the_reaction_line_plays_over_a_manual_line_whose_end_does_not_end_the_reaction() -> None:
    # A manual line in seeking, then a family Verdict without a face enters greeting.
    ms, _ = step(awaiting_verdict(), speak_line(UNCERTAIN_ID, uid=UID_A), NOW)
    manual = f"play-1-{UID_A}"
    ms, actions = step(ms, verdict(Verdict.FAMILY), REACTION_AT)

    # The Reaction line is emitted although the manual line is unfinished (R12.6).
    assert ms.state is State.GREETING
    assert PlayLine(line_id=FAMILY_ID, play_id=ENTRY_PLAY_ID) in without_status(actions)
    assert [pending.play_id for pending in ms.audio] == [manual, ENTRY_PLAY_ID]

    # The manual line is not the Reaction line: its end leaves greeting and its deadlines.
    nxt, actions = step(ms, AudioFinished(play_id=manual, uid=UID_B), REACTION_AT + 1)
    assert without_status(actions) == ()
    assert nxt.state is State.GREETING
    assert nxt.phase == ms.phase
    assert [pending.play_id for pending in nxt.audio] == [ENTRY_PLAY_ID]


# --- Manual gaze and lantern (R12.1, R12.2) --------------------------------------------------

# Each State with an Encounter outside cooldown, its builder, and a now inside it.
ACTIVE = [entry for entry in IN_ENCOUNTER if entry[0] is not State.COOLDOWN]
ACTIVE_IDS = [state.value for state, _, _ in ACTIVE]


@pytest.mark.parametrize(
    ("pan", "tilt", "expected"),
    [
        (12.0, -5.0, (12.0, -5.0)),
        (100.0, -100.0, (PAN_LIMIT, -TILT_LIMIT)),
        (-1e9, 1e9, (-PAN_LIMIT, TILT_LIMIT)),
    ],
    ids=["inside", "beyond", "far-beyond"],
)
@pytest.mark.parametrize(("state", "build", "at"), ACTIVE, ids=ACTIVE_IDS)
def test_a_manual_gaze_is_clamped_and_keeps_the_state_and_deadlines(
    state: State,
    build: Callable[[], MachineState],
    at: float,
    pan: float,
    tilt: float,
    expected: tuple[float, float],
) -> None:
    ms = build()
    assert ms.state is state

    nxt, actions = step(ms, gaze_cmd(pan, tilt), at)

    assert without_status(actions) == (
        GazeTarget(pan_deg=expected[0], tilt_deg=expected[1], motion_id=CMD_MOTION_ID),
    )
    # The phase still waits for its own Motion_Id with its own deadlines.
    assert nxt == dataclasses.replace(ms, gaze=expected, servos_released=False)


@pytest.mark.parametrize(
    ("level", "fade_ms", "expected"),
    [
        (0.25, 400, LanternFade(level=0.25, fade_ms=400)),
        (1.5, 20_000, LanternFade(level=1.0, fade_ms=10_000)),
        (-0.5, -5, LanternFade(level=0.0, fade_ms=0)),
    ],
    ids=["inside", "above", "below"],
)
@pytest.mark.parametrize(("state", "build", "at"), ACTIVE, ids=ACTIVE_IDS)
def test_a_manual_lantern_is_clamped_and_keeps_the_state_and_deadlines(
    state: State,
    build: Callable[[], MachineState],
    at: float,
    level: float,
    fade_ms: int,
    expected: LanternFade,
) -> None:
    ms = build()
    assert ms.state is state

    nxt, actions = step(ms, lantern_cmd(level, fade_ms), at)

    assert without_status(actions) == (expected,)
    assert nxt == dataclasses.replace(ms, lantern_level=expected.level)


def test_a_manual_gaze_in_waking_is_used_by_the_first_snapshot() -> None:
    ms, phase = woken()
    ms, _ = step(ms, gaze_cmd(12.0, -5.0), WAKE_AT + 0.5)
    assert ms.phase == phase  # still waiting for the waking Motion_Id

    # The manual motion's arrival is not the one waking waits for.
    same, actions = step(ms, ServoArrived(motion_id=CMD_MOTION_ID, uid=UID_B), FADE_DONE)
    assert without_status(actions) == ()
    assert same == ms

    # The waking arrival starts the first snapshot at the manual angles (R3.1).
    nxt, actions = step(ms, ServoArrived(motion_id=phase.motion_id, uid=UID_B), FADE_DONE)
    assert without_status(actions) == entered_seeking(Reason.ARRIVED, UID_B, UID_A)
    attempt = current_attempt(nxt)
    assert (attempt.pan_deg, attempt.tilt_deg) == (12.0, -5.0)


def test_a_manual_gaze_during_a_scan_move_is_used_by_the_next_snapshot() -> None:
    ms, scan_target = scan_started(awaiting_verdict(), 1, NOW + 1)
    ms, _ = step(ms, gaze_cmd(-7.0, 4.0), NOW + 1.5)

    nxt, actions = step(ms, ServoArrived(motion_id=scan_target.motion_id, uid=UID_B), NOW + 2)

    snapshots = [a for a in without_status(actions) if isinstance(a, TakeSnapshot)]
    assert snapshots == [TakeSnapshot(snapshot_id=f"snap-1-{UID_B}")]
    attempt = current_attempt(nxt)
    assert (attempt.pan_deg, attempt.tilt_deg) == (-7.0, 4.0)


# --- mode.set (R12.7, R12.8, R12.9, R8.3) ----------------------------------------------------


@pytest.mark.parametrize(("state", "build", "at"), ACTIVE, ids=ACTIVE_IDS)
def test_mode_sleep_during_an_encounter_ends_it_through_a_manual_cooldown(
    state: State, build: Callable[[], MachineState], at: float
) -> None:
    ms = build()
    assert ms.encounter is not None
    encounter_id = ms.encounter.encounter_id
    timing = CONFIG.timing

    nxt, actions = step(ms, mode_cmd(Mode.SLEEP), at)

    assert without_status(actions) == (
        PublishEvent(
            data=StateChanged(from_=state, to=State.COOLDOWN, reason=Reason.MANUAL),
            encounter_id=encounter_id,
        ),
        GazeTarget(pan_deg=0.0, tilt_deg=0.0, motion_id=CMD_MOTION_ID),
    )
    assert nxt.mode is Mode.SLEEP
    assert nxt.phase == Cooldown(
        motion_id=CMD_MOTION_ID,
        glide_deadline=at + timing.glide_timeout_s,
        until=at + timing.cooldown_s,
        manual=True,
    )
    assert nxt.encounter == ms.encounter

    # The cooldown ends as usual, and encounter.ended says manual (R8.3).
    nxt, _ = step(nxt, Tick(uid=UID_A), at + timing.glide_timeout_s)
    nxt, actions = step(nxt, Tick(uid=UID_B), at + timing.cooldown_s)
    assert published(actions) == (
        PublishEvent(
            data=StateChanged(
                from_=State.COOLDOWN, to=State.SLEEPING, reason=Reason.COOLDOWN_DONE
            ),
            encounter_id=encounter_id,
        ),
        PublishEvent(data=EncounterEnded(reason=EndReason.MANUAL), encounter_id=encounter_id),
    )
    assert (nxt.state, nxt.mode, nxt.encounter) == (State.SLEEPING, Mode.SLEEP, None)

    # Mode sleep then ignores presence (R11.6).
    after, actions = step(nxt, PirRising(uid=CMD_UID), at + timing.cooldown_s + 1)
    assert without_status(actions) == ()
    assert after.state is State.SLEEPING


@pytest.mark.parametrize(
    ("build", "at", "mode"),
    [
        (base_state, NOW, Mode.SLEEP),
        (cooling, COOL_AT + 1, Mode.SLEEP),
        (
            lambda: dataclasses.replace(cooling(manual=True), mode=Mode.SLEEP),
            COOL_AT + 1,
            Mode.GUARD,
        ),
        (awaiting_verdict, CMD_AT, Mode.GUARD),
        (
            lambda: dataclasses.replace(cooling(manual=True), mode=Mode.SLEEP),
            COOL_AT + 1,
            Mode.SLEEP,
        ),
        (lambda: base_state(mode=Mode.SLEEP), NOW, Mode.SLEEP),
    ],
    ids=[
        "sleep-in-sleeping",
        "sleep-in-cooldown",
        "guard-in-manual-cooldown",
        "repeat-guard-in-seeking",
        "repeat-sleep-in-cooldown",
        "repeat-sleep-in-sleeping",
    ],
)
def test_mode_set_in_sleeping_or_cooldown_or_repeating_the_mode_only_records_it(
    build: Callable[[], MachineState], at: float, mode: Mode
) -> None:
    ms = build()

    nxt, actions = step(ms, mode_cmd(mode), at)

    assert without_status(actions) == ()
    assert nxt == dataclasses.replace(ms, mode=mode)


@pytest.mark.parametrize(
    ("manual", "mode", "end_reason"),
    [(False, Mode.SLEEP, EndReason.COOLDOWN), (True, Mode.GUARD, EndReason.MANUAL)],
    ids=["sleep-in-normal-cooldown", "guard-in-manual-cooldown"],
)
def test_mode_set_during_cooldown_keeps_how_the_cooldown_started(
    manual: bool, mode: Mode, end_reason: EndReason
) -> None:
    ms = cooling(released=True, manual=manual)
    if manual:
        ms = dataclasses.replace(ms, mode=Mode.SLEEP)
    ms, _ = step(ms, mode_cmd(mode), COOL_AT + 1)

    nxt, actions = step(ms, Tick(uid=UID_A), COOL_UNTIL)

    assert published(actions) == ended(end_reason)
    assert (nxt.state, nxt.mode) == (State.SLEEPING, mode)


def test_mode_guard_starts_no_encounter_until_a_later_pir_rising() -> None:
    # The PIR level is already high, as when someone stands in front of the sleeping doll.
    ms = base_state(mode=Mode.SLEEP, pir_high=True)

    ms, actions = step(ms, mode_cmd(Mode.GUARD), NOW)
    assert without_status(actions) == ()
    assert ms == base_state(pir_high=True)

    ms, actions = step(ms, Tick(uid=UID_A), NOW + 0.1)
    assert presences(actions) == []
    assert (ms.state, ms.encounter) == (State.SLEEPING, None)

    nxt, actions = step(ms, PirRising(uid=UID_B), NOW + 0.2)
    assert nxt.state is State.WAKING
    assert [event.encounter_id for event in presences(actions)] == [UID_B]


# ============================================================================================
# Status reports (task 17.2): triggers, one per call, the data, the camera indicator
# ============================================================================================
#
# finalize() appends one PublishStatus as the last Action when the State changed,
# cameraActive flipped, on the first Tick since the Start_Time, or on a Tick at least
# status_interval_s after the last report (R1.8, R23.1, R23.5). The hand-built states below
# set first_tick_seen and last_status_at where a test needs a Tick that reports nothing.

INTERVAL_S = CONFIG.timing.status_interval_s  # 60 s with the defaults
WATCH = CameraWatch(snapshot_id=SNAP_ID, deadline=NOW + CONFIG.timing.verdict_timeout_s)


def report(ms: MachineState, now: float, **changes: object) -> StatusReport:
    """The StatusReport expected for ``ms`` at ``now``, built field by field from R23.4."""
    data = StatusReport(
        state=ms.state,
        mode=ms.mode,
        pan_deg=ms.gaze[0],
        tilt_deg=ms.gaze[1],
        lantern=ms.lantern_level,
        camera_active=ms.camera is not None,
        mic_active=False,
        motion_enabled=ms.config.motion.motion_enabled,
        uptime_sec=math.floor(now - ms.start_time),
        agent_version=ms.agent_version,
    )
    return dataclasses.replace(data, **changes) if changes else data


def the_status(actions: tuple[Action, ...]) -> StatusReport:
    """The data of the one PublishStatus of the call, which must be the last Action (R23.5)."""
    statuses = [action for action in actions if isinstance(action, PublishStatus)]
    assert len(statuses) == 1, f"expected one PublishStatus, got {actions!r}"
    assert actions[-1] is statuses[0], "PublishStatus must be the last Action"
    return statuses[0].data


def reported_recently(ms: MachineState, at: float = NOW) -> MachineState:
    """``ms`` after its first Tick and a report at ``at``, so a Tick only reports when due."""
    return dataclasses.replace(ms, first_tick_seen=True, last_status_at=at)


# --- The first Tick (R23.1) ------------------------------------------------------------------


def test_the_first_tick_reports_once_and_a_quiet_tick_after_it_returns_the_same_state() -> None:
    ms = base_state()
    at = START + 0.1

    first, actions = step(ms, Tick(uid=UID_A), at)

    assert actions == (PublishStatus(data=report(ms, at)),)
    assert first == dataclasses.replace(ms, first_tick_seen=True, last_status_at=at)

    # Nothing is due on the next Tick, so the call changes nothing at all (R1.9).
    again, actions = step(first, Tick(uid=UID_B), at + 0.1)
    assert actions == ()
    assert again is first


def test_an_event_other_than_a_tick_is_not_the_first_tick() -> None:
    ms = base_state()
    nxt, actions = step(ms, PirFalling(uid=UID_A), START + 0.1)
    assert actions == ()
    assert nxt.first_tick_seen is False


# --- The interval (R23.1) --------------------------------------------------------------------


def test_a_tick_reports_once_status_interval_s_has_passed_since_the_last_report() -> None:
    ms = reported_recently(base_state())

    early, actions = step(ms, Tick(uid=UID_A), NOW + INTERVAL_S - 0.001)
    assert actions == ()
    assert early is ms

    due, actions = step(early, Tick(uid=UID_B), NOW + INTERVAL_S)
    assert actions == (PublishStatus(data=report(ms, NOW + INTERVAL_S)),)
    assert due.last_status_at == NOW + INTERVAL_S

    # The next interval is measured from this report.
    _, actions = step(due, Tick(uid=UID_A), NOW + 2 * INTERVAL_S - 0.001)
    assert actions == ()


def test_a_report_on_a_state_change_restarts_the_interval_but_is_not_the_first_tick() -> None:
    ms, _ = woken()  # the pir.rising call reported the State change at WAKE_AT
    assert ms.last_status_at == WAKE_AT
    assert ms.first_tick_seen is False  # that call was not a Tick


def test_only_a_tick_reports_on_the_interval() -> None:
    ms = reported_recently(base_state())
    nxt, actions = step(ms, PirFalling(uid=UID_A), NOW + 2 * INTERVAL_S)
    assert actions == ()
    assert nxt.last_status_at == NOW


def test_a_reconnect_reports_at_once() -> None:
    """The broker published the last will; a fresh report clears "offline" (M5)."""
    ms = reported_recently(base_state())
    nxt, actions = step(ms, CloudConnected(uid=UID_A), NOW + 1)
    assert actions == (PublishStatus(data=report(nxt, NOW + 1)),)
    assert nxt.last_status_at == NOW + 1
    assert nxt.cloud_connected is True


# --- State changes (R1.8, R23.1) -------------------------------------------------------------


def test_a_state_change_reports_the_state_at_the_end_of_the_call() -> None:
    nxt, actions = step(base_state(), PirRising(uid=UID_A), WAKE_AT)

    assert the_status(actions) == report(nxt, WAKE_AT)
    assert the_status(actions).state is State.WAKING
    assert the_status(actions).lantern == CONFIG.lantern.lantern_wake_level
    assert nxt.last_status_at == WAKE_AT


def test_every_trigger_at_once_still_gives_one_status_with_the_final_data() -> None:
    # The waking deadline Tick changes the State, starts a snapshot (cameraActive flips on),
    # is the first Tick of the process and comes after the interval.
    ms, _ = woken()
    at = WAKE_AT + INTERVAL_S
    assert at >= WAKING_DEADLINE

    nxt, actions = step(ms, Tick(uid=UID_B), at)

    assert without_status(actions) == entered_seeking(Reason.TIMEOUT, UID_B, UID_A)
    assert the_status(actions) == report(nxt, at)
    assert (the_status(actions).state, the_status(actions).camera_active) == (State.SEEKING, True)
    assert (nxt.first_tick_seen, nxt.last_status_at) == (True, at)


# --- The camera indicator (R23.1, R23.2) -----------------------------------------------------


def test_a_take_snapshot_without_a_state_change_reports_camera_active() -> None:
    ms, scan_target = scan_started(awaiting_verdict(), 0, NOW)
    assert ms.camera is None
    at = NOW + 1

    nxt, actions = step(ms, ServoArrived(motion_id=scan_target.motion_id, uid=scan_uid(1)), at)

    assert without_status(actions) == (TakeSnapshot(snapshot_id=f"snap-1-{scan_uid(1)}"),)
    assert nxt.camera == CameraWatch(
        snapshot_id=f"snap-1-{scan_uid(1)}", deadline=at + CONFIG.timing.verdict_timeout_s
    )
    assert the_status(actions) == report(nxt, at, camera_active=True)
    assert nxt.state is State.SEEKING


@pytest.mark.parametrize(
    "result",
    [
        SnapshotReady(snapshot_id=SNAP_ID, jpeg=JPEG, width=640, height=480, uid=UID_B),
        SnapshotFailed(snapshot_id=SNAP_ID, code="camera_failed", uid=UID_B),
    ],
    ids=["ready", "failed"],
)
def test_the_watched_result_in_seeking_clears_the_indicator(result: Event) -> None:
    ms = reported_recently(awaiting_verdict(camera=WATCH))

    nxt, actions = step(ms, result, NOW + 1)

    assert nxt.camera is None
    assert the_status(actions) == report(nxt, NOW + 1, camera_active=False)


def test_a_late_result_outside_seeking_keeps_the_indicator_until_the_deadline_tick() -> None:
    gazing = Gazing(motion_id="motion-1-gazing", deadline=WATCH.deadline + 10)
    ms = reported_recently(in_phase(gazing, encounter=CURRENT_ENCOUNTER, camera=WATCH))
    ready = SnapshotReady(snapshot_id=SNAP_ID, jpeg=JPEG, width=640, height=480, uid=UID_A)

    # A late result adds no Action (R3.8), so the indicator stays on.
    late, actions = step(ms, ready, NOW + 1)
    assert actions == ()
    assert late.camera == WATCH

    failed = SnapshotFailed(snapshot_id=SNAP_ID, code="camera_failed", uid=UID_A)
    late, actions = step(late, failed, NOW + 2)
    assert not any(isinstance(action, PublishStatus) for action in actions)
    assert late.camera == WATCH

    before, actions = step(late, Tick(uid=UID_B), WATCH.deadline - 0.001)
    assert actions == ()
    assert before.camera == WATCH

    # The first Tick at the deadline clears it and reports the change.
    cleared, actions = step(before, Tick(uid=UID_B), WATCH.deadline)
    assert actions == (PublishStatus(data=report(cleared, WATCH.deadline)),)
    assert cleared.camera is None
    assert the_status(actions).camera_active is False
    assert cleared.state is State.GAZING


# --- The data (R23.3, R23.4) -----------------------------------------------------------------


def test_the_status_data_follows_r23_4_field_by_field() -> None:
    config = dataclasses.replace(CONFIG, motion=MotionConfig(motion_enabled=True))
    ms = initial_state(config=config, lines=LINES, agent_version="1.2.3", start_time=START)
    ms = dataclasses.replace(ms, mode=Mode.SLEEP, gaze=(12.5, -4.0), lantern_level=0.3)
    at = START + 42.75

    _, actions = step(ms, Tick(uid=UID_A), at)

    assert the_status(actions) == StatusReport(
        state=State.SLEEPING,
        mode=Mode.SLEEP,
        pan_deg=12.5,
        tilt_deg=-4.0,
        lantern=0.3,
        camera_active=False,
        mic_active=False,
        motion_enabled=True,
        uptime_sec=42,
        agent_version="1.2.3",
    )


@pytest.mark.parametrize(
    ("offset", "uptime"),
    [(0.0, 0), (0.999, 0), (1.0, 1), (59.5, 59), (3600.25, 3600)],
)
def test_uptime_sec_is_the_floor_of_the_time_since_start(offset: float, uptime: int) -> None:
    _, actions = step(base_state(), Tick(uid=UID_A), START + offset)
    assert the_status(actions).uptime_sec == uptime


def test_publish_status_carries_no_encounter_id() -> None:
    # Only data: the status.report envelope can only carry encounterId null (R20.4).
    assert [f.name for f in dataclasses.fields(PublishStatus)] == ["data"]
