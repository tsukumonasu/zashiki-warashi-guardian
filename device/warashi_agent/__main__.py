"""Entry point: parse arguments, run the startup sequence, then the loop (R20.5-R20.7, R27).

Why this module is built from small functions:
- ``main()`` is the only place that touches the process: ``sys`` streams, signals, exit codes.
  Everything else takes its inputs as arguments, so task 27.6 can inject a fake stdin, fake
  adapters and a ``ManualScheduler`` without a Raspberry Pi and without a subprocess.
- Adapters come from a ``Factories`` value. ``real_factories()`` and ``fake_factories()`` are
  the two production choices (normal and ``--fake`` mode); a test passes its own. Nothing is
  built, started or moved at import: gpiozero and lgpio are imported only inside the real
  factories' adapters (hardware.md, "No motion on import or at startup").
- A rejected Config exits with code 2 before any factory is called, so a wrong calibration
  never reaches a GPIO pin (R25.10).
- SIGTERM and SIGINT only call ``ShutdownRelay.request()``, which ends in
  ``Dispatcher.request_shutdown()`` (or ``Event.set()`` for the self-test): both are safe in a
  signal handler. The Dispatcher then detaches the servos and switches the lantern off without
  a glide (R20.6).
"""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import importlib.metadata
import logging
import queue
import signal
import sys
import threading
import time
import tomllib
import uuid
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Final, Protocol, TextIO, runtime_checkable

from warashi_agent import cli, selftest
from warashi_agent.adapters.audio import VOICE_DIR, AudioAdapter
from warashi_agent.adapters.camera import CameraAdapter
from warashi_agent.adapters.cloud import (
    CloudLink,
    CloudPost,
    LocalCloudLink,
    MqttCloudLink,
    PahoClientFactory,
)
from warashi_agent.adapters.fakes import (
    FakeAudio,
    FakeCamera,
    FakeCloudLink,
    FakePir,
    FakePwmDevice,
    FakeServoDeviceFactory,
)
from warashi_agent.adapters.lantern import LanternAdapter, create_pwm_led
from warashi_agent.adapters.pir import PirAdapter
from warashi_agent.adapters.ports import (
    AudioPort,
    CameraPort,
    LanternPort,
    PirPort,
    ProbeResult,
    ServoPort,
)
from warashi_agent.adapters.servo import GpiozeroServoFactory, ServoAdapter
from warashi_agent.config import Config, ConfigRejected, format_rejection, load_config
from warashi_agent.dispatcher import Adapters, Dispatcher
from warashi_agent.messages import Envelope, ErrorCode, ErrorReported, encode
from warashi_agent.model import Action, Event, TakeSnapshot
from warashi_agent.redact import format_action, format_envelope
from warashi_agent.state_machine import initial_state
from warashi_agent.timebase import MonotonicClock, Scheduler, ThreadScheduler
from warashi_agent.voice import ManifestResult, VoiceLine, load_manifest

_log = logging.getLogger(__name__)

PACKAGE_NAME: Final = "warashi-agent"
DEFAULT_CONFIG_PATH: Final = "config.toml"
EXIT_CONFIG_REJECTED: Final = 2
"""systemd must not restart on this code (``RestartPreventExitStatus=2``, R25.10)."""
EXIT_STARTUP_FAILED: Final = 1

QUIT_SETTLE_S: Final = 0.3
"""How long the ``--fake`` reader waits before it shuts down after ``quit`` or end of input.

Piped input such as ``p``, ``offline``, ``quit`` arrives in one burst. Without a short wait the
shutdown flag would be seen before the loop processed the first line, and the printed Actions
(R27.3) would be missing. The wait is not hardware-relevant: it only delays the exit.
"""

Post = Callable[[Event], None]


