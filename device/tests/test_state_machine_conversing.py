"""Unit tests for the ``conversing`` phase of the State_Machine (voice-conversation task 15.3).

One test (or one parametrized test) per cell of the design's transition table
(``.kiro/specs/voice-conversation/design.md``, "Transitions") and of the ``docs/schema.md``
reason mapping, plus the rules around them: the closing line of every end reason, a stale
session id, a second ``snapshot.request``, ``speak`` in ``conversing``, and the secret token.

States are built by hand, as ``test_state_machine.py`` does, so each test names the one rule it
checks. Flow tests compare Actions without the trailing ``PublishStatus``; the status rule
(``micActive`` only in ``conversing``) has its own tests.

Sections:

- Helpers
- Entering from sleeping (manual start)
- Entering through greeting (grant, request, audio done)
- Rejected starts and the other cells of ``conversation.start``
- Leaving conversing (end reasons, lines, reasons, adapter, deadline, offline, manual, verdict)
- Stale and ignored events
- Looks (``snapshot.request``)
- ``speak``, manual gaze and lantern, PIR in conversing
- The secret token
"""

from __future__ import annotations

import base64
import dataclasses
import logging
from collections.abc import Iterable

import pytest

from warashi_agent.config import Config, ConversationConfig
from warashi_agent.messages import (
    ConversationEnded,
    ConversationEndReason,
    ConversationRequested,
    ErrorCode,
    ErrorReported,
    PresenceDetected,
    ReactionPerformed,
    SnapshotCaptured,
    StateChanged,
    StatusReport,
)
from warashi_agent.model import (
    AcceptedVerdict,
    Action,
    AudioFailed,
    AudioFinished,
    Category,
    CloudConnected,
    CloudDisconnected,
    ConversationEnd,
    ConversationFinished,
    ConversationStart,
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
    SnapshotFailed,
    SnapshotReady,
    SnapshotRequest,
    Speak,
    StartConversation,
    State,
    StopConversation,
    TakeSnapshot,
    Tick,
    Verdict,
)
from warashi_agent.redact import format_action, format_event
from warashi_agent.state_machine import (
    ConversationGrant,
    Conversing,
    Cooldown,
    Encounter,
    Gazing,
    Greeting,
    LookRequest,
    MachineState,
    PendingAudio,
    ReactionLine,
    Seeking,
    SnapshotAttempt,
    Uncertain,
    Waking,
    WarningPhase,
    initial_state,
    step,
)
from warashi_agent.voice import VoiceLine

# ============================================================================================
# Helpers
# ============================================================================================

CONFIG = Config()
CONV_CONFIG = dataclasses.replace(
    CONFIG, conversation=ConversationConfig(conversation_enabled=True)
)
START = 1000.0
NOW = START + 90.0
AGENT_VERSION = "0.1.0"

UID_A = "00000000-0000-4000-8000-00000000000a"
UID_B = "00000000-0000-4000-8000-00000000000b"
ENCOUNTER_ID = "00000000-0000-4000-8000-0000000000e1"

SESSION = "sess-1"
OTHER_SESSION = "sess-2"
TOKEN = "tok-SECRET-0123456789abcdef"  # noqa: S105 - a fake secret for the leak tests
SNAP_ID = "snap-1-current"
GREETING_PLAY = "play-1-line"
CONVERSING_DEADLINE = NOW + 100.0


def voice_line(line_id: str, category: Category) -> VoiceLine:
    return VoiceLine(
        id=line_id, category=category, ja="……だれか、いるの？", en="...?", wav=f"{line_id}.wav"
    )


# The two conversation lines sort before ``greeting_family``, so a greeting that drew from the
# whole family pool at ``rand`` 0.0 would say goodbye (see the Reaction test below).
LINES = (
    voice_line("conversation_bye", Category.FAMILY),
    voice_line("conversation_trouble", Category.FAMILY),
    voice_line("greeting_family", Category.FAMILY),
    voice_line("uncertain", Category.UNCERTAIN),
    voice_line("warning_stranger", Category.STRANGER),
)


def machine(config: Config = CONV_CONFIG, **changes: object) -> MachineState:
    """A sleeping, connected doll with the given Config, optionally changed."""
    ms = initial_state(config=config, lines=LINES, agent_version=AGENT_VERSION, start_time=START)
    return dataclasses.replace(ms, **{"cloud_connected": True, **changes})


def in_phase(
    phase: object,
    *,
    config: Config = CONV_CONFIG,
    accepted: AcceptedVerdict | None = AcceptedVerdict.FAMILY,
    **changes: object,
) -> MachineState:
    """A state inside an Encounter that has already reacted, head attached, lantern lit."""
    return machine(
        config,
        phase=phase,
        encounter=Encounter(encounter_id=ENCOUNTER_ID, accepted=accepted, reacted=True),
        servos_released=False,
        lantern_level=config.lantern.lantern_wake_level,
        **changes,
    )


def conversing(*, look: LookRequest | None = None, **changes: object) -> MachineState:
    return in_phase(
        Conversing(session_id=SESSION, deadline=CONVERSING_DEADLINE, look=look), **changes
    )


def grant(
    session_id: str = SESSION, *, max_s: int = 120, silence_s: int = 15
) -> ConversationGrant:
    return ConversationGrant(session_id=session_id, token=TOKEN, max_s=max_s, silence_s=silence_s)


