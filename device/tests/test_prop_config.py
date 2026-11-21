"""Property 11: Config_Loader (device-core-loop design, "Correctness Properties").

`validate_mapping` must accept a config mapping exactly when an independent oracle finds every
rule of R25.2 to R25.8 and R25.14 satisfied. The oracle below is written from the Glossary
table "Configuration keys and defaults" of `requirements.md` and from the text of R25. It
imports nothing from `warashi_agent.config` except the function under test, `ConfigRejected`
and `format_rejection`, so a rule that is wrong in `config.py` cannot be copied into the test.

Readings of the requirements that the oracle encodes:

- Integer keys are exactly the ones R25.14 lists: the pins, `jpeg_max_bytes`,
  `scan_attempts_max` and `dedup_window_size`. Every other numeric key is a "number key": a
  TOML integer or float, never a boolean, and finite (R25.14).
- A known section whose value is not a table cannot hold its keys; the oracle rejects it and
  expects the section name in the message (R25.8, R25.14).
- The R25.3, `nod_deg <= tilt_limit`, `scan_attempts_max <= len(scan_pan_positions_deg)` and
  distinct-pin rules are evaluated whenever their keys have the right type. When one breaks,
  every key it uses counts as violating, because R25.9 names every key involved.
- The R25.7 rules are evaluated only when none of their keys broke an earlier rule (R25.7).
  An infinite Sweep_Time (a subnormal `glide_step_deg`) breaks the rule instead of raising.
- A valid `[aws]` table does not change the verdict on the other sections (R21.7, R23.5).

The test then checks that an accepted mapping fills every missing key with its Glossary default
(R25.1), that a rejection message names every key the oracle found violating (R25.9), and that
no word listed under `[privacy]` ever appears in that message (R25.9, R13.1).
"""

# Feature: device-core-loop, Property 11: Config_Loader

from __future__ import annotations

import math
import re
import string
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from hypothesis import event, example, given, settings
from hypothesis import strategies as st

from tests.strategies import as_mapping, valid_configs
from warashi_agent.config import ConfigRejected, format_rejection, validate_mapping

TOLERANCE = 1e-9
INF = math.inf

# ---------------------------------------------------------------------------------------------
# Oracle: the Glossary table, transcribed
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Rule:
    """One Glossary row: TOML kind, default and the single-key allowed range.

    `lo` / `hi` bound the value; `lo_open` makes the lower bound strict (`0 < value`).
    `None` means unbounded on that side. Cross-key bounds are in `oracle()`.
    """

    kind: str  # id | int | number | bool | path | card | number_list | str_list
    default: object
    lo: float | None = None
    hi: float | None = None
    lo_open: bool = False


def _pos(default: float, hi: float | None = None) -> Rule:
    """`0 < value` (and `<= hi`): the "> 0" rows and every `*_s` / `*_ms` key of R25.4."""
    return Rule("number", default, 0, hi, lo_open=True)


