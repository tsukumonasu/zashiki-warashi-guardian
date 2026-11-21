"""Tests for the command line entry point in warashi_agent.__main__ (task 27.6).

Most tests call ``main()`` in-process with injected ``Factories`` and a fake stdin, so no
subprocess and no hardware is involved. The adapters are the finished fakes on a
``ManualScheduler``; nothing advances virtual time, so only events typed at the keyboard
reach the state machine. ``--fake`` waits ``QUIT_SETTLE_S`` (0.3 s of real time) after
``quit`` so the loop can process the burst of typed lines; that wait is the only sleeping.

One smoke test starts a real ``python -m warashi_agent --fake`` subprocess. It is the only test
that uses the real clock and the real fake adapters, and pytest-timeout bounds it.

The repository's ``voice/lines.toml`` is not asserted on: until task 28.1 rewrites it, every
line in it is rejected. No test here depends on its content.

Sections:
- Rejected Config (R25.10, R25.11)
- ``--fake`` keyboard flow (R27.1 to R27.4, R27.11)
- Subprocess smoke test (R27.1, R27.3, R27.11)
"""

from __future__ import annotations

import dataclasses
import io
import subprocess
import sys
from pathlib import Path

import pytest

from warashi_agent import __main__ as entry
from warashi_agent import cli
from warashi_agent.timebase import ManualClock, ManualScheduler

DEVICE_DIR = Path(__file__).resolve().parent.parent


# ============================================================================================
# Helpers
# ============================================================================================


def manual_factories(*, calls: list[str] | None = None) -> entry.Factories:
    """The ``--fake`` adapters on a ManualScheduler; each factory call is noted in ``calls``."""
    scheduler = ManualScheduler(ManualClock(1000.0))
    base = entry.fake_factories()
    log = calls if calls is not None else []

    def noting(name, factory):  # type: ignore[no-untyped-def]
        def build(*args):  # type: ignore[no-untyped-def]
            log.append(name)
            return factory(*args)

        return build

    return dataclasses.replace(
        base,
        scheduler=lambda: scheduler,
        cloud=noting("cloud", base.cloud),
        servo=noting("servo", base.servo),
        lantern=noting("lantern", base.lantern),
        pir=noting("pir", base.pir),
        camera=noting("camera", base.camera),
        audio=noting("audio", base.audio),
    )


def run_main(
    argv: list[str], stdin_text: str = "", *, factories: entry.Factories | None = None
) -> tuple[int, str, str]:
    stdout, stderr = io.StringIO(), io.StringIO()
    code = entry.main(
        argv, factories=factories, stdin=io.StringIO(stdin_text), stdout=stdout, stderr=stderr
    )
    return code, stdout.getvalue(), stderr.getvalue()


# ============================================================================================
# Rejected Config (R25.10, R25.11)
# ============================================================================================


def test_rejected_config_exits_2_before_any_factory_is_called(tmp_path: Path) -> None:
    bad = tmp_path / "config.toml"
    bad.write_text('[motion]\nmotion_enabled = "yes"\n', encoding="utf-8")
    calls: list[str] = []

    code, stdout, stderr = run_main(
        ["--config", str(bad), "--fake"], "quit\n", factories=manual_factories(calls=calls)
    )

    assert code == entry.EXIT_CONFIG_REJECTED == 2
    assert calls == []
    assert "config.toml rejected" in stderr
    assert "motion" in stderr
    assert stdout == ""


def test_missing_config_is_rejected_without_fake_and_names_the_path(tmp_path: Path) -> None:
    missing = tmp_path / "missing.toml"
    calls: list[str] = []

    code, _, stderr = run_main(["--config", str(missing)], factories=manual_factories(calls=calls))

    assert code == 2
    assert calls == []
    assert str(missing) in stderr


# ============================================================================================
# --fake keyboard flow (R27.1 to R27.4, R27.11)
# ============================================================================================


