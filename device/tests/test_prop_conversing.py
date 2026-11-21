"""Property 4: `conversing` always has an exit (voice-conversation task 15.4).

Random event sequences, with Ticks at most `T` apart and valid configs, drive the State_Machine
through the reactive harness of `tests/harness.py`, extended with the conversation events
(`conversation.start`, `conversation.end`, `snapshot.request`, `ConversationFinished`) and
with "assist" draws that steer the doll toward `conversing` (a family verdict, a stored grant,
a manual start), which uniform random draws almost never reach.

For every trace the oracle below checks, from the requirements and `docs/schema.md`:

- a visit to `conversing` never lasts longer than `conversation_max_s + T` (R11.6),
- every exit is one of the design's exits and carries the reason of the schema's mapping
  (R11.7, R11.9, R11.18),
- `conversing` is never entered without a deadline, in mode `sleep` or with
  `conversation_enabled` off (R11.4, R11.5),
- leaving emits exactly one `StopConversation` and one `conversation.ended` (R11.8),
- a stale session id changes nothing (R11.9),
- the Encounter ends within `Encounter_Bound`, which holds the extra `conversation_max_s + 2T`
  term (R11.14), and
- an Encounter publishes at most one `reaction.performed`; the conversation lines are not
  Reactions (R11.13).

`micActive` is also checked, because the privacy indicator must follow the state (R11.19).
"""

# Feature: voice-conversation, Property 4: `conversing` always has an exit (device)

from __future__ import annotations

import dataclasses
import math

import pytest
from hypothesis import event, given, settings
from hypothesis import strategies as st

from tests.harness import (
    START_TIME,
    EncounterSlice,
    Record,
    Trace,
    _Driver,
    split_by_encounter,
    state_visits,
)
from tests.strategies import line_sets, valid_configs
from warashi_agent.config import AwsConfig, Config, ConversationConfig
from warashi_agent.messages import (
    ConversationEnded,
    ConversationEndReason,
    ReactionPerformed,
    StateChanged,
)
from warashi_agent.model import (
    CloudConnected,
    CloudDisconnected,
    ConversationEnd,
    ConversationFinished,
    ConversationStart,
    FaceBox,
    JudgementResult,
    Mode,
    ModeSet,
    PirRising,
    PublishEvent,
    PublishStatus,
    Reason,
    SnapshotRequest,
    StartConversation,
    State,
    StopConversation,
    Tick,
    Verdict,
)
from warashi_agent.state_machine import Conversing, Greeting
from warashi_agent.voice import VoiceLine

TOL = 1e-9
BUDGET = 60
SESSIONS = ("sess-a", "sess-b")
REQUESTS = ("req-1", "req-2")
CENTER_FACE = FaceBox(left=0.4, top=0.4, width=0.2, height=0.2)
END_REASONS = tuple(r.value for r in ConversationEndReason)


# --------------------------------------------------------------------------------------------
# Configs and the driver
# --------------------------------------------------------------------------------------------


@st.composite
def conversation_configs(draw: st.DrawFn) -> Config:
    """A valid config with a random `[conversation]` section, enabled in most examples."""
    cfg = draw(valid_configs())
    max_s = draw(st.integers(30, 120))
    silence_s = draw(st.integers(5, min(60, max_s - 5)))
    enabled = draw(st.sampled_from((True, True, True, False)))
    conversation = ConversationConfig(
        conversation_enabled=enabled,
        conversation_max_s=max_s,
        conversation_silence_s=silence_s,
    )
    aws = AwsConfig(
        enabled=True,
        appsync_realtime_host="rt.example.invalid",
        appsync_http_host="h.example.invalid",
    )
    return dataclasses.replace(cfg, conversation=conversation, aws=aws if enabled else cfg.aws)