GLOSSARY: dict[str, Rule] = {
    "device.id": Rule("id", "warashi-01"),
    "pins.pir_pin": Rule("int", 17, 2, 27),
    "pins.pan_pin": Rule("int", 18, 2, 27),
    "pins.tilt_pin": Rule("int", 13, 2, 27),
    "pins.lantern_pin": Rule("int", 23, 2, 27),
    "motion.motion_enabled": Rule("bool", False),
    "servo.pan_center_offset": Rule("number", 0),
    "servo.tilt_center_offset": Rule("number", 0),
    "servo.pan_limit": _pos(30, 60),
    "servo.tilt_limit": _pos(20, 30),
    "servo.pan_invert": Rule("bool", False),
    "servo.tilt_invert": Rule("bool", False),
    "servo.glide_step_deg": _pos(2, 2),
    "servo.glide_interval_ms": Rule("number", 30, 30, 1000),
    "servo.servo_settle_ms": _pos(300, 2000),
    "servo.nod_deg": _pos(8),  # upper bound tilt_limit: cross-key rule
    "servo.pose_file": Rule("path", "last_pose.json"),
    "lantern.lantern_wake_level": _pos(0.8, 1),
    "lantern.lantern_fade_in_ms": _pos(1500, 10000),
    "lantern.lantern_fade_out_ms": _pos(2000, 10000),
    "camera.camera_hfov_deg": _pos(54, 180),
    "camera.camera_vfov_deg": _pos(41.8, 180),
    "camera.jpeg_max_bytes": Rule("int", 90000, 10000, 90000),
    "camera.scan_pan_positions_deg": Rule("number_list", (-15.0, 15.0, 0.0)),
    "camera.scan_attempts_max": Rule("int", 3, 0),  # upper bound: cross-key rule
    "judgement.family_confidence_min": _pos(0.80, 1),
    "judgement.stranger_confidence_min": _pos(0.80, 1),
    "timing.tick_interval_ms": Rule("number", 100, 10, 1000),
    "timing.pir_warmup_s": Rule("number", 60, 0, 120),
    "timing.waking_timeout_s": _pos(3),
    "timing.verdict_timeout_s": _pos(8),
    "timing.glide_timeout_s": _pos(3),
    "timing.stare_s": _pos(2),
    "timing.audio_timeout_s": _pos(12),
    "timing.camera_timeout_s": _pos(5),
    "timing.download_timeout_s": _pos(5),
    "timing.probe_timeout_s": _pos(5),
    "timing.cooldown_s": _pos(20),
    "timing.status_interval_s": _pos(60),
    "audio.audio_device": Rule("card", "plughw:CARD=Device,DEV=0"),
    "messages.dedup_window_size": Rule("int", 256, 16, 4096),
    "privacy.blocked_words": Rule("str_list", ()),
}

SECTIONS: dict[str, tuple[str, ...]] = {}
for _name in GLOSSARY:
    _section, _key = _name.split(".")
    SECTIONS.setdefault(_section, ())
    SECTIONS[_section] += (_key,)

NUMERIC = ("int", "number")
PIN_KEYS = ("pins.pir_pin", "pins.pan_pin", "pins.tilt_pin", "pins.lantern_pin")
SWEEP_KEYS = (
    "servo.pan_limit",
    "servo.tilt_limit",
    "servo.glide_step_deg",
    "servo.glide_interval_ms",
)
DEVICE_ID = re.compile(r"[a-z0-9-]{1,64}")


def _is_number(v: object) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool)


def _is_finite_number(v: object) -> bool:
    return _is_number(v) and math.isfinite(float(v))  # type: ignore[arg-type]


def _type_ok(kind: str, v: object) -> bool:
    """R25.14: the TOML type of a value, before any range rule."""
    match kind:
        case "id":
            return isinstance(v, str)
        case "int":
            return isinstance(v, int) and not isinstance(v, bool)
        case "number":
            return _is_finite_number(v)
        case "bool":
            return isinstance(v, bool)
        case "path":
            return isinstance(v, str) and v != ""
        case "card":
            if not isinstance(v, str):
                return False
            first = v.find("CARD=")
            return first >= 0 and first + len("CARD=") < len(v)
        case "number_list":
            return isinstance(v, list) and all(_is_finite_number(x) for x in v)
        case "str_list":
            return isinstance(v, list) and all(isinstance(x, str) for x in v)
    raise AssertionError(kind)


def _range_ok(rule: Rule, v: Any) -> bool:
    """The single-key "Allowed values" of the Glossary (R25.2, R25.4 to R25.6)."""
    if rule.kind == "id":
        return DEVICE_ID.fullmatch(v) is not None
    if rule.kind == "str_list":
        return all(w != "" for w in v)
    if rule.kind not in ("int", "number"):
        return True
    x = float(v)
    if rule.lo is not None and (x <= rule.lo if rule.lo_open else x < rule.lo):
        return False
    return rule.hi is None or x <= rule.hi


def _sweep_time_s(v: Mapping[str, Any]) -> float:
    """Glossary Sweep_Time; infinite when the step count overflows."""
    q = 2 * max(v["servo.pan_limit"], v["servo.tilt_limit"]) / v["servo.glide_step_deg"]
    if not math.isfinite(q):
        return INF
    return math.ceil(q) * v["servo.glide_interval_ms"] / 1000


def _tick_s(v: Mapping[str, Any]) -> float:
    return v["timing.tick_interval_ms"] / 1000


