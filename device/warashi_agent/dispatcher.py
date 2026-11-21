"""Dispatcher: the main loop between the adapters, the State_Machine and the Cloud_Link (R20).

Why this module exists:
- ``step()`` is pure (R1.1). Something has to read the clock, draw random numbers, create
  UUIDs, call ``step()`` and hand its Actions to the hardware and the cloud. That is this
  module, and only this module: it is the one place in the package that uses ``time`` (through
  the injected ``Clock``), ``random``, ``os.urandom`` and ``uuid4``.
- Every input goes through one queue and is processed one at a time (R20.1). Adapters, the
  Tick and the Cloud_Link only post; the loop never waits on a servo, the camera, audio or the
  network, because every port's ``handle()`` only enqueues work (R20.2, R20.3, hardware.md).
- The hardware must be safe whatever happens. A failing ``step()`` restarts the State_Machine
  after releasing the servos and switching the lantern off (R10.5, R10.7). A shutdown request
  or an exception that escapes the loop detaches the servos and switches the lantern off at
  once, without gliding back to center, and no later Action reaches them (R20.6).

Tests drive the loop with ``pump()`` and a ``ManualScheduler``; production calls ``run()``.
"""

from __future__ import annotations

import dataclasses
import logging
import os
import queue
import random
import threading
import traceback
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final

from warashi_agent.adapters.cloud import CloudLink, InboundRaw
from warashi_agent.adapters.ports import (
    AudioPort,
    CameraPort,
    ConversationPort,
    LanternPort,
    PirPort,
    ServoPort,
)
from warashi_agent.config import Config
from warashi_agent.inbound import Deduplicator, ErrorToPublish, route_inbound
from warashi_agent.messages import (
    EncounterEnded,
    Envelope,
    ErrorCode,
    ErrorReported,
    Payload,
    StateChanged,
)
from warashi_agent.model import (
    Action,
    EndReason,
    Event,
    GazeTarget,
    LanternFade,
    PlayAudioUrl,
    PlayLine,
    PublishEvent,
    PublishStatus,
    Reason,
    ReleaseServos,
    StartConversation,
    State,
    StopConversation,
    TakeSnapshot,
    Tick,
)
from warashi_agent.redact import format_action, format_envelope, format_event, one_line
from warashi_agent.state_machine import MachineState, initial_state, step
from warashi_agent.timebase import Clock, Handle, Scheduler

_log = logging.getLogger(__name__)

POLL_INTERVAL_S: Final = 0.1
"""How long ``run()`` waits on the queue before it checks the shutdown flag again (R20.6)."""

StepFn = Callable[[MachineState, Event, float], tuple[MachineState, tuple[Action, ...]]]
"""The shape of ``state_machine.step``; tests inject a failing one to drive the restart."""

ActionObserver = Callable[[Action], None]
"""Hook called with every Action before it is routed; the ``--fake`` CLI prints them."""

# Fixed ``error.reported`` texts. The Dispatcher never copies text from an incoming message or
# an exception into a published event, so no nickname, token or payload can leak (R13.6).
ERROR_MESSAGES: Final[dict[ErrorCode, str]] = {
    ErrorCode.UNKNOWN_TYPE: "unknown message type",
    ErrorCode.UNSUPPORTED_VERSION: "unsupported contract version",
    ErrorCode.MALFORMED_MESSAGE: "malformed message",
    ErrorCode.WRONG_DEVICE: "message for another device",
    ErrorCode.INTERNAL_ERROR: "state machine restarted",
}


class _ShutdownSentinel:
    """Queue item posted by ``request_shutdown()`` so a waiting loop wakes at once."""

    def __repr__(self) -> str:
        return "<shutdown>"


_SHUTDOWN: Final = _ShutdownSentinel()

QueueItem = Event | InboundRaw | _ShutdownSentinel
"""Everything that can sit in the Dispatcher's single queue."""


@dataclass(frozen=True, kw_only=True)
class Adapters:
    """The hardware ports the Dispatcher routes Actions to and stops on shutdown."""

    servo: ServoPort
    lantern: LanternPort
    pir: PirPort
    camera: CameraPort
    audio: AudioPort
    conversation: ConversationPort | None = None
    """Built only when ``conversation_enabled``; ``None`` means voice sessions are off."""


