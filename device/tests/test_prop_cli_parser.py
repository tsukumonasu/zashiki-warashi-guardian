"""Property test for the keyboard parser (Property 22, R27.2, R27.4).

The printer below is written independently of ``cli.py``: it follows the grammar in the design.
"""

from dataclasses import dataclass

from hypothesis import given, settings
from hypothesis import strategies as st

from warashi_agent.cli import (
    ConnectivityKey,
    GazeKey,
    HelpRequest,
    LanternKey,
    ModeKey,
    ParseError,
    PirKey,
    Quit,
    SpeakKey,
    VerdictKey,
    parse_line,
)
from warashi_agent.model import FaceBox, Mode, Verdict

RESULT_TYPES = (
    PirKey,
    VerdictKey,
    SpeakKey,
    GazeKey,
    LanternKey,
    ModeKey,
    ConnectivityKey,
    HelpRequest,
    Quit,
    ParseError,
)

finite = st.floats(allow_nan=False, allow_infinity=False)
# Includes negatives, -0.0, huge and tiny (subnormal) values.
numbers = st.one_of(
    finite,
    st.sampled_from([0.0, -0.0, 1e308, -1e308, 5e-324, -5e-324, 1e-300, 0.5, 1.0]),
)
non_numeric = st.sampled_from(["abc", "x", "--", "1,5", "0x10", "", "--1", "1e", "1__0"])
bad_numbers = st.one_of(
    st.sampled_from(["nan", "inf", "-inf", "1e999", "-1e999", "NaN", "Infinity"]), non_numeric
)
line_ids = st.text(min_size=1, max_size=30).filter(lambda s: not any(c.isspace() for c in s))
whitespace = st.sampled_from([" ", "  ", "\t", " \t ", "\u3000", "\x0b"])


@dataclass(frozen=True)
class Printed:
    """A printed line, its expected result, and which argument positions are numeric."""

    name: str
    args: list[str]
    expected: object
    numeric: list[int]
    optional_arity: bool = False


def _num(x: float) -> str:
    return repr(x)


@st.composite
def printed_commands(draw: st.DrawFn) -> Printed:
    kind = draw(
        st.sampled_from(
            ["pir", "verdict", "bare", "speak", "gaze", "lantern", "mode", "conn", "word"]
        )
    )
    if kind == "pir":
        rising = draw(st.booleans())
        return Printed("p" if rising else "u", [], PirKey(rising=rising), [])
    if kind == "bare":
        name, verdict = draw(
            st.sampled_from([("noface", Verdict.NO_FACE), ("unsure", Verdict.UNCERTAIN)])
        )
        return Printed(name, [], VerdictKey(verdict=verdict, confidence=1.0, face=None), [])
    if kind == "verdict":
        name, verdict = draw(
            st.sampled_from([("family", Verdict.FAMILY), ("stranger", Verdict.STRANGER)])
        )
        arity = draw(st.sampled_from([0, 1, 5]))
        values = [draw(numbers) for _ in range(arity)]
        confidence = values[0] if values else 1.0
        face = (
            FaceBox(left=values[1], top=values[2], width=values[3], height=values[4])
            if arity == 5
            else None
        )
        return Printed(
            name,
            [_num(v) for v in values],
            VerdictKey(verdict=verdict, confidence=confidence, face=face),
            list(range(arity)),
            optional_arity=True,
        )
    if kind == "speak":
        line_id = draw(line_ids)
        return Printed("speak", [line_id], SpeakKey(line_id=line_id), [])
    if kind == "gaze":
        pan, tilt = draw(numbers), draw(numbers)
        return Printed(
            "gaze", [_num(pan), _num(tilt)], GazeKey(pan_deg=pan, tilt_deg=tilt), [0, 1]
        )
    if kind == "lantern":
        level, fade = draw(numbers), draw(st.integers(min_value=-(10**30), max_value=10**30))
        return Printed(
            "lantern", [_num(level), str(fade)], LanternKey(level=level, fade_ms=fade), [0, 1]
        )
    if kind == "mode":
        mode = draw(st.sampled_from([Mode.SLEEP, Mode.GUARD]))
        return Printed("mode", [mode.value], ModeKey(mode=mode), [])
    if kind == "conn":
        online = draw(st.booleans())
        return Printed("online" if online else "offline", [], ConnectivityKey(online=online), [])
    word = draw(st.sampled_from(["help", "quit"]))
    return Printed(word, [], HelpRequest() if word == "help" else Quit(), [])


def _line(name: str, args: list[str]) -> str:
    return " ".join([name, *args])


