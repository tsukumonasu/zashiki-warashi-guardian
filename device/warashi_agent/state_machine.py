"""Pure State_Machine: ``step(state, event, now) -> (state, actions)`` (device-core-loop R1).

Every decision of the doll's core loop lives here, and nothing else does. The module is pure:

- It reads no clock, no random source, no file, no network and no global mutable data
  (R1.1). ``now`` is an argument; ``rand`` and ``uid`` are fields of the Event, stamped by the
  Dispatcher (R1.5). The module deliberately imports neither ``time``, ``random``, ``uuid``
  nor ``os``; a unit test checks this.
- ``MachineState``, every Event and every Action are frozen dataclasses holding only
  immutable values. ``step()`` builds a new ``MachineState`` with ``dataclasses.replace`` and
  never mutates its argument, so equal arguments give equal results (R1.2) and Hypothesis can
  replay any Event sequence (Property 9).
- The Config and the Available_Lines are part of ``MachineState``, so the result depends on
  the arguments only.

The State is not a free field. It is derived from the type of the phase record
(``MachineState.phase``), so impossible combinations, such as a scan move outside ``seeking``,
cannot be represented.

Structure of one call:

1. ``step()`` creates a ``StepContext`` that collects Actions, hands out identifiers and
   tracks the outputs emitted in this call (last Gaze_Target, last lantern level, whether the
   servos are released).
2. It looks up a handler for ``(State, Event class)`` in ``STATE_HANDLERS``, then for the
   Event class in ``GLOBAL_HANDLERS``. An Event without a handler returns the argument
   unchanged and no Actions (R1.9).
3. ``StepContext.commit()`` copies the tracked outputs into the returned state, and
   ``finalize()`` adds the per-call bookkeeping (camera indicator, status report; R23).

Behaviour is added flow by flow (tasks 9 to 17 of the spec): each flow registers its handlers
in the two tables at the bottom of this module and uses the ``StepContext`` helpers, which
keep the hardware rules (every ``GazeTarget`` Clamped to the Calibrated_Range, R5.7) and the
announcement rules (``state.changed`` first, with the current ``encounterId``, R1.8) in one
place.
"""

from __future__ import annotations

import base64
import dataclasses
import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import ClassVar, Literal

from warashi_agent.config import Config, JudgementConfig
from warashi_agent.glide import clamp, clamp_gaze
from warashi_agent.head_tracker import head_target
from warashi_agent.messages import (
    ConversationEnded,
    ConversationEndReason,
    ConversationRequested,
    ConversationSource,
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
    ConversationEnd,
    ConversationFinished,
    ConversationStart,
    EndReason,
    Event,
    FaceBox,
    Gaze,
    GazeTarget,
    JudgementResult,
    Lantern,
    LanternFade,
    Mode,
    ModeRequest,
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
    SnapshotRequest,
    Speak,
    StartConversation,
    State,
    StopConversation,
    TakeSnapshot,
    Tick,
    Verdict,
)
from warashi_agent.voice import VoiceLine, choose_line

LANTERN_FADE_MS_MAX = 10_000

# Ids of the two closing lines of a voice session. Defined here, before the Reaction code
# uses them; the conversation flow below refers to them by the same names.
CONVERSATION_BYE_LINE = "conversation_bye"
CONVERSATION_TROUBLE_LINE = "conversation_trouble"
CONVERSATION_LINE_IDS = frozenset({CONVERSATION_BYE_LINE, CONVERSATION_TROUBLE_LINE})
"""Upper Clamp of every ``LanternFade.fade_ms`` (R12.2, docs/schema.md)."""

IdKind = Literal["snap", "motion", "play"]
"""Kinds of identifiers the State_Machine derives from an Event ``uid`` (R1.4)."""


# --------------------------------------------------------------------------------------------
# Records inside a phase or an Encounter
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True, kw_only=True)
class SnapshotAttempt:
    """One snapshot request and its wait for a Verdict (R3.1).

    The angles are the last emitted Gaze_Target in the call that emitted ``TakeSnapshot``.
    They are kept because the Head_Tracker corrects relative to where the head looked when
    the picture was taken, not where it looks now (R5.3).
    """

    snapshot_id: str  # the Current_Snapshot_Id
    pan_deg: float
    tilt_deg: float
    deadline: float  # now + verdict_timeout_s
    verdict_processed: bool = False  # a second Verdict for this id is ignored (R3.3, R3.4)


@dataclass(frozen=True, kw_only=True)
class ScanMove:
    """A pending scan move after a ``no_face`` Verdict (R6.1, R6.2)."""

    motion_id: str
    deadline: float  # move start + glide_timeout_s


@dataclass(frozen=True, kw_only=True)
class ReactionLine:
    """The Reaction's voice line and its deadline (R7.6).

    ``play_id`` is ``None`` when the Category had no Available_Line (R7.7); the next Tick then
    ends the Reaction with reason ``error`` (R7.10).
    """

    play_id: str | None
    deadline: float | None  # emit time + audio_timeout_s


# --------------------------------------------------------------------------------------------
# Phase records: one per State, holding only what that State waits for and its deadlines
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True, kw_only=True)
class Sleeping:
    """Waiting for presence. No deadline (R10.1).

    ``quiet_until`` is set when an Encounter ends: PIR edges before it are ignored, so a person
    who stays in front of the doll is not greeted again every few seconds (``pir_quiet_s``).
    """

    state: ClassVar[State] = State.SLEEPING
    quiet_until: float = 0.0


@dataclass(frozen=True, kw_only=True)
class Remote:
    """Remote control from the dashboard (remote-mode M1 to M3).

    Always has a deadline, so the doll can never stay awake for ever: every accepted command
    moves it to ``now + remote_idle_s``, and the first Tick after it enters ``cooldown``.
    """

    state: ClassVar[State] = State.REMOTE
    idle_until: float


@dataclass(frozen=True, kw_only=True)
class Waking:
    """Lantern fading in, head gliding to center (R2.2 to R2.4)."""

    state: ClassVar[State] = State.WAKING
    motion_id: str
    fade_done_at: float  # entry + lantern_fade_in_ms / 1000
    deadline: float  # entry + waking_timeout_s
    arrived: bool = False  # the waking servo.arrived was received (R2.3)


@dataclass(frozen=True, kw_only=True)
class Seeking:
    """Snapshot attempts and scan moves (R3, R6). The attempt itself lives in the Encounter."""

    state: ClassVar[State] = State.SEEKING
    scan: ScanMove | None = None  # a pending scan move


@dataclass(frozen=True, kw_only=True)
class Gazing:
    """Head turning toward the face (R5.4, R5.6)."""

    state: ClassVar[State] = State.GAZING
    motion_id: str
    deadline: float  # entry + glide_timeout_s


@dataclass(frozen=True, kw_only=True)
class ConversationGrant:
    """A ``conversation.start`` stored in ``greeting`` until the greeting line ends (R11.2).

    ``token`` is a secret, so it is hidden from ``repr()`` and never reaches a log line.
    """

    session_id: str
    token: str = field(repr=False)
    max_s: int
    silence_s: int


@dataclass(frozen=True, kw_only=True)
class Greeting:
    """Family greeting with a nod (R7.1, R7.2)."""

    state: ClassVar[State] = State.GREETING
    pan: float  # Gaze_Target recorded on entry, the nod returns here
    tilt: float
    nod_motion_id: str
    nod_deadline: float
    nod_returned: bool = False
    line: ReactionLine
    pending_conversation: ConversationGrant | None = None


@dataclass(frozen=True, kw_only=True)
class WarningPhase:
    """Silent stare, then the stranger line (R7.3, R7.4).

    Named ``WarningPhase`` because ``Warning`` would shadow the builtin exception class.
    """

    state: ClassVar[State] = State.WARNING
    stare_until: float  # entry + stare_s
    line: ReactionLine | None = None  # set when the stranger line is emitted


@dataclass(frozen=True, kw_only=True)
class Uncertain:
    """Cautious line, with or without a Verdict (R7.5)."""

    state: ClassVar[State] = State.UNCERTAIN
    line: ReactionLine


@dataclass(frozen=True, kw_only=True)
class Cooldown:
    """Head back to center, then release and fade out, then sleep (R8)."""

    state: ClassVar[State] = State.COOLDOWN
    motion_id: str
    glide_deadline: float  # entry + glide_timeout_s (R8.2)
    released: bool = False  # ReleaseServos emitted since entry
    until: float  # entry + cooldown_s (R8.3)
    manual: bool  # entered by mode.set sleep, so encounter.ended says "manual" (R8.3, R12.7)


@dataclass(frozen=True, kw_only=True)
class LookRequest:
    """An outstanding ``snapshot.request`` of a voice session (R11.15)."""

    request_id: str
    snapshot_id: str
    pan_deg: float  # head angles when the snapshot was requested
    tilt_deg: float
    deadline: float  # now + verdict_timeout_s; a lost snapshot must not block later looks


@dataclass(frozen=True, kw_only=True)
class Conversing:
    """A voice session is live. Always has a deadline, so the state always ends (R11.5, R11.6)."""

    state: ClassVar[State] = State.CONVERSING
    session_id: str
    deadline: float  # entry + min(command maxSeconds, conversation_max_s)
    look: LookRequest | None = None
    # Snapshot ids already sent for this session. A verdict is acted on only for one of them.
    looked_snapshot_ids: tuple[str, ...] = ()


Phase = (
    Sleeping
    | Waking
    | Seeking
    | Gazing
    | Greeting
    | WarningPhase
    | Uncertain
    | Cooldown
    | Conversing
    | Remote
)


# --------------------------------------------------------------------------------------------
# Encounter, audio and camera bookkeeping
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True, kw_only=True)
class Encounter:
    """One visit, from the ``pir.rising`` that leaves ``sleeping`` to the next ``sleeping``."""

    encounter_id: str  # the uid of the starting pir.rising (a UUID v4 on the wire)
    accepted: AcceptedVerdict | None = None  # the Accepted_Verdict (R4)
    attempt: SnapshotAttempt | None = None  # the current snapshot attempt
    scans_run: int = 0  # scan attempts run in this Encounter (R6.1, R6.5)
    reacted: bool = False  # reaction.performed was published (R7.8)
    conversation_requested: bool = False  # conversation.requested was sent (R11, S1)
    # Set for a remote photo (remote-actions R2): the id of the ``snapshot.request`` that started
    # this Encounter. Such an Encounter takes one picture and rests; it never asks for a Verdict.
    photo_request_id: str | None = None

    def with_verdict(self, accepted: AcceptedVerdict) -> Encounter:
        """Record ``accepted`` unless a final Accepted_Verdict is already set (R4.6).

        ``family``, ``stranger`` and ``uncertain`` decide the Reaction, so they hold until the
        Encounter ends: a later Verdict must never turn a family visit into a stranger one
        (R7.9). Only ``no_face`` can be replaced, because it leads to a scan and a new
        snapshot attempt rather than a Reaction (R6). Returns ``self`` when nothing changes,
        so an unchanged Encounter stays the identical object (R1.9).
        """
        if self.accepted in FINAL_VERDICTS or self.accepted is accepted:
            return self
        return dataclasses.replace(self, accepted=accepted)


FINAL_VERDICTS: frozenset[AcceptedVerdict] = frozenset(
    {AcceptedVerdict.FAMILY, AcceptedVerdict.STRANGER, AcceptedVerdict.UNCERTAIN}
)
"""Accepted_Verdicts kept until the Encounter ends (R4.6)."""


@dataclass(frozen=True, kw_only=True)
class PendingAudio:
    """An unfinished ``PlayLine`` or ``PlayAudioUrl``, for the ``audio_busy`` rule (R12.6)."""

    play_id: str
    # PlayLine: emit time + audio_timeout_s;
    # PlayAudioUrl: emit time + download_timeout_s + audio_timeout_s.
    busy_until: float


@dataclass(frozen=True, kw_only=True)
class PendingPhoto:
    """A remote photo asked for during an Encounter (remote-feedback F1).

    It lives beside the phase, not inside it: the picture is taken at the current head angles
    while the visit goes on, and it is published whatever State the doll is in when the camera
    answers. At most one is outstanding, so the slow camera and uplink stay bounded.
    """

    request_id: str
    snapshot_id: str
    pan_deg: float  # head angles when the photo was asked for
    tilt_deg: float
    deadline: float  # now + verdict_timeout_s; a lost result must not block later photos


@dataclass(frozen=True, kw_only=True)
class CameraWatch:
    """The snapshot that keeps ``cameraActive`` true (R23.2)."""

    snapshot_id: str
    deadline: float  # the attempt deadline