def greeting(
    *,
    pending: ConversationGrant | None = None,
    nod_returned: bool = True,
    config: Config = CONV_CONFIG,
    accepted: AcceptedVerdict | None = AcceptedVerdict.FAMILY,
    **changes: object,
) -> MachineState:
    """``greeting`` with its line playing, as ``enter_greeting`` leaves it."""
    phase = Greeting(
        pan=0.0,
        tilt=0.0,
        nod_motion_id="motion-1-nod",
        nod_deadline=NOW + 3,
        nod_returned=nod_returned,
        line=ReactionLine(play_id=GREETING_PLAY, deadline=NOW + 12),
        pending_conversation=pending,
    )
    return in_phase(
        phase,
        config=config,
        accepted=accepted,
        audio=(PendingAudio(play_id=GREETING_PLAY, busy_until=NOW + 12),),
        **changes,
    )


def start_command(
    *,
    source: str = "manual",
    session_id: str = SESSION,
    max_s: int = 120,
    silence_s: int = 15,
    uid: str = UID_A,
) -> ConversationStart:
    return ConversationStart(
        ref_id="cmd-start",
        session_id=session_id,
        token=TOKEN,
        max_s=max_s,
        silence_s=silence_s,
        source=source,
        uid=uid,
    )


def without_status(actions: Iterable[Action]) -> tuple[Action, ...]:
    return tuple(a for a in actions if not isinstance(a, PublishStatus))


def published(actions: Iterable[Action]) -> tuple[object, ...]:
    """The ``data`` of every ``PublishEvent``, in order."""
    return tuple(a.data for a in actions if isinstance(a, PublishEvent))


def of_type[T](items: Iterable[object], cls: type[T]) -> list[T]:
    return [item for item in items if isinstance(item, cls)]


def status_of(actions: Iterable[Action]) -> StatusReport:
    (status,) = [a for a in actions if isinstance(a, PublishStatus)]
    return status.data


def state_change(actions: Iterable[Action]) -> StateChanged:
    (change,) = of_type(published(actions), StateChanged)
    return change


def error_codes(actions: Iterable[Action]) -> list[ErrorCode]:
    return [e.code for e in of_type(published(actions), ErrorReported)]


def assert_rejected(ms: MachineState, actions: tuple[Action, ...], nxt: MachineState) -> None:
    """The command changed nothing and was answered with one ``command_rejected_state``."""
    assert nxt is ms
    (error,) = of_type(published(actions), ErrorReported)
    assert error.code is ErrorCode.COMMAND_REJECTED_STATE
    assert error.ref_id is not None
    assert [a for a in actions if not isinstance(a, PublishEvent | PublishStatus)] == []


# ============================================================================================
# Entering from sleeping (manual start)
# ============================================================================================


def test_manual_start_in_sleeping_enters_conversing_in_order() -> None:
    nxt, actions = step(machine(), start_command(), NOW)

    kinds = [type(a) for a in actions]
    assert kinds == [
        PublishEvent,  # state.changed
        PublishEvent,  # presence.detected(manual)
        LanternFade,
        GazeTarget,
        StartConversation,
        PublishStatus,
    ]
    assert published(actions) == (
        StateChanged(from_=State.SLEEPING, to=State.CONVERSING, reason=Reason.CONVERSATION),
        PresenceDetected(source="manual"),
    )
    assert all(a.encounter_id == UID_A for a in actions if isinstance(a, PublishEvent))
    (fade,) = of_type(actions, LanternFade)
    assert fade.level == CONV_CONFIG.lantern.lantern_wake_level
    (gaze,) = of_type(actions, GazeTarget)
    assert (gaze.pan_deg, gaze.tilt_deg) == (0.0, 0.0)
    assert nxt.encounter is not None and nxt.encounter.encounter_id == UID_A
    assert nxt.phase == Conversing(session_id=SESSION, deadline=NOW + 120)


def test_manual_start_publishes_no_reaction() -> None:
    _, actions = step(machine(), start_command(), NOW)
    assert of_type(published(actions), ReactionPerformed) == []


@pytest.mark.parametrize(
    ("max_s", "silence_s", "want_max", "want_silence"),
    [
        (120, 15, 120, 15),  # inside both limits
        (420, 15, 180, 15),  # maxSeconds is clamped to conversation_max_s
        (30, 60, 30, 25),  # the silence limit stays 5 s below the maximum
        (200, 60, 180, 60),  # silence below the clamped maximum stays
    ],
)
def test_start_clamps_max_and_silence_and_sets_the_deadline(
    max_s: int, silence_s: int, want_max: int, want_silence: int
) -> None:
    nxt, actions = step(machine(), start_command(max_s=max_s, silence_s=silence_s), NOW)

    (start,) = of_type(actions, StartConversation)
    assert (start.session_id, start.token) == (SESSION, TOKEN)
    assert (start.max_s, start.silence_s) == (want_max, want_silence)
    assert isinstance(nxt.phase, Conversing)
    assert nxt.phase.deadline == NOW + want_max