def _same(actual: object, expected: object) -> bool:
    # Equality ignores the sign of zero, so compare the repr as well.
    return actual == expected and repr(actual) == repr(expected)


# Feature: device-core-loop, Property 22: Keyboard parser
@settings(max_examples=300)
@given(text=st.text(max_size=300))
def test_arbitrary_text_never_raises(text: str) -> None:
    assert isinstance(parse_line(text), RESULT_TYPES)


# Feature: device-core-loop, Property 22: Keyboard parser
@settings(max_examples=200)
@given(
    prefix=st.sampled_from(["", "family ", "gaze ", "lantern ", "stranger ", "gaze 1 ", "speak "]),
    tail=st.one_of(
        st.sampled_from(
            ["1e999", "nan", "inf", "-inf", "0x10", "1_000", "1e-999", "+", "-", ".", "1e", "٣"]
        ),
        st.text(alphabet="0123456789.eE+-_xnaifty \t", max_size=60),
        st.text(st.characters(codec="utf-8"), max_size=40),
    ),
    long_pad=st.sampled_from(["", "9" * 5000, " " * 5000, "1 " * 3000]),
)
def test_hostile_numeric_text_never_raises(prefix: str, tail: str, long_pad: str) -> None:
    assert isinstance(parse_line(prefix + tail + long_pad), RESULT_TYPES)
    assert isinstance(parse_line(prefix + long_pad + tail), RESULT_TYPES)


# Feature: device-core-loop, Property 22: Keyboard parser
@settings(max_examples=300)
@given(item=printed_commands(), lead=whitespace, sep=whitespace, trail=whitespace)
def test_printed_lines_round_trip(item: Printed, lead: str, sep: str, trail: str) -> None:
    plain = parse_line(_line(item.name, item.args))
    assert _same(plain, item.expected)
    spaced = parse_line(lead + sep.join([item.name, *item.args]) + trail)
    assert _same(spaced, item.expected)


# Feature: device-core-loop, Property 22: Keyboard parser
@settings(max_examples=300)
@given(item=printed_commands(), bad=bad_numbers, data=st.data())
def test_one_bad_numeric_argument_is_an_error(
    item: Printed, bad: str, data: st.DataObject
) -> None:
    if not item.numeric:
        return
    index = data.draw(st.sampled_from(item.numeric))
    # An empty token would just vanish from the line, which changes the arity instead.
    token = bad if bad else "abc"
    args = list(item.args)
    args[index] = token
    assert isinstance(parse_line(_line(item.name, args)), ParseError)


# Feature: device-core-loop, Property 22: Keyboard parser
@settings(max_examples=300)
@given(item=printed_commands(), extra=st.sampled_from(["1", "abc", "0.5", "nan"]))
def test_one_extra_argument_is_an_error(item: Printed, extra: str) -> None:
    # Optional-argument verdicts accept 0, 1 or 5 arguments: only 1 -> 2 and 5 -> 6 are invalid.
    if item.optional_arity and len(item.args) == 0:
        return
    assert isinstance(parse_line(_line(item.name, [*item.args, extra])), ParseError)


# Feature: device-core-loop, Property 22: Keyboard parser
@settings(max_examples=300)
@given(item=printed_commands(), data=st.data())
def test_one_missing_argument_is_an_error(item: Printed, data: st.DataObject) -> None:
    if not item.args:
        return
    # Dropping from 1 argument gives 0 and is valid for the optional verdicts.
    if item.optional_arity and len(item.args) == 1:
        return
    index = data.draw(st.integers(min_value=0, max_value=len(item.args) - 1))
    args = item.args[:index] + item.args[index + 1 :]
    assert isinstance(parse_line(_line(item.name, args)), ParseError)


# Feature: device-core-loop, Property 22: Keyboard parser
@settings(max_examples=150)
@given(
    first=numbers,
    fade=st.one_of(st.sampled_from(["1.5", "1e3", "nan", "inf", "0.0"]), st.just("2.")),
)
def test_fade_ms_must_be_an_integer(first: float, fade: str) -> None:
    assert isinstance(parse_line(f"lantern {_num(first)} {fade}"), ParseError)


# Feature: device-core-loop, Property 22: Keyboard parser
@settings(max_examples=150)
@given(
    word=st.sampled_from(["P", "Family", "GAZE", "quit!", "pp", "mode", "sleep", "q", "exit"]),
    rest=st.lists(st.sampled_from(["1", "sleep", "x"]), max_size=3),
)
def test_unknown_words_and_bad_modes_are_errors(word: str, rest: list[str]) -> None:
    if word == "mode" and rest in (["sleep"],):
        return
    assert isinstance(parse_line(_line(word, rest)), ParseError)
