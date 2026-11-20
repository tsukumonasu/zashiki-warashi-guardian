"""Tests for ``scripts/deploy_pi.sh`` and the systemd unit template (R28).

The script runs under ``bash`` with stub ``rsync`` and ``ssh`` programs first on
``PATH``. The stubs append one tab-separated line per call to a log file and exit
with a code scripted through environment variables, so nothing touches the network.
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "deploy_pi.sh"
UNIT = REPO / "device" / "systemd" / "warashi-agent.service"

BASH = shutil.which("bash")
needs_bash = pytest.mark.skipif(BASH is None, reason="bash is not available on this machine")

# One stub body for both programs. Environment variables script the behavior:
#   STUB_LOG          log file (one line per call: index, program, arguments)
#   STUB_FAIL_<NAME>  fail with code 23 on the call whose index equals the value
#   STUB_USER         output of `ssh <host> id -un`
#   STUB_WORKDIR      output of `ssh <host> "cd ... && pwd"`
STUB = r"""#!/bin/bash
name="$(basename "$0")"
n=$(( $(wc -l < "$STUB_LOG" 2>/dev/null || echo 0) + 1 ))
line="$n	$name"
for a in "$@"; do line="$line	$a"; done
printf '%s\n' "$line" >> "$STUB_LOG"
failvar="STUB_FAIL_$(echo "$name" | tr a-z A-Z)"
if [ "${!failvar:-}" = "$n" ]; then
    exit 23
fi
if [ "$name" = "ssh" ]; then
    case "${2:-}" in
        id) echo "${STUB_USER-pi}" ;;
        "cd "*) echo "${STUB_WORKDIR-/home/pi/warashi/device}" ;;
    esac