def test_entering_reports_mic_active_and_other_states_do_not() -> None:
    nxt, actions = step(machine(), start_command(), NOW)
    assert status_of(actions).state is State.CONVERSING
    assert status_of(actions).mic_active is True
    assert nxt.state is State.CONVERSING

    # A sleeping doll's first Tick reports micActive false.
    _, sleeping_actions = step(machine(), Tick(uid=UID_A), NOW)
    assert status_of(sleeping_actions).mic_active is False


def test_encounter_bound_gains_the_conversation_term_only_when_enabled() -> None:
    extra = CONV_CONFIG.encounter_bound_s - CONFIG.encounter_bound_s
    assert extra == pytest.approx(
        CONV_CONFIG.conversation.conversation_max_s + 2 * CONV_CONFIG.tick_s
    )


# ============================================================================================
# Entering through greeting
# ============================================================================================


def seeking_family(*, rand: float = 0.0, config: Config = CONV_CONFIG, connected: bool = True):
    ms = machine(
        config,
        cloud_connected=connected,
        phase=Seeking(),
        encounter=Encounter(
            encounter_id=ENCOUNTER_ID,
            attempt=SnapshotAttempt(
                snapshot_id=SNAP_ID, pan_deg=0.0, tilt_deg=0.0, deadline=NOW + 9
            ),
        ),
        servos_released=False,
    )
    verdict = JudgementResult(
        ref_id="cmd-1",
        snapshot_id=SNAP_ID,
        verdict=Verdict.FAMILY,
        confidence=0.99,
        face=None,
        rand=rand,
        uid=UID_B,
    )
    return step(ms, verdict, NOW + 1)


@pytest.mark.parametrize("rand", [0.0, 0.5, 0.999])
def test_the_family_greeting_never_uses_a_conversation_line(rand: float) -> None:
    # The conversation lines are in the family category so family may hear them, but a
    # greeting that said "goodbye" would be wrong. Only greeting_family is a Reaction line.
    nxt, actions = seeking_family(rand=rand)

    (play,) = of_type(actions, PlayLine)
    assert play.line_id == "greeting_family"
    (reaction,) = of_type(published(actions), ReactionPerformed)
    assert reaction.line_id == "greeting_family"
    assert nxt.state is State.GREETING


def test_entering_greeting_sends_conversation_requested_once() -> None:
    nxt, actions = seeking_family()

    assert of_type(published(actions), ConversationRequested) == [
        ConversationRequested(reason="family_verdict")
    ]
    assert nxt.encounter is not None and nxt.encounter.conversation_requested


@pytest.mark.parametrize(
    ("config", "connected"),
    [(CONFIG, True), (CONV_CONFIG, False)],
    ids=["conversation-disabled", "cloud-disconnected"],
)
def test_no_conversation_request_when_disabled_or_offline(config: Config, connected: bool) -> None:
    _, actions = seeking_family(config=config, connected=connected)
    assert of_type(published(actions), ConversationRequested) == []


def test_conversation_requested_is_not_repeated_for_the_same_encounter() -> None:
    ms = greeting()
    ms = dataclasses.replace(
        ms, encounter=dataclasses.replace(ms.encounter, conversation_requested=True)
    )
    _, actions = step(ms, start_command(source="family_verdict"), NOW + 1)
    assert of_type(published(actions), ConversationRequested) == []


def test_start_in_greeting_stores_the_grant_and_changes_nothing_else() -> None:
    ms = greeting()
    nxt, actions = step(ms, start_command(source="family_verdict"), NOW + 1)

    assert without_status(actions) == ()
    assert isinstance(nxt.phase, Greeting)
    assert nxt.phase.pending_conversation == grant()
    assert nxt.state is State.GREETING


def test_a_second_start_for_the_stored_session_changes_nothing() -> None:
    ms = greeting(pending=grant())
    nxt, actions = step(ms, start_command(source="family_verdict"), NOW + 1)
    assert nxt is ms
    assert without_status(actions) == ()


def test_a_start_for_another_session_while_a_grant_is_stored_is_rejected() -> None:
    ms = greeting(pending=grant())
    nxt, actions = step(
        ms, start_command(source="family_verdict", session_id=OTHER_SESSION), NOW + 1
    )
    assert_rejected(ms, actions, nxt)


@pytest.mark.parametrize("result", [AudioFinished, AudioFailed])
def test_the_grant_starts_the_conversation_when_the_greeting_line_ends(result: type) -> None:
    ms = greeting(pending=grant())
    event = (
        AudioFinished(play_id=GREETING_PLAY, uid=UID_A)
        if result is AudioFinished
        else AudioFailed(play_id=GREETING_PLAY, code="audio_failed", uid=UID_A)
    )
    nxt, actions = step(ms, event, NOW + 5)

    assert state_change(actions) == StateChanged(
        from_=State.GREETING, to=State.CONVERSING, reason=Reason.CONVERSATION
    )
    (start,) = of_type(actions, StartConversation)
    assert (start.session_id, start.max_s, start.silence_s) == (SESSION, 120, 15)
    assert nxt.phase == Conversing(session_id=SESSION, deadline=NOW + 5 + 120)
    assert status_of(actions).mic_active is True
    # The greeting already was the Reaction: nothing publishes a second one.
    assert of_type(published(actions), ReactionPerformed) == []