def test_fake_keyboard_flow_prints_actions_and_envelopes_and_exits_0(tmp_path: Path) -> None:
    config = ["--config", str(tmp_path / "missing.toml"), "--fake"]

    code, stdout, stderr = run_main(config, "p\noffline\nquit\n", factories=manual_factories())

    assert code == 0
    action_lines = [line for line in stdout.splitlines() if line.startswith("action ")]
    publish_lines = [line for line in stdout.splitlines() if line.startswith("publish ")]
    # pir_warmup_s is 0 under --fake, so the first rising edge starts an Encounter at once.
    assert any("LanternFade" in line for line in action_lines)
    assert any("GazeTarget" in line for line in action_lines)
    assert any("presence.detected" in line for line in publish_lines)
    assert any("state.changed" in line for line in publish_lines)
    # Logging goes to stderr under --fake, never into the printed Action lines.
    assert "action " not in stderr


def test_end_of_input_shuts_down_like_quit(tmp_path: Path) -> None:
    config = ["--config", str(tmp_path / "missing.toml"), "--fake"]

    code, stdout, _ = run_main(config, "p\n", factories=manual_factories())

    assert code == 0
    assert "LanternFade" in stdout


def test_unknown_input_prints_help_and_posts_nothing(tmp_path: Path) -> None:
    config = ["--config", str(tmp_path / "missing.toml"), "--fake"]

    code, stdout, _ = run_main(config, "xyzzy\n\nhelp\nquit\n", factories=manual_factories())

    assert code == 0
    assert stdout.count(cli.HELP_TEXT) == 3  # unknown word, empty line, ``help``
    assert "action " not in stdout


def test_verdict_before_any_snapshot_prints_no_snapshot_is_pending(tmp_path: Path) -> None:
    config = ["--config", str(tmp_path / "missing.toml"), "--fake"]

    code, stdout, _ = run_main(
        config, "family\nstranger 0.5\nquit\n", factories=manual_factories()
    )

    assert code == 0
    assert stdout.count(cli.NO_SNAPSHOT_TEXT) == 2
    assert "judgement" not in stdout


# ============================================================================================
# Subprocess smoke test (R27.1, R27.3, R27.11)
# ============================================================================================


@pytest.mark.timeout(30)
def test_fake_mode_subprocess_smoke(tmp_path: Path) -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "warashi_agent",
            "--fake",
            "--config",
            str(tmp_path / "missing.toml"),
        ],
        input="p\noffline\nquit\n",
        capture_output=True,
        text=True,
        cwd=DEVICE_DIR,
        timeout=20,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "LanternFade" in result.stdout
    assert "GazeTarget" in result.stdout
    assert "state.changed" in result.stdout


# ============================================================================================
# Cloud link selection (cloud-judgement R23.2)
# ============================================================================================


def _aws_config(*, enabled: bool):  # type: ignore[no-untyped-def]
    from warashi_agent.config import AwsConfig, Config

    return Config(aws=AwsConfig(enabled=enabled, endpoint="example.invalid"))


def _scheduler() -> ManualScheduler:
    return ManualScheduler(ManualClock(0.0))


def test_real_factories_use_local_link_when_aws_is_disabled() -> None:
    from warashi_agent.adapters.cloud import LocalCloudLink

    link = entry.real_factories().cloud(_aws_config(enabled=False), _scheduler())
    assert isinstance(link, LocalCloudLink)


def test_real_factories_use_mqtt_link_when_aws_is_enabled_without_touching_the_network() -> None:
    from warashi_agent.adapters.cloud import MqttCloudLink

    link = entry.real_factories().cloud(_aws_config(enabled=True), _scheduler())
    assert isinstance(link, MqttCloudLink)  # built, not started: no paho import, no connect


def test_fake_factories_use_fake_link_even_when_aws_is_enabled() -> None:
    from warashi_agent.adapters.fakes import FakeCloudLink

    link = entry.fake_factories().cloud(_aws_config(enabled=True), _scheduler())
    assert isinstance(link, FakeCloudLink)
