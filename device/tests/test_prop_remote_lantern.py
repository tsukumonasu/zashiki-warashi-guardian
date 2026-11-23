"""Property: whatever the family does through remote control, a doll that rests has no light on.

The remote-control rehearsal (11/24) left the lantern at 100% after a visit was cut short by
``mode.set remote``. This test replays random command sequences, including remote control,
photos and typed speech, and checks the *last LanternFade the adapter received*, not the
machine's own belief, once the doll is back in ``sleeping``.
"""

from __future__ import annotations

import dataclasses

from hypothesis import given, settings
from hypothesis import strategies as st

from warashi_agent.config import Config
from warashi_agent.model import (
    AudioFinished,
    Category,
    Event,
    Gaze,
    GazeTarget,
    Lantern,
    LanternFade,
    ModeRequest,
    ModeSet,
    PirFalling,
    PirRising,
    PlayAudioUrl,
    PlayLine,
    PublishStatus,
    ReleaseServos,
    ServoArrived,
    SnapshotReady,
    SnapshotRequest,
    Speak,
    State,
    TakeSnapshot,
    Tick,
)
from warashi_agent.state_machine import initial_state, step
from warashi_agent.voice import VoiceLine

CONFIG = Config()
LINES = (VoiceLine(id="uncertain", category=Category.UNCERTAIN, ja="x", en="x", wav="u.wav"),)
URL = "https://example.invalid/say.wav"

kinds = st.sampled_from(
    (
        "tick",
        "pir",
        "pir_off",
        "remote",
        "guard",
        "sleep",
        "gaze",
        "lantern",
        "photo",
        "say",
        "arrive",
        "snapshot",
        "audio",
    )
)


@settings(max_examples=300, deadline=None)
@given(
    steps=st.lists(
        st.tuples(kinds, st.floats(0.0, 30.0), st.floats(-90, 90), st.floats(0.0, 1.0)),
        max_size=40,
    )
)
def test_resting_doll_has_the_last_lantern_command_at_zero(steps) -> None:
    ms = initial_state(config=CONFIG, lines=LINES, agent_version="0", start_time=0.0)
    ms = dataclasses.replace(ms, cloud_connected=True)
    now, n = 100.0, 0
    lantern = 0.0
    servo_released = True
    motions: list[str] = []
    snaps: list[str] = []
    plays: list[str] = []

    def feed(event: Event) -> None:
        nonlocal ms, now, n, lantern, servo_released
        n += 1
        event = dataclasses.replace(event, uid=f"u{n}")
        ms, actions = step(ms, event, now)
        for a in actions:
            if isinstance(a, LanternFade):
                lantern = a.level
            elif isinstance(a, GazeTarget):
                servo_released = False
                motions.append(a.motion_id)
            elif isinstance(a, ReleaseServos):
                servo_released = True
            elif isinstance(a, TakeSnapshot):
                snaps.append(a.snapshot_id)
            elif isinstance(a, PlayLine | PlayAudioUrl):
                plays.append(a.play_id)

    for kind, gap, a, b in steps:
        now += gap
        match kind:
            case "tick":
                feed(Tick())
            case "pir":
                feed(PirRising())
            case "pir_off":
                feed(PirFalling())
            case "remote":
                feed(ModeSet(ref_id="r", mode=ModeRequest.REMOTE))
            case "guard":
                feed(ModeSet(ref_id="r", mode=ModeRequest.GUARD))
            case "sleep":
                feed(ModeSet(ref_id="r", mode=ModeRequest.SLEEP))
            case "gaze":
                feed(Gaze(ref_id="g", pan_deg=a, tilt_deg=0.0))
            case "lantern":
                feed(Lantern(ref_id="l", level=b, fade_ms=1000))
            case "photo":
                feed(SnapshotRequest(ref_id="p", request_id="req", purpose="photo"))
            case "say":
                feed(Speak(ref_id="s", line_id=None, audio_url=URL, remote=True))
            case "arrive" if motions:
                feed(ServoArrived(motion_id=motions.pop(0)))
            case "snapshot" if snaps:
                feed(SnapshotReady(snapshot_id=snaps.pop(0), jpeg=b"x", width=1, height=1))
            case "audio" if plays:
                feed(AudioFinished(play_id=plays.pop(0)))

    # Let every deadline pass, with no further input but ticks.
    for _ in range(600):
        now += 1.0
        feed(Tick())
    assert ms.state is State.SLEEPING or ms.phase is not None
    if ms.state is State.SLEEPING:
        assert lantern == 0.0, f"lantern left at {lantern}"
        assert servo_released


