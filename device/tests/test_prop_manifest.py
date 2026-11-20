"""Property 12: Manifest_Loader (design "Correctness Properties", R29.14).

``load_manifest(..., wav_check=False)`` must reject a Voice_Line exactly when at least one rule
of R26.3, R26.4, R26.9 or R13.1 is broken, keep the first line of a repeated ``id``, return the
kept lines sorted by ``id`` as the Available_Lines (R26.10), and name each rejected line only by
its ``id`` (or ``#<position>``) and the broken rule, never by its text or the blocked word that
matched (R13.1, R26.5).

The oracle below is written from the requirements, not imported from ``voice.py``. Two points
the requirements leave open follow the documented loader decisions:

- A later line whose ``id`` string equals the ``id`` of any earlier table entry is a repeat and
  is rejected, even when the earlier entry was itself rejected for another reason ("keep the
  first line in file order and reject each later one", R26.9).
- "Latin letter" means an ASCII letter or a full-width letter (U+FF21-U+FF3A, U+FF41-U+FF5A),
  as the parenthesis in R26.3 says. Other Latin-script letters such as ``À`` are allowed.

Generated manifests are written as TOML by a small writer in this file (``tomllib`` only
reads). Each example checks that ``tomllib`` parses the written document back to the generated
entries, so the writer cannot hide a generator mistake.

Privacy markers: every ASCII blocked word starts with ``zqxj`` and every ``en`` text carries
``wkpv`` (in some letter case). Neither prefix occurs in ``voice.py`` or in the generated ids,
so finding one in a problem or a log line means text or a blocked word leaked.
"""

# Feature: device-core-loop, Property 12: Manifest_Loader

from __future__ import annotations

import logging
import string
import tempfile
import tomllib
from pathlib import Path

from hypothesis import example, given, settings
from hypothesis import strategies as st

from warashi_agent.model import Category
from warashi_agent.voice import load_manifest

# --------------------------------------------------------------------------------------------
# Oracle, written from R26.1, R26.3, R26.4, R26.9 and R13.1
# --------------------------------------------------------------------------------------------

REQUIRED_FIELDS = ("id", "category", "ja", "en", "wav")
ID_CHARS = frozenset(string.ascii_lowercase + string.digits + "_")
CATEGORIES = frozenset({"family", "stranger", "uncertain"})
JA_MAX_CODE_POINTS = 40
JA_SENTENCE_MARKS = "。？！?!"
JA_MAX_SENTENCE_MARKS = 2
EN_MAX_CHARACTERS = 120

PRIVACY_MARKERS = ("zqxj", "wkpv")  # compared after casefold()


def _is_valid_id(value: object) -> bool:
    """R26.1: ``[a-z0-9_]+``, the whole string."""
    return isinstance(value, str) and len(value) > 0 and all(ch in ID_CHARS for ch in value)


def _is_latin_letter(ch: str) -> bool:
    """R26.3: an ASCII letter or a full-width Latin letter."""
    o = ord(ch)
    return ch in string.ascii_letters or 0xFF21 <= o <= 0xFF3A or 0xFF41 <= o <= 0xFF5A


def _is_emoji(ch: str) -> bool:
    """R26.3: a code point in U+1F000-U+1FAFF, U+2600-U+27BF or U+FE0F."""
    o = ord(ch)
    return 0x1F000 <= o <= 0x1FAFF or 0x2600 <= o <= 0x27BF or o == 0xFE0F


