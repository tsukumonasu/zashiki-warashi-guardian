"""Tests for scripts/provision_device.sh (cloud-judgement R21).

The script runs under ``bash`` with stub ``aws``, ``curl`` and ``git`` executables placed first
on ``PATH``. The stubs record their arguments and never touch the network or AWS. The key text
the ``aws`` stub writes is a unique marker, so a leak into any output is detectable.
"""

from __future__ import annotations

import os
import stat
import subprocess
import tomllib
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "provision_device.sh"

KEY_MARKER = "STUB-PRIVATE-KEY-MATERIAL-9f3a"

AWS_STUB = r"""#!/usr/bin/env bash
# Stub aws: records "iot <subcommand> <args...>" and fakes the few calls the script makes.
echo "$*" >> "$STUB_LOG"
sub="$2"
shift 2
if [ "${STUB_FAIL:-}" = "$sub" ]; then
    echo "stub: $sub failed" >&2
    exit 254
fi
case "$sub" in
    describe-thing)
        [ -e "$STUB_STATE/thing" ] || exit 254
        echo thing ;;
    create-thing)
        touch "$STUB_STATE/thing"; echo thing ;;
    create-keys-and-certificate)
        n=$(( $(cat "$STUB_STATE/count" 2>/dev/null || echo 0) + 1 ))
        echo "$n" > "$STUB_STATE/count"
        while [ $# -gt 0 ]; do
            case "$1" in
                --certificate-pem-outfile) printf 'CERT-%s\n' "$n" > "$2"; shift 2 ;;
                --private-key-outfile) printf '%s-%s\n' "$STUB_KEY_MARKER" "$n" > "$2"; shift 2 ;;
                *) shift ;;
            esac
        done
        echo "arn:aws:iot:test-region:acct:cert/cert$n" ;;
    describe-endpoint)
        echo "abc123-ats.iot.test-region.amazonaws.com" ;;
    *) ;;
esac
"""

CURL_STUB = r"""#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
[ -z "${STUB_CURL_FAIL:-}" ] || { echo "stub: curl failed" >&2; exit 22; }
while [ $# -gt 0 ]; do
    if [ "$1" = "--output" ]; then out="$2"; shift 2; else shift; fi
done
if [ -n "${STUB_CURL_BAD:-}" ]; then echo "<html>" > "$out"; else
    printf -- '-----BEGIN CERTIFICATE-----\nSTUBCA\n-----END CERTIFICATE-----\n' > "$out"
fi
"""

# Reports a git work tree for every path below $STUB_GIT_TREE, and logs the call.
GIT_STUB = r"""#!/usr/bin/env bash
echo "git $*" >> "$STUB_LOG"
dir="$2"
case "$dir/" in
    "${STUB_GIT_TREE:-/nonexistent-tree}"/*) echo true ;;
    *) echo false; exit 128 ;;
esac
"""


def _write_exe(path: Path, text: str) -> None:
    path.write_text(text)
    path.chmod(0o755)


@pytest.fixture
def env(tmp_path: Path) -> dict[str, str]:
    """Environment with stubs first on PATH; state and log live in tmp_path."""
    stubs = tmp_path / "stubs"
    stubs.mkdir()
    _write_exe(stubs / "aws", AWS_STUB)
    _write_exe(stubs / "curl", CURL_STUB)
    _write_exe(stubs / "git", GIT_STUB)
    state = tmp_path / "state"
    state.mkdir()
    log = tmp_path / "calls.log"
    log.write_text("")
    e = dict(os.environ)
    e["PATH"] = f"{stubs}{os.pathsep}{e['PATH']}"
    e["STUB_LOG"] = str(log)
    e["STUB_STATE"] = str(state)
    e["STUB_KEY_MARKER"] = KEY_MARKER
    for name in ("STUB_FAIL", "STUB_CURL_FAIL", "STUB_CURL_BAD", "STUB_GIT_TREE"):
        e.pop(name, None)
    return e