# (keys, holds): R25.3 and the cross-key "Allowed values" of the Glossary.
RANGE_CROSS_RULES: tuple[tuple[tuple[str, ...], Callable[[Mapping[str, Any]], bool]], ...] = (
    (
        ("servo.pan_center_offset", "servo.pan_limit"),
        lambda v: abs(v["servo.pan_center_offset"]) + v["servo.pan_limit"] <= 90,
    ),
    (
        ("servo.tilt_center_offset", "servo.tilt_limit"),
        lambda v: abs(v["servo.tilt_center_offset"]) + v["servo.tilt_limit"] <= 90,
    ),
    (("servo.nod_deg", "servo.tilt_limit"), lambda v: v["servo.nod_deg"] <= v["servo.tilt_limit"]),
    (
        ("camera.scan_attempts_max", "camera.scan_pan_positions_deg"),
        lambda v: v["camera.scan_attempts_max"] <= len(v["camera.scan_pan_positions_deg"]),
    ),
)

# (keys, holds): R25.7.
TIMING_RULES: tuple[tuple[tuple[str, ...], Callable[[Mapping[str, Any]], bool]], ...] = (
    (
        ("timing.waking_timeout_s", "lantern.lantern_fade_in_ms"),
        lambda v: v["timing.waking_timeout_s"] >= v["lantern.lantern_fade_in_ms"] / 1000,
    ),
    (
        ("timing.waking_timeout_s", *SWEEP_KEYS),
        lambda v: v["timing.waking_timeout_s"] >= _sweep_time_s(v),
    ),
    (
        ("timing.glide_timeout_s", *SWEEP_KEYS, "timing.tick_interval_ms"),
        lambda v: v["timing.glide_timeout_s"] >= _sweep_time_s(v) + 2 * _tick_s(v),
    ),
    (
        ("timing.cooldown_s", "timing.glide_timeout_s", "lantern.lantern_fade_out_ms"),
        lambda v: (
            v["timing.cooldown_s"]
            >= v["timing.glide_timeout_s"] + v["lantern.lantern_fade_out_ms"] / 1000
        ),
    ),
    (
        ("timing.camera_timeout_s", "timing.verdict_timeout_s"),
        lambda v: v["timing.camera_timeout_s"] < v["timing.verdict_timeout_s"],
    ),
)


def _stored(kind: str, v: object) -> object:
    """The value the oracle expects in the Config for a raw TOML value."""
    if kind == "number":
        return float(v)  # type: ignore[arg-type]
    if kind in ("number_list", "str_list"):
        return tuple(float(x) if kind == "number_list" else x for x in v)  # type: ignore[attr-defined]
    return v


@dataclass(frozen=True)
class Verdict:
    accepted: bool
    named: frozenset[str]  # every name a rejection message must contain


def oracle(mapping: Mapping[str, object]) -> Verdict:
    """Accept exactly when every rule of R25.2 to R25.8 and R25.14 holds."""
    named: set[str] = set()
    broken = False
    failed: set[str] = set()
    values: dict[str, object] = {}  # name -> stored value of every key of the right type

    # R25.8: sections and keys.
    for section, body in mapping.items():
        if section == "aws":
            continue
        if section not in SECTIONS:
            broken = True
            named.add(section)
            continue
        if not isinstance(body, Mapping):
            broken = True
            named.add(section)
            failed.update(f"{section}.{k}" for k in SECTIONS[section])
            continue
        for key in body:
            if key not in SECTIONS[section]:
                broken = True
                named.add(f"{section}.{key}")

    # R25.14 types, then the single-key ranges.
    for name, rule in GLOSSARY.items():
        if name in failed:
            continue
        section, key = name.split(".")
        body = mapping.get(section)
        if not isinstance(body, Mapping) or key not in body:
            values[name] = _stored(rule.kind, rule.default)
            continue
        raw = body[key]
        if not _type_ok(rule.kind, raw):
            broken = True
            named.add(name)
            failed.add(name)
            continue
        values[name] = _stored(rule.kind, raw)
        if not _range_ok(rule, raw):
            broken = True
            named.add(name)
            failed.add(name)

    # Cross-key allowed values, R25.3 and distinct pins (R25.6).
    involved: set[str] = set()
    for keys, holds in RANGE_CROSS_RULES:
        if all(k in values for k in keys) and not holds(values):
            broken = True
            involved.update(keys)
    pins = [k for k in PIN_KEYS if k in values]
    for k in pins:
        if any(values[j] == values[k] for j in pins if j != k):
            broken = True
            involved.add(k)
    named |= involved
    failed |= involved

    # R25.7, only on keys that passed every earlier rule.
    for keys, holds in TIMING_RULES:
        if any(k in failed or k not in values for k in keys):
            continue
        if not holds(values):
            broken = True
            named.update(keys)

    return Verdict(accepted=not broken, named=frozenset(named))