class _ConversationDriver(_Driver):
    """The reactive harness plus conversation events and state-aware "assist" draws."""

    def __init__(self, data: st.DataObject, cfg: Config, lines: tuple[VoiceLine, ...]) -> None:
        super().__init__(data, cfg, lines, cfg.tick_s)
        # The PIR warm-up is not under test here; start the doll long after power-up.
        self.ms = dataclasses.replace(self.ms, start_time=START_TIME - 1000.0)
        self.feed(CloudConnected(), START_TIME)

    def draw_one(self) -> None:
        kind = self.data.draw(
            st.sampled_from(("base", "base", "conversation", "conversation", "assist", "assist")),
            label="driver kind",
        )
        at = self.now + self.data.draw(st.sampled_from((0.0, 0.05, 0.5, 5.0, 30.0)), label="gap")
        if kind == "base":
            super().draw_one()
        elif kind == "conversation":
            self._draw_conversation(at)
        else:
            self._draw_assist(at)

    def _session_ids(self) -> list[str]:
        """The live session first (so shrinking prefers it), then pool ids, then a stale one."""
        phase = self.ms.phase
        ids: list[str] = []
        if isinstance(phase, Conversing):
            ids.append(phase.session_id)
        elif isinstance(phase, Greeting) and phase.pending_conversation is not None:
            ids.append(phase.pending_conversation.session_id)
        ids.extend(s for s in SESSIONS if s not in ids)
        ids.append("stale-session")
        return ids

    def _draw_conversation(self, at: float) -> None:
        draw = self.data.draw
        ref_id, session = self.uids(), draw(st.sampled_from(self._session_ids()), label="session")
        kind = draw(
            st.sampled_from(("start_family", "start_manual", "end", "finished", "request")),
            label="conversation event",
        )
        if kind.startswith("start"):
            self.feed(
                ConversationStart(
                    ref_id=ref_id,
                    session_id=session,
                    token="tok-secret-0123",  # noqa: S106 - a fake token
                    max_s=draw(st.integers(30, 420)),
                    silence_s=draw(st.integers(5, 60)),
                    source="family_verdict" if kind == "start_family" else "manual",
                ),
                at,
            )
        elif kind == "end":
            reason = draw(st.sampled_from(END_REASONS))
            self.feed(ConversationEnd(ref_id=ref_id, session_id=session, reason=reason), at)
        elif kind == "finished":
            reason = draw(st.sampled_from((*END_REASONS, "adapter_failed")))
            self.feed(ConversationFinished(session_id=session, reason=reason), at)
        else:
            request_id = draw(st.sampled_from(REQUESTS))
            self.feed(SnapshotRequest(ref_id=ref_id, request_id=request_id), at)

    def _draw_assist(self, at: float) -> None:
        """The event that moves the Encounter toward `conversing`, or a plain Tick."""
        ms = self.ms
        encounter = ms.encounter
        if not ms.cloud_connected:
            self.feed(CloudConnected(), at)
        elif ms.state is State.SLEEPING:
            if ms.mode is Mode.SLEEP:
                self.feed(ModeSet(ref_id=self.uids(), mode=Mode.GUARD), at)
            else:
                self.feed(PirRising(), at)
        elif (
            ms.state is State.SEEKING
            and encounter is not None
            and encounter.attempt is not None
            and not self.snapshots
        ):
            self.feed(
                JudgementResult(
                    ref_id=self.uids(),
                    snapshot_id=encounter.attempt.snapshot_id,
                    verdict=Verdict.FAMILY,
                    confidence=1.0,
                    face=CENTER_FACE,
                ),
                at,
            )
        elif (
            isinstance(ms.phase, Greeting)
            and ms.phase.pending_conversation is None
            and self.data.draw(st.booleans(), label="grant")
        ):
            self.feed(
                ConversationStart(
                    ref_id=self.uids(),
                    session_id=self.data.draw(st.sampled_from(SESSIONS), label="grant session"),
                    token="tok-secret-0123",  # noqa: S106 - a fake token
                    max_s=self.data.draw(st.integers(30, 420), label="grant max"),
                    silence_s=self.data.draw(st.integers(5, 60), label="grant silence"),
                    source="family_verdict",
                ),
                at,
            )
        elif self.snapshots or self.motions or self.plays:
            self._draw_feedback(at)
        else:
            self.feed(Tick(), at)


def run_conversation(data: st.DataObject, cfg: Config, lines: tuple[VoiceLine, ...]) -> Trace:
    """Up to `BUDGET` drawn events, then a silent tail of Ticks `T` apart."""
    driver = _ConversationDriver(data, cfg, lines)
    for _ in range(data.draw(st.integers(0, BUDGET), label="drawn events")):
        driver.draw_one()
    driver.silent_tail()
    return tuple(driver.records)


# --------------------------------------------------------------------------------------------
# The oracle
# --------------------------------------------------------------------------------------------


def _published(rec: Record, cls: type) -> list[object]:
    return [a.data for a in rec.actions if isinstance(a, PublishEvent) and isinstance(a.data, cls)]


def expected_exit(rec: Record) -> tuple[Reason, ConversationEndReason]:
    """The `state.changed` reason and the end reason of an exit, from the design's table."""
    ev = rec.event
    match ev:
        case Tick():
            return Reason.TIMEOUT, ConversationEndReason.LIMIT
        case CloudDisconnected():
            return Reason.OFFLINE, ConversationEndReason.OFFLINE
        case JudgementResult():
            return Reason.VERDICT, ConversationEndReason.STRANGER
        case ModeSet(mode=Mode.SLEEP):
            return Reason.MANUAL, ConversationEndReason.MANUAL
        case ConversationEnd(reason=reason):
            return Reason.CONVERSATION_DONE, ConversationEndReason(reason)
        case ConversationFinished(reason="adapter_failed"):
            return Reason.ERROR, ConversationEndReason.ERROR
        case ConversationFinished(reason=reason):
            return Reason.CONVERSATION_DONE, ConversationEndReason(reason)
    raise AssertionError(f"{type(ev).__name__} must not leave conversing")