# --------------------------------------------------------------------------------------------
# Arguments and version
# --------------------------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    """The command line: ``--config``, ``--fake`` and ``--selftest`` (R27.1, R27.5, R27.7)."""
    parser = argparse.ArgumentParser(
        prog="warashi_agent",
        description="Zashiki-Warashi Guardian device agent.",
    )
    parser.add_argument(
        "--config",
        default=DEFAULT_CONFIG_PATH,
        help=f"path of config.toml (default: {DEFAULT_CONFIG_PATH})",
    )
    parser.add_argument(
        "--fake",
        action="store_true",
        help="run with fake hardware and a fake cloud; read keyboard lines from stdin",
    )
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="exercise each adapter once, print PASS, FAIL or SKIP, and exit",
    )
    return parser


def read_agent_version(pyproject: Path | None = None) -> str:
    """The ``warashi-agent`` version: installed metadata, else ``device/pyproject.toml``.

    The fallback covers running from a plain checkout (``python -m warashi_agent`` on the Pi
    after ``rsync``), where the package is not installed. ``"unknown"`` is the last resort so
    the version can never stop the doll from starting.
    """
    try:
        return importlib.metadata.version(PACKAGE_NAME)
    except importlib.metadata.PackageNotFoundError:
        pass
    path = (
        pyproject
        if pyproject is not None
        else Path(__file__).resolve().parent.parent / ("pyproject.toml")
    )
    try:
        with path.open("rb") as fp:
            version = tomllib.load(fp)["project"]["version"]
    except (OSError, tomllib.TOMLDecodeError, KeyError, TypeError):
        return "unknown"
    return version if isinstance(version, str) else "unknown"


# --------------------------------------------------------------------------------------------
# Factories
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True, kw_only=True)
class Factories:
    """Everything ``main()`` builds, as callables, so tests can replace any part.

    Each adapter factory gets the Config, the ``post`` callback (``inbox.put``) and the
    Scheduler. The Scheduler also serves as the Clock: it has ``now()``. ``wait`` is the
    self-test's sleep: ``time.sleep`` in production, ``scheduler.advance`` in tests.
    """

    scheduler: Callable[[], Scheduler]
    cloud: Callable[[Config, Scheduler], CloudLink]
    servo: Callable[[Config, Post, Scheduler], ServoPort]
    lantern: Callable[[Config, Post, Scheduler], LanternPort]
    pir: Callable[[Config, Post, Scheduler], PirPort]
    camera: Callable[[Config, Post, Scheduler], CameraPort]
    audio: Callable[[Config, Post, Scheduler, tuple[VoiceLine, ...]], AudioPort]
    wait: Callable[[float], None] = time.sleep


def select_real_cloud(config: Config, scheduler: Scheduler) -> CloudLink:
    """``[aws].enabled`` picks the MQTT link, otherwise the local one (cloud-judgement R23.2).

    Building the link only stores settings: paho is imported, files are read and the network
    is touched in ``start()``, on the link's own thread, so startup never blocks here. The log
    carries the choice only, never the endpoint or a file path.
    """
    if not config.aws.enabled:
        return LocalCloudLink()
    _log.info("cloud link: MQTT (AWS IoT Core)")
    return MqttCloudLink(config.aws, config.device.id, PahoClientFactory(), encode, _log)


def real_factories() -> Factories:
    """Real adapters; the cloud link follows ``[aws].enabled`` (normal mode, ``--selftest``)."""
    return Factories(
        scheduler=lambda: ThreadScheduler(MonotonicClock()),
        cloud=select_real_cloud,
        servo=lambda config, post, scheduler: ServoAdapter(
            config, post, scheduler, GpiozeroServoFactory()
        ),
        lantern=lambda config, post, scheduler: LanternAdapter(
            post, scheduler, create_pwm_led(config.pins.lantern_pin)
        ),
        pir=lambda config, post, scheduler: PirAdapter(config.pins.pir_pin, post),
        camera=lambda config, post, scheduler: CameraAdapter(post, scheduler, config),
        audio=lambda config, post, scheduler, lines: AudioAdapter(post, scheduler, config, lines),
    )


