"""Shared Hypothesis strategies for the device-core-loop tests (design "Shared generators").

Import them as `from tests.strategies import valid_configs, rands, uid_counters, as_mapping`
(and `line_sets`).

- `valid_configs()` builds a Config that passes every rule of R25 by construction, so property
  tests never waste examples on rejected configs. Some ranges are narrower than R25 allows.
  These are test budgets, not validity rules: they keep one Encounter short enough to replay
  quickly (see the `*_MAX_*` and `*_MIN_*` constants below).
- `rands()` draws the `rand` value of an Event in [0, 1). The two edges are drawn often.
- `uid_counters()` gives a fresh `UidCounter` per example, so uids are pairwise distinct
  within one example by construction (R29.2).
- `as_mapping(cfg)` turns a Config back into the mapping `tomllib` would return for an
  equivalent config.toml. Task 4.2 uses it to check `valid_configs()` against the
  Config_Loader.
- `line_sets()` draws Available_Lines: valid Voice_Lines with distinct ids, zero to four per
  Category, sorted by id in code-point order (R1.3, R26).

Hypothesis cannot force a strategy to emit a given value in every run. The default Config and
the `rand` edges are the first branch of a `one_of`, which Hypothesis tries early and often.
A test that must see them in every run adds `@example(...)` with `DEFAULT_CONFIG` or
`RAND_EDGES`.
"""

from __future__ import annotations

import dataclasses
import math
import string
import sys
import uuid
from collections.abc import Iterable

from hypothesis import strategies as st

from warashi_agent.config import (
    AudioConfig,
    AwsConfig,
    CameraConfig,
    Config,
    DeviceConfig,
    JudgementConfig,
    LanternConfig,
    MessagesConfig,
    MotionConfig,
    PinsConfig,
    PrivacyConfig,
    ServoConfig,
    TimingConfig,
)
from warashi_agent.model import Category
from warashi_agent.voice import VoiceLine

DEFAULT_CONFIG = Config()

# Test budgets (design: "timing caps as a test budget"). Each is inside the R25 range.
TIMEOUT_MAX_S = 30.0  # every timing value except pir_warmup_s and status_interval_s
STATUS_INTERVAL_MAX_S = 120.0
TIMEOUT_MIN_S = 0.01  # keeps deadlines well above the 1e-9 comparison tolerance
TICK_MIN_MS = 50.0  # R25 allows 10; 50 keeps the Tick count of one Encounter small
SWEEP_MAX_S = 8.0  # largest Sweep_Time, so waking and glide timeouts fit under 30 s
GLIDE_TIMEOUT_MAX_S = 20.0  # leaves room for cooldown_s >= glide + fade_out (<= 10 s)

# 0.0 and the largest float below 1.0 are the edges of floor(rand * n) (R1.3).
RAND_EDGES = (0.0, math.nextafter(1.0, 0.0))

_ID_ALPHABET = string.ascii_lowercase + string.digits + "-"
_NAME_ALPHABET = string.ascii_letters + string.digits + "_"


def _just_above(bound: float) -> float:
    """A value a few ulps above `bound`.

    Lower bounds of the R25.7 cross-key rules are sums of floats. The Config_Loader may add
    the same terms in another order and get a result one or two ulps higher, which would turn
    an exact-boundary draw into a rejection. Eight machine epsilons of margin absorb that and
    still sit on the boundary for every practical purpose. Exact boundaries are tested with
    hand-written examples in test_config.py (task 4.2).
    """
    return bound * (1 + 8 * sys.float_info.epsilon) + sys.float_info.min


def _pos_floats(max_value: float, *, min_value: float = 0.0) -> st.SearchStrategy[float]:
    """Floats in (min_value, max_value]: the "> 0" and "0 < value <= max" rules of R25."""
    return st.floats(
        min_value=min_value,
        max_value=max_value,
        exclude_min=True,
        allow_nan=False,
        allow_infinity=False,
        allow_subnormal=False,
    )


def _closed_floats(min_value: float, max_value: float) -> st.SearchStrategy[float]:
    return st.floats(
        min_value=min_value,
        max_value=max_value,
        allow_nan=False,
        allow_infinity=False,
        allow_subnormal=False,
    )