@dataclass(frozen=True, kw_only=True)
class MachineState:
    """The value passed to and returned by ``step()`` (Glossary: Machine_State)."""

    # Fixed for the process; kept across a restart (R10.7).
    config: Config
    lines: tuple[VoiceLine, ...]  # Available_Lines sorted by id in code-point order (R1.3)
    agent_version: str
    start_time: float  # the now of loop entry (R1.7)
    # Inputs and mode.
    mode: Mode = Mode.GUARD
    cloud_connected: bool = False  # disconnected until cloud.connected arrives (R9.1)
    pir_high: bool = False
    # The State and the current visit.
    phase: Phase = field(default_factory=Sleeping)
    encounter: Encounter | None = None
    # Outputs as last emitted. Only StepContext.commit() writes these three.
    gaze: tuple[float, float] = (0.0, 0.0)  # last GazeTarget (R23.4)
    lantern_level: float = 0.0  # level of the last LanternFade (R23.4)
    servos_released: bool = True  # no GazeTarget since the last ReleaseServos (R8.4)
    # Bookkeeping for the audio_busy rule and status reports.
    audio: tuple[PendingAudio, ...] = ()  # unfinished PlayLine / PlayAudioUrl
    camera: CameraWatch | None = None  # cameraActive is camera is not None (R23.2)
    photo: PendingPhoto | None = None  # a remote photo taken during an Encounter (F1)
    first_tick_seen: bool = False  # R23.1
    last_status_at: float | None = None  # now of the last PublishStatus

    @property
    def state(self) -> State:
        """The State, derived from the phase record."""
        return self.phase.state

    def line_by_id(self, line_id: str) -> VoiceLine | None:
        """The Available_Line with this id, or ``None`` (R12.5).

        A linear search is enough: the manifest holds a handful of lines, and the Pi only
        looks one up per ``speak`` command.
        """
        return next((line for line in self.lines if line.id == line_id), None)


def initial_state(
    *,
    config: Config,
    lines: tuple[VoiceLine, ...],
    agent_version: str,
    start_time: float,
    mode: Mode = Mode.GUARD,
    cloud_connected: bool = False,
) -> MachineState:
    """Machine_State at startup (R1.7), or after a restart (R10.7).

    State ``sleeping``, no Encounter, lantern level 0, servos released, PIR level low. A
    restart passes the failing state's ``start_time``, ``mode`` and ``cloud_connected``; the
    PIR level is low, so a person still in front of the doll needs a fresh ``pir.rising``.

    The lines are sorted by ``id`` here as well as in the Manifest_Loader, so the line-choice
    rule (R1.3) holds whatever the caller passes.
    """
    return MachineState(
        config=config,
        lines=tuple(sorted(lines, key=lambda line: line.id)),
        agent_version=agent_version,
        start_time=start_time,
        mode=mode,
        cloud_connected=cloud_connected,
    )


# --------------------------------------------------------------------------------------------
# StepContext: per-call collector of Actions, identifiers and emitted outputs
# --------------------------------------------------------------------------------------------


class StepContext:
    """Mutable helper that lives for one ``step()`` call only.

    It is created at the start of the call and discarded at the end, so no mutable state
    escapes and ``step()`` stays pure. Handlers emit Actions only through it, which keeps
    three rules in one place:

    - every ``GazeTarget`` is Clamped to the Calibrated_Range (R5.7, hardware.md);
    - ``state.changed`` is announced with the right ``from`` and the current ``encounterId``
      (R1.8, R8.5);
    - the last emitted Gaze_Target, lantern level and the ``servos_released`` flag stay in
      step with the emitted Actions (R3.1, R8.4, R23.4).
    """

    def __init__(self, ms: MachineState, event: Event, now: float) -> None:
        self.ms = ms
        self.event = event
        self.now = now
        self.actions: list[Action] = []
        self._counts: dict[str, int] = {}
        # The State as of the last change_state() in this call, so chained changes report the
        # right "from".
        self.state: State = ms.state
        # The encounterId every PublishEvent of this call carries. begin_encounter() sets it;
        # entering sleeping keeps it for the rest of the call, so the ending events still
        # carry the ending id (R8.5).
        self.encounter_id: str | None = (
            ms.encounter.encounter_id if ms.encounter is not None else None
        )
        # Outputs as last emitted, starting from the argument state.
        self.gaze: tuple[float, float] = ms.gaze
        self.lantern_level: float = ms.lantern_level
        self.servos_released: bool = ms.servos_released

    @property
    def config(self) -> Config:
        return self.ms.config

    # Identifiers (R1.4) --------------------------------------------------------------------

    def new_id(self, kind: IdKind) -> str:
        """Return ``'<kind>-<n>-<uid>'``.

        The string is injective in ``(kind, n, uid)``: Events with different ``uid`` values
        give different identifiers, and the per-call counter ``n`` keeps two identifiers of
        one kind in one call apart.
        """
        n = self._counts.get(kind, 0) + 1
        self._counts[kind] = n
        return f"{kind}-{n}-{self.event.uid}"

    def new_encounter_id(self) -> str:
        """Return the Event ``uid`` as is.

        At most one Encounter starts per call, so no counter is needed, and the id stays a
        UUID on the wire as ``docs/schema.md`` shows.
        """
        return self.event.uid

    def begin_encounter(self) -> Encounter:
        """Create the new Encounter and make its id the one later PublishEvents carry."""
        encounter = Encounter(encounter_id=self.new_encounter_id())
        self.encounter_id = encounter.encounter_id
        return encounter

    # Emitting Actions ------------------------------------------------------------------------

    def gaze_to(self, pan_deg: float, tilt_deg: float) -> GazeTarget:
        """Emit a ``GazeTarget`` Clamped to the Calibrated_Range with a new Motion_Id.

        This is the only way handlers move the head, so no angle outside the neck limits can
        leave ``step()`` (R5.7). The inputs must be finite: the codec rejects non-finite
        numbers, and ``clamp`` raises on them as a guard.
        """
        pan, tilt = clamp_gaze((pan_deg, tilt_deg), self.config)
        action = GazeTarget(pan_deg=pan, tilt_deg=tilt, motion_id=self.new_id("motion"))
        self.actions.append(action)
        self.gaze = (pan, tilt)
        self.servos_released = False
        return action

    def release_servos(self) -> ReleaseServos:
        """Emit ``ReleaseServos`` (R8.2, R8.4)."""
        action = ReleaseServos()
        self.actions.append(action)
        self.servos_released = True
        return action

    def fade_lantern(self, level: float, fade_ms: float) -> LanternFade:
        """Emit ``LanternFade`` with ``level`` Clamped to [0, 1] and ``fade_ms`` to [0, 10000].

        Clamping here covers both Config values and manual ``lantern`` commands (R12.2).
        ``fade_ms`` is rounded to an integer because the Action and the wire use integers.
        """
        clamped_level = clamp(level, 0.0, 1.0)
        clamped_ms = round(clamp(fade_ms, 0, LANTERN_FADE_MS_MAX))
        action = LanternFade(level=clamped_level, fade_ms=clamped_ms)
        self.actions.append(action)
        self.lantern_level = clamped_level
        return action

    def emit(self, action: Action) -> Action:
        """Append an Action that needs no output tracking.

        ``GazeTarget``, ``ReleaseServos`` and ``LanternFade`` must use their helpers, so this
        method refuses them: emitting one here would bypass the Clamp or leave the tracked
        outputs stale.
        """
        if isinstance(action, GazeTarget | ReleaseServos | LanternFade):
            raise TypeError("use gaze_to(), release_servos() or fade_lantern()")
        self.actions.append(action)
        return action

    def publish(self, data: EventData) -> PublishEvent:
        """Emit ``PublishEvent`` with the current ``encounterId`` of this call."""
        action = PublishEvent(data=data, encounter_id=self.encounter_id)
        self.actions.append(action)
        return action

    def report_error(
        self, code: ErrorCode, message: str, ref_id: str | None = None
    ) -> PublishEvent:
        """Emit ``error.reported``. ``message`` must be a fixed text without private data."""
        return self.publish(ErrorReported(code=code, message=message, ref_id=ref_id))

    def change_state(self, to: State, reason: Reason) -> PublishEvent:
        """Announce a State change; call it before the entry Actions of the new State.

        The caller builds the new phase record; this helper only emits
        ``state.changed(from, to, reason)`` so the announcement comes first (R1.8) and carries
        the current ``encounterId``. The reason must come from the R24.4 table.
        """
        if to is self.state:
            raise ValueError("change_state() needs a different State")
        action = self.publish(StateChanged(from_=self.state, to=to, reason=reason))
        self.state = to
        return action

    # Closing the call --------------------------------------------------------------------------

    def commit(self, nxt: MachineState) -> MachineState:
        """Copy the tracked outputs into the state a handler returned.

        Handlers never set ``gaze``, ``lantern_level`` or ``servos_released`` themselves. When
        nothing was emitted the returned object is ``nxt`` itself, so an Event that changes
        nothing returns its argument unchanged (R1.9).
        """
        outputs = (self.gaze, self.lantern_level, self.servos_released)
        if outputs == (nxt.gaze, nxt.lantern_level, nxt.servos_released):
            return nxt
        return dataclasses.replace(
            nxt,
            gaze=self.gaze,
            lantern_level=self.lantern_level,
            servos_released=self.servos_released,
        )


# --------------------------------------------------------------------------------------------
# step() and finalize()
# --------------------------------------------------------------------------------------------

Handler = Callable[[StepContext], MachineState]
"""A handler reads ``ctx.ms``, ``ctx.event`` and ``ctx.now``, emits through ``ctx`` and
returns the next state."""


def step(ms: MachineState, event: Event, now: float) -> tuple[MachineState, tuple[Action, ...]]:
    """Compute the next Machine_State and the Actions for one Event (R1).

    State-specific handlers come first; global handlers cover Events that behave the same in
    every State. An Event without a handler returns ``ms`` unchanged and no Actions (R1.9).

    Only defined Events are accepted (R1.6). Anything else is a programming error and raises
    ``TypeError``; the Dispatcher then restarts the State_Machine safely (R10.5).
    """
    if not isinstance(event, Event):
        raise TypeError(f"step() got an undefined event type: {type(event).__name__}")
    ctx = StepContext(ms, event, now)
    handler = (
        photo_result_handler(ms, event)
        or STATE_HANDLERS.get((ms.state, type(event)))
        or GLOBAL_HANDLERS.get(type(event))
    )
    nxt = handler(ctx) if handler is not None else ms
    return finalize(ctx, ms, ctx.commit(nxt))


def finalize(
    ctx: StepContext, prev: MachineState, nxt: MachineState
) -> tuple[MachineState, tuple[Action, ...]]:
    """Per-call bookkeeping after the handler (R1.8, R23).

    Doing this once here, instead of in every handler, keeps the status rule in one place:
    no flow can forget the report or emit two in one call. The three steps are the camera
    indicator, the pruning of finished audio entries and the single trailing
    ``PublishStatus``. When none of them applies, ``nxt`` is returned as is, so an Event
    without a response still returns its argument unchanged (R1.9).
    """
    camera = next_camera_watch(ctx, prev)
    state_changed = any(
        isinstance(action, PublishEvent) and isinstance(action.data, StateChanged)
        for action in ctx.actions
    )
    audio = (
        tuple(pending for pending in nxt.audio if ctx.now < pending.busy_until)
        if state_changed
        else nxt.audio
    )
    is_tick = isinstance(ctx.event, Tick)
    first_tick = is_tick and not prev.first_tick_seen
    interval_due = (
        is_tick
        and prev.last_status_at is not None
        and ctx.now >= prev.last_status_at + nxt.config.timing.status_interval_s
    )
    camera_changed = (camera is None) is not (prev.camera is None)
    # A reconnect follows a broker last will, so the dashboard needs a fresh report (M5).
    reconnected = isinstance(ctx.event, CloudConnected)
    # A remote command changes what the dashboard shows (head, lantern, mode) without any State
    # change, so the doll reports right after it (M6).
    command_applied = (
        isinstance(ctx.event, Gaze | Lantern)
        and any(isinstance(a, GazeTarget | LanternFade) for a in ctx.actions)
    ) or nxt.mode is not prev.mode
    report = (
        state_changed
        or camera_changed
        or first_tick
        or interval_due
        or reconnected
        or command_applied
    )

    updates: dict[str, object] = {}
    if is_tick and nxt.photo is not None and ctx.now >= nxt.photo.deadline:
        updates["photo"] = None  # the camera never answered; allow the next photo (F1)
    if camera != nxt.camera:
        updates["camera"] = camera
    if audio != nxt.audio:
        updates["audio"] = audio
    if first_tick:
        updates["first_tick_seen"] = True
    if report:
        updates["last_status_at"] = ctx.now
    if updates:
        nxt = dataclasses.replace(nxt, **updates)
    if report:
        ctx.emit(PublishStatus(data=status_report(nxt, ctx.now)))
    return nxt, tuple(ctx.actions)