# ---------------------------------------------------------------------------------------------
# Generators
# ---------------------------------------------------------------------------------------------

MARKER_PREFIX = "ZQXJ"
markers = st.text(string.ascii_letters + string.digits, min_size=8, max_size=12).map(
    lambda s: MARKER_PREFIX + s
)
safe_text = st.text(max_size=20).filter(lambda s: MARKER_PREFIX not in s)
NAME_ALPHABET = string.ascii_lowercase + string.digits + "_"
INT64 = st.integers(-(2**63), 2**63 - 1)

scalar_toml = st.one_of(
    st.booleans(),
    INT64,
    st.floats(),  # includes nan and +-inf, which TOML allows
    safe_text,
)
any_toml = st.one_of(
    scalar_toml,
    st.lists(scalar_toml, max_size=3),
    st.dictionaries(st.text(NAME_ALPHABET, min_size=1, max_size=6), scalar_toml, max_size=2),
)


def _edges(x: float) -> list[float]:
    return [x, math.nextafter(x, -INF), math.nextafter(x, INF)]


def values_for(name: str) -> st.SearchStrategy[object]:
    """Interesting values for one key: boundaries, near misses and wrong types."""
    rule = GLOSSARY[name]
    match rule.kind:
        case "int":
            lo = int(rule.lo) if rule.lo is not None else 0
            hi = int(rule.hi) if rule.hi is not None else 10
            return st.one_of(
                st.sampled_from([lo, hi, lo - 1, hi + 1, 0, -1]),
                st.integers(lo - 3, hi + 3),
                INT64,
                st.sampled_from([float(lo), float(hi), True, False, str(lo), [lo]]),
            )
        case "number":
            edges = [0.0, -0.0, 5e-324, 1e-9, 1.0, 1e308, -1e308]
            for bound in (rule.lo, rule.hi):
                if bound is not None:
                    edges += _edges(float(bound))
            return st.one_of(
                st.sampled_from(edges),
                st.floats(-1e4, 1e4),
                st.integers(-20000, 20000),
                st.sampled_from([math.nan, INF, -INF, True, False, "1", [1.0]]),
            )
        case "bool":
            return st.one_of(st.booleans(), st.sampled_from([0, 1, "true", 1.0]))
        case "id":
            return st.one_of(
                st.text(string.ascii_lowercase + string.digits + "-", min_size=0, max_size=66),
                st.sampled_from(["", "a" * 64, "a" * 65, "Warashi-01", "doll_1", "x\n"]),
                safe_text,
                st.just(7),
            )
        case "path":
            return st.one_of(safe_text, st.sampled_from(["", "pose.json", 1, ["a"]]))
        case "card":
            return st.one_of(
                st.sampled_from(
                    [
                        "plughw:CARD=Device,DEV=0",
                        "CARD=x",
                        "CARD=",
                        "hw:0,0",
                        "",
                        "plughw:CARD=",
                        "xCARD=\n",
                        3,
                    ]
                ),
                safe_text,
            )
        case "number_list":
            return st.one_of(
                st.lists(st.floats(-1e3, 1e3), max_size=5),
                st.lists(st.integers(-90, 90), max_size=5),
                st.lists(st.one_of(st.floats(), st.booleans(), safe_text), min_size=1, max_size=3),
                st.sampled_from([0.0, "[-15, 15]", True]),
            )
    raise AssertionError(name)