fi
exit 0
"""


def _read_log(log: Path) -> list[list[str]]:
    if not log.exists():
        return []
    return [line.split("\t") for line in log.read_text().splitlines()]


@pytest.fixture
def sandbox(tmp_path: Path) -> dict:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name in ("rsync", "ssh"):
        path = bin_dir / name
        path.write_text(STUB)
        path.chmod(0o755)
    log = tmp_path / "calls.log"
    return {"bin": bin_dir, "log": log}


def _run(sandbox: dict, **env: str) -> subprocess.CompletedProcess[str]:
    full_env = {
        "PATH": f"{sandbox['bin']}{os.pathsep}/usr/bin{os.pathsep}/bin",
        "STUB_LOG": str(sandbox["log"]),
        "HOME": str(sandbox["log"].parent),
    }
    full_env.update(env)
    assert BASH is not None
    return subprocess.run(
        [BASH, str(SCRIPT)],
        env=full_env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def test_script_is_executable_bash_with_strict_mode() -> None:
    mode = SCRIPT.stat().st_mode
    assert mode & stat.S_IXUSR and mode & stat.S_IXGRP and mode & stat.S_IXOTH
    text = SCRIPT.read_text()
    assert text.startswith("#!/usr/bin/env bash")
    assert "set -euo pipefail" in text


@needs_bash
def test_pi_host_unset_exits_1_and_calls_nothing(sandbox: dict) -> None:
    result = _run(sandbox)
    assert result.returncode == 1
    assert "PI_HOST" in result.stderr
    assert _read_log(sandbox["log"]) == []


@needs_bash
def test_full_run_order_excludes_and_default_pi_dir(sandbox: dict) -> None:
    result = _run(sandbox, PI_HOST="user@host.example")
    assert result.returncode == 0, result.stderr
    calls = _read_log(sandbox["log"])
    assert [c[1] for c in calls] == ["rsync", "ssh", "ssh", "ssh", "ssh"]
    assert [c[0] for c in calls] == ["1", "2", "3", "4", "5"]

    rsync = calls[0][2:]
    assert rsync[0] == "-a"
    assert "--rsync-path=mkdir -p 'warashi/device' && rsync" in rsync
    for pattern in (
        "config.toml",
        ".venv",
        "__pycache__",
        ".pytest_cache",
        ".ruff_cache",
        "*.egg-info",
        "last_pose.json",
    ):
        assert f"--exclude={pattern}" in rsync
    assert not any(a.startswith("--delete") or a == "--mkpath" for a in rsync)
    assert rsync[-1] == "user@host.example:warashi/device/"
    assert rsync[-2].endswith("/device/")

    assert calls[1][2:] == ["user@host.example", "id", "-un"]
    assert calls[2][3] == "cd 'warashi/device' && pwd"
    install = calls[3][3]
    assert "sudo tee /etc/systemd/system/warashi-agent.service" in install
    assert "sudo systemctl daemon-reload" in install
    assert "sudo systemctl enable warashi-agent" in install
    assert calls[4][2:] == ["user@host.example", "sudo", "systemctl", "restart", "warashi-agent"]


@needs_bash
def test_custom_pi_dir_with_tilde_prefix_is_made_relative(sandbox: dict) -> None:
    result = _run(sandbox, PI_HOST="h", PI_DIR="~/other/dir/")
    assert result.returncode == 0, result.stderr
    assert _read_log(sandbox["log"])[0][-1] == "h:other/dir/"


@needs_bash
@pytest.mark.parametrize("bad", ["-rf", "a/../b", "a b", "a;b", "$(x)", "a'b", ""])
def test_unsafe_pi_dir_is_rejected_before_any_call(sandbox: dict, bad: str) -> None:
    result = _run(sandbox, PI_HOST="h", PI_DIR=bad)
    if bad == "":
        # An empty PI_DIR falls back to the default.
        assert result.returncode == 0
        return
    assert result.returncode != 0
    assert "step 'PI_DIR' failed" in result.stderr
    assert _read_log(sandbox["log"]) == []


@needs_bash
def test_root_user_is_refused_and_nothing_is_installed(sandbox: dict) -> None:
    result = _run(sandbox, PI_HOST="h", STUB_USER="root")
    assert result.returncode == 1
    assert "step 'user query' failed" in result.stderr
    calls = _read_log(sandbox["log"])
    assert [c[1] for c in calls] == ["rsync", "ssh"]
    assert not any("tee" in " ".join(c) or "restart" in " ".join(c) for c in calls)


@needs_bash
@pytest.mark.parametrize("bad_user", ["Bad User", "1abc", "a;b", ""])
def test_unexpected_user_name_is_refused(sandbox: dict, bad_user: str) -> None:
    result = _run(sandbox, PI_HOST="h", STUB_USER=bad_user)
    assert result.returncode != 0
    assert "step 'user query' failed" in result.stderr
    assert len(_read_log(sandbox["log"])) == 2


@needs_bash
@pytest.mark.parametrize("bad_dir", ["relative/path", "/a b", "/a;b", ""])
def test_unexpected_working_directory_is_refused(sandbox: dict, bad_dir: str) -> None:
    result = _run(sandbox, PI_HOST="h", STUB_WORKDIR=bad_dir)
    assert result.returncode != 0
    assert "step 'unit installation' failed" in result.stderr
    assert len(_read_log(sandbox["log"])) == 3


@needs_bash
@pytest.mark.parametrize(
    ("failing", "call_index", "step", "calls_made"),
    [
        ("RSYNC", 1, "copy", 1),
        ("SSH", 2, "user query", 2),
        ("SSH", 3, "unit installation", 3),
        ("SSH", 4, "unit installation", 4),
        ("SSH", 5, "restart", 5),
    ],
)
def test_failing_step_stops_later_steps(
    sandbox: dict, failing: str, call_index: int, step: str, calls_made: int
) -> None:
    result = _run(sandbox, PI_HOST="h", **{f"STUB_FAIL_{failing}": str(call_index)})
    assert result.returncode != 0
    assert f"deploy_pi: step '{step}' failed:" in result.stderr
    assert "done" not in result.stdout
    assert len(_read_log(sandbox["log"])) == calls_made


@needs_bash
def test_installed_unit_has_workdir_and_user_filled_in(sandbox: dict, tmp_path: Path) -> None:
    result = _run(sandbox, PI_HOST="h", STUB_USER="warashi", STUB_WORKDIR="/home/warashi/w/device")
    assert result.returncode == 0, result.stderr
    install = _read_log(sandbox["log"])[3][3]
    # Run only the sed part locally, on the template, in place of the remote file.
    sed_part = install.split(" | sudo tee ", 1)[0]
    remote_file = "'warashi/device/systemd/warashi-agent.service'"
    assert sed_part.endswith(remote_file)
    command = sed_part[: -len(remote_file)] + f"'{UNIT}'"
    rendered = subprocess.run(
        [BASH or "bash", "-c", command], capture_output=True, text=True, check=True, timeout=30
    ).stdout
    assert "WorkingDirectory=/home/warashi/w/device\n" in rendered
    assert "User=warashi\n" in rendered
    assert "@" not in rendered


# ---- unit template ----------------------------------------------------------------


def _unit_lines() -> list[str]:
    return UNIT.read_text().splitlines()


def test_unit_has_required_keys_and_placeholders() -> None:
    lines = _unit_lines()
    for expected in (
        "ExecStart=/usr/bin/python3 -m warashi_agent",
        "Restart=on-failure",
        "RestartSec=5",
        "RestartPreventExitStatus=2",
        "KillSignal=SIGTERM",
        "TimeoutStopSec=5",
        "SupplementaryGroups=gpio video audio",
        "StandardOutput=journal",
        "StandardError=journal",
        "User=@USER@",
        "WorkingDirectory=@WORKDIR@",
    ):
        assert expected in lines


def test_unit_substitution_leaves_no_placeholder() -> None:
    text = UNIT.read_text()
    # The header comment names the placeholders; only non-comment lines matter.
    body = "\n".join(line for line in text.splitlines() if not line.startswith("#"))
    rendered = body.replace("@WORKDIR@", "/home/pi/warashi/device").replace("@USER@", "pi")
    assert "@" not in rendered
    assert "pi" in rendered


def test_unit_contains_no_private_values() -> None:
    text = UNIT.read_text()
    forbidden = [
        r"\b\d{1,3}(\.\d{1,3}){3}\b",  # IPv4 address
        r"\.local\b",  # mDNS host name
        r"[\w.+-]+@[\w-]+\.[\w.-]+",  # user@host
        r"/home/\w+",  # a concrete home directory
        r"-----BEGIN",  # PEM block
        r"\.(pem|crt|key)\b",  # certificate files
        r"arn:aws",  # account identifiers
    ]
    for pattern in forbidden:
        assert re.search(pattern, text) is None, pattern
    # Only the two documented placeholders exist.
    assert set(re.findall(r"@[A-Z]+@", text)) == {"@USER@", "@WORKDIR@"}