class Ticker:
    """Posts a ``Tick`` every ``interval_s`` on the Scheduler (R20.1).

    The Tick runs as a self-rescheduling callback on the Scheduler instead of a dedicated
    sleeping thread: in production the ``ThreadScheduler`` worker posts it, and in tests a
    ``ManualScheduler`` posts it only when virtual time advances, so tests never sleep. The
    next Tick is due one interval after the previous due time, or at once when the scheduler
    fell behind, so the Tick period does not drift and a late scheduler does not flood the
    queue with a burst of Ticks.
    """

    def __init__(self, scheduler: Scheduler, interval_s: float, post: Callable[[Tick], None]):
        self._scheduler = scheduler
        self._interval_s = interval_s
        self._post = post
        self._lock = threading.Lock()
        self._handle: Handle | None = None
        self._next_due = 0.0
        self._started = False
        self._stopped = False

    def start(self) -> None:
        """Schedule the first Tick one interval from now. A second call does nothing."""
        with self._lock:
            if self._started or self._stopped:
                return
            self._started = True
            self._next_due = self._scheduler.now() + self._interval_s
            self._handle = self._scheduler.call_at(self._next_due, self._fire)

    def stop(self) -> None:
        """Cancel the pending Tick; no Tick is posted afterwards."""
        with self._lock:
            self._stopped = True
            handle, self._handle = self._handle, None
        if handle is not None:
            handle.cancel()

    def _fire(self) -> None:
        with self._lock:
            if self._stopped:
                return
            self._next_due = max(self._next_due + self._interval_s, self._scheduler.now())
            self._handle = self._scheduler.call_at(self._next_due, self._fire)
        self._post(Tick())


def _seeded_random() -> random.Random:
    """A generator seeded from the OS, so two runs of the doll choose lines differently."""
    return random.Random(int.from_bytes(os.urandom(16), "big"))


def _uuid4() -> str:
    return str(uuid.uuid4())


def _utc_now() -> datetime:
    return datetime.now(UTC)


