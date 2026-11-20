"""Config dataclasses and the Config_Loader for config.toml (device-core-loop R25).

The defaults in the dataclasses are the single place where the Glossary defaults of
`.kiro/specs/device-core-loop/requirements.md` ("Configuration keys and defaults") appear in
code; the loader's key table reads them from there. Every dataclass is frozen so a Config can
live inside the pure State_Machine's Machine_State and be compared and hashed like any other
value.

The loader is split so that the rules can be property-tested without files:

- `validate_mapping(mapping)` is pure. It takes what `tomllib` returns and gives a `Config`
  or a `ConfigRejected` that lists every violation, not only the first (R25.9).
- `load_config(path, fake=...)` reads and parses the file and calls `validate_mapping`.
- `format_rejection(rejected)` builds the one stderr message of R25.9.

A wrong config.toml must never reach a servo, so the caller exits with code 2 on rejection
before any adapter is built (R25.10).
"""

from __future__ import annotations

import dataclasses
import logging
import math
import re
import tomllib
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal


@dataclass(frozen=True, kw_only=True)
class DeviceConfig:
    """`[device]`: the id this doll puts in every envelope as `deviceId`."""

    id: str = "warashi-01"


@dataclass(frozen=True, kw_only=True)
class PinsConfig:
    """`[pins]`: BCM pin numbers, matching the pin map in hardware.md."""

    pir_pin: int = 17
    pan_pin: int = 18
    tilt_pin: int = 13
    lantern_pin: int = 23


@dataclass(frozen=True, kw_only=True)
class MotionConfig:
    """`[motion]`: servos stay unpowered until the owner has verified and calibrated them."""

    motion_enabled: bool = False


@dataclass(frozen=True, kw_only=True)
class ServoConfig:
    """`[servo]`: calibration and glide limits that keep the neck cables safe (R14, R15)."""

    pan_center_offset: float = 0.0
    tilt_center_offset: float = 0.0
    pan_limit: float = 30.0
    tilt_limit: float = 20.0
    pan_invert: bool = False
    tilt_invert: bool = False
    glide_step_deg: float = 2.0
    glide_interval_ms: float = 30.0
    servo_settle_ms: float = 300.0
    nod_deg: float = 8.0
    pose_file: str = "last_pose.json"


@dataclass(frozen=True, kw_only=True)
class LanternConfig:
    """`[lantern]`: level and fade times of the lantern during an Encounter."""

    lantern_wake_level: float = 0.8
    lantern_fade_in_ms: float = 1500.0
    lantern_fade_out_ms: float = 2000.0


@dataclass(frozen=True, kw_only=True)
class CameraConfig:
    """`[camera]`: optics for the Head_Tracker, the JPEG size limit and the scan positions.

    `camera_vfov_deg` defaults to 2 * atan(tan(54 deg / 2) * 3/4), the vertical field of view
    of the 4:3 image.
    """

    camera_hfov_deg: float = 54.0
    camera_vfov_deg: float = 41.8
    jpeg_max_bytes: int = 90000
    scan_pan_positions_deg: tuple[float, ...] = (-15.0, 15.0, 0.0)
    scan_attempts_max: int = 3


@dataclass(frozen=True, kw_only=True)
class JudgementConfig:
    """`[judgement]`: lowest confidences the device accepts as `family` or `stranger` (R4)."""

    family_confidence_min: float = 0.80
    stranger_confidence_min: float = 0.80


@dataclass(frozen=True, kw_only=True)
class TimingConfig:
    """`[timing]`: tick period and every deadline of the State_Machine and the adapters."""

    tick_interval_ms: float = 100.0
    pir_warmup_s: float = 60.0
    waking_timeout_s: float = 3.0
    verdict_timeout_s: float = 8.0
    glide_timeout_s: float = 3.0
    stare_s: float = 2.0
    audio_timeout_s: float = 12.0
    camera_timeout_s: float = 5.0
    download_timeout_s: float = 5.0
    probe_timeout_s: float = 5.0
    cooldown_s: float = 20.0
    status_interval_s: float = 60.0


@dataclass(frozen=True, kw_only=True)
class AudioConfig:
    """`[audio]`: ALSA device chosen by card name, because card numbers change."""

    audio_device: str = "plughw:CARD=Device,DEV=0"