def next_camera_watch(ctx: StepContext, prev: MachineState) -> CameraWatch | None:
    """The camera indicator at the end of this call (R23.2).

    The indicator is cleared first and set second, so a call that both ends one capture and
    asks for the next (a scan move ending on the deadline Tick) leaves it on.

    It is cleared only when the result for the watched Snapshot_Id is handled in
    ``seeking``, or by the first Tick at or after the attempt deadline. A late result outside
    ``seeking`` must not add an Action (R3.8, R3.9), so it leaves the indicator on until the
    deadline Tick; the indicator may over-report for a short while but never shows ``false``
    while ``rpicam-still`` may still run (design, Q2).

    The deadline is ``now + verdict_timeout_s`` of the emitting call, the same value
    ``start_snapshot_attempt`` stores as the attempt deadline (R3.1). The watch keeps its own
    copy because the Encounter, and with it the attempt, may end while the capture still runs.
    """
    camera = prev.camera
    event = ctx.event
    if camera is not None:
        result_handled = (
            isinstance(event, SnapshotReady | SnapshotFailed)
            and event.snapshot_id == camera.snapshot_id
            and (
                prev.state in (State.SEEKING, State.CONVERSING)
                or (prev.photo is not None and prev.photo.snapshot_id == event.snapshot_id)
            )
        )
        deadline_passed = isinstance(event, Tick) and ctx.now >= camera.deadline
        if result_handled or deadline_passed:
            camera = None
    for action in ctx.actions:
        if isinstance(action, TakeSnapshot):
            camera = CameraWatch(
                snapshot_id=action.snapshot_id,
                deadline=ctx.now + prev.config.timing.verdict_timeout_s,
            )
    return camera


def status_report(ms: MachineState, now: float) -> StatusReport:
    """The ``status.report`` data for the state at the end of a call (R23.4, R23.5).

    Built from the returned state so the dashboard sees what the doll does after this call.
    ``micActive`` is true only in ``conversing``, the one state in which the doll records
    audio (voice-conversation R11.19, S10).
    """
    pan, tilt = ms.gaze
    return StatusReport(
        state=ms.state,
        mode=ms.mode,
        pan_deg=pan,
        tilt_deg=tilt,
        lantern=ms.lantern_level,
        camera_active=ms.camera is not None,
        mic_active=ms.state is State.CONVERSING,
        motion_enabled=ms.config.motion.motion_enabled,
        uptime_sec=math.floor(now - ms.start_time),
        agent_version=ms.agent_version,
    )


# --------------------------------------------------------------------------------------------
# Small helpers shared by the flows
# --------------------------------------------------------------------------------------------


def _as[T](value: object, cls: type[T]) -> T:
    """Return ``value`` typed as ``cls``.

    The handler tables already guarantee the phase and Event types, so a mismatch is a
    programming error. Raising lets the Dispatcher restart the State_Machine safely (R10.5)
    instead of acting on a record of the wrong shape.
    """
    if not isinstance(value, cls):
        raise TypeError(f"expected {cls.__name__}, got {type(value).__name__}")
    return value


def _with_connectivity(ms: MachineState, connected: bool) -> MachineState:
    """Record the cloud connectivity; return ``ms`` itself when it is already recorded (R1.9)."""
    if ms.cloud_connected is connected:
        return ms
    return dataclasses.replace(ms, cloud_connected=connected)


def _with_pir_level(ms: MachineState, high: bool) -> MachineState:
    """Record the PIR level (R11.3); return ``ms`` itself when it is already recorded (R1.9)."""
    if ms.pir_high is high:
        return ms
    return dataclasses.replace(ms, pir_high=high)


# --------------------------------------------------------------------------------------------
# Flow: sleeping -> waking -> seeking, and the snapshot attempt (task 9.1; R2, R3.1, R3.2,
# R3.8, R3.9, R9.1, R9.7)
# --------------------------------------------------------------------------------------------


def _is_photo(ms: MachineState) -> bool:
    """True while the Encounter is a remote photo (remote-actions R2)."""
    return ms.encounter is not None and ms.encounter.photo_request_id is not None


def on_pir_rising_sleeping(ctx: StepContext) -> MachineState:
    """``pir.rising`` in ``sleeping``: start an Encounter when the doll may (R2.1).

    The PIR sensor needs ``pir_warmup_s`` to settle after power-up and fires at random
    before that, so early edges only record the level (R11.5). Mode ``sleep`` ignores
    presence on purpose (R11.6).
    """
    ms = _with_pir_level(ctx.ms, True)
    warm = ctx.now - ms.start_time >= ms.config.timing.pir_warmup_s
    quiet = ctx.now < _as(ms.phase, Sleeping).quiet_until
    if ms.mode is not Mode.GUARD or not warm or quiet:
        return ms
    return enter_waking(ctx, ms)


def enter_waking(
    ctx: StepContext,
    ms: MachineState,
    *,
    source: Literal["pir", "manual"] = "pir",
    reason: Reason = Reason.PRESENCE,
    photo_request_id: str | None = None,
) -> MachineState:
    """Start the Encounter and enter ``waking`` with reason ``presence`` (R2.1, R2.2).

    The Encounter is created before ``state.changed`` so that the announcement already
    carries the new ``encounterId`` (R1.8). The lantern comes up first because the camera is
    weak in the dark, and the head glides slowly to the calibrated center: this is the first
    motion of the Encounter, and it happens only in response to the PIR edge (hardware.md).
    """
    encounter = ctx.begin_encounter()
    if photo_request_id is not None:
        encounter = dataclasses.replace(encounter, photo_request_id=photo_request_id)
    ctx.change_state(State.WAKING, reason)
    ctx.publish(PresenceDetected(source=source))
    lantern = ms.config.lantern
    ctx.fade_lantern(lantern.lantern_wake_level, lantern.lantern_fade_in_ms)
    motion = ctx.gaze_to(0.0, 0.0)
    phase = Waking(
        motion_id=motion.motion_id,
        fade_done_at=ctx.now + lantern.lantern_fade_in_ms / 1000,
        deadline=ctx.now + ms.config.timing.waking_timeout_s,
    )
    return dataclasses.replace(ms, phase=phase, encounter=encounter)


def on_servo_arrived_waking(ctx: StepContext) -> MachineState:
    """The waking glide arrived: leave ``waking`` if the fade-in is over, else remember it.

    Waiting for both keeps the first snapshot from being taken in a half-lit room (R2.3).
    An arrival for another Motion_Id is stale and changes nothing (R5.8).
    """
    ms = ctx.ms
    phase = _as(ms.phase, Waking)
    if _as(ctx.event, ServoArrived).motion_id != phase.motion_id:
        return ms
    if ctx.now >= phase.fade_done_at:
        return leave_waking(ctx, ms, Reason.ARRIVED)
    if phase.arrived:
        return ms
    return dataclasses.replace(ms, phase=dataclasses.replace(phase, arrived=True))


def on_tick_waking(ctx: StepContext) -> MachineState:
    """Deadline checks of ``waking`` (R2.3, R2.4, R10.3).

    The arrival check comes first: when a sparse Tick finds both the arrival with the fade
    over and the waking deadline passed, the R24.4 table's first matching row is the
    ``arrived`` one.
    """
    ms = ctx.ms
    phase = _as(ms.phase, Waking)
    if phase.arrived and ctx.now >= phase.fade_done_at:
        return leave_waking(ctx, ms, Reason.ARRIVED)
    if ctx.now >= phase.deadline:
        return leave_waking(ctx, ms, Reason.TIMEOUT)
    return ms


def leave_waking(ctx: StepContext, ms: MachineState, reason: Reason) -> MachineState:
    """Leave ``waking`` for ``seeking`` (cloud connected) or the Offline_Reaction (R2.5, R2.6).

    ``reason`` is the leaving cause (``arrived`` or ``timeout``). It applies only to the
    connected branch; the disconnected branch always announces ``offline`` (R9.8).
    """
    if ms.cloud_connected:
        return enter_seeking(ctx, ms, reason)
    if _is_photo(ms):
        # A photo cannot reach the cloud, so there is nothing to take; go back to rest quietly.
        return enter_cooldown(ctx, ms, Reason.OFFLINE)
    return leave_waking_disconnected(ctx, ms)


def leave_waking_disconnected(ctx: StepContext, ms: MachineState) -> MachineState:
    """Leave ``waking`` with the cloud disconnected: the Offline_Reaction (R2.6, R9.2, R9.8).

    Without a cloud no Verdict can come, so taking a snapshot would only waste the slow
    uplink and delay the doll; it skips ``seeking`` (no ``TakeSnapshot``, R9.5) and says
    the cautious line at once. The reason is ``offline`` whatever ended ``waking``
    (arrival or deadline), because the first matching row of the R24.4 table is the
    disconnected one. This bounds the line to Offline_Bound_Disconnected after presence.
    """
    return enter_uncertain(ctx, ms, offline=True, reason=Reason.OFFLINE)


def enter_seeking(ctx: StepContext, ms: MachineState, reason: Reason) -> MachineState:
    """Enter ``seeking`` and start the first snapshot attempt in the same call (R2.5, R3.1)."""
    ctx.change_state(State.SEEKING, reason)
    return start_snapshot_attempt(ctx, dataclasses.replace(ms, phase=Seeking()))


def start_snapshot_attempt(ctx: StepContext, ms: MachineState) -> MachineState:
    """Emit ``TakeSnapshot`` and make its id the Current_Snapshot_Id (R3.1).

    The snapshot angles are the last emitted Gaze_Target as of this call (``ctx.gaze``),
    because the camera sits on the tilt plate and sees where the head was sent; the
    Head_Tracker later corrects relative to these angles (R5.3). Used on entering
    ``seeking`` and when a scan move ends (R6.2).
    """
    encounter = _as(ms.encounter, Encounter)
    snapshot_id = ctx.new_id("snap")
    ctx.emit(TakeSnapshot(snapshot_id=snapshot_id))
    pan, tilt = ctx.gaze
    attempt = SnapshotAttempt(
        snapshot_id=snapshot_id,
        pan_deg=pan,
        tilt_deg=tilt,
        deadline=ctx.now + ms.config.timing.verdict_timeout_s,
    )
    return dataclasses.replace(ms, encounter=dataclasses.replace(encounter, attempt=attempt))


def on_snapshot_ready_seeking(ctx: StepContext) -> MachineState:
    """Publish ``snapshot.captured`` for the Current_Snapshot_Id (R3.2).

    A stale snapshot (another id) publishes nothing, so the cloud never judges a picture the
    doll no longer waits for (R3.8). ``snapshot.ready`` outside ``seeking`` has no handler
    at all. The State and deadlines stay as they are: the attempt deadline keeps running
    while the cloud works.
    """
    ms = ctx.ms
    event = _as(ctx.event, SnapshotReady)
    attempt = ms.encounter.attempt if ms.encounter is not None else None
    if attempt is None or event.snapshot_id != attempt.snapshot_id:
        return ms
    photo_id = ms.encounter.photo_request_id if ms.encounter is not None else None
    ctx.publish(
        SnapshotCaptured(
            snapshot_id=attempt.snapshot_id,
            width=event.width,
            height=event.height,
            pan_deg=attempt.pan_deg,
            tilt_deg=attempt.tilt_deg,
            jpeg_base64=base64.b64encode(event.jpeg).decode("ascii"),
            request_id=photo_id,
            purpose="photo" if photo_id is not None else None,
        )
    )
    if photo_id is not None:
        # One picture is all a remote photo needs: no Verdict, no Reaction (remote-actions R2).
        return enter_cooldown(ctx, ms, Reason.PHOTO_DONE)
    return ms


SNAPSHOT_FAILED_MESSAGES: Mapping[str, str] = MappingProxyType(
    {
        ErrorCode.CAMERA_FAILED: "snapshot capture failed or timed out",
        ErrorCode.SNAPSHOT_TOO_LARGE: "snapshot above the JPEG size limit at the lowest quality",
    }
)
"""Fixed ``error.reported`` texts for ``snapshot.failed``; no file names or image data."""


def on_snapshot_failed(ctx: StepContext) -> MachineState:
    """Report a failed snapshot and change nothing else (R3.9).

    This global handler covers stale ids and every State other than ``seeking``;
    ``on_snapshot_failed_seeking`` handles the Current_Snapshot_Id (R3.5).
    """
    code = ErrorCode(_as(ctx.event, SnapshotFailed).code)
    ctx.report_error(code, SNAPSHOT_FAILED_MESSAGES[code])
    return ctx.ms


def on_snapshot_failed_seeking(ctx: StepContext) -> MachineState:
    """``snapshot.failed`` in ``seeking``: report it, and give up for the current one (R3.5).

    For the Current_Snapshot_Id no picture will reach the cloud, so no Verdict can come;
    the doll reacts at once with the cautious line (reason ``error``) instead of waiting
    for the attempt deadline. While a scan move is pending, the recorded attempt already
    has its Verdict and the next snapshot has not been asked for, so no id is current and
    the failure is stale: it is only reported, like any other stale id (R3.9).
    """
    ms = on_snapshot_failed(ctx)
    attempt = ms.encounter.attempt if ms.encounter is not None else None
    pending_scan = _as(ms.phase, Seeking).scan is not None
    failed_id = _as(ctx.event, SnapshotFailed).snapshot_id
    if pending_scan or attempt is None or failed_id != attempt.snapshot_id:
        return ms
    if _is_photo(ms):
        return enter_cooldown(ctx, ms, Reason.ERROR)
    return enter_uncertain(ctx, ms, offline=True, reason=Reason.ERROR)


def on_cloud_connected(ctx: StepContext) -> MachineState:
    """Record that the cloud is reachable; nothing else changes (R2.7, R9.7)."""
    return _with_connectivity(ctx.ms, True)