def broken_rules(entry: object, earlier_ids: set[str], folded_words: tuple[str, ...]) -> list[str]:
    """Every rule the entry breaks. The line is rejected exactly when the list is not empty."""
    if not isinstance(entry, dict):
        return ["not a table"]
    broken: list[str] = []
    for name in REQUIRED_FIELDS:
        if name not in entry:
            broken.append(f"{name} missing")
        elif not isinstance(entry[name], str):
            broken.append(f"{name} not a string")
    line_id = entry.get("id")
    if isinstance(line_id, str):
        if not _is_valid_id(line_id):
            broken.append("id pattern")
        if line_id in earlier_ids:
            broken.append("id repeated")
    category = entry.get("category")
    if isinstance(category, str) and category not in CATEGORIES:
        broken.append("category")
    wav = entry.get("wav")
    if isinstance(wav, str) and (not wav.endswith(".wav") or "/" in wav or "\\" in wav):
        broken.append("wav")
    ja = entry.get("ja")
    if isinstance(ja, str):
        if len(ja) == 0:
            broken.append("ja empty")
        if len(ja) > JA_MAX_CODE_POINTS:
            broken.append("ja too long")
        if sum(ch in JA_SENTENCE_MARKS for ch in ja) > JA_MAX_SENTENCE_MARKS:
            broken.append("ja sentence marks")
        if any(_is_latin_letter(ch) for ch in ja):
            broken.append("ja latin letter")
        if any(_is_emoji(ch) for ch in ja):
            broken.append("ja emoji")
    en = entry.get("en")
    if isinstance(en, str):
        if len(en) == 0:
            broken.append("en empty")
        if len(en) > EN_MAX_CHARACTERS:
            broken.append("en too long")
    texts = [t.casefold() for t in (ja, en) if isinstance(t, str)]
    if any(word in text for word in folded_words for text in texts):
        broken.append("blocked word")
    return broken


def expected_outcome(
    entries: list[object], blocked_words: tuple[str, ...]
) -> tuple[list[str], list[tuple[str, str, str, str, str]]]:
    """The expected problem refs in file order and the kept lines in file order."""
    folded_words = tuple(w.casefold() for w in blocked_words if w)
    earlier_ids: set[str] = set()
    refs: list[str] = []
    kept: list[tuple[str, str, str, str, str]] = []
    for position, entry in enumerate(entries, start=1):
        broken = broken_rules(entry, earlier_ids, folded_words)
        if isinstance(entry, dict) and isinstance(entry.get("id"), str):
            earlier_ids.add(entry["id"])
        if broken:
            usable_id = isinstance(entry, dict) and _is_valid_id(entry.get("id"))
            refs.append(entry["id"] if usable_id else f"#{position}")
        else:
            kept.append(tuple(entry[name] for name in REQUIRED_FIELDS))
    return refs, kept


# --------------------------------------------------------------------------------------------
# TOML writer (basic strings, inline tables, arrays)
# --------------------------------------------------------------------------------------------