def test_a_nod_that_has_not_returned_returns_before_the_conversation_starts() -> None:
    ms = greeting(pending=grant(), nod_returned=False)
    _, actions = step(ms, AudioFinished(play_id=GREETING_PLAY, uid=UID_A), NOW + 5)

    kinds = [type(a) for a in without_status(actions)]
    assert kinds.index(GazeTarget) < kinds.index(StartConversation)
    (back,) = of_type(actions, GazeTarget)
    assert (back.pan_deg, back.tilt_deg) == (0.0, 0.0)  # the recorded nod base


def test_a_greeting_without_a_grant_ends_in_cooldown_as_before() -> None:
    nxt, actions = step(greeting(), AudioFinished(play_id=GREETING_PLAY, uid=UID_A), NOW + 5)
    assert state_change(actions).to is State.COOLDOWN
    assert state_change(actions).reason is Reason.AUDIO_DONE
    assert of_type(actions, StartConversation) == []
    assert nxt.state is State.COOLDOWN


@pytest.mark.parametrize(
    "ms",
    [
        greeting(pending=grant(), cloud_connected=False),
        greeting(pending=grant(), config=CONFIG),
    ],
    ids=["cloud-lost-since-the-grant", "switch-turned-off-since-the-grant"],
)
def test_a_grant_is_dropped_when_the_cloud_or_the_switch_is_gone(ms: MachineState) -> None:
    _, actions = step(ms, AudioFinished(play_id=GREETING_PLAY, uid=UID_A), NOW + 5)
    assert of_type(actions, StartConversation) == []
    assert state_change(actions).to is State.COOLDOWN
    assert state_change(actions).reason is Reason.AUDIO_DONE


def test_the_greeting_deadline_without_audio_result_drops_the_grant() -> None:
    # The line's own deadline ends the greeting; a hung audio result cannot start a session.
    ms = greeting(pending=grant())
    _, actions = step(ms, Tick(uid=UID_A), NOW + 12)
    assert of_type(actions, StartConversation) == []
    assert state_change(actions).to is State.COOLDOWN


# ============================================================================================
# Rejected starts and the other cells of conversation.start
# ============================================================================================


def cooldown_phase() -> Cooldown:
    return Cooldown(motion_id="m", glide_deadline=NOW + 3, until=NOW + 20, manual=False)


WRONG_STATES = {
    "waking": lambda: in_phase(
        Waking(motion_id="m", fade_done_at=NOW + 1, deadline=NOW + 5), accepted=None
    ),
    "seeking": lambda: in_phase(Seeking(), accepted=None),
    "gazing": lambda: in_phase(Gazing(motion_id="m", deadline=NOW + 3)),
    "warning": lambda: in_phase(
        WarningPhase(stare_until=NOW + 2), accepted=AcceptedVerdict.STRANGER
    ),
    "uncertain": lambda: in_phase(
        Uncertain(line=ReactionLine(play_id="p", deadline=NOW + 9)),
        accepted=AcceptedVerdict.UNCERTAIN,
    ),
    "cooldown": lambda: in_phase(cooldown_phase()),
}


@pytest.mark.parametrize("name", list(WRONG_STATES))
@pytest.mark.parametrize("source", ["manual", "family_verdict"])
def test_start_in_the_wrong_state_is_rejected(name: str, source: str) -> None:
    ms = WRONG_STATES[name]()
    nxt, actions = step(ms, start_command(source=source), NOW)
    assert_rejected(ms, actions, nxt)


def test_start_is_rejected_when_conversation_is_disabled() -> None:
    ms = machine(CONFIG)
    nxt, actions = step(ms, start_command(), NOW)
    assert_rejected(ms, actions, nxt)
    assert nxt.state is State.SLEEPING and nxt.encounter is None


def test_start_is_rejected_in_mode_sleep() -> None:
    ms = machine(mode=Mode.SLEEP)
    nxt, actions = step(ms, start_command(), NOW)
    assert_rejected(ms, actions, nxt)
    assert nxt.encounter is None


def test_a_family_verdict_start_in_sleeping_is_rejected() -> None:
    ms = machine()
    nxt, actions = step(ms, start_command(source="family_verdict"), NOW)
    assert_rejected(ms, actions, nxt)


def test_start_in_greeting_is_rejected_when_disabled() -> None:
    ms = greeting(config=CONFIG)
    nxt, actions = step(ms, start_command(source="family_verdict"), NOW + 1)
    assert_rejected(ms, actions, nxt)


def test_a_manual_start_in_greeting_is_rejected() -> None:
    ms = greeting()
    nxt, actions = step(ms, start_command(source="manual"), NOW + 1)
    assert_rejected(ms, actions, nxt)


@pytest.mark.parametrize("accepted", [None, AcceptedVerdict.STRANGER, AcceptedVerdict.UNCERTAIN])
def test_a_start_in_greeting_without_an_accepted_family_verdict_is_rejected(
    accepted: AcceptedVerdict | None,
) -> None:
    ms = greeting(accepted=accepted)
    nxt, actions = step(ms, start_command(source="family_verdict"), NOW + 1)
    assert_rejected(ms, actions, nxt)


def test_the_same_session_start_in_conversing_is_ignored() -> None:
    ms = conversing()
    nxt, actions = step(ms, start_command(), NOW + 1)
    assert nxt is ms
    assert without_status(actions) == ()