@dataclass(frozen=True, kw_only=True)
class MessagesConfig:
    """`[messages]`: size of the duplicate window for incoming command ids (R22.8)."""

    dedup_window_size: int = 256


@dataclass(frozen=True, kw_only=True)
class PrivacyConfig:
    """`[privacy]`: words no voice line may contain.

    The owner may list family names here on the Pi, so the value is hidden from `repr()` and
    can never leak into a log line or a traceback (R13.1, R25.9).
    """

    blocked_words: tuple[str, ...] = field(default=(), repr=False)


@dataclass(frozen=True, kw_only=True)
class Config:
    """The validated contents of config.toml.

    `aws` is kept opaque as `(key, value)` pairs: the section is reserved for the
    `cloud-judgement` spec and this spec never reads it (R21.7).
    """

    device: DeviceConfig = field(default_factory=DeviceConfig)
    pins: PinsConfig = field(default_factory=PinsConfig)
    motion: MotionConfig = field(default_factory=MotionConfig)
    servo: ServoConfig = field(default_factory=ServoConfig)
    lantern: LanternConfig = field(default_factory=LanternConfig)
    camera: CameraConfig = field(default_factory=CameraConfig)
    judgement: JudgementConfig = field(default_factory=JudgementConfig)
    timing: TimingConfig = field(default_factory=TimingConfig)
    audio: AudioConfig = field(default_factory=AudioConfig)
    messages: MessagesConfig = field(default_factory=MessagesConfig)
    privacy: PrivacyConfig = field(default_factory=PrivacyConfig)
    aws: tuple[tuple[str, object], ...] = ()

    # Derived values (Glossary). They live here so the State_Machine, the Config_Loader's
    # cross-key rules (R25.7) and the property tests share one definition of each bound.

    @property
    def tick_s(self) -> float:
        """Tick_Lag T: the longest delay between a deadline and the Tick that observes it."""
        return self.timing.tick_interval_ms / 1000

    @property
    def sweep_time_s(self) -> float:
        """Sweep_Time: Glide_Planner time for a full limit-to-limit move on the wider axis."""
        s = self.servo
        steps = math.ceil(2 * max(s.pan_limit, s.tilt_limit) / s.glide_step_deg)
        return steps * s.glide_interval_ms / 1000

    @property
    def encounter_bound_s(self) -> float:
        """Encounter_Bound L: latest time from the starting `pir.rising` to `sleeping` (R10.2).

        It is the sum of the R10.1 dwell bounds along the worst route
        waking -> seeking (all scans) -> gazing -> warning -> cooldown.
        """
        t, n = self.timing, self.camera.scan_attempts_max
        return (
            t.waking_timeout_s
            + (n + 1) * (t.verdict_timeout_s + t.glide_timeout_s)
            + t.stare_s
            + t.audio_timeout_s
            + t.cooldown_s
            + (2 * n + 6) * self.tick_s
        )

    @property
    def offline_bound_disconnected_s(self) -> float:
        """Offline_Bound_Disconnected: latest offline line when the cloud is down at the start.

        `waking` ends by its deadline plus one Tick lag, and the line is emitted in that call
        (R9.2).
        """
        return self.timing.waking_timeout_s + self.tick_s

    @property
    def offline_bound_silent_s(self) -> float:
        """Offline_Bound_Silent: latest offline line when no verdict ever arrives (R9.3).

        `waking` plus one timed-out snapshot attempt, each observed up to one Tick late.
        """
        return self.timing.waking_timeout_s + self.timing.verdict_timeout_s + 2 * self.tick_s


# ---------------------------------------------------------------------------------------------
# Config_Loader (R25, R21.7)
# ---------------------------------------------------------------------------------------------

log = logging.getLogger(__name__)

# Section name -> dataclass. The names equal the `Config` field names and the TOML tables.
_SECTIONS: dict[str, type] = {
    "device": DeviceConfig,
    "pins": PinsConfig,
    "motion": MotionConfig,
    "servo": ServoConfig,
    "lantern": LanternConfig,
    "camera": CameraConfig,
    "judgement": JudgementConfig,
    "timing": TimingConfig,
    "audio": AudioConfig,
    "messages": MessagesConfig,
    "privacy": PrivacyConfig,
}