def toml_string(text: str) -> str:
    """A TOML basic string. Quote, backslash and control characters other than tab are
    escaped; every other code point is written as itself (the file is UTF-8)."""
    out = ['"']
    for ch in text:
        o = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif (o < 0x20 and ch != "\t") or o == 0x7F:
            out.append(f"\\u{o:04X}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def toml_value(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)  # finite values only
    if isinstance(value, str):
        return toml_string(value)
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ", ".join(f"{k} = {toml_value(v)}" for k, v in value.items()) + "}"
    raise TypeError(f"no TOML form for {type(value).__name__}")


def manifest_document(entries: list[object]) -> str:
    """``lines = [ ... ]`` with one entry per line. A TOML 1.0 array may mix tables and other
    values, which lets the test place non-table entries at any position."""
    if not entries:
        return "lines = []\n"
    return "lines = [\n" + ",\n".join(toml_value(e) for e in entries) + "\n]\n"


# --------------------------------------------------------------------------------------------
# Generators
# --------------------------------------------------------------------------------------------

KANA = "あいうえおかきくけこさしすせそたちつてとなにのはまやよらりるれろわをん、ー…　"
EN_FILLER = "abcdefghilmnortuy .,'?!-"  # no letter of the privacy markers

JA_MARK_SAMPLES = list(JA_SENTENCE_MARKS)
LATIN_SAMPLES = ["a", "Z", "Ａ", "Ｚ", "ａ", "ｚ", "wkpv", "ＷＫＰＶ"]
EMOJI_SAMPLES = ["\U0001f000", "\U0001f600", "\U0001faff", "\u2600", "\u2764", "\u27bf", "\ufe0f"]
# Characters just outside the R26.3 classes: full-width neighbours of the letter blocks,
# neighbours of the emoji ranges, digits, a non-ASCII Latin-1 letter and other punctuation.
JA_NEAR_MISS = [
    "＠", "［", "｀", "｛", "１", "1", "À", "．", "、",
    "\U0001efff", "\U0001fb00", "\u25ff", "\u27c0", "\ufe0e",
]  # fmt: skip

VALID_IDS = ["a", "a1", "a_1", "b", "line_2", "_", "0"]
INVALID_IDS = ["", "A", "a-b", "a b", "é", "Ａ", "line\n", "a.b"]
INVALID_CATEGORIES = ["Family", "", "strangers", "uncertain ", "no_face"]
VALID_WAVS = ["a.wav", "greeting_family.wav", "x.y.wav", "ゑ.wav"]
INVALID_WAVS = ["a.WAV", "a.mp3", "", "dir/a.wav", "dir\\a.wav", "a.wav ", "/a.wav"]
# Any code point of each R26.3 class, one branch per range so that every range is drawn often.
any_emoji = st.one_of(
    st.integers(0x1F000, 0x1FAFF), st.integers(0x2600, 0x27BF), st.just(0xFE0F)
).map(chr)
any_latin_letter = st.one_of(
    st.sampled_from(string.ascii_letters),
    st.integers(0xFF21, 0xFF3A).map(chr),
    st.integers(0xFF41, 0xFF5A).map(chr),
)
NON_STRINGS = st.sampled_from([0, 7, -1, True, False, 1.5, [], ["a"], {}])
NON_TABLES = st.sampled_from([0, "line", True, ["a"], 2.5, []])

ascii_blocked_words = st.builds(
    lambda body, sharp: "zqxj" + body + ("ß" if sharp else ""),
    st.text(alphabet="abs", max_size=3),
    st.booleans(),
)
kana_blocked_words = st.builds(lambda body: "ゑゐ" + body, st.text(alphabet="ぬゑ", max_size=2))
blocked_word_lists = st.lists(st.one_of(ascii_blocked_words, kana_blocked_words), max_size=3)


@st.composite
def injected_words(draw: st.DrawFn, blocked: tuple[str, ...], near_miss: bool = True) -> str:
    """A blocked word as it may appear in a text: the same, in another case, with ``ß`` and
    ``ss`` swapped (both casefold to ``ss``), or, with ``near_miss``, cut short by one
    character."""
    word = draw(st.sampled_from(blocked))
    variants = ["same", "upper", "swap", "sharp_ss", "ss_sharp"] + (["cut"] if near_miss else [])
    variant = draw(st.sampled_from(variants))
    if variant == "upper":
        return word.upper()
    if variant == "swap":
        return word.swapcase()
    if variant == "sharp_ss":
        return word.replace("ß", draw(st.sampled_from(["ss", "SS", "sS"])))
    if variant == "ss_sharp":
        return word.replace("ss", "ß")
    if variant == "cut":
        return word[:-1]
    return word


def _insert_all(draw: st.DrawFn, base: str, extras: list[str]) -> str:
    """Insert each extra string, whole, at a drawn position of the growing text."""
    text = base
    for extra in extras:
        pos = draw(st.integers(0, len(text)))
        text = text[:pos] + extra + text[pos:]
    return text


@st.composite
def ja_texts(
    draw: st.DrawFn, blocked: tuple[str, ...], wild: bool, forced: tuple[str, ...] = ()
) -> str:
    """A ``ja`` text. ``wild`` texts may break any R26.3 or R13.1 rule; the others keep at most
    two marks, no Latin letter, no emoji, no blocked word and 1 to 40 code points, apart from
    the ``forced`` strings inserted on top (used for single-fault lines)."""
    if wild and draw(st.integers(0, 9)) == 0:
        return ""
    marks = draw(st.integers(0, 4 if wild else JA_MAX_SENTENCE_MARKS))
    extras = list(forced) + [draw(st.sampled_from(JA_MARK_SAMPLES)) for _ in range(marks)]
    extras += draw(st.lists(st.sampled_from(JA_NEAR_MISS), max_size=2))
    if wild:
        if draw(st.integers(0, 3)) == 0:
            extras.append(draw(st.sampled_from(LATIN_SAMPLES)))
        if draw(st.integers(0, 3)) == 0:
            extras.append(draw(st.sampled_from(EMOJI_SAMPLES)))
    if blocked and wild and draw(st.integers(0, 2)) == 0:
        extras.append(draw(injected_words(blocked)))
    used = sum(len(e) for e in extras)
    if wild:
        target = draw(st.one_of(st.integers(0, 42), st.sampled_from([39, 40, 41])))
    else:
        target = draw(st.one_of(st.integers(max(1, used), 40), st.just(40)))
    pad = max(0, target - used)
    base = draw(st.text(alphabet=KANA, min_size=pad, max_size=pad))
    return _insert_all(draw, base, extras)


@st.composite
def en_texts(
    draw: st.DrawFn,
    blocked: tuple[str, ...],
    wild: bool,
    forced: tuple[str, ...] = (),
    too_long: bool = False,
) -> str:
    """An ``en`` text that carries the ``wkpv`` marker. ``wild`` texts may be empty, longer
    than 120 characters or contain a blocked word. ``forced`` strings are inserted on top and
    ``too_long`` makes the text 121 to 124 characters (used for single-fault lines)."""
    if wild and draw(st.integers(0, 9)) == 0:
        return ""
    extras = [draw(st.sampled_from(["wkpv", "Wkpv", "WKPV"])), *forced]
    if draw(st.booleans()):
        extras.append(draw(st.sampled_from(["ß", "é", "ゑ", "…"])))
    if blocked and wild and draw(st.integers(0, 2)) == 0:
        extras.append(draw(injected_words(blocked)))
    used = sum(len(e) for e in extras)
    if too_long:
        target = EN_MAX_CHARACTERS + 1  # the boundary; wild lines cover longer texts
    elif wild:
        target = draw(st.one_of(st.integers(0, 122), st.sampled_from([119, 120, 121])))
    else:
        target = draw(st.one_of(st.integers(used, 120), st.just(120)))
    pad = max(0, target - used)
    base = draw(st.text(alphabet=EN_FILLER, min_size=pad, max_size=pad))
    return _insert_all(draw, base, extras)


# The text rules have more boundaries (lengths, character classes), so they are drawn more often.
SINGLE_FAULTS = (
    [f"missing:{name}" for name in REQUIRED_FIELDS]
    + [f"not_a_string:{name}" for name in REQUIRED_FIELDS]
    + ["id"] * 4
    + ["category", "wav", "wav"]
    + ["ja_empty", "ja_long", "ja_marks", "ja_latin", "ja_emoji", "ja_blocked"] * 4
    + ["en_empty", "en_long", "en_blocked"] * 4
)


@st.composite
def single_fault_entry(draw: st.DrawFn, blocked: tuple[str, ...]) -> dict[str, object]:
    """A clean line with exactly one rule broken, so that a loader that skips any single rule
    keeps a line the oracle rejects."""
    entry = draw(clean_entry(blocked))
    fault = draw(st.sampled_from(SINGLE_FAULTS))
    kind, _, name = fault.partition(":")
    kana_words = tuple(w for w in blocked if w.startswith("ゑゐ"))
    if kind == "missing":
        del entry[name]
    elif kind == "not_a_string":
        entry[name] = draw(NON_STRINGS)
    elif fault == "id":
        entry["id"] = draw(st.sampled_from(INVALID_IDS))
    elif fault == "category":
        entry["category"] = draw(st.sampled_from(INVALID_CATEGORIES))
    elif fault == "wav":
        entry["wav"] = draw(st.sampled_from(INVALID_WAVS))
    elif fault == "ja_empty":
        entry["ja"] = ""
    elif fault == "ja_long":
        size = JA_MAX_CODE_POINTS + 1  # the boundary; wild lines cover longer texts
        entry["ja"] = draw(st.text(alphabet=KANA, min_size=size, max_size=size))
    elif fault == "ja_marks":
        marks = tuple(draw(st.lists(st.sampled_from(JA_MARK_SAMPLES), min_size=3, max_size=3)))
        entry["ja"] = draw(ja_texts(blocked, wild=False, forced=marks))
    elif fault == "ja_latin":
        letter = draw(any_latin_letter)
        entry["ja"] = draw(ja_texts(blocked, wild=False, forced=(letter,)))
    elif fault == "ja_emoji":
        emoji = draw(any_emoji)
        entry["ja"] = draw(ja_texts(blocked, wild=False, forced=(emoji,)))
    elif fault == "ja_blocked" and kana_words:
        word = draw(injected_words(kana_words, near_miss=False))
        entry["ja"] = draw(ja_texts(blocked, wild=False, forced=(word,)))
    elif fault in ("ja_blocked", "en_blocked") and blocked:
        word = draw(injected_words(blocked, near_miss=False))
        entry["en"] = draw(en_texts(blocked, wild=False, forced=(word,)))
    elif fault in ("ja_blocked", "en_blocked", "en_empty"):
        entry["en"] = ""
    elif fault == "en_long":
        entry["en"] = draw(en_texts(blocked, wild=False, too_long=True))
    return entry


@st.composite
def clean_entry(draw: st.DrawFn, blocked: tuple[str, ...]) -> dict[str, object]:
    """Every field present and inside its rule; only a repeated id can reject it."""
    return {
        "id": draw(st.sampled_from(VALID_IDS)),
        "category": draw(st.sampled_from(sorted(CATEGORIES))),
        "ja": draw(ja_texts(blocked, wild=False)),
        "en": draw(en_texts(blocked, wild=False)),
        "wav": draw(st.sampled_from(VALID_WAVS)),
    }


@st.composite
def entries(draw: st.DrawFn, blocked: tuple[str, ...]) -> object:
    """One element of the ``lines`` array.

    Table entries come in three flavors. "Clean" lines keep every rule, so only a repeated id
    can reject them. "Single-fault" lines break exactly one rule, so every rule must reject on
    its own. "Wild" lines may miss fields, have wrong types or break several rules at once.
    The oracle decides in every case; the flavors only control the mix.
    """
    if draw(st.integers(0, 15)) == 0:
        return draw(NON_TABLES)
    flavor = draw(st.sampled_from(["clean", "single_fault", "single_fault", "wild"]))
    if flavor == "clean":
        entry = draw(clean_entry(blocked))
    elif flavor == "single_fault":
        entry = draw(single_fault_entry(blocked))
    else:
        entry = draw(wild_entry(blocked))
    if draw(st.integers(0, 4)) == 0:
        entry["note"] = draw(st.text(alphabet="abc", max_size=3))  # undefined field: ignored
    return entry


@st.composite
def wild_entry(draw: st.DrawFn, blocked: tuple[str, ...]) -> dict[str, object]:
    """Any field may be missing, of the wrong type or broken, several at once."""
    values = {
        "id": st.sampled_from(VALID_IDS + INVALID_IDS),
        "category": st.sampled_from(sorted(CATEGORIES) + INVALID_CATEGORIES),
        "ja": ja_texts(blocked, wild=True),
        "en": en_texts(blocked, wild=True),
        "wav": st.sampled_from(VALID_WAVS + INVALID_WAVS),
    }
    modes = st.sampled_from(["value"] * 8 + ["missing", "not_a_string"])
    entry: dict[str, object] = {}
    for name, strategy in values.items():
        mode = draw(modes)
        if mode == "missing":
            continue
        entry[name] = draw(NON_STRINGS) if mode == "not_a_string" else draw(strategy)
    return entry


@st.composite
def manifests(draw: st.DrawFn) -> tuple[tuple[str, ...], list[object]]:
    blocked = tuple(draw(blocked_word_lists))
    return blocked, draw(st.lists(entries(blocked), max_size=10))


class _ListHandler(logging.Handler):
    """Collects the formatted messages of one example (Hypothesis forbids ``caplog``)."""

    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())