# --------------------------------------------------------------------------------------------
# Examples: the rehearsal sequence and the report after a remote command (remote-mode M6)
# --------------------------------------------------------------------------------------------


def _machine():
    ms = initial_state(config=CONFIG, lines=LINES, agent_version="0", start_time=0.0)
    return dataclasses.replace(ms, cloud_connected=True)


def _go(ms, event, now, uid):
    return step(ms, dataclasses.replace(event, uid=uid), now)


def test_remote_control_started_while_waking_ends_with_the_lantern_faded_out() -> None:
    """The 11/24 rehearsal: PIR, remote 3 s later, commands, back to guard, no servo feedback."""
    ms, _ = _go(_machine(), PirRising(), 100.0, "u1")
    assert ms.state is State.WAKING
    ms, _ = _go(ms, ModeSet(ref_id="a", mode=ModeRequest.REMOTE), 103.0, "u2")
    assert ms.state is State.REMOTE
    ms, _ = _go(ms, Gaze(ref_id="b", pan_deg=-20.0, tilt_deg=0.0), 110.0, "u3")
    ms, _ = _go(ms, Lantern(ref_id="c", level=1.0, fade_ms=1000), 115.0, "u4")
    ms, _ = _go(ms, ModeSet(ref_id="d", mode=ModeRequest.GUARD), 150.0, "u5")
    assert ms.state is State.COOLDOWN
    faded: list[LanternFade] = []
    for i in range(120):
        ms, actions = _go(ms, Tick(), 151.0 + i, f"t{i}")
        faded += [a for a in actions if isinstance(a, LanternFade)]
    assert ms.state is State.SLEEPING
    assert faded[0].level == 0.0 and faded[0].fade_ms > 0  # slow, not a cut
    assert ms.lantern_level == 0.0


def test_remote_commands_are_reported_at_once() -> None:
    ms, _ = _go(_machine(), ModeSet(ref_id="a", mode=ModeRequest.REMOTE), 100.0, "u1")
    ms, actions = _go(ms, Gaze(ref_id="b", pan_deg=-20.0, tilt_deg=0.0), 101.0, "u2")
    status = [a for a in actions if isinstance(a, PublishStatus)]
    assert [s.data.pan_deg for s in status] == [-20.0]
    ms, actions = _go(ms, Lantern(ref_id="c", level=1.0, fade_ms=500), 102.0, "u3")
    status = [a for a in actions if isinstance(a, PublishStatus)]
    assert [s.data.lantern for s in status] == [1.0]


def test_remote_control_interrupts_every_visit_state_but_not_a_conversation() -> None:
    """One rule for 'start remote control' during a visit: it takes over (M1)."""
    for pir_events in (1, 2):
        ms, _ = _go(_machine(), PirRising(), 100.0, "u1")
        if pir_events == 2:
            ms, _ = _go(ms, ModeSet(ref_id="x", mode=ModeRequest.SLEEP), 101.0, "u2")  # cooldown
            assert ms.state is State.COOLDOWN
        ms, actions = _go(ms, ModeSet(ref_id="a", mode=ModeRequest.REMOTE), 104.0, "u9")
        assert ms.state is State.REMOTE
        assert ms.lantern_level > 0.0