def check_entry(rec: Record, cfg: Config) -> None:
    """R11.4, R11.5: enabled, mode guard, a finite deadline, and the entry actions."""
    phase = rec.after.phase
    assert isinstance(phase, Conversing)
    assert cfg.conversation.conversation_enabled, "entered conversing while disabled"
    assert rec.before.mode is Mode.GUARD and rec.after.mode is Mode.GUARD, "entered in mode sleep"
    assert math.isfinite(phase.deadline), "conversing without a deadline"
    assert rec.now < phase.deadline <= rec.now + cfg.conversation.conversation_max_s + TOL
    starts = [a for a in rec.actions if isinstance(a, StartConversation)]
    assert [s.session_id for s in starts] == [phase.session_id]
    changes = [c for c in _published(rec, StateChanged) if c.to is State.CONVERSING]  # type: ignore[attr-defined]
    assert len(changes) == 1 and changes[0].reason is Reason.CONVERSATION  # type: ignore[attr-defined]


def check_exit(rec: Record) -> None:
    """R11.8, R11.9: one stop, one `conversation.ended`, the mapped reasons, then cooldown."""
    before = rec.before.phase
    assert isinstance(before, Conversing)
    state_reason, end_reason = expected_exit(rec)
    stops = [a for a in rec.actions if isinstance(a, StopConversation)]
    assert [s.session_id for s in stops] == [before.session_id], "not exactly one stop"
    ended = _published(rec, ConversationEnded)
    assert len(ended) == 1, "not exactly one conversation.ended"
    assert ended[0].session_id == before.session_id  # type: ignore[attr-defined]
    assert ended[0].reason is end_reason  # type: ignore[attr-defined]
    changes = [c for c in _published(rec, StateChanged) if c.from_ is State.CONVERSING]  # type: ignore[attr-defined]
    assert len(changes) == 1, "not exactly one state.changed out of conversing"
    assert changes[0].to is State.COOLDOWN and changes[0].reason is state_reason  # type: ignore[attr-defined]


def check_stay(rec: Record) -> None:
    """A record that stays in `conversing`: before its deadline, no start, stop or end."""
    before = rec.before.phase
    assert isinstance(before, Conversing)
    if isinstance(rec.event, Tick):
        assert rec.now < before.deadline, "a Tick at the deadline did not end conversing"
    assert not any(isinstance(a, StartConversation | StopConversation) for a in rec.actions)
    assert not _published(rec, ConversationEnded)
    stale = isinstance(rec.event, ConversationEnd | ConversationFinished) and (
        rec.event.session_id != before.session_id
    )
    if stale:
        assert rec.after == rec.before and rec.actions == (), "a stale session id changed state"


def check_status(rec: Record) -> None:
    """R11.19: `micActive` is true exactly while the state is `conversing`."""
    for action in rec.actions:
        if isinstance(action, PublishStatus):
            assert action.data.mic_active is (rec.after.state is State.CONVERSING)


def check_encounter(part: EncounterSlice, cfg: Config) -> None:
    """R11.13, R11.14: `Encounter_Bound` with the conversation term; one Reaction at most."""
    assert part.ended, "Encounter never reached sleeping"
    assert part.end - part.start <= cfg.encounter_bound_s + TOL, "Encounter_Bound exceeded"
    reactions = [r for rec in part.records for r in _published(rec, ReactionPerformed)]
    assert len(reactions) <= 1, "more than one reaction.performed in an Encounter"


def check_trace(trace: Trace, cfg: Config) -> None:
    entries = exits = 0
    for rec in trace:
        was, now = rec.before.state is State.CONVERSING, rec.after.state is State.CONVERSING
        check_status(rec)
        if not cfg.conversation.conversation_enabled:
            assert not now, "conversing while conversation_enabled is false"
        if now and not was:
            entries += 1
            check_entry(rec, cfg)
        elif was and now:
            check_stay(rec)
        elif was:
            exits += 1
            check_exit(rec)
        else:
            assert not any(
                isinstance(a, StartConversation | StopConversation) for a in rec.actions
            )
    assert entries == exits, "a conversing visit never ended"
    limit = cfg.conversation.conversation_max_s + cfg.tick_s + TOL
    for visit in state_visits(trace):
        if visit.state is State.CONVERSING:
            assert visit.closed and visit.duration <= limit, "conversing lasted too long"
    for part in split_by_encounter(trace):
        check_encounter(part, cfg)
    event(f"conversing visits: {min(entries, 3)}{'+' if entries > 3 else ''}")


# Feature: voice-conversation, Property 4: `conversing` always has an exit (device)
@pytest.mark.timeout(300)
@settings(deadline=None)
@given(data=st.data())
def test_conversing_always_has_an_exit(data: st.DataObject) -> None:
    """**Validates: Requirements 11.6, 11.7, 11.8, 11.9, 11.13, 11.14, 11.18, 11.19**"""
    cfg = data.draw(conversation_configs(), label="cfg")
    lines = data.draw(line_sets(), label="lines")
    check_trace(run_conversation(data, cfg, lines), cfg)