def on_cloud_disconnected(ctx: StepContext) -> MachineState:
    """Record that the cloud is unreachable (R9.1, R2.7, R9.7).

    This global handler covers every State other than ``seeking``, where
    ``on_cloud_disconnected_seeking`` also reacts (R3.7).
    """
    return _with_connectivity(ctx.ms, False)


def on_cloud_disconnected_seeking(ctx: StepContext) -> MachineState:
    """``cloud.disconnected`` in ``seeking``: the Offline_Reaction in the same call (R3.7, R9.8).

    A Verdict can no longer arrive, so waiting for the attempt deadline would only leave
    the person standing in silence. This applies during a pending scan move too, because
    the next snapshot could not be judged either; it also keeps R9.5, since the scan move
    would otherwise end with a ``TakeSnapshot`` while disconnected.
    """
    ms = _with_connectivity(ctx.ms, False)
    if _is_photo(ms):
        return enter_cooldown(ctx, ms, Reason.OFFLINE)
    return enter_uncertain(ctx, ms, offline=True, reason=Reason.OFFLINE)


# --------------------------------------------------------------------------------------------
# Flow: Verdict, head tracking and gazing (task 10.1; R3.3, R3.4, R4, R5.4 to R5.8)
# --------------------------------------------------------------------------------------------


def accept(verdict: Verdict, confidence: float, j: JudgementConfig) -> AcceptedVerdict:
    """Apply the confidence thresholds to a cloud Verdict (R4.1 to R4.5).

    A low-confidence ``family`` or ``stranger`` becomes ``uncertain``, so the doll never
    greets a stranger as family or warns a family member as a stranger by mistake. The
    thresholds are inclusive: a confidence exactly at the minimum is accepted.
    """
    if verdict is Verdict.FAMILY:
        ok = confidence >= j.family_confidence_min
        return AcceptedVerdict.FAMILY if ok else AcceptedVerdict.UNCERTAIN
    if verdict is Verdict.STRANGER:
        ok = confidence >= j.stranger_confidence_min
        return AcceptedVerdict.STRANGER if ok else AcceptedVerdict.UNCERTAIN
    if verdict is Verdict.NO_FACE:
        return AcceptedVerdict.NO_FACE
    return AcceptedVerdict.UNCERTAIN


def on_judgement_seeking(ctx: StepContext) -> MachineState:
    """``judgement.result`` in ``seeking``: act on the Verdict for the current snapshot (R3.3).

    The result is matched by ``snapshotId`` only, never by ``encounterId``, because the cloud
    cannot always know the current Encounter (docs/schema.md). It is ignored, with the
    argument returned unchanged, when a scan move is pending (R6.6), when it names another
    snapshot or when a Verdict for this snapshot was already processed (R3.4, QoS 1 can
    redeliver). Outside ``seeking`` no handler exists, which ignores it the same way.

    No deadline is compared here: a Verdict that arrives after the attempt deadline but
    before the Tick that observes it is still processed (R3.3, R10.3).
    """
    ms = ctx.ms
    event = _as(ctx.event, JudgementResult)
    if _as(ms.phase, Seeking).scan is not None:
        return ms
    encounter = _as(ms.encounter, Encounter)
    attempt = encounter.attempt
    if attempt is None or event.snapshot_id != attempt.snapshot_id or attempt.verdict_processed:
        return ms

    accepted = accept(event.verdict, event.confidence, ms.config.judgement)
    encounter = dataclasses.replace(
        encounter, attempt=dataclasses.replace(attempt, verdict_processed=True)
    ).with_verdict(accepted)
    ms = dataclasses.replace(ms, encounter=encounter)

    if accepted in (AcceptedVerdict.FAMILY, AcceptedVerdict.STRANGER):
        if event.face is not None:
            return enter_gazing(ctx, ms, event.face, attempt)  # R5.4
        if accepted is AcceptedVerdict.FAMILY:  # R5.5
            return enter_greeting(ctx, ms, Reason.VERDICT)
        return enter_warning(ctx, ms, Reason.VERDICT)
    if accepted is AcceptedVerdict.UNCERTAIN:
        return enter_uncertain(ctx, ms, offline=False, reason=Reason.VERDICT)
    return on_no_face(ctx, ms)


def on_no_face(ctx: StepContext, ms: MachineState) -> MachineState:
    """An accepted ``no_face``: scan, or give up with the cautious line (R6.1, R6.3).

    A person standing to one side is outside the camera's field of view, so the doll looks
    around a little before it decides that nobody is there. Once ``scan_attempts_max`` scans
    have run (at once when it is 0) it gives up with the cautious line, so it never hangs.
    """
    encounter = _as(ms.encounter, Encounter)
    if encounter.scans_run < ms.config.camera.scan_attempts_max:
        return start_scan_move(ctx, ms, encounter)
    return enter_uncertain(ctx, ms, offline=False, reason=Reason.NO_FACE)


# --------------------------------------------------------------------------------------------
# Flow: scanning when no face is seen (task 11.1; R6)
# --------------------------------------------------------------------------------------------


def start_scan_move(ctx: StepContext, ms: MachineState, encounter: Encounter) -> MachineState:
    """Turn the head to the next scan position and wait for the move to end (R6.1, R6.5).

    Entry ``k = scans_run + 1`` (1-based) of ``scan_pan_positions_deg`` is used, so the
    positions run in their configured order and each runs at most once per Encounter. Tilt
    goes to 0 because a person is expected at about head height. ``gaze_to`` Clamps the pan,
    since the configured positions are not checked against the calibrated limits. The scan
    counts as run from this call, so a late Verdict can never start the same scan twice.

    The State stays ``seeking`` and no ``state.changed`` is published. The processed
    attempt stays in the Encounter until the next attempt replaces it; ``on_judgement_seeking``
    ignores every Verdict while the move is pending (R6.6).

    The config loader guarantees ``scan_attempts_max <= len(scan_pan_positions_deg)``; a
    hand-built Config that breaks this raises ``IndexError`` here, and the Dispatcher
    restarts the State_Machine safely (R10.5).
    """
    camera, timing = ms.config.camera, ms.config.timing
    pan = camera.scan_pan_positions_deg[encounter.scans_run]
    motion = ctx.gaze_to(pan, 0.0)
    scan = ScanMove(motion_id=motion.motion_id, deadline=ctx.now + timing.glide_timeout_s)
    return dataclasses.replace(
        ms,
        phase=Seeking(scan=scan),
        encounter=dataclasses.replace(encounter, scans_run=encounter.scans_run + 1),
    )


def end_scan_move(ctx: StepContext, ms: MachineState) -> MachineState:
    """Clear the scan move and take the next snapshot in the same call (R6.2, R3.1).

    ``start_snapshot_attempt`` records the last emitted Gaze_Target, which is the Clamped
    scan position, as the snapshot's angles. The Head_Tracker therefore corrects relative to
    where the head was sent for this scan (R5.3).
    """
    return start_snapshot_attempt(ctx, dataclasses.replace(ms, phase=Seeking()))


def on_servo_arrived_seeking(ctx: StepContext) -> MachineState:
    """The scan move arrived: take the next snapshot (R6.2).

    Only the pending scan move's Motion_Id counts. Any other arrival, or any arrival while
    no scan move is pending, is stale and changes nothing (R5.8).
    """
    ms = ctx.ms
    scan = _as(ms.phase, Seeking).scan
    if scan is None or _as(ctx.event, ServoArrived).motion_id != scan.motion_id:
        return ms
    return end_scan_move(ctx, ms)


def on_tick_seeking(ctx: StepContext) -> MachineState:
    """Deadline checks of ``seeking`` (R6.2, R10.3).

    A pending scan move ends on the first Tick at or after its glide deadline, so a servo
    that never reports arrival (for example a loose battery rail) does not stop the scan.
    While a scan move is pending, the processed attempt's deadline does not apply: that
    attempt already has its Verdict.

    Without a pending scan move, the first Tick at or after the attempt deadline gives up
    on a silent cloud with the cautious line, reason ``timeout`` (R3.6). This is what bounds
    the line to Offline_Bound_Silent when the cloud is connected but never answers.
    """
    ms = ctx.ms
    scan = _as(ms.phase, Seeking).scan
    if scan is not None:
        return end_scan_move(ctx, ms) if ctx.now >= scan.deadline else ms
    attempt = _as(ms.encounter, Encounter).attempt
    if attempt is None or attempt.verdict_processed or ctx.now < attempt.deadline:
        return ms
    if _is_photo(ms):
        return enter_cooldown(ctx, ms, Reason.TIMEOUT)
    return enter_uncertain(ctx, ms, offline=True, reason=Reason.TIMEOUT)


def enter_gazing(
    ctx: StepContext, ms: MachineState, face: FaceBox, attempt: SnapshotAttempt
) -> MachineState:
    """Turn the head toward the face and enter ``gazing`` with reason ``verdict`` (R5.4).

    The Head_Tracker corrects relative to the angles recorded with the snapshot, not the
    current head angles, because the camera saw the person from where the head was then
    (R5.3, hardware.md). ``gaze_to`` Clamps the result once more, which keeps every emitted
    angle inside the neck limits whatever the tracker returns (R5.7).
    """
    ctx.change_state(State.GAZING, Reason.VERDICT)
    pan, tilt = head_target(face, attempt.pan_deg, attempt.tilt_deg, ms.config)
    motion = ctx.gaze_to(pan, tilt)
    phase = Gazing(motion_id=motion.motion_id, deadline=ctx.now + ms.config.timing.glide_timeout_s)
    return dataclasses.replace(ms, phase=phase)


def on_servo_arrived_gazing(ctx: StepContext) -> MachineState:
    """The head now faces the person: start the Reaction with reason ``arrived`` (R5.6).

    An arrival for another Motion_Id is stale and changes nothing (R5.8).
    """
    ms = ctx.ms
    if _as(ctx.event, ServoArrived).motion_id != _as(ms.phase, Gazing).motion_id:
        return ms
    return leave_gazing(ctx, ms, Reason.ARRIVED)


def on_tick_gazing(ctx: StepContext) -> MachineState:
    """The glide took too long: start the Reaction anyway, with reason ``timeout`` (R5.6).

    A servo that never reports arrival (for example a loose battery rail) must not hang the
    Encounter (R10.1).
    """
    ms = ctx.ms
    if ctx.now < _as(ms.phase, Gazing).deadline:
        return ms
    return leave_gazing(ctx, ms, Reason.TIMEOUT)


def leave_gazing(ctx: StepContext, ms: MachineState, reason: Reason) -> MachineState:
    """Enter ``greeting`` for ``family`` or ``warning`` for ``stranger`` (R5.6).

    The cloud connectivity is not checked: the Verdict is already known, so the Reaction
    needs no cloud. ``gazing`` is entered only with one of these two Accepted_Verdicts, and
    R4.6 keeps it, so any other value is a programming error.
    """
    accepted = _as(ms.encounter, Encounter).accepted
    if accepted is AcceptedVerdict.FAMILY:
        return enter_greeting(ctx, ms, reason)
    if accepted is AcceptedVerdict.STRANGER:
        return enter_warning(ctx, ms, reason)
    raise ValueError(f"gazing with Accepted_Verdict {accepted!r}")


# --------------------------------------------------------------------------------------------
# Flow: Reactions (task 12.1; R1.3, R7, R10.6, R20.9)
# --------------------------------------------------------------------------------------------

VOICE_LINE_MISSING_MESSAGE = "no cached voice line of the reaction's category"
"""Fixed ``error.reported`` text for R7.7; it names no line text."""

AUDIO_FAILED_MESSAGES: Mapping[str, str] = MappingProxyType(
    {
        ErrorCode.AUDIO_FAILED: "playback failed, timed out or the file was missing",
        ErrorCode.DOWNLOAD_FAILED: "audio download failed, timed out, too large or not a WAV",
    }
)
"""Fixed ``error.reported`` texts for ``audio.failed``; no file names or URLs (R20.9)."""

ADAPTER_ERROR_MESSAGE = "a hardware adapter reported a problem"
"""Fixed ``error.reported`` text for ``adapter.error``; the code says which problem (R20.9)."""

NO_REACTION_LINE = ReactionLine(play_id=None, deadline=None)
"""The line record when no ``PlayLine`` was emitted; the next Tick ends the Reaction (R7.10)."""