def test_another_session_start_in_conversing_is_rejected() -> None:
    ms = conversing()
    nxt, actions = step(ms, start_command(session_id=OTHER_SESSION), NOW + 1)
    assert_rejected(ms, actions, nxt)


# ============================================================================================
# Leaving conversing
# ============================================================================================

# The line rule of R11.10 to R11.12 written out independently of the implementation.
LINE_FOR_END_REASON: dict[ConversationEndReason, str | None] = {
    ConversationEndReason.SILENCE: "conversation_bye",
    ConversationEndReason.LIMIT: "conversation_bye",
    ConversationEndReason.USER: "conversation_bye",
    ConversationEndReason.NO_CLIENT: "conversation_bye",
    ConversationEndReason.ERROR: "conversation_trouble",
    ConversationEndReason.LANGUAGE: "conversation_trouble",
    ConversationEndReason.STRANGER: None,
    ConversationEndReason.MANUAL: None,
    ConversationEndReason.OFFLINE: None,
    ConversationEndReason.UNSAFE_OUTPUT: None,
}


def test_the_line_table_covers_every_end_reason() -> None:
    assert set(LINE_FOR_END_REASON) == set(ConversationEndReason)


def assert_one_exit(
    actions: tuple[Action, ...],
    *,
    end_reason: ConversationEndReason,
    state_reason: Reason,
    line_id: str | None,
) -> None:
    """The exit contract of R11.8: stop, ended, state.changed, cooldown entry, line, status."""
    assert of_type(actions, StopConversation) == [StopConversation(session_id=SESSION)]
    assert of_type(published(actions), ConversationEnded) == [
        ConversationEnded(session_id=SESSION, reason=end_reason)
    ]
    assert state_change(actions) == StateChanged(
        from_=State.CONVERSING, to=State.COOLDOWN, reason=state_reason
    )
    (back,) = of_type(actions, GazeTarget)
    assert (back.pan_deg, back.tilt_deg) == (0.0, 0.0)
    plays = of_type(actions, PlayLine)
    assert [p.line_id for p in plays] == ([line_id] if line_id is not None else [])
    assert of_type(published(actions), ReactionPerformed) == []
    # Order: stop first, so the microphone closes before anything else happens.
    order = [type(a) for a in without_status(actions)]
    assert order[0] is StopConversation
    assert order.index(PublishEvent) < order.index(GazeTarget)
    status = status_of(actions)
    assert status.state is State.COOLDOWN and status.mic_active is False


@pytest.mark.parametrize("reason", list(ConversationEndReason))
def test_conversation_end_stops_and_plays_the_line_of_its_reason(
    reason: ConversationEndReason,
) -> None:
    nxt, actions = step(
        conversing(),
        ConversationEnd(ref_id="cmd-end", session_id=SESSION, reason=reason.value, uid=UID_A),
        NOW + 5,
    )
    assert_one_exit(
        actions,
        end_reason=reason,
        state_reason=Reason.CONVERSATION_DONE,
        line_id=LINE_FOR_END_REASON[reason],
    )
    assert isinstance(nxt.phase, Cooldown) and not nxt.phase.manual


@pytest.mark.parametrize("reason", list(ConversationEndReason))
def test_the_adapter_finishing_plays_the_line_of_its_reason(reason: ConversationEndReason) -> None:
    _, actions = step(
        conversing(),
        ConversationFinished(session_id=SESSION, reason=reason.value, uid=UID_A),
        NOW + 5,
    )
    assert_one_exit(
        actions,
        end_reason=reason,
        state_reason=Reason.CONVERSATION_DONE,
        line_id=LINE_FOR_END_REASON[reason],
    )


def test_an_adapter_failure_leaves_with_reason_error_and_the_trouble_line() -> None:
    _, actions = step(
        conversing(),
        ConversationFinished(session_id=SESSION, reason="adapter_failed", uid=UID_A),
        NOW + 5,
    )
    assert_one_exit(
        actions,
        end_reason=ConversationEndReason.ERROR,
        state_reason=Reason.ERROR,
        line_id="conversation_trouble",
    )


def test_the_deadline_tick_leaves_with_reason_timeout_and_the_goodbye() -> None:
    nxt, actions = step(conversing(), Tick(uid=UID_A), CONVERSING_DEADLINE)
    assert_one_exit(
        actions,
        end_reason=ConversationEndReason.LIMIT,
        state_reason=Reason.TIMEOUT,
        line_id="conversation_bye",
    )
    assert nxt.state is State.COOLDOWN


def test_a_gapped_tick_far_past_the_deadline_still_leaves_once() -> None:
    _, actions = step(conversing(), Tick(uid=UID_A), CONVERSING_DEADLINE + 1000)
    assert len(of_type(actions, StopConversation)) == 1
    assert len(of_type(published(actions), ConversationEnded)) == 1


def test_a_tick_before_the_deadline_changes_nothing() -> None:
    ms = conversing()
    nxt, actions = step(ms, Tick(uid=UID_A), CONVERSING_DEADLINE - 0.001)
    assert nxt.phase == ms.phase
    assert without_status(actions) == ()