# The section reserved for the cloud-judgement spec: accepted in any form, never validated.
AWS_SECTION = "aws"

# Sections whose values are never echoed in a rejection message. The owner may list family
# names under [privacy], also under a mistyped key (R13.1, R25.9).
_HIDDEN_VALUE_SECTIONS = frozenset({"privacy"})

Kind = Literal["int", "float", "bool", "str", "path", "alsa_card", "float_list", "str_list"]
"""How a key is typed in TOML (R25.14).

- `int`: a TOML integer only; a float such as `17.0` or a boolean is the wrong type.
- `float`: a TOML integer or float, stored as `float`; a boolean is never a number.
- `bool`, `str`: a TOML boolean or string.
- `path`: a non-empty string (`pose_file`).
- `alsa_card`: a non-empty string that contains `CARD=` followed by at least one character, so
  the card is chosen by name, because card numbers change between boots (hardware.md).
- `float_list`: an array of numbers, stored as a tuple of floats.
- `str_list`: an array of strings, stored as a tuple of strings.

Every number, also inside an array, must be finite (`nan` and `inf` are valid TOML).
"""


@dataclass(frozen=True, kw_only=True)
class KeySpec:
    """One row of the Glossary table "Configuration keys and defaults".

    `check` holds only the rule that needs no other key; rules over several keys are in
    `_CROSS_RULES`. `check` is called only on a value that passed the `kind` test, so it
    never sees a wrong type or a non-finite number. `allowed_text` is the "Allowed values"
    text that a rejection message shows (R25.9).
    """

    section: str
    key: str
    kind: Kind
    default: object
    check: Callable[[Any], bool]
    allowed_text: str

    @property
    def name(self) -> str:
        """`section.key`, the name a rejection message uses."""
        return f"{self.section}.{self.key}"


def _default(section: str, key: str) -> object:
    """The dataclass default, so defaults stay defined in one place."""
    for f in dataclasses.fields(_SECTIONS[section]):
        if f.name == key:
            return f.default
    raise KeyError(f"{section}.{key}")


def _always(_: object) -> bool:
    return True


def _in_range(lo: float, hi: float, *, lo_open: bool = False) -> Callable[[float], bool]:
    """`lo < v <= hi` with `lo_open`, else `lo <= v <= hi`."""
    if lo_open:
        return lambda v: lo < v <= hi
    return lambda v: lo <= v <= hi


def _positive(v: float) -> bool:
    return v > 0


_DEVICE_ID = re.compile(r"[a-z0-9-]{1,64}")
_PIN_TEXT = "integer, BCM 2-27, all pins distinct"
_OFFSET_TEXT = "number; abs({axis}_center_offset) + {axis}_limit <= 90"
_FADE_TEXT = "number, 0 < value <= 10000"
_FOV_TEXT = "number, 0 < value <= 180"
_CONF_TEXT = "number, 0 < value <= 1"
_POS_TEXT = "number > 0"


def _spec(
    section: str, key: str, kind: Kind, check: Callable[[Any], bool], allowed_text: str
) -> KeySpec:
    return KeySpec(
        section=section,
        key=key,
        kind=kind,
        default=_default(section, key),
        check=check,
        allowed_text=allowed_text,
    )