def play_reaction_line(
    ctx: StepContext, ms: MachineState, kind: Category
) -> tuple[MachineState, VoiceLine | None, ReactionLine]:
    """Emit the Reaction's ``PlayLine`` and register it as unfinished audio (R7.1, R7.4, R7.5).

    The line is chosen with the ``rand`` of the current Event, so the choice is random for
    the listener but deterministic for ``step()`` (R1.3). The ``PendingAudio`` entry makes a
    ``speak`` command during the line answer ``audio_busy`` (R12.6); its busy window and the
    line deadline end at the same time, ``now + audio_timeout_s`` (R7.6).

    Returns no line and ``NO_REACTION_LINE`` when the Category has no Available_Line (R7.7),
    and also when the Encounter already reacted. The second case cannot happen through the
    transitions, because each Encounter enters one Reaction state only; the guard keeps the
    "at most one Reaction" rule (R7.8) local to this helper, and the next Tick still ends the
    Reaction, so the doll never hangs.
    """
    if _as(ms.encounter, Encounter).reacted:
        return ms, None, NO_REACTION_LINE
    # The two conversation lines are in the ``family`` category so a family member may hear
    # them, but they are never a Reaction: a greeting must not say goodbye (R11.10 to R11.13).
    pool = tuple(line for line in ms.lines if line.id not in CONVERSATION_LINE_IDS)
    line = choose_line(pool, kind, ctx.event.rand)
    if line is None:
        return ms, None, NO_REACTION_LINE
    play_id = ctx.new_id("play")
    ctx.emit(PlayLine(line_id=line.id, play_id=play_id))
    deadline = ctx.now + ms.config.timing.audio_timeout_s
    pending = PendingAudio(play_id=play_id, busy_until=deadline)
    ms = dataclasses.replace(ms, audio=(*ms.audio, pending))
    return ms, line, ReactionLine(play_id=play_id, deadline=deadline)


def announce_reaction(
    ctx: StepContext, ms: MachineState, kind: Category, line: VoiceLine | None, *, offline: bool
) -> MachineState:
    """Publish ``reaction.performed`` once per Encounter and set the Reaction flag (R7.8).

    The event says what the doll actually did, so a missing line is published with
    ``lineId: null`` and reported as ``voice_line_missing`` (R7.7): the timeline then shows
    a Reaction without sound instead of no Reaction at all.
    """
    encounter = _as(ms.encounter, Encounter)
    if encounter.reacted:
        return ms
    line_id = line.id if line is not None else None
    ctx.publish(ReactionPerformed(kind=kind, line_id=line_id, offline=offline))
    if line is None:
        ctx.report_error(ErrorCode.VOICE_LINE_MISSING, VOICE_LINE_MISSING_MESSAGE)
    return dataclasses.replace(ms, encounter=dataclasses.replace(encounter, reacted=True))


def enter_greeting(ctx: StepContext, ms: MachineState, reason: Reason) -> MachineState:
    """Enter ``greeting``: the family line and a small nod (R7.1).

    The nod base is the last emitted Gaze_Target, so the doll nods while facing the person it
    turned to (or a manual ``gaze``). The nod goes down by ``nod_deg`` (positive tilt looks
    up) and ``gaze_to`` Clamps it, so a head already near the lower limit nods less instead of
    straining the neck. The nod and the line run at the same time; each has its own deadline.
    """
    ctx.change_state(State.GREETING, reason)
    pan, tilt = ctx.gaze
    ms, line, reaction_line = play_reaction_line(ctx, ms, Category.FAMILY)
    nod = ctx.gaze_to(pan, tilt - ms.config.servo.nod_deg)
    ms = announce_reaction(ctx, ms, Category.FAMILY, line, offline=False)
    ms = request_conversation(ctx, ms)
    phase = Greeting(
        pan=pan,
        tilt=tilt,
        nod_motion_id=nod.motion_id,
        nod_deadline=ctx.now + ms.config.timing.glide_timeout_s,
        line=reaction_line,
    )
    return dataclasses.replace(ms, phase=phase)


def return_from_nod(ctx: StepContext, ms: MachineState, phase: Greeting) -> MachineState:
    """Glide back to the recorded nod base, once (R7.2).

    The flag stops a second return; the return's own arrival is then stale, because only the
    nod Motion_Id is waited for.
    """
    ctx.gaze_to(phase.pan, phase.tilt)
    return dataclasses.replace(ms, phase=dataclasses.replace(phase, nod_returned=True))


def on_servo_arrived_greeting(ctx: StepContext) -> MachineState:
    """The nod arrived: finish it by looking up again (R7.2).

    Any other arrival, and every arrival after the return, is stale (R5.8).
    """
    ms = ctx.ms
    phase = _as(ms.phase, Greeting)
    if phase.nod_returned or _as(ctx.event, ServoArrived).motion_id != phase.nod_motion_id:
        return ms
    return return_from_nod(ctx, ms, phase)


def on_tick_greeting(ctx: StepContext) -> MachineState:
    """Deadline checks of ``greeting`` (R7.2, R7.6, R7.10).

    The nod return comes first: a servo that never reports arrival must not leave the head
    bowed, and when one sparse Tick passes both the nod deadline and the end of the line, the
    return is still emitted before ``cooldown`` is entered, so both rules hold.
    """
    ms = ctx.ms
    phase = _as(ms.phase, Greeting)
    if not phase.nod_returned and ctx.now >= phase.nod_deadline:
        ms = return_from_nod(ctx, ms, phase)
    return end_reaction_on_tick(ctx, ms, phase.line)


def enter_warning(ctx: StepContext, ms: MachineState, reason: Reason) -> MachineState:
    """Enter ``warning``: a silent stare until ``stare_until`` (R7.3).

    Nothing audible is emitted on entry; the stare is part of the character. The stranger
    line and ``reaction.performed`` follow on the first Tick at or after ``stare_until``
    (R7.4), so the Reaction is published when it is actually performed.
    """
    ctx.change_state(State.WARNING, reason)
    phase = WarningPhase(stare_until=ctx.now + ms.config.timing.stare_s)
    return dataclasses.replace(ms, phase=phase)


def on_tick_warning(ctx: StepContext) -> MachineState:
    """Deadline checks of ``warning``: end of the stare, then the line rules (R7.4, R7.6, R7.10).

    The line rules apply only from the Tick after the line started, so a missing stranger line
    ends the Reaction one Tick after it was reported (R7.10), never in the same call.
    """
    ms = ctx.ms
    phase = _as(ms.phase, WarningPhase)
    if phase.line is not None:
        return end_reaction_on_tick(ctx, ms, phase.line)
    if ctx.now < phase.stare_until:
        return ms
    ms, line, reaction_line = play_reaction_line(ctx, ms, Category.STRANGER)
    ms = announce_reaction(ctx, ms, Category.STRANGER, line, offline=False)
    return dataclasses.replace(ms, phase=dataclasses.replace(phase, line=reaction_line))


def enter_uncertain(
    ctx: StepContext, ms: MachineState, *, offline: bool, reason: Reason
) -> MachineState:
    """Enter ``uncertain``: the cautious "is someone there?" line (R7.5).

    ``offline`` is true for an Offline_Reaction (R9.4), where the doll reacts without a
    Verdict; ``reaction.performed`` carries it so the timeline can tell the two apart.
    """
    ctx.change_state(State.UNCERTAIN, reason)
    ms, line, reaction_line = play_reaction_line(ctx, ms, Category.UNCERTAIN)
    ms = announce_reaction(ctx, ms, Category.UNCERTAIN, line, offline=offline)
    return dataclasses.replace(ms, phase=Uncertain(line=reaction_line))


def on_tick_uncertain(ctx: StepContext) -> MachineState:
    """Deadline checks of ``uncertain`` (R7.6, R7.10)."""
    ms = ctx.ms
    return end_reaction_on_tick(ctx, ms, _as(ms.phase, Uncertain).line)


def end_reaction_on_tick(ctx: StepContext, ms: MachineState, line: ReactionLine) -> MachineState:
    """The Tick rules for a started Reaction line, shared by the three Reaction states.

    No line was played (R7.7): the Reaction ends on this Tick with reason ``error``, because
    nothing will ever answer (R7.10). A line was played: the Reaction ends with reason
    ``timeout`` once its deadline passes, so a playback that never reports back cannot hang
    the doll (R7.6, R10.1).
    """
    if line.play_id is None:
        return enter_cooldown(ctx, ms, Reason.ERROR)
    if line.deadline is not None and ctx.now >= line.deadline:
        return enter_cooldown(ctx, ms, Reason.TIMEOUT)
    return ms


def reaction_line_of(phase: Phase) -> ReactionLine | None:
    """The Reaction's line record, or ``None`` when no line has started (or no Reaction)."""
    if isinstance(phase, Greeting | WarningPhase | Uncertain):
        return phase.line
    return None


def settle_audio(ctx: StepContext) -> tuple[MachineState, str]:
    """Forget the Event's Play_Id and report a real playback failure (R12.6, R20.9, R10.6).

    Every ``audio.*`` ends its playback, so the entry leaves the ``audio_busy`` list whatever
    the State. ``interrupted`` is not reported, because the device itself stopped the
    playback. Returns the state and the Event's Play_Id; the state is ``ctx.ms`` itself when
    the Play_Id was not listed, so stale feedback changes nothing else (R1.9).
    """
    event = ctx.event
    if not isinstance(event, AudioFinished | AudioFailed):
        raise TypeError(f"expected an audio result, got {type(event).__name__}")
    if isinstance(event, AudioFailed) and event.code != "interrupted":
        code = ErrorCode(event.code)
        ctx.report_error(code, AUDIO_FAILED_MESSAGES[code])
    ms = ctx.ms
    remaining = tuple(a for a in ms.audio if a.play_id != event.play_id)
    if len(remaining) != len(ms.audio):
        ms = dataclasses.replace(ms, audio=remaining)
    return ms, event.play_id


def on_audio_result(ctx: StepContext) -> MachineState:
    """``audio.finished`` / ``audio.failed`` in any State: forget and report only (R10.6)."""
    ms, _ = settle_audio(ctx)
    return ms


def on_audio_result_reaction(ctx: StepContext) -> MachineState:
    """The Reaction's line ended, normally or not: enter ``cooldown`` with ``audio_done`` (R7.6).

    A failed line ends the Reaction the same way as a finished one: the doll has nothing
    left to say, and the failure is already reported by ``settle_audio``.
    """
    ms, play_id = settle_audio(ctx)
    line = reaction_line_of(ms.phase)
    if line is None or line.play_id is None or line.play_id != play_id:
        return ms
    if isinstance(ms.phase, Greeting) and ms.phase.pending_conversation is not None:
        return leave_greeting_for_conversation(ctx, ms, ms.phase, ms.phase.pending_conversation)
    return enter_cooldown(ctx, ms, Reason.AUDIO_DONE)


def on_adapter_error(ctx: StepContext) -> MachineState:
    """Report a hardware adapter problem and change nothing else (R20.9).

    The doll keeps reacting with whatever still works; the owner sees the code on the
    dashboard. A code outside the contract list is a programming error of the adapter
    (R20.11): ``ErrorCode`` raises, and the Dispatcher restarts the State_Machine safely.
    """
    code = ErrorCode(_as(ctx.event, AdapterError).code)
    ctx.report_error(code, ADAPTER_ERROR_MESSAGE)
    return ctx.ms


# --------------------------------------------------------------------------------------------
# Flow: cooldown and return to sleep (task 13.1; R8, R10.1, R10.3)
# --------------------------------------------------------------------------------------------


def enter_cooldown(
    ctx: StepContext, ms: MachineState, reason: Reason, *, manual: bool = False
) -> MachineState:
    """Enter ``cooldown``: glide the head back to center and set the deadlines (R8.1, R10.3).

    Every Encounter ends at center so the next start does not jump (hardware.md). The glide
    goes through ``gaze_to``, which Clamps it like every other movement. The lantern stays lit
    until the servos are released, so the doll does not go dark while its head still moves.

    ``manual`` is true only when ``mode.set`` with ``mode: "sleep"`` starts this cooldown
    (task 16.1, R12.7); it decides the ``encounter.ended`` reason later (R8.3). The Encounter
    stays, because ``encounter.ended`` must still carry its id (R8.5).
    """
    ctx.change_state(State.COOLDOWN, reason)
    motion = ctx.gaze_to(0.0, 0.0)
    timing = ms.config.timing
    phase = Cooldown(
        motion_id=motion.motion_id,
        glide_deadline=ctx.now + timing.glide_timeout_s,
        until=ctx.now + timing.cooldown_s,
        manual=manual,
    )
    return dataclasses.replace(ms, phase=phase)


def release_after_glide(ctx: StepContext, ms: MachineState, phase: Cooldown) -> MachineState:
    """Detach the servos, then fade the lantern out, once per cooldown (R8.2).

    Detaching stops the PWM pulse, which prevents jitter and saves the battery (hardware.md).
    The ``released`` flag makes the pair happen once: the glide arrival and the glide
    deadline can both occur, and the second must emit nothing.
    """
    ctx.release_servos()
    ctx.fade_lantern(0.0, ms.config.lantern.lantern_fade_out_ms)
    return dataclasses.replace(ms, phase=dataclasses.replace(phase, released=True))


def on_servo_arrived_cooldown(ctx: StepContext) -> MachineState:
    """The head is back at center: release and fade out (R8.2).

    Any other arrival, and the cooldown arrival after the release, is stale (R5.8, R10.6).
    """
    ms = ctx.ms
    phase = _as(ms.phase, Cooldown)
    if phase.released or _as(ctx.event, ServoArrived).motion_id != phase.motion_id:
        return ms
    return release_after_glide(ctx, ms, phase)