def test_cloud_disconnected_leaves_with_reason_offline_and_no_line() -> None:
    nxt, actions = step(conversing(), CloudDisconnected(uid=UID_A), NOW + 5)
    assert_one_exit(
        actions,
        end_reason=ConversationEndReason.OFFLINE,
        state_reason=Reason.OFFLINE,
        line_id=None,
    )
    assert nxt.cloud_connected is False


def test_mode_sleep_leaves_with_reason_manual_through_a_manual_cooldown() -> None:
    nxt, actions = step(
        conversing(), ModeSet(ref_id="cmd-mode", mode=Mode.SLEEP, uid=UID_A), NOW + 5
    )
    assert_one_exit(
        actions,
        end_reason=ConversationEndReason.MANUAL,
        state_reason=Reason.MANUAL,
        line_id=None,
    )
    assert nxt.mode is Mode.SLEEP
    assert isinstance(nxt.phase, Cooldown) and nxt.phase.manual


def test_mode_guard_in_conversing_changes_nothing() -> None:
    ms = conversing()
    nxt, actions = step(ms, ModeSet(ref_id="cmd-mode", mode=Mode.GUARD, uid=UID_A), NOW + 5)
    assert nxt is ms
    assert without_status(actions) == ()


def test_mode_sleep_in_greeting_with_a_grant_never_starts_the_conversation() -> None:
    ms = greeting(pending=grant())
    nxt, actions = step(ms, ModeSet(ref_id="cmd-mode", mode=Mode.SLEEP, uid=UID_A), NOW + 5)
    assert state_change(actions).reason is Reason.MANUAL
    assert of_type(actions, StartConversation) == []
    assert nxt.state is State.COOLDOWN


def test_a_conversation_ends_the_encounter_through_cooldown_and_sleeping() -> None:
    ms, _ = step(
        conversing(),
        ConversationEnd(ref_id="c", session_id=SESSION, reason="user", uid=UID_A),
        NOW + 5,
    )
    assert isinstance(ms.phase, Cooldown)
    _, actions = step(ms, Tick(uid=UID_B), ms.phase.until)
    assert state_change(actions).to is State.SLEEPING
    assert state_change(actions).reason is Reason.COOLDOWN_DONE


# --- A stranger verdict for a look ---------------------------------------------------------

LOOK_ID = "snap-1-" + UID_A


def take_look(ms: MachineState, at: float = NOW + 5) -> MachineState:
    nxt, _ = step(ms, SnapshotRequest(ref_id="cmd-req", request_id="req-1", uid=UID_A), at)
    return nxt


def looked(verdict_value: Verdict, *, snapshot_id: str = LOOK_ID, confidence: float = 0.99):
    return JudgementResult(
        ref_id="cmd-j",
        snapshot_id=snapshot_id,
        verdict=verdict_value,
        confidence=confidence,
        face=None,
        uid=UID_B,
    )


def with_sent_look() -> MachineState:
    ms = take_look(conversing())
    nxt, _ = step(
        ms,
        SnapshotReady(
            snapshot_id=LOOK_ID, jpeg=b"\xff\xd8\xff\xd9", width=640, height=480, uid=UID_B
        ),
        NOW + 6,
    )
    return nxt


def test_a_stranger_verdict_for_a_look_leaves_silently_with_reason_verdict() -> None:
    ms = with_sent_look()
    nxt, actions = step(ms, looked(Verdict.STRANGER), NOW + 8)

    assert of_type(actions, StopConversation) == [StopConversation(session_id=SESSION)]
    assert of_type(published(actions), ConversationEnded) == [
        ConversationEnded(session_id=SESSION, reason=ConversationEndReason.STRANGER)
    ]
    assert state_change(actions) == StateChanged(
        from_=State.CONVERSING, to=State.COOLDOWN, reason=Reason.VERDICT
    )
    # Cooldown, not warning: the greeting already was the Reaction, and the doll stays silent.
    assert of_type(actions, PlayLine) == []
    assert of_type(published(actions), ReactionPerformed) == []
    assert nxt.state is State.COOLDOWN
    assert nxt.encounter is not None and nxt.encounter.accepted is AcceptedVerdict.FAMILY


def test_a_stranger_verdict_for_a_look_still_outstanding_also_leaves() -> None:
    ms = take_look(conversing())
    _, actions = step(ms, looked(Verdict.STRANGER), NOW + 6)
    assert state_change(actions).reason is Reason.VERDICT


@pytest.mark.parametrize("v", [Verdict.FAMILY, Verdict.NO_FACE, Verdict.UNCERTAIN])
def test_other_verdicts_for_a_look_are_ignored(v: Verdict) -> None:
    ms = with_sent_look()
    nxt, actions = step(ms, looked(v), NOW + 8)
    assert nxt is ms
    assert without_status(actions) == ()


def test_a_low_confidence_stranger_verdict_is_ignored() -> None:
    ms = with_sent_look()
    nxt, _ = step(ms, looked(Verdict.STRANGER, confidence=0.0), NOW + 8)
    assert nxt.state is State.CONVERSING


def test_a_stranger_verdict_for_an_unknown_snapshot_is_ignored() -> None:
    ms = with_sent_look()
    nxt, actions = step(ms, looked(Verdict.STRANGER, snapshot_id="snap-9-other"), NOW + 8)
    assert nxt is ms
    assert without_status(actions) == ()