# --------------------------------------------------------------------------------------------
# Property
# --------------------------------------------------------------------------------------------


def _line(line_id: object, **fields: object) -> dict[str, object]:
    """A clean line with some fields replaced, for the explicit boundary example."""
    line: dict[str, object] = {
        "id": line_id,
        "category": "family",
        "ja": "おかえり。",
        "en": "wkpv welcome home.",
        "wav": "a.wav",
    }
    line.update(fields)
    return line


# One line per rule boundary, so every run checks them whatever Hypothesis draws. The oracle
# decides these lines like any generated ones.
BOUNDARY_BLOCKED = ("zqxjß", "ゑゐ")
BOUNDARY_LINES: list[object] = [
    _line("a", ja="あ" * 38 + "。？", en="wkpv" + "a" * 116),  # kept: 40 cp, 2 marks, 120
    _line("b", ja="あ" * 41),  # ja one code point too long
    _line("line_2", ja="あ。い？う！"),  # three sentence marks
    _line("a1", ja="あＡ"),  # full-width capital
    _line("c1", ja="あｚ"),  # full-width small
    _line("a_1", ja="あ\U0001f600"),  # astral emoji
    _line("_", ja="あ\ufe0f"),  # variation selector
    _line("c2", ja="あ\u2600"),  # miscellaneous symbol
    _line("0", en="wkpv" + "a" * 117),  # en one character too long
    _line("a.b"),  # id outside [a-z0-9_]+
    _line("c3", en="wkpv ZQXJSS"),  # blocked word after casefold (ß and SS)
    _line("c4", ja="あゑゐ"),  # blocked kana word in ja
    _line("c5", ja="＠［｀｛À\U0001efff\U0001fb00\u25ff\u27c0\ufe0e"),  # kept: near misses
    _line("c6", wav="a.WAV"),  # wav does not end in .wav
    _line("a"),  # repeated id
    3,  # not a table
]