def on_tick_cooldown(ctx: StepContext) -> MachineState:
    """Deadline checks of ``cooldown``: glide deadline, then cooldown deadline (R8.2, R8.3).

    A servo that never reports arrival must not keep the PWM pulse on, so the glide deadline
    releases as well. The release check comes first: when one sparse Tick passes both
    deadlines, ``ReleaseServos`` and the fade-out are emitted before ``sleeping`` is entered,
    so the normal path, not the R8.4 backstop, ends the Encounter.
    """
    ms = ctx.ms
    phase = _as(ms.phase, Cooldown)
    if not phase.released and ctx.now >= phase.glide_deadline:
        ms = release_after_glide(ctx, ms, phase)
    if ctx.now < phase.until:
        return ms
    end_reason = EndReason.MANUAL if phase.manual else EndReason.COOLDOWN
    return enter_sleeping(ctx, ms, Reason.COOLDOWN_DONE, end_reason)


def enter_sleeping(
    ctx: StepContext, ms: MachineState, reason: Reason, end_reason: EndReason
) -> MachineState:
    """Enter ``sleeping`` and end the Encounter (R8.3 to R8.5).

    The backstop (R8.4) guarantees the doll rests safely whatever path led here: when the
    servos were not released after the last ``GazeTarget``, or the last lantern level is not
    0, it emits ``ReleaseServos`` and ``LanternFade(0, 0)``. The fade is immediate because a
    sleeping doll must not keep a lit lantern while waiting for the next fade.

    ``ctx.encounter_id`` is left as it is, so every ``PublishEvent`` of this call, including
    ``state.changed`` and ``encounter.ended``, carries the ending id; clearing the Encounter in
    the returned state makes later calls publish ``encounterId: null`` (R8.5).

    It deliberately ignores ``ms.pir_high``. The HC-SR501 output stays high for seconds and
    retriggers, so a visitor still standing in front of the doll when cooldown ends would
    otherwise be greeted again at once. Only a fresh ``pir.rising`` in a later call starts
    the next Encounter (R11.4). That edge must also come after ``pir_quiet_s``: the sensor
    retriggers every few seconds while someone stays near, and without a quiet time the doll
    would never rest, keep its lantern lit and refuse remote commands.
    """
    ctx.change_state(State.SLEEPING, reason)
    ctx.publish(EncounterEnded(reason=end_reason))
    if not ctx.servos_released or ctx.lantern_level != 0.0:
        ctx.release_servos()
        ctx.fade_lantern(0.0, 0)
    quiet_until = ctx.now + ms.config.timing.pir_quiet_s
    return dataclasses.replace(ms, phase=Sleeping(quiet_until=quiet_until), encounter=None)


# --------------------------------------------------------------------------------------------
# Flow: PIR debounce (task 15.1; R11)
# --------------------------------------------------------------------------------------------


def on_pir_rising(ctx: StepContext) -> MachineState:
    """``pir.rising`` outside ``sleeping``: record the level only (R11.1 to R11.3).

    The HC-SR501 retriggers while a person moves in front of it, so one visit produces many
    rising edges. Treating each as presence would greet the same person again and again;
    instead the current Encounter, State and deadlines stay as they are and no Action is
    emitted. ``sleeping`` has its own handler, which may start an Encounter (R2.1).
    """
    return _with_pir_level(ctx.ms, True)


def on_pir_falling(ctx: StepContext) -> MachineState:
    """``pir.falling`` in every State and Mode: record the level only (R11.3).

    A falling edge says nothing reliable about the visitor leaving (the sensor holds its
    output for seconds and retriggers), so it changes no State, deadline or Encounter.
    """
    return _with_pir_level(ctx.ms, False)


# --------------------------------------------------------------------------------------------
# Flow: manual commands and privacy (task 16.1; R12, R13.2 to R13.5)
# --------------------------------------------------------------------------------------------

REJECTION_MESSAGES: Mapping[str, str] = MappingProxyType(
    {
        ErrorCode.UNKNOWN_LINE: "speak names a line that is not cached on the device",
        ErrorCode.SPEAK_REJECTED: "speak is not permitted for the current situation",
        ErrorCode.COMMAND_REJECTED_STATE: "command is not accepted in the current state",
        ErrorCode.AUDIO_BUSY: "speak arrived while earlier audio is unfinished",
    }
)
"""Fixed ``error.reported`` texts for command rejections.

They name neither the line, its text nor the URL: the ``refId`` already links the error to
the command, and a stranger-facing log must not repeat what the owner asked the doll to say
(R13.6).
"""

SITUATION_BY_VERDICT: Mapping[AcceptedVerdict, Category] = MappingProxyType(
    {AcceptedVerdict.FAMILY: Category.FAMILY, AcceptedVerdict.STRANGER: Category.STRANGER}
)
"""Accepted_Verdicts that give their own Situation_Category; every other case is uncertain."""


def reject(ctx: StepContext, code: ErrorCode) -> MachineState:
    """Refuse the current command: one ``error.reported``, nothing else changes (R12.12).

    Returning the argument state unchanged keeps a bad or ill-timed command from moving the
    doll, touching a deadline or ending the Encounter, so a rejection can never hang it.
    """
    command = ctx.event
    rejectable = Speak | Gaze | Lantern | ConversationStart | SnapshotRequest | ModeSet
    if not isinstance(command, rejectable):
        raise TypeError(f"expected a rejectable command, got {type(command).__name__}")
    ctx.report_error(code, REJECTION_MESSAGES[code], command.ref_id)
    return ctx.ms


def situation_category(ms: MachineState) -> Category:
    """The Situation_Category (Glossary): who the doll believes it is talking to.

    Only an Accepted_Verdict of ``family`` or ``stranger`` counts as knowing; anything else,
    including no Encounter at all, is ``uncertain``, so a doubtful case gets the cautious
    treatment and never a family-specific line.
    """
    accepted = ms.encounter.accepted if ms.encounter is not None else None
    if accepted is None:
        return Category.UNCERTAIN
    return SITUATION_BY_VERDICT.get(accepted, Category.UNCERTAIN)


def permitted(category: Category, situation: Category) -> bool:
    """Whether a line of ``category`` may be said in ``situation`` (R13.4, R13.5).

    Family may hear family and uncertain lines, never a stranger line. A stranger or an
    uncertain visitor hears only lines of their own Category, so nothing family-specific
    (such as a nickname) is ever said to someone the doll has not recognised.
    """
    if situation is Category.FAMILY:
        return category is not Category.STRANGER
    return category is situation


def audio_busy(ms: MachineState, now: float) -> bool:
    """An unfinished ``PlayLine`` or ``PlayAudioUrl`` whose busy window has not ended (R12.6).

    The window, not only the missing ``audio.*`` answer, decides: a playback whose result is
    lost must not block ``speak`` for ever. Entries whose window has passed simply no longer
    count.
    """
    return any(now < pending.busy_until for pending in ms.audio)


def on_speak(ctx: StepContext) -> MachineState:
    """``speak`` in every State: check in the R12.12 order, then play (R12.4 to R12.6, R13).

    The first failing check gives the single rejection: ``unknown_line`` (R12.5), then
    ``speak_rejected`` for a line Category or an ``audioUrl`` the situation does not permit
    (R13.3, R13.4), then ``command_rejected_state`` during the silent stare (R12.11), then
    ``audio_busy`` (R12.6). An accepted ``speak`` changes no State or deadline; it is not the
    Reaction line, so it neither ends the Reaction nor counts as one.

    The codec guarantees exactly one of ``line_id`` and ``audio_url``.
    """
    ms, cmd = ctx.ms, _as(ctx.event, Speak)
    if isinstance(ms.phase, Conversing):
        # One audio user at a time: the conversation owns the speaker (R11.17, S11).
        return reject(ctx, ErrorCode.COMMAND_REJECTED_STATE)
    situation = situation_category(ms)
    line: VoiceLine | None = None
    if cmd.line_id is not None:
        line = ms.line_by_id(cmd.line_id)
        if line is None:
            return reject(ctx, ErrorCode.UNKNOWN_LINE)
        if not permitted(line.category, situation):
            return reject(ctx, ErrorCode.SPEAK_REJECTED)
    elif situation is not Category.FAMILY and not cmd.remote:
        return reject(ctx, ErrorCode.SPEAK_REJECTED)
    if isinstance(ms.phase, WarningPhase) and ms.phase.line is None:
        return reject(ctx, ErrorCode.COMMAND_REJECTED_STATE)
    if audio_busy(ms, ctx.now):
        return reject(ctx, ErrorCode.AUDIO_BUSY)
    if line is not None:
        return emit_play_line(ctx, ms, line)
    return emit_play_audio_url(ctx, ms, _as(cmd.audio_url, str), remote=cmd.remote)


def emit_play_line(ctx: StepContext, ms: MachineState, line: VoiceLine) -> MachineState:
    """Play a cached line for ``speak`` and mark the audio busy (R12.4, R12.6).

    The busy window is ``audio_timeout_s``, the same bound the Audio_Adapter puts on one
    playback, so a lost ``audio.*`` answer frees ``speak`` again after that time.
    """
    play_id = ctx.new_id("play")
    ctx.emit(PlayLine(line_id=line.id, play_id=play_id))
    pending = PendingAudio(play_id=play_id, busy_until=ctx.now + ms.config.timing.audio_timeout_s)
    return dataclasses.replace(ms, audio=(*ms.audio, pending))


def emit_play_audio_url(
    ctx: StepContext, ms: MachineState, url: str, *, remote: bool = False
) -> MachineState:
    """Download and play a WAV for ``speak``; only reached in Situation_Category ``family``.

    Generated audio may hold a family nickname, so ``on_speak`` lets it through only after a
    ``family`` Accepted_Verdict (R13.2, R13.3). The busy window adds the download bound to
    the playback bound, because the Audio_Adapter first downloads, then plays (R12.6).
    """
    if situation_category(ms) is not Category.FAMILY and not remote:
        raise ValueError("PlayAudioUrl outside Situation_Category family")
    timing = ms.config.timing
    play_id = ctx.new_id("play")
    ctx.emit(PlayAudioUrl(url=url, play_id=play_id))
    busy_until = ctx.now + timing.download_timeout_s + timing.audio_timeout_s
    pending = PendingAudio(play_id=play_id, busy_until=busy_until)
    return dataclasses.replace(ms, audio=(*ms.audio, pending))


def on_gaze(ctx: StepContext) -> MachineState:
    """Manual ``gaze`` during an Encounter outside ``cooldown`` (R12.1).

    ``gaze_to`` Clamps both angles to the Calibrated_Range, so a command can never strain the
    neck. The State and every deadline stay: the phase still waits for its own Motion_Id, and
    its deadline ends it if the manual glide supersedes that motion. The new angles become the
    last emitted Gaze_Target, which a later snapshot or greeting nod starts from (R3.1, R7.1).
    """
    cmd = _as(ctx.event, Gaze)
    ctx.gaze_to(cmd.pan_deg, cmd.tilt_deg)
    return ctx.ms


def on_lantern(ctx: StepContext) -> MachineState:
    """Manual ``lantern`` during an Encounter outside ``cooldown`` (R12.2).

    ``fade_lantern`` Clamps the level to [0, 1] and the fade to [0, 10000] ms; out-of-range
    finite numbers are valid on the wire (docs/schema.md). The waking fade-in timer is not
    moved, so a manual fade cannot hold the doll in ``waking``.
    """
    cmd = _as(ctx.event, Lantern)
    ctx.fade_lantern(cmd.level, cmd.fade_ms)
    return ctx.ms


def on_motion_command_resting(ctx: StepContext) -> MachineState:
    """``gaze`` or ``lantern`` in ``sleeping`` or ``cooldown``: rejected (R12.3).

    A resting doll keeps its servos detached and its lantern off, and a cooldown must end at
    center, so a manual move here would break the hardware rules of hardware.md.
    """
    return reject(ctx, ErrorCode.COMMAND_REJECTED_STATE)


def on_mode_set(ctx: StepContext) -> MachineState:
    """``mode.set`` in every State (R12.7 to R12.9).

    ``sleep`` during an Encounter outside ``cooldown`` ends the visit early: the Mode is set
    and ``cooldown`` is entered with reason ``manual``, so the head still returns to center
    and the servos detach as at the end of every Encounter; ``encounter.ended`` later says
    ``manual`` (R12.7, R8.3). In ``sleeping`` or ``cooldown``, or when the Mode does not
    change, only the Mode is recorded (R12.8). ``guard`` never starts an Encounter by itself;
    only a later ``pir.rising`` does (R12.9). The argument state is returned itself when
    nothing changes (R1.9).
    """
    ms, requested = ctx.ms, _as(ctx.event, ModeSet).mode
    if requested is ModeRequest.REMOTE:
        return start_remote(ctx)
    mode = Mode(requested.value)
    if isinstance(ms.phase, Remote):
        # guard or sleep ends remote control: back to center, detach, lantern out (M3).
        return enter_cooldown(ctx, dataclasses.replace(ms, mode=mode), Reason.MANUAL, manual=True)
    if ms.mode is mode:
        return ms
    ms = dataclasses.replace(ms, mode=mode)
    ending = mode is Mode.SLEEP and ms.encounter is not None
    if ending and isinstance(ms.phase, Conversing):
        return leave_conversing(
            ctx,
            ms,
            ms.phase,
            state_reason=Reason.MANUAL,
            end_reason=ConversationEndReason.MANUAL,
            manual=True,
        )
    if ending and ms.state not in (State.SLEEPING, State.COOLDOWN):
        return enter_cooldown(ctx, ms, Reason.MANUAL, manual=True)
    return ms