# ============================================================================================
# Stale and ignored events
# ============================================================================================


def test_a_conversation_end_for_another_session_changes_nothing() -> None:
    ms = conversing()
    nxt, actions = step(
        ms,
        ConversationEnd(ref_id="c", session_id=OTHER_SESSION, reason="user", uid=UID_A),
        NOW + 5,
    )
    assert nxt is ms
    assert without_status(actions) == ()


def test_a_finished_for_another_session_changes_nothing() -> None:
    ms = conversing()
    nxt, actions = step(
        ms, ConversationFinished(session_id=OTHER_SESSION, reason="error", uid=UID_A), NOW + 5
    )
    assert nxt is ms
    assert without_status(actions) == ()


def test_a_second_end_after_leaving_is_ignored() -> None:
    cooling, _ = step(
        conversing(),
        ConversationEnd(ref_id="c", session_id=SESSION, reason="user", uid=UID_A),
        NOW + 5,
    )
    nxt, actions = step(
        cooling,
        ConversationEnd(ref_id="c2", session_id=SESSION, reason="user", uid=UID_B),
        NOW + 6,
    )
    assert nxt is cooling
    assert without_status(actions) == ()
    nxt, actions = step(
        cooling, ConversationFinished(session_id=SESSION, reason="user", uid=UID_B), NOW + 6
    )
    assert nxt is cooling
    assert without_status(actions) == ()


@pytest.mark.parametrize("make", [machine, greeting, lambda: in_phase(cooldown_phase())])
@pytest.mark.parametrize("reason", ["user", "error"])
def test_end_and_finished_outside_conversing_are_ignored(make, reason: str) -> None:
    ms = make()
    for event in (
        ConversationEnd(ref_id="c", session_id=SESSION, reason=reason, uid=UID_A),
        ConversationFinished(session_id=SESSION, reason=reason, uid=UID_A),
    ):
        nxt, actions = step(ms, event, NOW + 5)
        assert nxt is ms
        assert without_status(actions) == ()


# ============================================================================================
# Looks (snapshot.request)
# ============================================================================================


def test_snapshot_request_in_conversing_takes_one_snapshot_and_stores_the_look() -> None:
    ms = conversing(gaze=(4.0, -2.0))
    nxt, actions = step(
        ms, SnapshotRequest(ref_id="cmd-req", request_id="req-1", uid=UID_A), NOW + 5
    )

    assert without_status(actions) == (TakeSnapshot(snapshot_id=LOOK_ID),)
    assert isinstance(nxt.phase, Conversing)
    assert nxt.phase.look == LookRequest(
        request_id="req-1",
        snapshot_id=LOOK_ID,
        pan_deg=4.0,
        tilt_deg=-2.0,
        deadline=NOW + 5 + CONV_CONFIG.timing.verdict_timeout_s,
    )
    assert nxt.state is State.CONVERSING


def test_a_second_snapshot_request_while_one_is_outstanding_is_rejected() -> None:
    ms = take_look(conversing())
    nxt, actions = step(
        ms, SnapshotRequest(ref_id="cmd-req2", request_id="req-2", uid=UID_B), NOW + 6
    )
    assert_rejected(ms, actions, nxt)
    assert of_type(actions, TakeSnapshot) == []


@pytest.mark.parametrize(
    "make",
    [machine, greeting, lambda: in_phase(cooldown_phase()), *WRONG_STATES.values()],
)
def test_snapshot_request_outside_conversing_is_rejected(make) -> None:
    ms = make()
    nxt, actions = step(
        ms, SnapshotRequest(ref_id="cmd-req", request_id="req-1", uid=UID_A), NOW + 5
    )
    assert_rejected(ms, actions, nxt)
    assert of_type(actions, TakeSnapshot) == []


def test_the_look_snapshot_is_published_with_its_request_id() -> None:
    ms = take_look(conversing(gaze=(4.0, -2.0)))
    jpeg = b"\xff\xd8\xff\xd9"
    nxt, actions = step(
        ms,
        SnapshotReady(snapshot_id=LOOK_ID, jpeg=jpeg, width=640, height=480, uid=UID_B),
        NOW + 6,
    )

    (captured,) = of_type(published(actions), SnapshotCaptured)
    assert captured.snapshot_id == LOOK_ID
    assert captured.request_id == "req-1"
    assert (captured.width, captured.height) == (640, 480)
    assert (captured.pan_deg, captured.tilt_deg) == (4.0, -2.0)
    assert captured.jpeg_base64 == base64.b64encode(jpeg).decode("ascii")
    assert isinstance(nxt.phase, Conversing)
    assert nxt.phase.look is None
    assert nxt.phase.looked_snapshot_ids == (LOOK_ID,)


def test_a_stale_snapshot_ready_publishes_nothing() -> None:
    ms = take_look(conversing())
    nxt, actions = step(
        ms,
        SnapshotReady(snapshot_id="snap-9-stale", jpeg=b"\xff\xd8", width=1, height=1, uid=UID_B),
        NOW + 6,
    )
    assert of_type(published(actions), SnapshotCaptured) == []
    assert nxt.phase == ms.phase


