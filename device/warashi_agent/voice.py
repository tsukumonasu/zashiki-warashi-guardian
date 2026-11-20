"""Voice_Manifest loader and the line-choice rule (R1.3, R13.1, R26).

The doll's cached lines live in ``voice/lines.toml`` next to this module, each with a WAV file
of the same directory. ``load_manifest`` validates every line and returns the Available_Lines
plus a list of problems. The caller (the agent startup) turns each problem into an
``error.reported`` event; this module logs it.

Privacy: a problem and its log line name only the line ``id`` (or its position) and the
broken rule. They never contain the line text or the blocked word that matched, because the
owner may list family names in ``privacy.blocked_words`` (R13.1). ``VoiceLine`` hides ``ja``
and ``en`` from ``repr()`` for the same reason.

``choose_line`` is pure: the random value comes from the Event, so the State_Machine stays
deterministic (R1.3).
"""

from __future__ import annotations

import logging
import math
import re
import tomllib
import wave
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Literal

from warashi_agent.model import Category

log = logging.getLogger(__name__)

REQUIRED_FIELDS = ("id", "category", "ja", "en", "wav")

ID_PATTERN = re.compile(r"[a-z0-9_]+")
JA_MAX_CODE_POINTS = 40
JA_MAX_SENTENCE_MARKS = 2
JA_SENTENCE_MARKS = frozenset("。？！?!")
# ASCII letters and their full-width forms (U+FF21-U+FF3A, U+FF41-U+FF5A).
LATIN_LETTER = re.compile(r"[A-Za-zＡ-Ｚａ-ｚ]")
# Emoji and pictographs, miscellaneous symbols and dingbats, and the emoji variation selector.
EMOJI = re.compile(r"[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F]")
EN_MAX_CHARACTERS = 120

ProblemCode = Literal["voice_line_invalid", "voice_file_missing"]


@dataclass(frozen=True, kw_only=True)
class VoiceLine:
    """One valid manifest entry. ``ja`` and ``en`` never appear in ``repr()`` (R13.6)."""

    id: str
    category: Category
    ja: str = field(repr=False)
    en: str = field(repr=False)
    wav: str  # file name inside the voice directory, no path separator


@dataclass(frozen=True, kw_only=True)
class ManifestProblem:
    """A rejected line, an excluded WAV file or an unusable manifest.

    ``line_ref`` is the line ``id``, ``#<position>`` (1-based) when the id is missing or
    invalid, or ``manifest`` for a problem with the whole file. ``rule`` names the broken rule
    with a fixed text and never quotes the line text or a blocked word.
    """

    line_ref: str
    rule: str
    code: ProblemCode


@dataclass(frozen=True, kw_only=True)
class ManifestResult:
    """Result of ``load_manifest``."""

    available: tuple[VoiceLine, ...]  # the Available_Lines, sorted by id in code-point order
    problems: tuple[ManifestProblem, ...]  # in file order


def load_manifest(
    path: Path, *, blocked_words: tuple[str, ...], wav_check: bool
) -> ManifestResult:
    """Load and validate the Voice_Manifest at ``path``.

    Each line is checked in a fixed order and rejected at the first broken rule (R26.9,
    R26.3, R26.4, R13.1); loading continues with the next line (R26.5). A repeated ``id``
    keeps the first entry in file order: every later entry with an ``id`` that an earlier
    entry already had is rejected, whatever happened to the earlier one.

    With ``wav_check`` a valid line whose WAV file is missing or not 16-bit PCM mono is left
    out and reported as ``voice_file_missing`` (R26.6). Without it every valid line is
    available (R26.10). A missing, unreadable or invalid manifest gives no lines and one
    ``voice_line_invalid`` problem, so the agent keeps running (R26.11).
    """
    entries, manifest_problem = _read_entries(path)
    if manifest_problem is not None:
        _log_problem(manifest_problem)
        return ManifestResult(available=(), problems=(manifest_problem,))

    folded_words = tuple(w.casefold() for w in blocked_words if w)
    seen_ids: set[str] = set()
    kept: list[VoiceLine] = []
    problems: list[ManifestProblem] = []

    for position, entry in enumerate(entries, start=1):
        line_or_problem = _validate_entry(entry, position, seen_ids, folded_words)
        if isinstance(entry, dict) and isinstance(entry.get("id"), str):
            seen_ids.add(entry["id"])
        if isinstance(line_or_problem, ManifestProblem):
            problems.append(line_or_problem)
            continue
        line = line_or_problem
        if wav_check and not is_pcm16_mono_wav(path.parent / line.wav):
            problems.append(
                ManifestProblem(
                    line_ref=line.id,
                    rule=f"WAV file {line.wav} is missing or not 16-bit PCM mono",
                    code="voice_file_missing",
                )
            )
            continue
        kept.append(line)

    for problem in problems:
        _log_problem(problem)
    available = tuple(sorted(kept, key=lambda line: line.id))
    return ManifestResult(available=available, problems=tuple(problems))