def fake_factories() -> Factories:
    """Fake adapters and the Fake_Cloud_Link with the real clock (``--fake``, R27.1)."""
    return Factories(
        scheduler=lambda: ThreadScheduler(MonotonicClock()),
        cloud=lambda config, scheduler: FakeCloudLink(scheduler, config.device.id),
        servo=lambda config, post, scheduler: ServoAdapter(
            config, post, scheduler, FakeServoDeviceFactory(scheduler)
        ),
        lantern=lambda config, post, scheduler: LanternAdapter(
            post, scheduler, FakePwmDevice(scheduler)
        ),
        pir=lambda config, post, scheduler: FakePir(post, scheduler),
        camera=lambda config, post, scheduler: FakeCamera(post, scheduler),
        audio=lambda config, post, scheduler, lines: FakeAudio(post, scheduler),
    )


# --------------------------------------------------------------------------------------------
# Shutdown relay and signals
# --------------------------------------------------------------------------------------------


class ShutdownRelay:
    """Forwards a shutdown request to whatever is running, even one that came too early.

    The signal handlers are installed first, before the Dispatcher exists. A SIGTERM during
    startup sets a flag; ``bind()`` runs the request as soon as the target exists. ``request()``
    takes no lock and calls only the bound target, because it runs inside a signal handler.
    """

    def __init__(self) -> None:
        self._requested = False
        self._target: Callable[[], None] | None = None

    @property
    def requested(self) -> bool:
        return self._requested

    def request(self) -> None:
        self._requested = True
        target = self._target
        if target is not None:
            target()

    def bind(self, target: Callable[[], None]) -> None:
        self._target = target
        if self._requested:
            target()


@contextlib.contextmanager
def signal_handlers(relay: ShutdownRelay) -> Iterator[None]:
    """Route SIGTERM and SIGINT to ``relay.request()`` and restore the old handlers after.

    ``signal.signal`` works only on the main thread; elsewhere (a test thread) the handlers
    are skipped and the relay can still be driven by hand.
    """

    def handler(signum: int, frame: object) -> None:
        relay.request()

    previous: dict[int, object] = {}
    try:
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous[signum] = signal.signal(signum, handler)
    except ValueError:
        pass  # not the main thread
    try:
        yield
    finally:
        for signum, old in previous.items():
            signal.signal(signum, old)  # type: ignore[arg-type]


# --------------------------------------------------------------------------------------------
# Logging and printing
# --------------------------------------------------------------------------------------------

_HANDLER_MARK: Final = "_warashi_main_handler"


@contextlib.contextmanager
def logging_to(stream: TextIO, *, dispatcher_level: int) -> Iterator[None]:
    """Log the ``warashi_agent`` loggers to ``stream`` without colour codes (R27.7).

    The handler sits on the package logger, not on the root logger, so other libraries and a
    test's own handlers are untouched. ``dispatcher_level`` lets ``--fake`` silence the
    Dispatcher's per-Event lines, because that mode prints its own Action lines (R27.3).
    """
    package = logging.getLogger("warashi_agent")
    dispatcher = logging.getLogger("warashi_agent.dispatcher")
    old_levels = (package.level, dispatcher.level)
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    setattr(handler, _HANDLER_MARK, True)
    package.addHandler(handler)
    package.setLevel(logging.INFO)
    dispatcher.setLevel(dispatcher_level)
    try:
        yield
    finally:
        package.removeHandler(handler)
        package.setLevel(old_levels[0])
        dispatcher.setLevel(old_levels[1])
        handler.flush()


class LinePrinter:
    """Thread-safe one-line printer: the loop thread and the keyboard thread both print."""

    def __init__(self, stream: TextIO) -> None:
        self._stream = stream
        self._lock = threading.Lock()

    def __call__(self, text: str) -> None:
        with self._lock:
            try:
                self._stream.write(text + "\n")
                self._stream.flush()
            except (OSError, ValueError):
                pass  # a closed pipe must not stop the doll


