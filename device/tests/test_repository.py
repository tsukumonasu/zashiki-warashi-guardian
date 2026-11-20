"""Checks on the files committed to the repository (task 28.4; R26.2, R26.7, R26.8, R25.12).

These read the real Voice_Manifest and the real .gitignore, so a bad edit to either fails
here instead of on the doll.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from warashi_agent.model import Category
from warashi_agent.voice import load_manifest

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST = REPO_ROOT / "device" / "warashi_agent" / "voice" / "lines.toml"


def test_repository_manifest_has_no_rejected_line_and_enough_lines_per_category() -> None:
    # The WAV files are generated and git-ignored, so the WAV_File_Check is off (R26.7).
    result = load_manifest(MANIFEST, blocked_words=(), wav_check=False)
    assert result.problems == ()
    for category in Category:
        count = sum(1 for line in result.available if line.category is category)
        assert count >= 3, f"{category.value} has only {count} lines"


def _git_check_ignore(relative_path: str) -> bool:
    """Return True when git ignores `relative_path` (the file need not exist)."""
    if shutil.which("git") is None:
        pytest.skip("git is not available")
    probe = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "check-ignore", "-q", "--no-index", relative_path],
        capture_output=True,
        check=False,
    )
    if probe.returncode not in (0, 1):
        pytest.skip(f"git check-ignore failed: {probe.stderr.decode(errors='replace')[:200]}")
    return probe.returncode == 0


@pytest.mark.parametrize(
    "path",
    [
        "config.toml",
        "device/config.toml",
        "last_pose.json",
        "device/last_pose.json",
        "device/warashi_agent/voice/family_01.wav",
    ],
)
def test_gitignore_covers_local_files(path: str) -> None:
    assert _git_check_ignore(path), f"{path} must be git-ignored"


@pytest.mark.parametrize(
    "path",
    [
        "device/config.example.toml",
        "device/warashi_agent/voice/lines.toml",
        ".kiro/steering/tech.md",
        ".kiro/specs/device-core-loop/tasks.md",
    ],
)
def test_gitignore_keeps_committed_files_tracked(path: str) -> None:
    assert not _git_check_ignore(path), f"{path} must not be git-ignored"