KEY_SPECS: tuple[KeySpec, ...] = (
    _spec(
        "device",
        "id",
        "str",
        lambda v: _DEVICE_ID.fullmatch(v) is not None,
        "string of 1-64 characters from a-z, 0-9 and -",
    ),
    _spec("pins", "pir_pin", "int", _in_range(2, 27), _PIN_TEXT),
    _spec("pins", "pan_pin", "int", _in_range(2, 27), _PIN_TEXT),
    _spec("pins", "tilt_pin", "int", _in_range(2, 27), _PIN_TEXT),
    _spec("pins", "lantern_pin", "int", _in_range(2, 27), _PIN_TEXT),
    _spec("motion", "motion_enabled", "bool", _always, "boolean"),
    _spec("servo", "pan_center_offset", "float", _always, _OFFSET_TEXT.format(axis="pan")),
    _spec("servo", "tilt_center_offset", "float", _always, _OFFSET_TEXT.format(axis="tilt")),
    _spec(
        "servo", "pan_limit", "float", _in_range(0, 60, lo_open=True), "number, 0 < value <= 60"
    ),
    _spec(
        "servo", "tilt_limit", "float", _in_range(0, 30, lo_open=True), "number, 0 < value <= 30"
    ),
    _spec("servo", "pan_invert", "bool", _always, "boolean"),
    _spec("servo", "tilt_invert", "bool", _always, "boolean"),
    _spec(
        "servo",
        "glide_step_deg",
        "float",
        _in_range(0, 2, lo_open=True),
        "number, 0 < value <= 2",
    ),
    _spec(
        "servo",
        "glide_interval_ms",
        "float",
        _in_range(30, 1000),
        "number, 30 <= value <= 1000",
    ),
    _spec(
        "servo",
        "servo_settle_ms",
        "float",
        _in_range(0, 2000, lo_open=True),
        "number, 0 < value <= 2000",
    ),
    # The upper bound tilt_limit is a cross-key rule (_CROSS_RULES).
    _spec("servo", "nod_deg", "float", _positive, "number, 0 < value <= tilt_limit"),
    _spec("servo", "pose_file", "path", _always, "non-empty string (path)"),
    _spec("lantern", "lantern_wake_level", "float", _in_range(0, 1, lo_open=True), _CONF_TEXT),
    _spec("lantern", "lantern_fade_in_ms", "float", _in_range(0, 10000, lo_open=True), _FADE_TEXT),
    _spec(
        "lantern", "lantern_fade_out_ms", "float", _in_range(0, 10000, lo_open=True), _FADE_TEXT
    ),
    _spec("camera", "camera_hfov_deg", "float", _in_range(0, 180, lo_open=True), _FOV_TEXT),
    _spec("camera", "camera_vfov_deg", "float", _in_range(0, 180, lo_open=True), _FOV_TEXT),
    _spec(
        "camera",
        "jpeg_max_bytes",
        "int",
        _in_range(10000, 90000),
        "integer, 10000 <= value <= 90000",
    ),
    _spec("camera", "scan_pan_positions_deg", "float_list", _always, "list of finite numbers"),
    # The upper bound (length of scan_pan_positions_deg) is a cross-key rule.
    _spec(
        "camera",
        "scan_attempts_max",
        "int",
        lambda v: v >= 0,
        "integer, 0 <= value <= length of scan_pan_positions_deg",
    ),
    _spec(
        "judgement",
        "family_confidence_min",
        "float",
        _in_range(0, 1, lo_open=True),
        _CONF_TEXT,
    ),
    _spec(
        "judgement",
        "stranger_confidence_min",
        "float",
        _in_range(0, 1, lo_open=True),
        _CONF_TEXT,
    ),
    _spec(
        "timing",
        "tick_interval_ms",
        "float",
        _in_range(10, 1000),
        "number, 10 <= value <= 1000",
    ),
    _spec("timing", "pir_warmup_s", "float", _in_range(0, 120), "number, 0 <= value <= 120"),
    _spec("timing", "waking_timeout_s", "float", _positive, _POS_TEXT),
    _spec("timing", "verdict_timeout_s", "float", _positive, _POS_TEXT),
    _spec("timing", "glide_timeout_s", "float", _positive, _POS_TEXT),
    _spec("timing", "stare_s", "float", _positive, _POS_TEXT),
    _spec("timing", "audio_timeout_s", "float", _positive, _POS_TEXT),
    _spec("timing", "camera_timeout_s", "float", _positive, "number > 0 and < verdict_timeout_s"),
    _spec("timing", "download_timeout_s", "float", _positive, _POS_TEXT),
    _spec("timing", "probe_timeout_s", "float", _positive, _POS_TEXT),
    _spec(
        "timing",
        "cooldown_s",
        "float",
        _positive,
        "number > 0 and >= glide_timeout_s + lantern_fade_out_ms / 1000",
    ),
    _spec("timing", "status_interval_s", "float", _positive, _POS_TEXT),
    _spec(
        "audio",
        "audio_device",
        "alsa_card",
        _always,
        "ALSA name selecting the card by name (contains CARD= and the card name)",
    ),
    _spec(
        "messages",
        "dedup_window_size",
        "int",
        _in_range(16, 4096),
        "integer, 16 <= value <= 4096",
    ),
    _spec(
        "privacy",
        "blocked_words",
        "str_list",
        lambda v: all(w != "" for w in v),
        "list of non-empty strings",
    ),
)