@st.composite
def _drawn_configs(draw: st.DrawFn, motion_enabled: bool | None) -> Config:
    """Draw a Config that satisfies R25.2 to R25.8 and R25.14 by construction."""
    # Servo geometry first: Sweep_Time depends only on it (Glossary).
    pan_limit = draw(_pos_floats(60.0))
    tilt_limit = draw(_pos_floats(30.0))
    pan_span = 90.0 - pan_limit
    tilt_span = 90.0 - tilt_limit
    widest = max(pan_limit, tilt_limit)
    # ceil(2 * widest / step) <= 265 steps keeps Sweep_Time <= SWEEP_MAX_S at 30 ms per step.
    max_steps = math.floor(SWEEP_MAX_S * 1000 / 30.0) - 1
    min_step = min(2.0, 2 * widest / max_steps)
    glide_step_deg = draw(_closed_floats(min_step, 2.0))
    steps = math.ceil(2 * widest / glide_step_deg)
    max_interval = max(30.0, min(1000.0, SWEEP_MAX_S * 1000 / steps))
    glide_interval_ms = draw(_closed_floats(30.0, max_interval))
    servo = ServoConfig(
        pan_center_offset=draw(_closed_floats(-pan_span, pan_span)),
        tilt_center_offset=draw(_closed_floats(-tilt_span, tilt_span)),
        pan_limit=pan_limit,
        tilt_limit=tilt_limit,
        pan_invert=draw(st.booleans()),
        tilt_invert=draw(st.booleans()),
        glide_step_deg=glide_step_deg,
        glide_interval_ms=glide_interval_ms,
        servo_settle_ms=draw(_pos_floats(2000.0)),
        nod_deg=draw(_pos_floats(tilt_limit)),
        pose_file=draw(st.text(_NAME_ALPHABET, min_size=1, max_size=16)) + ".json",
    )
    sweep_s = Config(servo=servo).sweep_time_s

    # Then T, then the timing rules of R25.7 that depend on Sweep_Time and T.
    tick_interval_ms = draw(_closed_floats(TICK_MIN_MS, 1000.0))
    tick_s = tick_interval_ms / 1000
    lantern = LanternConfig(
        lantern_wake_level=draw(_pos_floats(1.0)),
        lantern_fade_in_ms=draw(_pos_floats(10000.0)),
        lantern_fade_out_ms=draw(_pos_floats(10000.0)),
    )
    waking_min = _just_above(max(TIMEOUT_MIN_S, lantern.lantern_fade_in_ms / 1000, sweep_s))
    waking_timeout_s = draw(_closed_floats(waking_min, TIMEOUT_MAX_S))
    glide_min = _just_above(max(TIMEOUT_MIN_S, sweep_s + 2 * tick_s))
    glide_timeout_s = draw(_closed_floats(glide_min, GLIDE_TIMEOUT_MAX_S))
    cooldown_min = _just_above(glide_timeout_s + lantern.lantern_fade_out_ms / 1000)
    cooldown_s = draw(_closed_floats(cooldown_min, max(TIMEOUT_MAX_S, cooldown_min)))
    verdict_timeout_s = draw(_closed_floats(2 * TIMEOUT_MIN_S, TIMEOUT_MAX_S))
    camera_timeout_s = draw(
        st.floats(
            min_value=TIMEOUT_MIN_S,
            max_value=verdict_timeout_s,
            exclude_max=True,
            allow_nan=False,
            allow_infinity=False,
        )
    )
    timeout = _closed_floats(TIMEOUT_MIN_S, TIMEOUT_MAX_S)
    timing = TimingConfig(
        tick_interval_ms=tick_interval_ms,
        pir_warmup_s=draw(_closed_floats(0.0, 120.0)),
        waking_timeout_s=waking_timeout_s,
        verdict_timeout_s=verdict_timeout_s,
        glide_timeout_s=glide_timeout_s,
        stare_s=draw(timeout),
        audio_timeout_s=draw(timeout),
        camera_timeout_s=camera_timeout_s,
        download_timeout_s=draw(timeout),
        probe_timeout_s=draw(timeout),
        cooldown_s=cooldown_s,
        # A report period, not a timeout: the default 60 s is above the timeout cap.
        status_interval_s=draw(_closed_floats(TIMEOUT_MIN_S, STATUS_INTERVAL_MAX_S)),
    )

    # Keys without cross-key rules.
    pins = draw(st.lists(st.integers(2, 27), min_size=4, max_size=4, unique=True))
    positions = tuple(draw(st.lists(_closed_floats(-180.0, 180.0), max_size=4)))
    camera = CameraConfig(
        camera_hfov_deg=draw(_pos_floats(180.0)),
        camera_vfov_deg=draw(_pos_floats(180.0)),
        jpeg_max_bytes=draw(st.integers(10000, 90000)),
        scan_pan_positions_deg=positions,
        scan_attempts_max=draw(st.integers(0, len(positions))),
    )
    card = draw(st.text(string.ascii_letters + string.digits, min_size=1, max_size=12))
    suffix = draw(st.sampled_from(["", ",DEV=0", ",DEV=1"]))
    return Config(
        device=DeviceConfig(id=draw(st.text(_ID_ALPHABET, min_size=1, max_size=64))),
        pins=PinsConfig(pir_pin=pins[0], pan_pin=pins[1], tilt_pin=pins[2], lantern_pin=pins[3]),
        motion=MotionConfig(
            motion_enabled=draw(st.booleans()) if motion_enabled is None else motion_enabled
        ),
        servo=servo,
        lantern=lantern,
        camera=camera,
        judgement=JudgementConfig(
            family_confidence_min=draw(_pos_floats(1.0)),
            stranger_confidence_min=draw(_pos_floats(1.0)),
        ),
        timing=timing,
        audio=AudioConfig(audio_device=f"plughw:CARD={card}{suffix}"),
        messages=MessagesConfig(dedup_window_size=draw(st.integers(16, 4096))),
        privacy=PrivacyConfig(
            blocked_words=tuple(draw(st.lists(st.text(min_size=1, max_size=12), max_size=3)))
        ),
    )