@dataclass
class Case:
    """A generated mapping plus every marker string placed under `[privacy]`."""

    mapping: dict[str, object]
    markers: list[str]

    def __repr__(self) -> str:  # Hypothesis prints this for a counterexample
        return f"Case(mapping={self.mapping!r}, markers={self.markers!r})"


def _table(case: Case, section: str) -> dict[str, object] | None:
    """The section as a mutable table, created when absent; None for a non-table section."""
    body = case.mapping.setdefault(section, {})
    return body if isinstance(body, dict) else None


def _current(case: Case, name: str) -> float | None:
    """The value a key will have (given or default), when it is a finite number."""
    section, key = name.split(".")
    body = case.mapping.get(section)
    if not isinstance(body, dict):
        return None
    v = body.get(key, GLOSSARY[name].default)
    return float(v) if _is_finite_number(v) else None


def _set(case: Case, name: str, value: object) -> None:
    section, key = name.split(".")
    body = _table(case, section)
    if body is not None:
        body[key] = value


def _nudge(draw: st.DrawFn, x: float) -> float:
    return draw(st.sampled_from(_edges(x)))


Mutation = Callable[[st.DrawFn, Case], None]


def drop_key(draw: st.DrawFn, case: Case) -> None:
    name = draw(st.sampled_from(sorted(GLOSSARY)))
    section, key = name.split(".")
    body = case.mapping.get(section)
    if isinstance(body, dict):
        body.pop(key, None)


def drop_section(draw: st.DrawFn, case: Case) -> None:
    case.mapping.pop(draw(st.sampled_from(sorted(SECTIONS))), None)


def set_interesting(draw: st.DrawFn, case: Case) -> None:
    name = draw(st.sampled_from(sorted(k for k in GLOSSARY if k != "privacy.blocked_words")))
    _set(case, name, draw(values_for(name)))


def set_any(draw: st.DrawFn, case: Case) -> None:
    name = draw(st.sampled_from(sorted(k for k in GLOSSARY if k != "privacy.blocked_words")))
    _set(case, name, draw(any_toml))


def swap_number_spelling(draw: st.DrawFn, case: Case) -> None:
    """Write a number as `30.0` instead of `30`, or the reverse, as a TOML author might."""
    name = draw(st.sampled_from(sorted(k for k in GLOSSARY if GLOSSARY[k].kind in NUMERIC)))
    section, key = name.split(".")
    body = case.mapping.get(section)
    if not isinstance(body, dict):
        return
    v = body.get(key, GLOSSARY[name].default)
    if isinstance(v, bool) or not isinstance(v, int | float):
        return
    if isinstance(v, int):
        body[key] = float(v)
    elif math.isfinite(v) and v == int(v):
        body[key] = int(v)


def duplicate_pin(draw: st.DrawFn, case: Case) -> None:
    a, b = draw(st.lists(st.sampled_from(PIN_KEYS), min_size=2, max_size=2, unique=True))
    value = _current(case, a)
    if value is not None:
        _set(case, b, int(value))