def test_a_failed_look_snapshot_reports_the_error_and_clears_the_look() -> None:
    ms = take_look(conversing())
    nxt, actions = step(
        ms, SnapshotFailed(snapshot_id=LOOK_ID, code="camera_failed", uid=UID_B), NOW + 6
    )
    assert error_codes(actions) == [ErrorCode.CAMERA_FAILED]
    assert isinstance(nxt.phase, Conversing) and nxt.phase.look is None
    # A new request is possible again.
    again = take_look(nxt, NOW + 7)
    assert isinstance(again.phase, Conversing) and again.phase.look is not None


def test_a_lost_look_expires_at_its_deadline_so_later_requests_work() -> None:
    ms = take_look(conversing())
    assert isinstance(ms.phase, Conversing) and ms.phase.look is not None
    nxt, actions = step(ms, Tick(uid=UID_B), ms.phase.look.deadline)
    assert without_status(actions) == ()
    assert isinstance(nxt.phase, Conversing) and nxt.phase.look is None
    _, actions = step(
        nxt, SnapshotRequest(ref_id="cmd-req2", request_id="req-2", uid=UID_B), NOW + 100
    )
    assert of_type(actions, TakeSnapshot) != []


# ============================================================================================
# speak, gaze, lantern and PIR in conversing
# ============================================================================================


@pytest.mark.parametrize(
    "speak",
    [
        Speak(ref_id="cmd-speak", line_id="greeting_family", audio_url=None, uid=UID_A),
        Speak(ref_id="cmd-speak", line_id=None, audio_url="https://a.invalid/x.wav", uid=UID_A),
        Speak(ref_id="cmd-speak", line_id="no_such_line", audio_url=None, uid=UID_A),
    ],
    ids=["cached-line", "audio-url", "unknown-line"],
)
def test_speak_in_conversing_is_rejected_with_command_rejected_state(speak: Speak) -> None:
    ms = conversing()
    nxt, actions = step(ms, speak, NOW + 5)
    assert_rejected(ms, actions, nxt)
    assert of_type(actions, PlayLine) == [] and of_type(actions, PlayAudioUrl) == []


def test_manual_gaze_and_lantern_are_accepted_in_conversing() -> None:
    ms = conversing()
    nxt, actions = step(ms, Gaze(ref_id="g", pan_deg=10.0, tilt_deg=5.0, uid=UID_A), NOW + 5)
    (target,) = of_type(actions, GazeTarget)
    assert (target.pan_deg, target.tilt_deg) == (10.0, 5.0)
    assert nxt.state is State.CONVERSING and nxt.phase == ms.phase

    nxt, actions = step(ms, Lantern(ref_id="l", level=0.3, fade_ms=500, uid=UID_A), NOW + 5)
    assert of_type(actions, LanternFade) == [LanternFade(level=0.3, fade_ms=500)]
    assert nxt.phase == ms.phase


@pytest.mark.parametrize("event_cls", [PirRising, PirFalling])
def test_pir_edges_in_conversing_only_record_the_level(event_cls: type) -> None:
    ms = conversing()
    nxt, actions = step(ms, event_cls(uid=UID_A), NOW + 5)
    assert without_status(actions) == ()
    assert nxt.phase == ms.phase
    assert nxt.pir_high is (event_cls is PirRising)


def test_cloud_connected_in_conversing_only_records_connectivity() -> None:
    ms = conversing(cloud_connected=False)
    nxt, actions = step(ms, CloudConnected(uid=UID_A), NOW + 5)
    assert without_status(actions) == ()
    assert nxt.phase == ms.phase and nxt.cloud_connected


# ============================================================================================
# The secret token
# ============================================================================================


def test_the_token_is_hidden_from_repr_of_every_carrier() -> None:
    carriers: list[object] = [
        start_command(),
        grant(),
        StartConversation(session_id=SESSION, token=TOKEN, max_s=120, silence_s=15),
        greeting(pending=grant()),
        greeting(pending=grant()).phase,
    ]
    for carrier in carriers:
        assert TOKEN not in repr(carrier)
        assert TOKEN not in str(carrier)


def test_the_token_never_reaches_a_published_message_a_redacted_line_or_a_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    events = [
        (start_command(source="family_verdict"), greeting()),
    ]
    command, ms = events[0]
    seen: list[tuple[object, tuple[Action, ...]]] = []

    ms, actions = step(ms, command, NOW + 1)
    seen.append((command, actions))
    finish = AudioFinished(play_id=GREETING_PLAY, uid=UID_A)
    ms, actions = step(ms, finish, NOW + 5)
    seen.append((finish, actions))
    end = ConversationEnd(ref_id="c", session_id=SESSION, reason="user", uid=UID_B)
    ms, actions = step(ms, end, NOW + 6)
    seen.append((end, actions))

    # The start action does carry the token to the adapter, and only that one.
    carriers = [a for _, acts in seen for a in acts if isinstance(a, StartConversation)]
    assert [a.token for a in carriers] == [TOKEN]
    for event, acts in seen:
        assert TOKEN not in format_event(event)
        for action in acts:
            assert TOKEN not in repr(action)
            assert TOKEN not in format_action(action)
            if isinstance(action, PublishEvent):
                assert TOKEN not in str(dataclasses.asdict(action.data))
    assert TOKEN not in caplog.text
    assert TOKEN not in repr(ms)