def valid_configs(*, motion_enabled: bool | None = None) -> st.SearchStrategy[Config]:
    """Configs that pass every rule of R25, with the default Config tried first.

    `motion_enabled` forces that key (Property 7 needs `false`, Property 16 `true`); the
    default example then carries the forced value too. `aws` stays empty: the section is
    opaque and its loader representation belongs to task 4.1.
    """
    default = DEFAULT_CONFIG
    if motion_enabled is not None:
        default = dataclasses.replace(default, motion=MotionConfig(motion_enabled=motion_enabled))
    return st.one_of(st.just(default), _drawn_configs(motion_enabled))


def rands() -> st.SearchStrategy[float]:
    """The `rand` of an Event: floats in [0, 1), with both edges of R1.3 drawn often."""
    return st.one_of(
        st.sampled_from(RAND_EDGES),
        st.floats(min_value=0.0, max_value=1.0, exclude_max=True, allow_nan=False),
    )


class UidCounter:
    """Hands out `str(uuid.UUID(int=k, version=4))` for k = 1, 2, 3, ...

    `version=4` overwrites only bits 62, 63 and 76 to 79 of the integer, so every k below
    2**62 gives a different UUID v4 string. Use one counter per example (`uid_counters()`),
    so uids are pairwise distinct within the example and examples stay reproducible.
    """

    def __init__(self) -> None:
        self._k = 0

    def __call__(self) -> str:
        self._k += 1
        return str(uuid.UUID(int=self._k, version=4))

    def __repr__(self) -> str:
        return f"UidCounter(issued={self._k})"


def uid_counters() -> st.SearchStrategy[UidCounter]:
    """A fresh UidCounter for each example."""
    return st.builds(UidCounter)


def _toml_value(value: object) -> object:
    """Map a Config field value to the type `tomllib` returns for it."""
    if isinstance(value, tuple):
        return [_toml_value(v) for v in value]
    return value