def cross_boundary(draw: st.DrawFn, case: Case) -> None:
    """Put one cross-key rule exactly on, or one ulp either side of, its boundary."""
    which = draw(
        st.sampled_from(
            ["waking_fade", "waking_sweep", "glide", "cooldown", "camera"]
            + ["pan_offset", "tilt_offset", "nod", "scan"]
        )
    )
    get = {name: _current(case, name) for name in GLOSSARY if GLOSSARY[name].kind == "number"}
    sweep_inputs = {k: get[k] for k in SWEEP_KEYS}
    sweep = (
        _sweep_time_s(sweep_inputs)  # type: ignore[arg-type]
        if None not in sweep_inputs.values() and sweep_inputs["servo.glide_step_deg"] != 0
        else None
    )
    match which:
        case "waking_fade" if get["lantern.lantern_fade_in_ms"] is not None:
            target = get["lantern.lantern_fade_in_ms"] / 1000
            _set(case, "timing.waking_timeout_s", _nudge(draw, target))
        case "waking_sweep" if sweep is not None and math.isfinite(sweep):
            _set(case, "timing.waking_timeout_s", _nudge(draw, sweep))
        case "glide" if (
            sweep is not None and math.isfinite(sweep) and get["timing.tick_interval_ms"]
        ):
            target = sweep + 2 * (get["timing.tick_interval_ms"] / 1000)
            _set(case, "timing.glide_timeout_s", _nudge(draw, target))
        case "cooldown" if (
            get["timing.glide_timeout_s"] is not None
            and get["lantern.lantern_fade_out_ms"] is not None
        ):
            target = get["timing.glide_timeout_s"] + get["lantern.lantern_fade_out_ms"] / 1000
            _set(case, "timing.cooldown_s", _nudge(draw, target))
        case "camera" if get["timing.verdict_timeout_s"] is not None:
            _set(case, "timing.camera_timeout_s", _nudge(draw, get["timing.verdict_timeout_s"]))
        case "pan_offset" | "tilt_offset":
            axis = which.removesuffix("_offset")
            limit = get[f"servo.{axis}_limit"]
            if limit is not None:
                sign = draw(st.sampled_from([1.0, -1.0]))
                _set(case, f"servo.{axis}_center_offset", sign * _nudge(draw, 90 - limit))
        case "nod" if get["servo.tilt_limit"] is not None:
            _set(case, "servo.nod_deg", _nudge(draw, get["servo.tilt_limit"]))
        case "scan":
            body = case.mapping.get("camera")
            if isinstance(body, dict):
                positions = body.get("scan_pan_positions_deg", [-15, 15, 0])
                if isinstance(positions, list):
                    body["scan_attempts_max"] = len(positions) + draw(st.sampled_from([0, 1]))
        case _:
            pass


def unknown_key(draw: st.DrawFn, case: Case) -> None:
    section = draw(st.sampled_from(sorted(SECTIONS)))
    key = draw(st.text(NAME_ALPHABET, min_size=1, max_size=12))
    if key not in SECTIONS[section]:
        body = _table(case, section)
        if body is not None:
            body[key] = draw(any_toml)


def unknown_section(draw: st.DrawFn, case: Case) -> None:
    section = draw(st.text(NAME_ALPHABET, min_size=1, max_size=12))
    if section not in SECTIONS and section != "aws":
        case.mapping[section] = draw(any_toml)


def aws_section(draw: st.DrawFn, case: Case) -> None:
    """A valid `[aws]` table; the oracle ignores it, `test_config.py` covers its own rules."""
    case.mapping["aws"] = {"enabled": False, "port": draw(st.integers(1, 65535))}


def non_table_section(draw: st.DrawFn, case: Case) -> None:
    section = draw(st.sampled_from(sorted(s for s in SECTIONS if s != "privacy")))
    case.mapping[section] = draw(st.one_of(scalar_toml, st.lists(scalar_toml, max_size=2)))


def privacy_variant(draw: st.DrawFn, case: Case) -> None:
    """Hide markers in every corner of `[privacy]`, valid or not."""
    extra = draw(st.lists(markers, min_size=1, max_size=3, unique=True))
    case.markers += extra
    choice = draw(st.sampled_from(["invalid_entry", "unknown_key", "not_a_table", "not_a_list"]))
    match choice:
        case "invalid_entry":
            bad = draw(st.sampled_from(["", 5, True, 1.5, ["x"]]))
            case.mapping["privacy"] = {"blocked_words": [*extra, bad]}
        case "unknown_key":
            body = _table(case, "privacy")
            if body is not None:
                body["blocked_word"] = extra
                body["names"] = extra[0]
        case "not_a_table":
            case.mapping["privacy"] = extra
        case "not_a_list":
            case.mapping["privacy"] = {"blocked_words": extra[0]}


MUTATIONS: tuple[Mutation, ...] = (
    drop_key,
    drop_section,
    set_interesting,
    set_interesting,
    set_any,
    swap_number_spelling,
    swap_number_spelling,
    duplicate_pin,
    cross_boundary,
    cross_boundary,
    unknown_key,
    unknown_section,
    aws_section,
    non_table_section,
    privacy_variant,
)