_SPECS_BY_NAME: dict[str, KeySpec] = {s.name: s for s in KEY_SPECS}


def _check_table_matches_dataclasses() -> None:
    """Fail at import if a dataclass field has no KeySpec row or the reverse.

    A key without a row would be rejected as unknown, and a row without a field would crash
    the Config build, so drift between the two must not survive the first import.
    """
    fields = {f"{s}.{f.name}" for s, cls in _SECTIONS.items() for f in dataclasses.fields(cls)}
    if fields != set(_SPECS_BY_NAME):
        raise RuntimeError(
            f"KEY_SPECS out of sync with the dataclasses: {fields ^ set(_SPECS_BY_NAME)}"
        )


_check_table_matches_dataclasses()


@dataclass(frozen=True, kw_only=True)
class Violation:
    """One broken rule.

    `key` is `section.key`, or several `section.key` names joined by ", " for a rule over
    several keys (then `value` lists their values in the same order). `value` is `None` when
    the value must not be shown: `privacy.blocked_words` (it may hold family names), unknown
    keys and sections (they may hold secrets such as a mistyped Wi-Fi or AWS setting), and
    file problems (R25.13), where `key` names the file.
    """

    key: str
    value: str | None
    allowed: str


@dataclass(frozen=True, kw_only=True)
class ConfigRejected:
    """A config.toml that breaks at least one rule, with every violation found (R25.9)."""

    violations: tuple[Violation, ...]


@dataclass(frozen=True, kw_only=True)
class _CrossRule:
    """A rule over several keys.

    Stage `range` rules (R25.3, the key-relative bounds of R25.4) run when every key passed
    its type test. Stage `timing` rules (R25.7) run only when every key passed every earlier
    rule, as R25.7 demands, so they only ever see in-range numbers and cannot raise.
    """

    keys: tuple[str, ...]
    holds: Callable[[Mapping[str, Any]], bool]
    allowed: str
    stage: Literal["range", "timing"]


def _sweep_time_s(v: Mapping[str, Any]) -> float:
    """Sweep_Time from the loaded values, through the one definition on `Config`."""
    servo = ServoConfig(
        pan_limit=v["servo.pan_limit"],
        tilt_limit=v["servo.tilt_limit"],
        glide_step_deg=v["servo.glide_step_deg"],
        glide_interval_ms=v["servo.glide_interval_ms"],
    )
    return Config(servo=servo).sweep_time_s


def _tick_s(v: Mapping[str, Any]) -> float:
    """Tick_Lag T, through the one definition on `Config`."""
    return Config(timing=TimingConfig(tick_interval_ms=v["timing.tick_interval_ms"])).tick_s


_SWEEP_KEYS = (
    "servo.pan_limit",
    "servo.tilt_limit",
    "servo.glide_step_deg",
    "servo.glide_interval_ms",
)