def choose_line(lines: tuple[VoiceLine, ...], category: Category, rand: float) -> VoiceLine | None:
    """Pick the line at ``floor(rand * n)`` among the ``n`` lines of ``category`` (R1.3).

    The pool is sorted by ``id`` in code-point order. The product is computed exactly with
    ``Fraction``, because a floating-point ``rand * n`` can round up to the next integer ``k``
    when ``rand`` lies just below ``k / n`` (for example ``0.3333333333333333 * 3 == 1.0``)
    and would pick the wrong line. ``rand`` is in [0, 1), so the exact product never reaches
    ``n``; ``min(..., n - 1)`` only guards a caller that breaks that contract. Returns
    ``None`` when the Category has no line (R7.7).
    """
    pool = sorted((line for line in lines if line.category is category), key=lambda x: x.id)
    if not pool:
        return None
    n = len(pool)
    return pool[min(math.floor(Fraction(rand) * n), n - 1)]


def is_pcm16_mono_wav(path: Path) -> bool:
    """True when ``path`` is a readable 16-bit PCM mono WAV file (R26.6)."""
    try:
        with wave.open(str(path), "rb") as wav:
            return (
                wav.getsampwidth() == 2 and wav.getnchannels() == 1 and wav.getcomptype() == "NONE"
            )
    except (OSError, EOFError, wave.Error):
        return False


# --------------------------------------------------------------------------------------------
# Internals
# --------------------------------------------------------------------------------------------


def _read_entries(path: Path) -> tuple[list[object], ManifestProblem | None]:
    """Parse the manifest file and return its ``[[lines]]`` entries or one problem."""

    def problem(rule: str) -> tuple[list[object], ManifestProblem]:
        return [], ManifestProblem(line_ref="manifest", rule=rule, code="voice_line_invalid")

    try:
        with path.open("rb") as fp:
            document = tomllib.load(fp)
    except FileNotFoundError:
        return problem("manifest file is missing")
    except OSError:
        return problem("manifest file is unreadable")
    except (tomllib.TOMLDecodeError, UnicodeDecodeError):
        return problem("manifest is not valid TOML")
    entries = document.get("lines")
    if not isinstance(entries, list):
        return problem("manifest has no [[lines]] array")
    return entries, None


def _validate_entry(
    entry: object, position: int, seen_ids: set[str], folded_words: tuple[str, ...]
) -> VoiceLine | ManifestProblem:
    """Apply the per-line rules in order and return the line or the first broken rule."""
    position_ref = f"#{position}"

    def reject(ref: str, rule: str) -> ManifestProblem:
        return ManifestProblem(line_ref=ref, rule=rule, code="voice_line_invalid")

    if not isinstance(entry, dict):
        return reject(position_ref, "entry is not a table")

    # A usable id names the line in the problem; otherwise its position does (R26.5).
    raw_id = entry.get("id")
    id_usable = isinstance(raw_id, str) and ID_PATTERN.fullmatch(raw_id) is not None
    ref = raw_id if id_usable else position_ref

    # R26.9: required fields and string types.
    for name in REQUIRED_FIELDS:
        if name not in entry:
            return reject(ref, f"field {name} is missing")
        if not isinstance(entry[name], str):
            return reject(ref, f"field {name} is not a string")

    line_id: str = entry["id"]
    category: str = entry["category"]
    ja: str = entry["ja"]
    en: str = entry["en"]
    wav_name: str = entry["wav"]

    # R26.1, R26.9: id pattern and first-wins uniqueness.
    if not id_usable:
        return reject(ref, "id does not match [a-z0-9_]+")
    if line_id in seen_ids:
        return reject(ref, "id repeats an earlier line")

    # R26.1, R26.9: category and wav file name.
    if category not in {c.value for c in Category}:
        return reject(ref, "category is not family, stranger or uncertain")
    if not wav_name.endswith(".wav") or "/" in wav_name or "\\" in wav_name:
        return reject(ref, "wav is not a file name ending in .wav without a path separator")

    # R26.3: ja rules, counted in Unicode code points.
    ja_rule = _ja_rule_broken(ja)
    if ja_rule is not None:
        return reject(ref, ja_rule)

    # R26.4: en rules.
    if not en:
        return reject(ref, "en is empty")
    if len(en) > EN_MAX_CHARACTERS:
        return reject(ref, f"en is longer than {EN_MAX_CHARACTERS} characters")

    # R13.1: blocked words, compared after case folding. The word itself is never named.
    folded_ja, folded_en = ja.casefold(), en.casefold()
    if any(word in folded_ja or word in folded_en for word in folded_words):
        return reject(ref, "ja or en contains a blocked word")

    return VoiceLine(id=line_id, category=Category(category), ja=ja, en=en, wav=wav_name)


def _ja_rule_broken(ja: str) -> str | None:
    """Return the first broken R26.3 rule for ``ja``, or ``None`` when it passes."""
    if not ja:
        return "ja is empty"
    if len(ja) > JA_MAX_CODE_POINTS:
        return f"ja is longer than {JA_MAX_CODE_POINTS} characters"
    if sum(ch in JA_SENTENCE_MARKS for ch in ja) > JA_MAX_SENTENCE_MARKS:
        return f"ja has more than {JA_MAX_SENTENCE_MARKS} sentence-ending marks"
    if LATIN_LETTER.search(ja):
        return "ja contains a Latin letter"
    if EMOJI.search(ja):
        return "ja contains an emoji or pictograph"
    return None


def _log_problem(problem: ManifestProblem) -> None:
    """One log line per problem: the reference and the rule, never the text (R13.1, R26.5)."""
    log.warning("voice manifest: %s rejected: %s", problem.line_ref, problem.rule)