def run(
    env: dict[str, str], cwd: Path, *args: str, **extra: str
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        env={**env, **extra},
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def calls(env: dict[str, str]) -> list[str]:
    return [line for line in Path(env["STUB_LOG"]).read_text().splitlines() if line]


def aws_calls(env: dict[str, str]) -> list[str]:
    return [c for c in calls(env) if c.startswith("iot ")]


def subcommands(env: dict[str, str]) -> list[str]:
    return [c.split()[1] for c in aws_calls(env)]


def base_args(out: Path) -> list[str]:
    return ["--thing", "warashi-01", "--out", str(out), "--policy", "WarashiPolicy"]


@pytest.fixture
def out(tmp_path: Path) -> Path:
    return tmp_path.resolve() / "secrets" / "warashi-01"


def test_script_syntax_and_executable() -> None:
    assert subprocess.run(["bash", "-n", str(SCRIPT)], check=False).returncode == 0
    assert os.access(SCRIPT, os.X_OK)


def test_first_run_creates_everything(env: dict[str, str], tmp_path: Path, out: Path) -> None:
    result = run(env, tmp_path, *base_args(out), "--pi-dir", str(out))
    assert result.returncode == 0, result.stderr
    assert subcommands(env) == [
        "describe-thing",
        "create-thing",
        "create-keys-and-certificate",
        "attach-policy",
        "attach-thing-principal",
        "describe-endpoint",
    ]
    arn = "arn:aws:iot:test-region:acct:cert/cert1"
    log = aws_calls(env)
    assert f"--policy-name WarashiPolicy --target {arn}" in log[3]
    assert f"--thing-name warashi-01 --principal {arn}" in log[4]
    assert "--endpoint-type iot:Data-ATS" in log[5]
    assert "--set-as-active" in log[2]


def test_modes_of_directory_and_key(env: dict[str, str], tmp_path: Path, out: Path) -> None:
    assert run(env, tmp_path, *base_args(out)).returncode == 0
    assert stat.S_IMODE(out.stat().st_mode) == 0o700
    assert stat.S_IMODE((out / "device.private.key").stat().st_mode) == 0o600
    assert stat.S_IMODE((out / "device.pem.crt").stat().st_mode) == 0o600


def test_toml_has_nine_keys_and_existing_files(
    env: dict[str, str], tmp_path: Path, out: Path
) -> None:
    assert run(env, tmp_path, *base_args(out), "--pi-dir", str(out)).returncode == 0
    table = tomllib.loads((out / "warashi-aws.toml").read_text())["aws"]
    assert set(table) == {
        "enabled",
        "endpoint",
        "port",
        "ca_file",
        "cert_file",
        "key_file",
        "keepalive_s",
        "reconnect_min_s",
        "reconnect_max_s",
    }
    assert table["port"] == 8883
    assert table["endpoint"] == "abc123-ats.iot.test-region.amazonaws.com"
    for key in ("ca_file", "cert_file", "key_file"):
        assert Path(table[key]).is_file()
    assert KEY_MARKER not in (out / "warashi-aws.toml").read_text()


def test_second_run_creates_nothing_new(env: dict[str, str], tmp_path: Path, out: Path) -> None:
    assert run(env, tmp_path, *base_args(out)).returncode == 0
    files = ("device.private.key", "device.pem.crt", "certificate-arn.txt")
    before = {f: (out / f).read_bytes() for f in files}
    Path(env["STUB_LOG"]).write_text("")

    result = run(env, tmp_path, *base_args(out))

    assert result.returncode == 0, result.stderr
    subs = subcommands(env)
    assert "create-thing" not in subs
    assert "create-keys-and-certificate" not in subs
    assert {"attach-policy", "attach-thing-principal"} <= set(subs)
    assert {f: (out / f).read_bytes() for f in files} == before


def test_out_inside_work_tree_is_refused_without_side_effects(
    env: dict[str, str], tmp_path: Path
) -> None:
    tree = tmp_path.resolve() / "repo"
    tree.mkdir()
    target = tree / "keys"
    result = run(env, tmp_path, *base_args(target), STUB_GIT_TREE=str(tree))
    assert result.returncode != 0
    assert "git work tree" in result.stderr
    assert aws_calls(env) == []
    assert not target.exists()


def test_symlinked_out_into_work_tree_is_refused(env: dict[str, str], tmp_path: Path) -> None:
    tree = tmp_path.resolve() / "repo"
    tree.mkdir()
    link = tmp_path.resolve() / "link"
    link.symlink_to(tree)
    result = run(env, tmp_path, *base_args(link / "keys"), STUB_GIT_TREE=str(tree))
    assert result.returncode != 0
    assert aws_calls(env) == []
    assert list(tree.iterdir()) == []


@pytest.mark.parametrize(
    ("extra", "step"),
    [
        ({"STUB_FAIL": "describe-endpoint"}, "read endpoint"),
        ({"STUB_CURL_FAIL": "1"}, "download Amazon Root CA 1"),
        ({"STUB_CURL_BAD": "1"}, "download Amazon Root CA 1"),
    ],
)
def test_endpoint_or_ca_failure_writes_no_toml(
    env: dict[str, str], tmp_path: Path, out: Path, extra: dict[str, str], step: str
) -> None:
    result = run(env, tmp_path, *base_args(out), **extra)
    assert result.returncode != 0
    assert step in result.stderr
    assert not (out / "warashi-aws.toml").exists()


def _arn_of(out: Path) -> str:
    return (out / "certificate-arn.txt").read_text()


def test_rotation_order_and_files(env: dict[str, str], tmp_path: Path, out: Path) -> None:
    assert run(env, tmp_path, *base_args(out)).returncode == 0
    Path(env["STUB_LOG"]).write_text("")

    result = run(env, tmp_path, *base_args(out), "--rotate")

    assert result.returncode == 0, result.stderr
    old_arn = "arn:aws:iot:test-region:acct:cert/cert1"
    new_arn = "arn:aws:iot:test-region:acct:cert/cert2"
    rotation = [c for c in aws_calls(env) if c.split()[1] != "describe-thing"][:6]
    assert [c.split()[1] for c in rotation] == [
        "create-keys-and-certificate",
        "attach-policy",
        "attach-thing-principal",
        "update-certificate",
        "detach-thing-principal",
        "detach-policy",
    ]
    assert new_arn in rotation[1] and new_arn in rotation[2]
    assert "--certificate-id cert1 --new-status INACTIVE" in rotation[3]
    assert old_arn in rotation[4] and old_arn in rotation[5]
    assert _arn_of(out) == new_arn
    assert (out / "device.private.key").read_text() == f"{KEY_MARKER}-2\n"
    assert stat.S_IMODE((out / "device.private.key").stat().st_mode) == 0o600
    assert not [p for p in out.iterdir() if p.name.startswith(".")]


@pytest.mark.parametrize(
    "failing", ["create-keys-and-certificate", "attach-policy", "attach-thing-principal"]
)
def test_rotation_failure_keeps_old_certificate_active(
    env: dict[str, str], tmp_path: Path, out: Path, failing: str
) -> None:
    assert run(env, tmp_path, *base_args(out)).returncode == 0
    files = ("device.private.key", "device.pem.crt", "certificate-arn.txt")
    before = {f: (out / f).read_bytes() for f in files}
    Path(env["STUB_LOG"]).write_text("")

    result = run(env, tmp_path, *base_args(out), "--rotate", STUB_FAIL=failing)

    assert result.returncode != 0
    assert "rotate" in result.stderr
    old_arn = "arn:aws:iot:test-region:acct:cert/cert1"
    for call in aws_calls(env):
        if call.split()[1] in ("update-certificate", "detach-thing-principal", "detach-policy"):
            assert "cert1" not in call, call
            assert old_arn not in call, call
    assert {f: (out / f).read_bytes() for f in files} == before
    assert not [p for p in out.iterdir() if p.name.startswith(".")]


@pytest.mark.parametrize("missing", ["--thing", "--out", "--policy"])
@pytest.mark.parametrize("empty", [False, True])
def test_missing_or_empty_arguments(
    env: dict[str, str], tmp_path: Path, out: Path, missing: str, empty: bool
) -> None:
    args = base_args(out)
    i = args.index(missing)
    args = args[:i] + ([missing, ""] if empty else []) + args[i + 2 :]

    result = run(env, tmp_path, *args)

    assert result.returncode != 0
    assert "Usage" in result.stderr
    assert aws_calls(env) == []
    assert not out.exists()
    assert not out.parent.exists()


def test_default_region_on_every_aws_call(env: dict[str, str], tmp_path: Path, out: Path) -> None:
    assert run(env, tmp_path, *base_args(out)).returncode == 0
    log = aws_calls(env)
    assert log
    assert all("--region ap-northeast-1" in c for c in log), log


def test_explicit_region_on_every_aws_call(env: dict[str, str], tmp_path: Path, out: Path) -> None:
    assert run(env, tmp_path, *base_args(out), "--region", "us-east-1").returncode == 0
    assert all("--region us-east-1" in c for c in aws_calls(env))


@pytest.mark.parametrize("rotate", [False, True])
def test_no_key_text_in_any_output(
    env: dict[str, str], tmp_path: Path, out: Path, rotate: bool
) -> None:
    results = [run(env, tmp_path, *base_args(out))]
    if rotate:
        results.append(run(env, tmp_path, *base_args(out), "--rotate"))
    results.append(run(env, tmp_path, *base_args(out), STUB_FAIL="describe-endpoint"))
    for result in results:
        assert KEY_MARKER not in result.stdout
        assert KEY_MARKER not in result.stderr
    assert KEY_MARKER not in Path(env["STUB_LOG"]).read_text()
    for path in out.iterdir():
        if path.name != "device.private.key":
            assert KEY_MARKER not in path.read_text()