@settings(deadline=None)  # each example writes and reads a temporary file
@given(case=manifests())
@example(case=(BOUNDARY_BLOCKED, BOUNDARY_LINES))
@example(case=((), []))
def test_manifest_loader_rejects_exactly_the_broken_lines(
    case: tuple[tuple[str, ...], list[object]],
) -> None:
    blocked, generated = case
    document = manifest_document(generated)
    assert tomllib.loads(document) == {"lines": generated}, "TOML writer mismatch"

    logger = logging.getLogger("warashi_agent.voice")
    handler = _ListHandler()
    logger.addHandler(handler)
    try:
        with tempfile.TemporaryDirectory(prefix="warashi-manifest-") as tmp:
            path = Path(tmp) / "lines.toml"
            path.write_text(document, encoding="utf-8")
            result = load_manifest(path, blocked_words=blocked, wav_check=False)
    finally:
        logger.removeHandler(handler)

    expected_refs, expected_kept = expected_outcome(generated, blocked)

    # Rejected exactly when the oracle finds a broken rule: one problem per rejected line, in
    # file order, named by its id or #<position> (R26.5, R26.9, R26.3, R26.4, R13.1).
    assert [p.line_ref for p in result.problems] == expected_refs
    for problem in result.problems:
        assert problem.code == "voice_line_invalid"  # no WAV check here (R26.10)
        assert isinstance(problem.rule, str) and problem.rule

    # Available_Lines: the kept lines, first wins for repeated ids, sorted by id (R26.10).
    actual = [(ln.id, ln.category, ln.ja, ln.en, ln.wav) for ln in result.available]
    expected = sorted(expected_kept, key=lambda line: line[0])
    assert actual == [(i, Category(c), ja, en, wav) for i, c, ja, en, wav in expected]
    assert len({ln.id for ln in result.available}) == len(result.available)

    # Privacy: problems and log lines name no line text and no blocked word (R13.1, R26.5).
    texts = [
        value
        for entry in generated
        if isinstance(entry, dict)
        for value in (entry.get("ja"), entry.get("en"))
        if isinstance(value, str) and len(value) >= 4
    ]
    folded_words = [w.casefold() for w in blocked if w]
    reported = [f"{p.line_ref} {p.rule}" for p in result.problems] + handler.messages
    for message in reported:
        folded = message.casefold()
        for marker in PRIVACY_MARKERS:
            assert marker not in folded, f"privacy marker leaked into {message!r}"
        for word in folded_words:
            assert word not in folded, f"blocked word leaked into {message!r}"
        for text in texts:
            assert text not in message, f"line text leaked into {message!r}"