_CROSS_RULES: tuple[_CrossRule, ...] = (
    _CrossRule(
        keys=("servo.pan_center_offset", "servo.pan_limit"),
        holds=lambda v: abs(v["servo.pan_center_offset"]) + v["servo.pan_limit"] <= 90,
        allowed="abs(pan_center_offset) + pan_limit <= 90",
        stage="range",
    ),
    _CrossRule(
        keys=("servo.tilt_center_offset", "servo.tilt_limit"),
        holds=lambda v: abs(v["servo.tilt_center_offset"]) + v["servo.tilt_limit"] <= 90,
        allowed="abs(tilt_center_offset) + tilt_limit <= 90",
        stage="range",
    ),
    _CrossRule(
        keys=("servo.nod_deg", "servo.tilt_limit"),
        holds=lambda v: v["servo.nod_deg"] <= v["servo.tilt_limit"],
        allowed="0 < nod_deg <= tilt_limit",
        stage="range",
    ),
    _CrossRule(
        keys=("camera.scan_attempts_max", "camera.scan_pan_positions_deg"),
        holds=lambda v: v["camera.scan_attempts_max"] <= len(v["camera.scan_pan_positions_deg"]),
        allowed="0 <= scan_attempts_max <= length of scan_pan_positions_deg",
        stage="range",
    ),
    _CrossRule(
        keys=("timing.waking_timeout_s", "lantern.lantern_fade_in_ms"),
        holds=lambda v: v["timing.waking_timeout_s"] >= v["lantern.lantern_fade_in_ms"] / 1000,
        allowed="waking_timeout_s >= lantern_fade_in_ms / 1000",
        stage="timing",
    ),
    _CrossRule(
        keys=("timing.waking_timeout_s", *_SWEEP_KEYS),
        holds=lambda v: v["timing.waking_timeout_s"] >= _sweep_time_s(v),
        allowed=(
            "waking_timeout_s >= Sweep_Time = "
            "ceil(2 * max(pan_limit, tilt_limit) / glide_step_deg) * glide_interval_ms / 1000"
        ),
        stage="timing",
    ),
    _CrossRule(
        keys=("timing.glide_timeout_s", *_SWEEP_KEYS, "timing.tick_interval_ms"),
        holds=lambda v: v["timing.glide_timeout_s"] >= _sweep_time_s(v) + 2 * _tick_s(v),
        allowed=(
            "glide_timeout_s >= Sweep_Time + 2 * tick_interval_ms / 1000, so the cooldown "
            "release does not cut the return-to-center glide short"
        ),
        stage="timing",
    ),
    _CrossRule(
        keys=("timing.cooldown_s", "timing.glide_timeout_s", "lantern.lantern_fade_out_ms"),
        holds=lambda v: (
            v["timing.cooldown_s"]
            >= v["timing.glide_timeout_s"] + v["lantern.lantern_fade_out_ms"] / 1000
        ),
        allowed="cooldown_s >= glide_timeout_s + lantern_fade_out_ms / 1000",
        stage="timing",
    ),
    _CrossRule(
        keys=("timing.camera_timeout_s", "timing.verdict_timeout_s"),
        holds=lambda v: v["timing.camera_timeout_s"] < v["timing.verdict_timeout_s"],
        allowed="camera_timeout_s < verdict_timeout_s",
        stage="timing",
    ),
)

_PIN_KEYS = ("pins.pir_pin", "pins.pan_pin", "pins.tilt_pin", "pins.lantern_pin")

_SHOW_MAX = 80


def _show(value: object) -> str:
    """A short repr for a rejection message; long values are cut so stderr stays readable."""
    text = repr(value)
    return text if len(text) <= _SHOW_MAX else text[: _SHOW_MAX - 3] + "..."


def _is_number(value: object) -> bool:
    """TOML integer or float. `bool` is a subclass of `int` in Python but never a number."""
    return isinstance(value, int | float) and not isinstance(value, bool)


def _finite_float(value: object) -> float | None:
    """`float(value)` when it is a finite number, else None.

    A Python int above about 1.8e308 makes `float()` raise OverflowError; that counts as
    non-finite instead of escaping the validator.
    """
    if not _is_number(value):
        return None
    try:
        result = float(value)  # type: ignore[arg-type]
    except OverflowError:
        return None
    return result if math.isfinite(result) else None


def _convert(kind: Kind, value: object) -> tuple[bool, object]:
    """Apply the R25.14 type test of `kind`. Returns (ok, stored value)."""
    match kind:
        case "int":
            return (isinstance(value, int) and not isinstance(value, bool)), value
        case "float":
            converted = _finite_float(value)
            return converted is not None, converted
        case "bool":
            return isinstance(value, bool), value
        case "str":
            return isinstance(value, str), value
        case "path":
            return (isinstance(value, str) and value != ""), value
        case "alsa_card":
            ok = isinstance(value, str) and re.search(r"CARD=.", value, re.DOTALL) is not None
            return ok, value
        case "float_list":
            if not isinstance(value, list | tuple):
                return False, None
            items = [_finite_float(item) for item in value]
            if any(item is None for item in items):
                return False, None
            return True, tuple(items)
        case "str_list":
            if not isinstance(value, list | tuple) or not all(isinstance(w, str) for w in value):
                return False, None
            return True, tuple(value)
    return False, None  # pragma: no cover - every Kind is handled above