@st.composite
def config_cases(draw: st.DrawFn) -> Case:
    """A valid mapping from `valid_configs()`, then zero to five mutations."""
    mapping: dict[str, object] = dict(as_mapping(draw(valid_configs())))
    words = draw(st.lists(markers, max_size=3, unique=True))
    mapping["privacy"] = {"blocked_words": list(words)}
    case = Case(mapping=mapping, markers=list(words))
    for _ in range(draw(st.integers(0, 5))):
        draw(st.sampled_from(MUTATIONS))(draw, case)
    return case


# ---------------------------------------------------------------------------------------------
# The property
# ---------------------------------------------------------------------------------------------


def _mentions(message: str, name: str) -> bool:
    """`name` appears in the message as a whole `section.key` token."""
    return re.search(rf"(?<![\w.]){re.escape(name)}(?![\w])", message) is not None


def _same(expected: object, actual: object, kind: str) -> bool:
    if kind == "number":
        return math.isclose(float(actual), expected, rel_tol=0, abs_tol=TOLERANCE)  # type: ignore[arg-type]
    if kind == "number_list":
        return len(actual) == len(expected) and all(  # type: ignore[arg-type]
            math.isclose(a, e, rel_tol=0, abs_tol=TOLERANCE)
            for a, e in zip(actual, expected, strict=True)  # type: ignore[call-overload]
        )
    if kind == "bool":
        return actual is expected
    return type(actual) is type(expected) and actual == expected


@settings(deadline=None)
@given(case=config_cases())
@example(case=Case(mapping={}, markers=[]))
@example(case=Case(mapping={"aws": {"endpoint": "x", "port": 8883}}, markers=[]))
# R25.14 lists jpeg_max_bytes among the integer keys, so `50000.0` is the wrong TOML type even
# though its value is in range: the oracle rejects it and the message must name the key.
# test_float_jpeg_max_bytes_is_a_type_violation pins the same case as a plain example.
@example(case=Case(mapping={"camera": {"jpeg_max_bytes": 50000.0}}, markers=[]))
def test_validate_mapping_matches_the_glossary_oracle(case: Case) -> None:
    """**Validates: Requirements 21.7, 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.8, 25.9,
    25.14, 29.13**"""
    expected = oracle(case.mapping)
    result = validate_mapping(case.mapping)
    event("accepted" if expected.accepted else "rejected")

    assert (not isinstance(result, ConfigRejected)) == expected.accepted, (
        f"oracle {'accepts' if expected.accepted else 'rejects'} "
        f"(violating: {sorted(expected.named)}), validate_mapping returned {result!r}"
    )

    if isinstance(result, ConfigRejected):
        message = format_rejection(result)
        missing = sorted(n for n in expected.named if not _mentions(message, n))
        assert not missing, f"rejection message does not name {missing}:\n{message}"
        leaked = [m for m in case.markers if m in message]
        assert not leaked, f"rejection message shows a [privacy] word:\n{message}"
        return

    # R25.1: every key equals its given value, or its Glossary default when missing.
    for name, rule in GLOSSARY.items():
        section, key = name.split(".")
        body = case.mapping.get(section, {})
        assert isinstance(body, dict)
        want = _stored(rule.kind, body.get(key, rule.default))
        got = getattr(getattr(result, section), key)
        assert _same(want, got, rule.kind), f"{name}: expected {want!r}, got {got!r}"
    if "aws" not in case.mapping:
        assert result.aws.enabled is False  # `[aws]` is off unless the file turns it on


def test_float_jpeg_max_bytes_is_a_type_violation() -> None:
    """`jpeg_max_bytes = 50000.0` is in range but not a TOML integer (R25.14), so it is rejected
    as a type violation that names `camera.jpeg_max_bytes` and nothing else.

    **Validates: Requirements 25.9, 25.14**"""
    mapping = {"camera": {"jpeg_max_bytes": 50000.0}}
    assert not _type_ok(GLOSSARY["camera.jpeg_max_bytes"].kind, 50000.0)
    assert oracle(mapping) == Verdict(accepted=False, named=frozenset({"camera.jpeg_max_bytes"}))

    result = validate_mapping(mapping)
    assert isinstance(result, ConfigRejected)
    assert [v.key for v in result.violations] == ["camera.jpeg_max_bytes"]
    assert result.violations[0].allowed.startswith("integer")
    assert _mentions(format_rejection(result), "camera.jpeg_max_bytes")