def as_mapping(cfg: Config) -> dict[str, dict[str, object]]:
    """The `tomllib` mapping of a config.toml that sets every key of `cfg` explicitly.

    Sections and keys use the Glossary names, which equal the dataclass field names. Tuples
    become lists, as TOML arrays do. `[aws]` appears only when `cfg.aws` differs from the
    default (`valid_configs()` never sets it).
    """
    mapping: dict[str, dict[str, object]] = {}
    for f in dataclasses.fields(cfg):
        if f.name == "aws":
            continue
        section = getattr(cfg, f.name)
        mapping[f.name] = {
            k.name: _toml_value(getattr(section, k.name)) for k in dataclasses.fields(section)
        }
    if cfg.aws != AwsConfig():
        mapping["aws"] = dataclasses.asdict(cfg.aws)
    return mapping


# --------------------------------------------------------------------------------------------
# Voice lines
# --------------------------------------------------------------------------------------------

LINES_PER_CATEGORY_MAX = 4

# Ids whose code-point order differs from a "natural" order: '0'-'9' < '_' < 'a'-'z', so
# "a1" < "a_1" and "a" < "a0" < "a_". A sort that ignores '_' or compares naturally would pick
# a different line for the same rand (R1.3).
_CODE_POINT_IDS = ("a1", "a_1", "a", "a0", "a_", "a_0", "_a", "0a", "b", "b_", "z9", "z_9")
_ID_CHARS = "ab01_"

# Family-friendly texts that pass every R26.3 and R26.4 rule (at most 40 code points, at most
# two sentence marks, no Latin letters, no emoji; en at most 120 characters). They contain no
# '"' or '\', so they can be written as TOML basic strings without escaping.
_JA_TEXTS = (
    "おかえり。",
    "……だれか、いるの？",
    "あかり、ともしておいたよ。",
    "……ずっと、みているよ。",
    "かぜの おと、かな。",
    "ここは あたたかいね。またね！",
    "……しずかに。",
)
_EN_TEXTS = (
    "Welcome home.",
    "...Is someone there?",
    "I kept the lantern lit for you.",
    "...I have been watching, all along.",
    "Was that only the wind?",
    "It is warm here. See you again!",
    "...Quiet now.",
)


def _line_ids() -> st.SearchStrategy[str]:
    """Ids matching [a-z0-9_]+, biased toward the code-point-order cases above."""
    return st.one_of(
        st.sampled_from(_CODE_POINT_IDS),
        st.text(_ID_CHARS, min_size=1, max_size=6),
    )


@st.composite
def _drawn_line_sets(draw: st.DrawFn, required: frozenset[Category]) -> tuple[VoiceLine, ...]:
    categories = list(Category)
    counts = {
        c: draw(st.integers(1 if c in required else 0, LINES_PER_CATEGORY_MAX)) for c in categories
    }
    labels = [c for c in categories for _ in range(counts[c])]
    # Shuffle the labels so that ids and categories are not correlated: the code-point pairs
    # then land in one Category as often as in two.
    labels = draw(st.permutations(labels))
    ids = draw(st.lists(_line_ids(), min_size=len(labels), max_size=len(labels), unique=True))
    lines = [
        VoiceLine(
            id=line_id,
            category=category,
            ja=draw(st.sampled_from(_JA_TEXTS)),
            en=draw(st.sampled_from(_EN_TEXTS)),
            wav=f"{line_id}.wav",
        )
        for line_id, category in zip(ids, labels, strict=True)
    ]
    return tuple(sorted(lines, key=lambda line: line.id))


def line_sets(*, require: Iterable[Category] = ()) -> st.SearchStrategy[tuple[VoiceLine, ...]]:
    """Available_Lines as the Manifest_Loader returns them (R26.10): valid, distinct ids,
    sorted by id in code-point order.

    Each Category gets zero to four lines, so empty Categories (the R7.7 and R7.10 paths) are
    drawn often. `require` forces at least one line in the given Categories, which is cheaper
    than filtering (Property 3 needs every Category, Property 5 an `uncertain` line).

    The texts come from small fixed pools. The lines are meant to be placed in a
    Machine_State directly; they are not checked against a drawn `privacy.blocked_words`.
    """
    return _drawn_line_sets(frozenset(require))