class PrintingCloud:
    """Prints each published envelope as one redacted line, then hands it on (R27.3)."""

    def __init__(self, inner: CloudLink, out: Callable[[str], None]) -> None:
        self._inner = inner
        self._out = out

    def start(self, post: CloudPost) -> None:
        self._inner.start(post)

    def publish(self, envelope: Envelope) -> None:
        try:
            self._out(f"publish {format_envelope(envelope)}")
        except Exception as exc:  # noqa: BLE001 - publish must never raise (R21.1)
            _log.warning("could not print an envelope (%s)", type(exc).__name__)
        self._inner.publish(envelope)

    def stop(self) -> None:
        self._inner.stop()


# --------------------------------------------------------------------------------------------
# Startup pieces
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True, kw_only=True)
class Parts:
    """The built adapters and their cloud link; what the Dispatcher and clean-up need."""

    adapters: Adapters
    cloud: CloudLink


def build_adapters(
    config: Config,
    factories: Factories,
    scheduler: Scheduler,
    post: Post,
    lines: tuple[VoiceLine, ...],
) -> Adapters:
    """Build the five adapters and make the lantern 0 (R16.3).

    The Servo_Adapter reads ``pose_file`` lazily and creates no servo device, and the PIR
    adapter claims its pin only in ``start()``, so nothing moves here (R15.6, R17).
    """
    lantern = factories.lantern(config, post, scheduler)
    lantern.off_now()
    servo = factories.servo(config, post, scheduler)
    pir = factories.pir(config, post, scheduler)
    camera = factories.camera(config, post, scheduler)
    audio = factories.audio(config, post, scheduler, lines)
    return Adapters(servo=servo, lantern=lantern, pir=pir, camera=camera, audio=audio)


def load_voice(config: Config, *, fake: bool) -> ManifestResult:
    """Load the Voice_Manifest; the WAV_File_Check is off under ``--fake`` (R26.6, R27.1)."""
    return load_manifest(
        VOICE_DIR / "lines.toml",
        blocked_words=config.privacy.blocked_words,
        wav_check=not fake,
    )


def run_probes(
    camera: CameraPort, audio: AudioPort, timeout_s: float
) -> tuple[ProbeResult | None, ProbeResult | None]:
    """Run the camera and audio probes in parallel threads (R18.5, R19.7).

    Each probe is bounded by ``probe_timeout_s`` inside its adapter; the join adds one second
    on top, so a probe that ignores its bound still cannot hold the startup. ``None`` means
    the probe raised or did not finish; the caller reports that as ``adapter_failed``.
    """
    results: dict[str, ProbeResult] = {}

    def work(name: str, probe: Callable[[], ProbeResult]) -> None:
        try:
            results[name] = probe()
        except Exception as exc:  # noqa: BLE001 - a broken probe must not stop startup
            _log.error("%s probe raised %s", name, type(exc).__name__)

    threads = [
        threading.Thread(target=work, args=("camera", camera.probe), daemon=True),
        threading.Thread(target=work, args=("audio", audio.probe), daemon=True),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=timeout_s + 1.0)
    return results.get("camera"), results.get("audio")


def collect_startup_errors(
    manifest: ManifestResult,
    camera: ProbeResult | None,
    audio: ProbeResult | None,
) -> list[ErrorReported]:
    """Turn manifest problems and failed probes into ``error.reported`` payloads (R20.5).

    Order: manifest problems in file order, then camera, then audio. A failed probe logs its
    owner-facing hint (the PWR/USB swap hint for audio, hardware.md) and publishes its code.
    Texts hold no line text and no secret.
    """
    errors = [
        ErrorReported(
            code=ErrorCode(problem.code),
            message=f"{problem.line_ref}: {problem.rule}",
            ref_id=None,
        )
        for problem in manifest.problems
    ]
    for name, result in (("camera", camera), ("audio", audio)):
        if result is None:
            errors.append(
                ErrorReported(
                    code=ErrorCode.ADAPTER_FAILED, message=f"{name} probe failed", ref_id=None
                )
            )
        elif not result.ok and result.code is not None:
            _log.warning("%s probe failed: %s", name, result.hint)
            errors.append(
                ErrorReported(code=ErrorCode(result.code), message=result.hint, ref_id=None)
            )
    return errors