def _freeze(value: object) -> object:
    """A hashable copy of a TOML value: tables become (key, value) pairs, arrays tuples.

    Config must stay hashable because it lives in the Machine_State.
    """
    if isinstance(value, Mapping):
        return tuple((str(k), _freeze(v)) for k, v in value.items())
    if isinstance(value, list | tuple):
        return tuple(_freeze(v) for v in value)
    return value


def _freeze_aws(value: object) -> tuple[tuple[str, object], ...]:
    """Store `[aws]` opaquely (R21.7).

    A table keeps its keys in file order with frozen values. Any other TOML value (for
    example a top-level `aws = 1`) is kept as a single pair under the empty key, so nothing
    is lost and nothing is interpreted.
    """
    if isinstance(value, Mapping):
        return tuple((str(k), _freeze(v)) for k, v in value.items())
    return (("", _freeze(value)),)


def validate_mapping(mapping: Mapping[str, object]) -> Config | ConfigRejected:
    """Validate the `tomllib` mapping of config.toml and build the Config.

    Pure and total: any mapping gives a result, nothing raises, and every violation is
    collected so the owner fixes all of them in one go (R25.9). Passes, in order:

    1. Structure: unknown sections and keys outside `[aws]` (R25.8), known sections that are
       not tables.
    2. Types (R25.14): wrong TOML type, non-finite numbers and list entries, empty
       `pose_file` or `audio_device`, `audio_device` without `CARD=<name>`.
    3. Ranges, pins and the other key-relative bounds (R25.2 to R25.6).
    4. The cross-key timing rules of R25.7, each only when all its keys passed 1 to 3.

    Missing keys take the dataclass defaults (R25.1); `[aws]` is accepted in any form and
    kept opaque (R21.7).
    """
    violations: list[Violation] = []
    failed: set[str] = set()
    raw: dict[str, object] = {}  # section.key -> value as written, for messages

    # Pass 1: structure.
    for section, body in mapping.items():
        if section == AWS_SECTION:
            continue
        if section not in _SECTIONS:
            violations.append(Violation(key=str(section), value=None, allowed="no such section"))
            continue
        if not isinstance(body, Mapping):
            hidden = section in _HIDDEN_VALUE_SECTIONS
            violations.append(
                Violation(
                    key=section,
                    value=None if hidden else _show(body),
                    allowed=f"a table [{section}]",
                )
            )
            failed.update(s.name for s in KEY_SPECS if s.section == section)
            continue
        for key, value in body.items():
            name = f"{section}.{key}"
            if name in _SPECS_BY_NAME:
                raw[name] = value
            else:
                violations.append(
                    Violation(key=name, value=None, allowed=f"no such key in [{section}]")
                )

    # Pass 2: types. Defaults always pass; `typed` holds the stored value of every key that
    # passed, which later passes and the Config build read.
    typed: dict[str, object] = {}
    for spec in KEY_SPECS:
        if spec.name in failed:
            continue
        if spec.name not in raw:
            typed[spec.name] = spec.default
            continue
        ok, stored = _convert(spec.kind, raw[spec.name])
        if ok:
            typed[spec.name] = stored
        else:
            violations.append(_violation(spec.name, raw, spec.allowed_text))
            failed.add(spec.name)

    # Pass 3: single-key ranges, then the key-relative bounds and distinct pins.
    for spec in KEY_SPECS:
        if spec.name in typed and not spec.check(typed[spec.name]):
            violations.append(_violation(spec.name, raw, spec.allowed_text))
            failed.add(spec.name)
    range_failed: set[str] = set()
    for rule in _CROSS_RULES:
        if rule.stage != "range" or any(k not in typed for k in rule.keys):
            continue
        if not _holds(rule, typed):
            violations.append(_cross_violation(rule.keys, raw, typed, rule.allowed))
            range_failed.update(rule.keys)
    by_pin: dict[object, list[str]] = {}
    for name in _PIN_KEYS:
        if name in typed:
            by_pin.setdefault(typed[name], []).append(name)
    for names in by_pin.values():
        if len(names) > 1:
            violations.append(
                _cross_violation(tuple(names), raw, typed, "all pins distinct (BCM 2-27)")
            )
            range_failed.update(names)
    failed |= range_failed

    # Pass 4: R25.7, only on keys that passed every earlier rule.
    for rule in _CROSS_RULES:
        if rule.stage != "timing" or any(k in failed or k not in typed for k in rule.keys):
            continue
        if not _holds(rule, typed):
            violations.append(_cross_violation(rule.keys, raw, typed, rule.allowed))

    if violations:
        return ConfigRejected(violations=tuple(violations))
    aws = _freeze_aws(mapping[AWS_SECTION]) if AWS_SECTION in mapping else ()
    return _build(typed, aws)