# --------------------------------------------------------------------------------------------
# Flow: remote control (remote-mode M1 to M3)
# --------------------------------------------------------------------------------------------


def start_remote(ctx: StepContext) -> MachineState:
    """``mode.set remote``: enter ``remote``, or restart its idle time when already there (M1).

    From ``sleeping`` this is a manual Encounter, started like a visit: lantern first, then a
    slow glide to center, because this is the first motion after rest (hardware.md). From a
    visit or ``cooldown`` the Encounter goes on; its pending reaction is dropped with the old
    phase, and a remote-photo Encounter stops waiting for its picture. ``conversing`` owns the
    microphone and the speaker, so it refuses.
    """
    ms = ctx.ms
    idle_until = ctx.now + ms.config.timing.remote_idle_s
    if isinstance(ms.phase, Remote):
        return dataclasses.replace(ms, phase=Remote(idle_until=idle_until))
    if isinstance(ms.phase, Conversing):
        return reject(ctx, ErrorCode.COMMAND_REJECTED_STATE)
    lantern = ms.config.lantern
    if isinstance(ms.phase, Sleeping):
        encounter = ctx.begin_encounter()
        ctx.change_state(State.REMOTE, Reason.MANUAL)
        ctx.publish(PresenceDetected(source="manual"))
        ctx.fade_lantern(lantern.lantern_wake_level, lantern.lantern_fade_in_ms)
        ctx.gaze_to(0.0, 0.0)
    else:
        encounter = dataclasses.replace(_as(ms.encounter, Encounter), photo_request_id=None)
        ctx.change_state(State.REMOTE, Reason.MANUAL)
        if ctx.lantern_level == 0.0:
            # A cooldown may already have faded the lantern; the camera needs light.
            ctx.fade_lantern(lantern.lantern_wake_level, lantern.lantern_fade_in_ms)
    return dataclasses.replace(ms, phase=Remote(idle_until=idle_until), encounter=encounter)


def on_tick_remote(ctx: StepContext) -> MachineState:
    """End remote control after ``remote_idle_s`` without an accepted command (M3)."""
    ms = ctx.ms
    if ctx.now >= _as(ms.phase, Remote).idle_until:
        return enter_cooldown(ctx, ms, Reason.TIMEOUT)
    return ms


def _pir_ignored_in_remote(ctx: StepContext) -> MachineState:
    """``pir.rising`` in ``remote``: record the level only; the family is in control (M2)."""
    return _with_pir_level(ctx.ms, True)


def remote_command(handler: Handler) -> Handler:
    """Run a command handler in ``remote`` and restart the idle time if it accepted (M2).

    A refused command publishes ``error.reported`` and does not count as activity, so a script
    of bad commands cannot keep the doll awake.
    """

    def run(ctx: StepContext) -> MachineState:
        nxt = handler(ctx)
        refused = any(
            isinstance(action, PublishEvent) and isinstance(action.data, ErrorReported)
            for action in ctx.actions
        )
        if refused or not isinstance(nxt.phase, Remote):
            return nxt
        idle_until = ctx.now + nxt.config.timing.remote_idle_s
        return dataclasses.replace(nxt, phase=Remote(idle_until=idle_until))

    return run


# --------------------------------------------------------------------------------------------
# Flow: voice conversation (voice-conversation task 15.2; R11)
# --------------------------------------------------------------------------------------------

_NO_LINE_END_REASONS = frozenset(
    {
        ConversationEndReason.STRANGER,
        ConversationEndReason.MANUAL,
        ConversationEndReason.OFFLINE,
        ConversationEndReason.UNSAFE_OUTPUT,
    }
)
_TROUBLE_END_REASONS = frozenset({ConversationEndReason.ERROR, ConversationEndReason.LANGUAGE})


def conversation_line_id(end_reason: ConversationEndReason) -> str | None:
    """The line the doll says when it leaves ``conversing`` for ``end_reason`` (R11.10 to R11.12).

    A stranger, a manual stop, a lost cloud and unsafe output get silence: someone who should
    not hear a family goodbye, or nobody at all, is listening. A failure gets the "I can't hear
    well" line. Every other reason, including a remote end, gets the goodbye. Neither line is a
    Reaction, so neither publishes ``reaction.performed`` (R11.13).
    """
    if end_reason in _NO_LINE_END_REASONS:
        return None
    if end_reason in _TROUBLE_END_REASONS:
        return CONVERSATION_TROUBLE_LINE
    return CONVERSATION_BYE_LINE


def request_conversation(ctx: StepContext, ms: MachineState) -> MachineState:
    """Ask the cloud for a voice session, once per Encounter (S1, R11.1).

    Called when ``greeting`` is entered after an accepted ``family`` verdict. Nothing is sent
    when conversations are off or the cloud is unreachable, because no session could start.
    """
    encounter = _as(ms.encounter, Encounter)
    enabled = ms.config.conversation.conversation_enabled
    if encounter.conversation_requested or not enabled or not ms.cloud_connected:
        return ms
    ctx.publish(ConversationRequested(reason="family_verdict"))
    encounter = dataclasses.replace(encounter, conversation_requested=True)
    return dataclasses.replace(ms, encounter=encounter)


def enter_conversing(
    ctx: StepContext,
    ms: MachineState,
    grant: ConversationGrant,
    reason: Reason,
    *,
    manual_start: bool = False,
) -> MachineState:
    """Enter ``conversing``: announce, start the adapter, set the deadline (R11.5).

    The deadline always exists, so a hung adapter cannot keep the doll here (R11.6).
    ``maxSeconds`` of the command is clamped to ``conversation_max_s``, and the silence limit
    stays at least 5 s below the maximum, as the config rule requires. ``manual_start`` is
    true when the doll was asleep: it wakes the lantern and glides to center like ``waking``.
    The status report with ``micActive: true`` is added by ``finalize`` (R11.19).
    """
    max_s = min(grant.max_s, ms.config.conversation.conversation_max_s)
    silence_s = min(grant.silence_s, max_s - 5)
    ctx.change_state(State.CONVERSING, reason)
    if manual_start:
        ctx.publish(PresenceDetected(source="manual"))
        lantern = ms.config.lantern
        ctx.fade_lantern(lantern.lantern_wake_level, lantern.lantern_fade_in_ms)
        ctx.gaze_to(0.0, 0.0)
    ctx.emit(
        StartConversation(
            session_id=grant.session_id, token=grant.token, max_s=max_s, silence_s=silence_s
        )
    )
    phase = Conversing(session_id=grant.session_id, deadline=ctx.now + max_s)
    return dataclasses.replace(ms, phase=phase)


def leave_conversing(
    ctx: StepContext,
    ms: MachineState,
    phase: Conversing,
    *,
    state_reason: Reason,
    end_reason: ConversationEndReason,
    manual: bool = False,
) -> MachineState:
    """Leave ``conversing`` for ``cooldown``: one stop and one ``conversation.ended`` (R11.8).

    Order: ``StopConversation``, ``conversation.ended``, ``state.changed``, the cooldown entry
    actions, then the closing line chosen by ``end_reason``. The stop comes first so the
    microphone closes before anything else happens. ``manual`` is true only for ``mode.set``
    sleep, so ``encounter.ended`` says ``manual``.
    """
    ctx.emit(StopConversation(session_id=phase.session_id))
    ctx.publish(ConversationEnded(session_id=phase.session_id, reason=end_reason))
    ms = enter_cooldown(ctx, ms, state_reason, manual=manual)
    line_id = conversation_line_id(end_reason)
    line = ms.line_by_id(line_id) if line_id is not None else None
    if line is None:
        return ms
    return emit_play_line(ctx, ms, line)


def leave_greeting_for_conversation(
    ctx: StepContext, ms: MachineState, phase: Greeting, grant: ConversationGrant
) -> MachineState:
    """The greeting line ended with a stored grant: start the conversation (R11.2).

    A cloud that went away since the grant, or a switch turned off, ends the visit as an
    ordinary greeting would. A nod that has not returned yet returns first, so the head does
    not stay bowed for the whole conversation.
    """
    if not ms.cloud_connected or not ms.config.conversation.conversation_enabled:
        return enter_cooldown(ctx, ms, Reason.AUDIO_DONE)
    if not phase.nod_returned:
        ms = return_from_nod(ctx, ms, phase)
    return enter_conversing(ctx, ms, grant, Reason.CONVERSATION)


def on_conversation_start_sleeping(ctx: StepContext) -> MachineState:
    """``conversation.start`` in ``sleeping``: a manual start in mode ``guard`` only (R11.3)."""
    ms, cmd = ctx.ms, _as(ctx.event, ConversationStart)
    if (
        not ms.config.conversation.conversation_enabled
        or cmd.source != ConversationSource.MANUAL
        or ms.mode is not Mode.GUARD
    ):
        return reject(ctx, ErrorCode.COMMAND_REJECTED_STATE)
    ms = dataclasses.replace(ms, encounter=ctx.begin_encounter())
    grant = ConversationGrant(
        session_id=cmd.session_id, token=cmd.token, max_s=cmd.max_s, silence_s=cmd.silence_s
    )
    return enter_conversing(ctx, ms, grant, Reason.CONVERSATION, manual_start=True)


def on_conversation_start_greeting(ctx: StepContext) -> MachineState:
    """``conversation.start`` in ``greeting``: store the grant for a family verdict (R11.2).

    The conversation starts when the greeting line ends, so the doll never talks over its own
    greeting. A second start for the stored session changes nothing; any other is rejected.
    """
    ms, cmd = ctx.ms, _as(ctx.event, ConversationStart)
    phase = _as(ms.phase, Greeting)
    accepted = _as(ms.encounter, Encounter).accepted
    if (
        not ms.config.conversation.conversation_enabled
        or cmd.source != ConversationSource.FAMILY_VERDICT
        or accepted is not AcceptedVerdict.FAMILY
    ):
        return reject(ctx, ErrorCode.COMMAND_REJECTED_STATE)
    if phase.pending_conversation is not None:
        if phase.pending_conversation.session_id == cmd.session_id:
            return ms
        return reject(ctx, ErrorCode.COMMAND_REJECTED_STATE)
    grant = ConversationGrant(
        session_id=cmd.session_id, token=cmd.token, max_s=cmd.max_s, silence_s=cmd.silence_s
    )
    return dataclasses.replace(ms, phase=dataclasses.replace(phase, pending_conversation=grant))


def on_conversation_start_conversing(ctx: StepContext) -> MachineState:
    """``conversation.start`` in ``conversing``: ignore the same session, reject another."""
    ms = ctx.ms
    if _as(ctx.event, ConversationStart).session_id == _as(ms.phase, Conversing).session_id:
        return ms
    return reject(ctx, ErrorCode.COMMAND_REJECTED_STATE)


def on_conversation_start_other(ctx: StepContext) -> MachineState:
    """``conversation.start`` in any other state: rejected (R11.4)."""
    return reject(ctx, ErrorCode.COMMAND_REJECTED_STATE)


def on_conversation_end_conversing(ctx: StepContext) -> MachineState:
    """``conversation.end`` for the current session: stop and cool down (R11.7, R11.9)."""
    ms, cmd = ctx.ms, _as(ctx.event, ConversationEnd)
    phase = _as(ms.phase, Conversing)
    if cmd.session_id != phase.session_id:
        return ms
    return leave_conversing(
        ctx,
        ms,
        phase,
        state_reason=Reason.CONVERSATION_DONE,
        end_reason=ConversationEndReason(cmd.reason),
    )


def on_conversation_finished_conversing(ctx: StepContext) -> MachineState:
    """The adapter ended the session: ``conversation_done``, or ``error`` if it failed (R11.7)."""
    ms, event = ctx.ms, _as(ctx.event, ConversationFinished)
    phase = _as(ms.phase, Conversing)
    if event.session_id != phase.session_id:
        return ms
    if event.reason == "adapter_failed":
        return leave_conversing(
            ctx,
            ms,
            phase,
            state_reason=Reason.ERROR,
            end_reason=ConversationEndReason.ERROR,
        )
    return leave_conversing(
        ctx,
        ms,
        phase,
        state_reason=Reason.CONVERSATION_DONE,
        end_reason=ConversationEndReason(event.reason),
    )


def on_tick_conversing(ctx: StepContext) -> MachineState:
    """The deadline ends ``conversing`` whatever the adapter does (R11.6, design V17).

    A look whose snapshot never arrived is dropped at its own deadline, so a lost capture
    cannot block later ``snapshot.request`` commands.
    """
    ms = ctx.ms
    phase = _as(ms.phase, Conversing)
    if ctx.now >= phase.deadline:
        return leave_conversing(
            ctx,
            ms,
            phase,
            state_reason=Reason.TIMEOUT,
            end_reason=ConversationEndReason.LIMIT,
        )
    if phase.look is not None and ctx.now >= phase.look.deadline:
        return dataclasses.replace(ms, phase=dataclasses.replace(phase, look=None))
    return ms