def stop_quietly(parts: Parts) -> None:
    """Make the hardware safe after a failed startup: detach, lantern off, stop children."""
    steps: tuple[Callable[[], None], ...] = (
        parts.adapters.servo.emergency_detach,
        parts.adapters.lantern.off_now,
        parts.adapters.pir.close,
        parts.adapters.camera.stop,
        parts.adapters.audio.stop,
        parts.cloud.stop,
    )
    for stop in steps:
        try:
            stop()
        except Exception as exc:  # noqa: BLE001 - keep stopping the others
            _log.error("stop failed during startup clean-up: %s", type(exc).__name__)


# --------------------------------------------------------------------------------------------
# --fake keyboard
# --------------------------------------------------------------------------------------------


@runtime_checkable
class KeyboardPir(Protocol):
    """What the keyboard needs from the PIR adapter: the fake's ``rise`` and ``fall``."""

    def rise(self) -> None: ...

    def fall(self) -> None: ...


@runtime_checkable
class KeyboardCloud(Protocol):
    """What the keyboard needs from the cloud link: the Fake_Cloud_Link's scripting."""

    def script_raw(self, payload: bytes, *, at: float | None = None) -> None: ...

    def go_online(self, *, at: float | None = None) -> None: ...

    def go_offline(self, *, at: float | None = None) -> None: ...


class SnapshotTracker:
    """Remembers the Snapshot_Id of the latest ``TakeSnapshot`` Action (R27.2).

    It is the Dispatcher's Action observer, so it also prints each Action as one line (R27.3).
    The id is written on the loop thread and read on the keyboard thread; a plain attribute
    assignment is atomic in CPython.
    """

    def __init__(self, out: Callable[[str], None]) -> None:
        self._out = out
        self.latest: str | None = None

    def __call__(self, action: Action) -> None:
        if isinstance(action, TakeSnapshot):
            self.latest = action.snapshot_id
        self._out(f"action {format_action(action)}")