class Dispatcher:
    """Runs the State_Machine on one queue of Events and routes its Actions (R20).

    Threads only call ``post()`` and ``request_shutdown()``; everything else runs on the loop
    thread, so the Machine_State, the Deduplicator and the hardware gate need no lock.
    """

    def __init__(
        self,
        *,
        config: Config,
        initial: MachineState,
        adapters: Adapters,
        cloud: CloudLink,
        clock: Clock,
        scheduler: Scheduler,
        rng: random.Random | None = None,
        new_uid: Callable[[], str] | None = None,
        utc_now: Callable[[], datetime] | None = None,
        log: logging.Logger | None = None,
        step_fn: StepFn = step,
        observer: ActionObserver | None = None,
        inbox: queue.SimpleQueue[QueueItem] | None = None,
    ) -> None:
        """Wire the loop. Nothing starts here: no Tick, no PIR callback, no servo motion.

        ``rng``, ``new_uid`` and ``utc_now`` default to the OS-seeded generator, ``uuid4`` and
        the UTC wall clock; tests pass deterministic ones. ``inbox`` lets the startup sequence
        start the Cloud_Link with ``inbox.put`` before the initial state exists, so messages
        that arrive during startup wait in the same queue (design, "Startup sequence").
        """
        self._config = config
        self._ms = initial
        self._adapters = adapters
        self._cloud = cloud
        self._clock = clock
        self._rng = rng if rng is not None else _seeded_random()
        self._new_uid = new_uid if new_uid is not None else _uuid4
        self._utc_now = utc_now if utc_now is not None else _utc_now
        self._log = log if log is not None else _log
        self._step = step_fn
        self._observer = observer
        # SimpleQueue, not Queue: its put() is reentrant, so request_shutdown() may post the
        # sentinel from a signal handler even while the loop thread is inside get().
        self._queue: queue.SimpleQueue[QueueItem] = (
            inbox if inbox is not None else queue.SimpleQueue()
        )
        self._dedup = Deduplicator(window=config.messages.dedup_window_size)
        self._ticker = Ticker(scheduler, config.tick_s, self.post)
        self._started = False
        self._stopped = False
        self._shutdown_requested = False
        self._hardware_gate_closed = False

    # ----------------------------------------------------------------------------------------
    # Public interface
    # ----------------------------------------------------------------------------------------

    @property
    def machine_state(self) -> MachineState:
        """The current Machine_State, for tests and the self-test."""
        return self._ms

    def post(self, item: Event | InboundRaw) -> None:
        """Queue an Event or an inbound message. Thread safe; never blocks."""
        self._queue.put(item)

    def start(self) -> None:
        """Start the PIR callbacks and the Tick (design, startup step 7). Idempotent.

        ``run()`` calls this; tests that use ``pump()`` call it to get Ticks on a
        ``ManualScheduler``.
        """
        if self._started or self._stopped:
            return
        self._started = True
        self._adapters.pir.start()
        self._ticker.start()

    def request_shutdown(self) -> None:
        """Ask the loop to stop. The only call a signal handler makes (R20.6, R20.7).

        It sets a flag and posts a sentinel and touches no adapter: a signal handler runs on
        the main thread between bytecodes, so adapter code called from it could re-enter a
        lock that the interrupted loop holds.
        """
        self._shutdown_requested = True
        self._queue.put(_SHUTDOWN)

    def run(self) -> int:
        """Process the queue until shutdown; return the exit code (R20.6 to R20.8).

        Returns 0 after a shutdown request (or ``KeyboardInterrupt``) and 1 after an exception
        that escaped the loop. In every case the hardware is made safe first.
        """
        try:
            self.start()
            while not self._shutdown_requested:
                try:
                    item = self._queue.get(timeout=POLL_INTERVAL_S)
                except queue.Empty:
                    continue
                if isinstance(item, _ShutdownSentinel):
                    continue  # the loop condition sees the flag
                self._process(item)
        except KeyboardInterrupt:
            self._safe_stop()
            self._log.info("interrupted; hardware stopped safely")
            return 0
        except Exception as exc:
            self._safe_stop()  # hardware first, then the (slower) log line
            self._log_exception("an exception escaped the main loop; hardware stopped", exc)
            return 1
        finally:
            self._safe_stop()  # also covers SystemExit and other BaseExceptions
        self._log.info("shutdown requested; hardware stopped safely")
        return 0

    def pump(self, max_items: int | None = None) -> None:
        """Process queued items synchronously until the queue is empty; for tests.

        Items posted while pumping (Command_Events from the inbound pipeline, results of
        fakes) are processed in the same call. ``max_items`` bounds the number processed.
        Exceptions that would escape ``run()`` propagate to the caller. After the Dispatcher
        has stopped, nothing is processed.
        """
        processed = 0
        while not self._stopped and (max_items is None or processed < max_items):
            try:
                item = self._queue.get_nowait()
            except queue.Empty:
                return
            if isinstance(item, _ShutdownSentinel):
                continue
            self._process(item)
            processed += 1

    def publish(self, data: Payload, encounter_id: str | None = None) -> Envelope:
        """Wrap ``data`` in an envelope and hand it to the Cloud_Link (R20.4, R9.6).

        Used for ``PublishEvent`` and ``PublishStatus`` Actions, for the Dispatcher's own
        error reports, and by the startup sequence for probe and manifest errors. Publishing
        does not depend on connectivity: the Cloud_Link decides what to do while offline.
        """
        envelope = Envelope(
            id=self._new_uid(),
            ts=self._utc_now(),
            device_id=self._config.device.id,
            encounter_id=encounter_id,
            data=data,
        )
        self._cloud.publish(envelope)
        return envelope

    # ----------------------------------------------------------------------------------------
    # One queue item
    # ----------------------------------------------------------------------------------------

    def _process(self, item: Event | InboundRaw) -> None:
        if isinstance(item, InboundRaw):
            self._handle_inbound(item)
            return
        now = self._clock.now()  # read when the item is removed, so it never decreases (R20.1)
        event = dataclasses.replace(item, rand=self._rng.random(), uid=self._new_uid())  # R1.5
        if not isinstance(event, Tick):
            self._log.info("event %s", format_event(event))
        ms = self._ms
        try:
            nxt, actions = self._step(ms, event, now)
        except Exception as exc:
            self._restart(ms, exc)
            return
        self._ms = nxt
        for action in actions:  # in the order step() returned them (R20.2)
            self._route(action)

    def _handle_inbound(self, item: InboundRaw) -> None:
        """Run the R21.8 pipeline; publish its error or post its Command_Event back."""
        self._dedup, result = route_inbound(item.payload, self._dedup, self._config.device.id)
        if result is None:
            self._log.info("inbound duplicate dropped")
        elif isinstance(result, ErrorToPublish):
            # The id is untrusted text: cut it and print it escaped, on one line.
            shown = "null" if result.ref_id is None else one_line(repr(result.ref_id[:80]))
            self._log.info("inbound message dropped: %s refId=%s", result.code.value, shown)
            self._publish_logged(
                self._error(result.code, result.ref_id), self._current_encounter_id()
            )
        else:
            # Back onto the queue, so commands and hardware Events share one order (R21.8).
            self.post(result)

    def _route(self, action: Action) -> None:
        """Hand one Action to its port or the Cloud_Link without waiting (R20.2, R20.4)."""
        self._log.info("action %s", format_action(action))
        if self._observer is not None:
            self._observer(action)
        match action:
            case GazeTarget() | ReleaseServos():
                if self._gate_open(action):
                    self._adapters.servo.handle(action)
            case LanternFade():
                if self._gate_open(action):
                    self._adapters.lantern.handle(action)
            case TakeSnapshot():
                self._adapters.camera.handle(action)
            case PlayLine() | PlayAudioUrl():
                self._adapters.audio.handle(action)
            case StartConversation() | StopConversation():
                if self._adapters.conversation is not None:
                    self._adapters.conversation.handle(action)
                else:
                    self._log.warning("conversation action without an adapter dropped")
            case PublishEvent():
                self.publish(action.data, action.encounter_id)
            case PublishStatus():
                self.publish(action.data, None)  # status never belongs to an Encounter

    def _stop_conversation(self) -> None:
        if self._adapters.conversation is not None:
            self._adapters.conversation.stop()

    def _gate_open(self, action: Action) -> bool:
        """False once ``_safe_stop`` ran: no Action may reach the servos or lantern (R20.6)."""
        if self._hardware_gate_closed:
            self._log.info("dropped after shutdown: %s", type(action).__name__)
            return False
        return True

    # ----------------------------------------------------------------------------------------
    # Restart after a step() exception (R10.5, R10.7)
    # ----------------------------------------------------------------------------------------

    def _restart(self, ms: MachineState, exc: Exception) -> None:
        """Make the hardware safe, report the failure and start again in ``sleeping``.

        The failing state's Start_Time, Mode and connectivity are kept (R10.7). Its PIR level
        is not: the new state has it low, so a person still in front of the doll starts a new
        Encounter only with the next ``pir.rising``.
        """
        self._log_exception("step() failed; restarting the state machine", exc)
        self._route(ReleaseServos())
        self._route(LanternFade(level=0.0, fade_ms=0))
        encounter_id = ms.encounter.encounter_id if ms.encounter is not None else None
        self._publish_logged(self._error(ErrorCode.INTERNAL_ERROR, None), encounter_id)
        if ms.encounter is not None:
            if ms.state is not State.SLEEPING:
                self._publish_logged(
                    StateChanged(from_=ms.state, to=State.SLEEPING, reason=Reason.ERROR),
                    encounter_id,
                )
            self._publish_logged(EncounterEnded(reason=EndReason.ERROR), encounter_id)
        self._ms = initial_state(
            config=ms.config,
            lines=ms.lines,
            agent_version=ms.agent_version,
            start_time=ms.start_time,
            mode=ms.mode,
            cloud_connected=ms.cloud_connected,
        )

    # ----------------------------------------------------------------------------------------
    # Shutdown (R20.6 to R20.8)
    # ----------------------------------------------------------------------------------------

    def _safe_stop(self) -> None:
        """Stop everything once, hardware first, without any glide.

        The gate closes before anything else, so no Action reaches the servos or the lantern
        afterwards. Each stop is guarded on its own: one failing adapter must not keep the
        others (in particular the lantern after the servos) from stopping.
        """
        if self._stopped:
            return
        self._stopped = True
        self._hardware_gate_closed = True
        steps: tuple[tuple[str, Callable[[], None]], ...] = (
            ("servo detach", self._adapters.servo.emergency_detach),
            ("lantern off", self._adapters.lantern.off_now),
            ("tick", self._ticker.stop),
            ("pir", self._adapters.pir.close),
            ("camera", self._adapters.camera.stop),
            ("audio", self._adapters.audio.stop),
            ("conversation", self._stop_conversation),
            ("cloud link", self._cloud.stop),
        )
        for name, stop in steps:
            try:
                stop()
            except Exception as exc:
                self._log.error("%s failed during shutdown: %s", name, type(exc).__name__)

    # ----------------------------------------------------------------------------------------
    # Helpers
    # ----------------------------------------------------------------------------------------

    def _current_encounter_id(self) -> str | None:
        encounter = self._ms.encounter
        return encounter.encounter_id if encounter is not None else None

    @staticmethod
    def _error(code: ErrorCode, ref_id: str | None) -> ErrorReported:
        return ErrorReported(code=code, message=ERROR_MESSAGES[code], ref_id=ref_id)

    def _publish_logged(self, data: Payload, encounter_id: str | None) -> None:
        """Publish an envelope that no Action announced, and log it as one redacted line."""
        envelope = self.publish(data, encounter_id)
        self._log.info("publish %s", format_envelope(envelope))

    def _log_exception(self, text: str, exc: BaseException) -> None:
        """Log the exception type and stack, but not its message.

        The message of an exception raised inside ``step()`` or an adapter may repeat event
        data (a URL, a line text), which must never reach a log line (R13.6). The stack holds
        only file names, line numbers and source lines.
        """
        stack = "".join(traceback.format_tb(exc.__traceback__)).rstrip()
        self._log.error("%s: %s\n%s", text, type(exc).__name__, stack)