def on_cloud_disconnected_conversing(ctx: StepContext) -> MachineState:
    """``cloud.disconnected`` in ``conversing``: stop and cool down, reason ``offline``."""
    ms = _with_connectivity(ctx.ms, False)
    return leave_conversing(
        ctx,
        ms,
        _as(ms.phase, Conversing),
        state_reason=Reason.OFFLINE,
        end_reason=ConversationEndReason.OFFLINE,
    )


def on_snapshot_request_conversing(ctx: StepContext) -> MachineState:
    """``snapshot.request`` in ``conversing``: take one snapshot for the session (R11.15)."""
    ms, cmd = ctx.ms, _as(ctx.event, SnapshotRequest)
    phase = _as(ms.phase, Conversing)
    if cmd.purpose != "look" or phase.look is not None:
        return reject(ctx, ErrorCode.COMMAND_REJECTED_STATE)
    snapshot_id = ctx.new_id("snap")
    ctx.emit(TakeSnapshot(snapshot_id=snapshot_id))
    pan, tilt = ctx.gaze
    look = LookRequest(
        request_id=cmd.request_id,
        snapshot_id=snapshot_id,
        pan_deg=pan,
        tilt_deg=tilt,
        deadline=ctx.now + ms.config.timing.verdict_timeout_s,
    )
    return dataclasses.replace(ms, phase=dataclasses.replace(phase, look=look))


def on_snapshot_request_sleeping(ctx: StepContext) -> MachineState:
    """``snapshot.request`` in ``sleeping``: a ``photo`` wakes the doll for one picture (R2).

    The doll starts a manual Encounter exactly like a PIR visit (lantern first, then a slow glide
    to center, because the camera is weak in the dark and the head must not jump), whatever the
    Mode: the owner asked for it. A ``look`` is for a voice session and is rejected here.
    """
    ms, cmd = ctx.ms, _as(ctx.event, SnapshotRequest)
    if cmd.purpose != "photo":
        return reject(ctx, ErrorCode.COMMAND_REJECTED_STATE)
    return enter_waking(
        ctx, ms, source="manual", reason=Reason.MANUAL, photo_request_id=cmd.request_id
    )


def on_snapshot_request_other(ctx: StepContext) -> MachineState:
    """``snapshot.request`` in ``cooldown``: rejected (R11.16, F1).

    The lantern fades out and the head returns to center there, so a picture would be dark,
    and the visit is about to end.
    """
    return reject(ctx, ErrorCode.COMMAND_REJECTED_STATE)


PHOTO_STATES: tuple[State, ...] = (
    State.WAKING,
    State.SEEKING,
    State.GAZING,
    State.GREETING,
    State.WARNING,
    State.UNCERTAIN,
)
"""States in which a remote photo is taken during the visit (F1); the lantern is lit in all."""


def on_snapshot_request_awake(ctx: StepContext) -> MachineState:
    """A ``photo`` during an Encounter: one picture at the current head angles (F1).

    The visit goes on untouched: no State change, no deadline, no head or lantern move. The
    camera adapter runs one capture at a time, so the photo simply queues behind a snapshot of
    the scan. A ``look``, a second photo, or a photo during a remote-photo Encounter (which
    takes its own picture) is rejected.
    """
    ms, cmd = ctx.ms, _as(ctx.event, SnapshotRequest)
    if cmd.purpose != "photo" or ms.photo is not None or _is_photo(ms):
        return reject(ctx, ErrorCode.COMMAND_REJECTED_STATE)
    snapshot_id = ctx.new_id("snap")
    ctx.emit(TakeSnapshot(snapshot_id=snapshot_id))
    pan, tilt = ctx.gaze
    photo = PendingPhoto(
        request_id=cmd.request_id,
        snapshot_id=snapshot_id,
        pan_deg=pan,
        tilt_deg=tilt,
        deadline=ctx.now + ms.config.timing.verdict_timeout_s,
    )
    return dataclasses.replace(ms, photo=photo)


def photo_result_handler(ms: MachineState, event: Event) -> Handler | None:
    """The handler for the camera result of the outstanding photo, whatever the State (F1).

    Looked up before the State handlers, so a seeking or conversing handler never mistakes the
    photo for its own snapshot, and a photo that finishes after the visit ended still reaches
    the family.
    """
    photo = ms.photo
    if photo is None or not isinstance(event, SnapshotReady | SnapshotFailed):
        return None
    if event.snapshot_id != photo.snapshot_id:
        return None
    return on_photo_ready if isinstance(event, SnapshotReady) else on_photo_failed


def on_photo_ready(ctx: StepContext) -> MachineState:
    """Publish the photo with its ``requestId`` and ``purpose: "photo"`` (F1, R1)."""
    ms, event = ctx.ms, _as(ctx.event, SnapshotReady)
    photo = _as(ms.photo, PendingPhoto)
    ctx.publish(
        SnapshotCaptured(
            snapshot_id=photo.snapshot_id,
            width=event.width,
            height=event.height,
            pan_deg=photo.pan_deg,
            tilt_deg=photo.tilt_deg,
            jpeg_base64=base64.b64encode(event.jpeg).decode("ascii"),
            request_id=photo.request_id,
            purpose="photo",
        )
    )
    return dataclasses.replace(ms, photo=None)


def on_photo_failed(ctx: StepContext) -> MachineState:
    """Report the failed photo and allow the next one; the visit goes on (F1, R3.9)."""
    ms = on_snapshot_failed(ctx)
    return dataclasses.replace(ms, photo=None)


def on_snapshot_ready_conversing(ctx: StepContext) -> MachineState:
    """Send the snapshot of the outstanding look with its ``requestId`` (R11.15).

    The look ends here; its snapshot id is remembered so a ``stranger`` verdict for it can end
    the conversation. A stale snapshot publishes nothing.
    """
    ms, event = ctx.ms, _as(ctx.event, SnapshotReady)
    phase = _as(ms.phase, Conversing)
    look = phase.look
    if look is None or event.snapshot_id != look.snapshot_id:
        return ms
    ctx.publish(
        SnapshotCaptured(
            snapshot_id=look.snapshot_id,
            width=event.width,
            height=event.height,
            pan_deg=look.pan_deg,
            tilt_deg=look.tilt_deg,
            jpeg_base64=base64.b64encode(event.jpeg).decode("ascii"),
            request_id=look.request_id,
        )
    )
    phase = dataclasses.replace(
        phase, look=None, looked_snapshot_ids=(*phase.looked_snapshot_ids, look.snapshot_id)
    )
    return dataclasses.replace(ms, phase=phase)


def on_snapshot_failed_conversing(ctx: StepContext) -> MachineState:
    """Report a failed snapshot and end the outstanding look it belongs to (R11.15)."""
    ms = on_snapshot_failed(ctx)
    phase = _as(ms.phase, Conversing)
    look = phase.look
    if look is None or _as(ctx.event, SnapshotFailed).snapshot_id != look.snapshot_id:
        return ms
    return dataclasses.replace(ms, phase=dataclasses.replace(phase, look=None))


def on_judgement_conversing(ctx: StepContext) -> MachineState:
    """A ``stranger`` verdict for a look ends the conversation; anything else is ignored (R11.18).

    The greeting already happened, so the Encounter goes to ``cooldown`` and not ``warning``;
    the Accepted_Verdict of the Encounter stays as it is. The doll then says nothing (R11.20).
    """
    ms, event = ctx.ms, _as(ctx.event, JudgementResult)
    phase = _as(ms.phase, Conversing)
    known = (*phase.looked_snapshot_ids, *([phase.look.snapshot_id] if phase.look else []))
    if event.snapshot_id not in known:
        return ms
    accepted = accept(event.verdict, event.confidence, ms.config.judgement)
    if accepted is not AcceptedVerdict.STRANGER:
        return ms
    return leave_conversing(
        ctx,
        ms,
        phase,
        state_reason=Reason.VERDICT,
        end_reason=ConversationEndReason.STRANGER,
    )


# --------------------------------------------------------------------------------------------
# Handler tables. Read-only views, so no handler can change them at run time (R1.1).
# Each flow task registers its handlers in the dict literals below.
# --------------------------------------------------------------------------------------------

STATE_HANDLERS: Mapping[tuple[State, type], Handler] = MappingProxyType(
    {
        # Waking and seeking (task 9.1).
        (State.SLEEPING, PirRising): on_pir_rising_sleeping,
        (State.WAKING, ServoArrived): on_servo_arrived_waking,
        (State.WAKING, Tick): on_tick_waking,
        (State.SEEKING, SnapshotReady): on_snapshot_ready_seeking,
        # Verdict and gazing (task 10.1).
        (State.SEEKING, JudgementResult): on_judgement_seeking,
        (State.GAZING, ServoArrived): on_servo_arrived_gazing,
        (State.GAZING, Tick): on_tick_gazing,
        # Scanning (task 11.1).
        (State.SEEKING, ServoArrived): on_servo_arrived_seeking,
        (State.SEEKING, Tick): on_tick_seeking,
        # Offline_Reactions in seeking (task 14.1).
        (State.SEEKING, SnapshotFailed): on_snapshot_failed_seeking,
        (State.SEEKING, CloudDisconnected): on_cloud_disconnected_seeking,
        # Reactions (task 12.1).
        (State.GREETING, ServoArrived): on_servo_arrived_greeting,
        (State.GREETING, Tick): on_tick_greeting,
        (State.WARNING, Tick): on_tick_warning,
        (State.UNCERTAIN, Tick): on_tick_uncertain,
        **{
            (state, event_cls): on_audio_result_reaction
            for state in (State.GREETING, State.WARNING, State.UNCERTAIN)
            for event_cls in (AudioFinished, AudioFailed)
        },
        # Cooldown and return to sleep (task 13.1).
        (State.COOLDOWN, ServoArrived): on_servo_arrived_cooldown,
        (State.COOLDOWN, Tick): on_tick_cooldown,
        # Voice conversation (voice-conversation task 15.2).
        (State.SLEEPING, ConversationStart): on_conversation_start_sleeping,
        # Remote photo (remote-actions R2).
        (State.SLEEPING, SnapshotRequest): on_snapshot_request_sleeping,
        **{(state, SnapshotRequest): on_snapshot_request_awake for state in PHOTO_STATES},
        # Remote control (remote-mode M1 to M3).
        (State.REMOTE, Tick): on_tick_remote,
        (State.REMOTE, PirRising): _pir_ignored_in_remote,
        (State.REMOTE, Gaze): remote_command(on_gaze),
        (State.REMOTE, Lantern): remote_command(on_lantern),
        (State.REMOTE, Speak): remote_command(on_speak),
        (State.REMOTE, SnapshotRequest): remote_command(on_snapshot_request_awake),
        (State.GREETING, ConversationStart): on_conversation_start_greeting,
        (State.CONVERSING, ConversationStart): on_conversation_start_conversing,
        (State.CONVERSING, ConversationEnd): on_conversation_end_conversing,
        (State.CONVERSING, ConversationFinished): on_conversation_finished_conversing,
        (State.CONVERSING, Tick): on_tick_conversing,
        (State.CONVERSING, CloudDisconnected): on_cloud_disconnected_conversing,
        (State.CONVERSING, SnapshotRequest): on_snapshot_request_conversing,
        (State.CONVERSING, SnapshotReady): on_snapshot_ready_conversing,
        (State.CONVERSING, SnapshotFailed): on_snapshot_failed_conversing,
        (State.CONVERSING, JudgementResult): on_judgement_conversing,
        # Manual commands (task 16.1).
        **{
            (state, command_cls): on_motion_command_resting
            for state in (State.SLEEPING, State.COOLDOWN)
            for command_cls in (Gaze, Lantern)
        },
    }
)
"""Handlers for one ``(State, Event class)`` pair; looked up first."""

GLOBAL_HANDLERS: Mapping[type, Handler] = MappingProxyType(
    {
        # Waking and seeking (task 9.1).
        SnapshotFailed: on_snapshot_failed,
        CloudConnected: on_cloud_connected,
        CloudDisconnected: on_cloud_disconnected,
        # Reactions (task 12.1).
        AudioFinished: on_audio_result,
        AudioFailed: on_audio_result,
        AdapterError: on_adapter_error,
        # PIR debounce (task 15.1).
        PirRising: on_pir_rising,
        PirFalling: on_pir_falling,
        # Voice conversation: rejected outside the states that handle them (task 15.2).
        ConversationStart: on_conversation_start_other,
        SnapshotRequest: on_snapshot_request_other,
        # Manual commands (task 16.1).
        Speak: on_speak,
        Gaze: on_gaze,
        Lantern: on_lantern,
        ModeSet: on_mode_set,
    }
)
"""Handlers for an Event class in every State; looked up when no State handler exists."""