def run_keyboard(
    lines: Iterable[str],
    *,
    pir: KeyboardPir,
    cloud: KeyboardCloud,
    snapshots: SnapshotTracker,
    device_id: str,
    out: Callable[[str], None],
    relay: ShutdownRelay,
    new_id: Callable[[], str] | None = None,
    now: Callable[[], datetime] | None = None,
    settle_s: float = QUIT_SETTLE_S,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Map keyboard lines to the fakes until ``quit`` or end of input (R27.2, R27.4, R27.11).

    Verdicts and commands go through ``build_wire_message`` and ``cloud.script_raw``, so they
    take the same inbound pipeline as a message from the cloud. Unrecognised input prints the
    help text and posts nothing. At the end it waits ``settle_s`` and then asks for the same
    shutdown as SIGINT.
    """
    make_id = new_id if new_id is not None else lambda: str(uuid.uuid4())
    clock = now if now is not None else lambda: datetime.now(UTC)
    try:
        for text in lines:
            match cli.parse_line(text):
                case cli.Quit():
                    break
                case cli.HelpRequest() | cli.ParseError():
                    out(cli.HELP_TEXT)
                case cli.PirKey(rising=rising):
                    pir.rise() if rising else pir.fall()
                case cli.ConnectivityKey(online=online):
                    cloud.go_online() if online else cloud.go_offline()
                case (
                    cli.VerdictKey()
                    | cli.SpeakKey()
                    | cli.GazeKey()
                    | cli.LanternKey()
                    | cli.ModeKey()
                ) as command:
                    wire = cli.build_wire_message(
                        command,
                        device_id=device_id,
                        snapshot_id=snapshots.latest,
                        new_id=make_id,
                        now=clock,
                    )
                    if isinstance(wire, cli.NoSnapshotPending):
                        out(wire.text)
                    else:
                        cloud.script_raw(wire)
    finally:
        sleep(settle_s)
        relay.request()


# --------------------------------------------------------------------------------------------
# Modes
# --------------------------------------------------------------------------------------------


def run_agent(
    config: Config,
    *,
    fake: bool,
    factories: Factories,
    relay: ShutdownRelay,
    stdin: TextIO,
    stdout: TextIO,
    agent_version: str,
) -> int:
    """The startup sequence of the design, then the loop; returns the exit code."""
    out = LinePrinter(stdout)
    scheduler = factories.scheduler()
    inbox: queue.SimpleQueue = queue.SimpleQueue()

    # Step 2: the Cloud_Link first, so startup errors can be published.
    cloud = factories.cloud(config, scheduler)
    keyboard_cloud = cloud
    if fake:
        cloud = PrintingCloud(cloud, out)
    cloud.start(inbox.put)

    parts: Parts | None = None
    try:
        # Steps 3-4: Voice_Manifest, lantern at 0, Servo_Adapter (no device).
        manifest = load_voice(config, fake=fake)
        adapters = build_adapters(config, factories, scheduler, inbox.put, manifest.available)
        parts = Parts(adapters=adapters, cloud=cloud)
        # Step 5: probes in parallel.
        camera_probe, audio_probe = run_probes(
            adapters.camera, adapters.audio, config.timing.probe_timeout_s
        )
        errors = collect_startup_errors(manifest, camera_probe, audio_probe)
        # Step 7 (state): taken after the probes, right before the loop starts.
        snapshots = SnapshotTracker(out)
        dispatcher = Dispatcher(
            config=config,
            initial=initial_state(
                config=config,
                lines=manifest.available,
                agent_version=agent_version,
                start_time=scheduler.now(),
            ),
            adapters=adapters,
            cloud=cloud,
            clock=scheduler,
            scheduler=scheduler,
            observer=snapshots if fake else None,
            inbox=inbox,
        )
        # Step 6: every startup error, with no Encounter.
        for error in errors:
            dispatcher.publish(error, None)
        relay.bind(dispatcher.request_shutdown)
        if fake:
            dispatcher.start()  # the PIR fake posts edges only after start()
            _start_keyboard(stdin, keyboard_cloud, adapters.pir, snapshots, config, out, relay)
        return dispatcher.run()
    except Exception as exc:  # noqa: BLE001 - startup failed; leave the hardware safe
        _log.error("startup failed: %s", type(exc).__name__, exc_info=True)
        if parts is not None:
            stop_quietly(parts)
        else:
            cloud.stop()
        return EXIT_STARTUP_FAILED
    finally:
        _shutdown_scheduler(scheduler)


def _start_keyboard(
    stdin: TextIO,
    cloud: CloudLink,
    pir: PirPort,
    snapshots: SnapshotTracker,
    config: Config,
    out: Callable[[str], None],
    relay: ShutdownRelay,
) -> None:
    """Start the stdin reader thread, or explain why the injected parts cannot be typed to."""
    if not (isinstance(pir, KeyboardPir) and isinstance(cloud, KeyboardCloud)):
        _log.warning("--fake: the PIR or the cloud link has no keyboard hooks; stdin is ignored")
        return
    threading.Thread(
        target=run_keyboard,
        args=(stdin,),
        kwargs={
            "pir": pir,
            "cloud": cloud,
            "snapshots": snapshots,
            "device_id": config.device.id,
            "out": out,
            "relay": relay,
        },
        name="warashi-keyboard",
        daemon=True,  # a read blocked on stdin must not delay the exit
    ).start()


def run_selftest_mode(
    config: Config,
    *,
    fake: bool,
    factories: Factories,
    relay: ShutdownRelay,
    stdout: TextIO,
    agent_version: str,
) -> int:
    """``--selftest`` and ``--fake --selftest``: the adapters one at a time (R27.5-R27.10)."""
    out = LinePrinter(stdout)
    scheduler = factories.scheduler()
    inbox: queue.SimpleQueue = queue.SimpleQueue()
    cloud = factories.cloud(config, scheduler)
    cloud.start(lambda item: None)  # the self-test reads no inbound message
    interrupt = threading.Event()
    relay.bind(interrupt.set)
    parts: Parts | None = None
    try:
        manifest = load_voice(config, fake=fake)
        adapters = build_adapters(config, factories, scheduler, inbox.put, manifest.available)
        parts = Parts(adapters=adapters, cloud=cloud)
        return selftest.run_selftest(
            config=config,
            adapters=adapters,
            cloud=cloud,
            lines=manifest.available,
            inbox=inbox,
            scheduler=scheduler,
            wait=factories.wait,
            out=out,
            agent_version=agent_version,
            interrupt=interrupt,
        )
    except Exception as exc:  # noqa: BLE001 - leave the hardware safe whatever happened
        _log.error("self-test aborted: %s", type(exc).__name__, exc_info=True)
        return selftest.EXIT_FAILED
    finally:
        if parts is not None:
            stop_quietly(parts)
        else:
            cloud.stop()
        _shutdown_scheduler(scheduler)


def _shutdown_scheduler(scheduler: Scheduler) -> None:
    """Stop a production scheduler's worker; test schedulers have nothing to stop."""
    shutdown = getattr(scheduler, "shutdown", None)
    if callable(shutdown):
        shutdown()


# --------------------------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------------------------


def main(
    argv: list[str] | None = None,
    *,
    factories: Factories | None = None,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    """Run the agent and return the exit code.

    0 after SIGTERM, SIGINT, ``quit`` or a passing self-test; 1 after an escaped exception, a
    failed startup or a failing or interrupted self-test; 2 for a rejected Config, before any
    adapter is built. ``factories`` replaces the adapters whatever the mode (tests); by default
    ``--fake`` uses ``fake_factories()`` and every other mode ``real_factories()``.
    """
    out_stream = stdout if stdout is not None else sys.stdout
    err_stream = stderr if stderr is not None else sys.stderr
    in_stream = stdin if stdin is not None else sys.stdin
    args = build_parser().parse_args(argv)

    # Step 1: the Config. Nothing hardware-related exists yet (R25.10).
    loaded = load_config(args.config, fake=args.fake)
    if isinstance(loaded, ConfigRejected):
        err_stream.write(format_rejection(loaded) + "\n")
        err_stream.flush()
        return EXIT_CONFIG_REJECTED
    config = loaded
    if args.fake:
        # R27.1: no 60 s PIR warm-up while typing at a keyboard.
        config = dataclasses.replace(
            config, timing=dataclasses.replace(config.timing, pir_warmup_s=0.0)
        )
    chosen = (
        factories
        if factories is not None
        else (fake_factories() if args.fake else real_factories())
    )
    version = read_agent_version()
    relay = ShutdownRelay()

    if args.fake and not args.selftest:
        log_stream, dispatcher_level = err_stream, logging.WARNING
    else:
        log_stream, dispatcher_level = out_stream, logging.INFO  # R27.7
    with signal_handlers(relay), logging_to(log_stream, dispatcher_level=dispatcher_level):
        if args.selftest:
            return run_selftest_mode(
                config,
                fake=args.fake,
                factories=chosen,
                relay=relay,
                stdout=out_stream,
                agent_version=version,
            )
        return run_agent(
            config,
            fake=args.fake,
            factories=chosen,
            relay=relay,
            stdin=in_stream,
            stdout=out_stream,
            agent_version=version,
        )


if __name__ == "__main__":
    sys.exit(main())