def _holds(rule: _CrossRule, values: Mapping[str, Any]) -> bool:
    """Evaluate a cross-key rule; an arithmetic surprise counts as broken, never raises."""
    try:
        return bool(rule.holds(values))
    except (ArithmeticError, ValueError, TypeError):
        return False


def _violation(name: str, raw: Mapping[str, object], allowed: str) -> Violation:
    """A single-key violation; values under [privacy] are never shown (R25.9)."""
    hidden = name.split(".", 1)[0] in _HIDDEN_VALUE_SECTIONS
    return Violation(key=name, value=None if hidden else _show(raw.get(name)), allowed=allowed)


def _cross_violation(
    names: tuple[str, ...], raw: Mapping[str, object], typed: Mapping[str, object], allowed: str
) -> Violation:
    """A violation naming every key a rule uses, with the values in the same order.

    A key the file does not set shows its default, which is the value the rule saw.
    """
    shown = ", ".join(_show(raw[n]) if n in raw else _show(typed.get(n)) for n in names)
    return Violation(key=", ".join(names), value=shown, allowed=allowed)


def _build(typed: Mapping[str, object], aws: tuple[tuple[str, object], ...]) -> Config:
    """Build the frozen Config from values that passed every rule."""
    sections = {
        section: cls(**{f.name: typed[f"{section}.{f.name}"] for f in dataclasses.fields(cls)})
        for section, cls in _SECTIONS.items()
    }
    return Config(**sections, aws=aws)


def load_config(path: Path | str, *, fake: bool) -> Config | ConfigRejected:
    """Read config.toml from `path` and validate it (R25.1, R25.11, R25.13).

    With `fake` (the `--fake` CLI mode) a missing file gives the defaults, so a laptop needs
    no config.toml; the log line says so. Otherwise a missing, unreadable or invalid file is
    a rejection naming the path and the cause, because running the real doll on silent
    defaults could hide a calibration the owner believes is in effect.
    """
    path = Path(path)
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        if fake:
            log.info("config file %s not found; using the defaults (--fake)", path)
            return Config()
        return _file_problem(path, "missing")
    except OSError as exc:
        return _file_problem(path, f"unreadable ({exc.strerror or type(exc).__name__})")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return _file_problem(path, "not valid TOML (not UTF-8)")
    try:
        mapping = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        # tomllib messages name the rule and the position, never the file's content.
        return _file_problem(path, f"not valid TOML ({exc})")
    return validate_mapping(mapping)


def _file_problem(path: Path, cause: str) -> ConfigRejected:
    return ConfigRejected(
        violations=(Violation(key=f"config file {path}", value=None, allowed=cause),)
    )


def format_rejection(rejected: ConfigRejected) -> str:
    """The one stderr message of R25.9: every violation, one line each.

    A line reads `section.key = value (allowed: ...)`. Without a shown value it reads
    `section.key: ...`, which is how `privacy.blocked_words` names its broken rule without
    revealing any word, and how a file problem names the path and the cause.
    """
    lines = ["config.toml rejected:"]
    for v in rejected.violations:
        if v.value is not None:
            lines.append(f"  {v.key} = {v.value} (allowed: {v.allowed})")
        elif v.key.startswith("config file "):
            lines.append(f"  {v.key}: {v.allowed}")
        else:
            lines.append(f"  {v.key}: breaks the rule: {v.allowed} (value not shown)")
    return "\n".join(lines)
