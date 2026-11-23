"""Unit tests for the Config dataclasses and the Config_Loader (tasks 2.3 and 4.2).

The expected values are transcribed from the Glossary table "Configuration keys and defaults"
in .kiro/specs/device-core-loop/requirements.md, not imported from config.py, so a changed
default fails here (R25.1). The derived bounds use the numbers the Glossary states for the
defaults (R10.2).

The loader tests cover the file problems of R25.11 and R25.13, the message format of R25.9,
each R25.7 cross-key rule at its exact boundary, and the typed `[aws]` section of
cloud-judgement R23.2, R23.3 and R23.5.
"""

from __future__ import annotations

import dataclasses
import logging
import math
import os
import re
from pathlib import Path

import pytest
from hypothesis import given

from tests.strategies import as_mapping, valid_configs
from warashi_agent.config import (
    Config,
    ConfigRejected,
    format_rejection,
    load_config,
    validate_mapping,
)

TOL = 1e-9

# section -> key -> default, from the Glossary table. `aws` is the disabled AwsConfig by default.
GLOSSARY_DEFAULTS: dict[str, object] = {
    "device": {"id": "warashi-01"},
    "pins": {"pir_pin": 17, "pan_pin": 18, "tilt_pin": 13, "lantern_pin": 23},
    "motion": {"motion_enabled": False},
    "servo": {
        "pan_center_offset": 0,
        "tilt_center_offset": 0,
        "pan_limit": 30,
        "tilt_limit": 20,
        "tilt_up_limit": None,
        "tilt_down_limit": None,
        "pan_invert": False,
        "tilt_invert": False,
        "glide_step_deg": 2,
        "glide_interval_ms": 30,
        "servo_settle_ms": 300,
        "nod_deg": 8,
        "pose_file": "last_pose.json",
    },
    "lantern": {
        "lantern_wake_level": 0.8,
        "lantern_fade_in_ms": 1500,
        "lantern_fade_out_ms": 2000,
    },
    "camera": {
        "camera_hfov_deg": 54,
        "camera_vfov_deg": 41.8,
        "jpeg_max_bytes": 90000,
        "scan_pan_positions_deg": (-15, 15, 0),
        "scan_attempts_max": 3,
    },
    "judgement": {"family_confidence_min": 0.80, "stranger_confidence_min": 0.80},
    "timing": {
        "tick_interval_ms": 100,
        "pir_warmup_s": 60,
        "waking_timeout_s": 3,
        "verdict_timeout_s": 8,
        "glide_timeout_s": 3,
        "stare_s": 2,
        "audio_timeout_s": 12,
        "camera_timeout_s": 5,
        "download_timeout_s": 5,
        "probe_timeout_s": 5,
        "cooldown_s": 20,
        "status_interval_s": 60,
    },
    "audio": {"audio_device": "plughw:CARD=Device,DEV=0"},
    "messages": {"dedup_window_size": 256},
    "privacy": {"blocked_words": ()},
    "aws": {
        "enabled": False,
        "endpoint": "",
        "port": 8883,
        "ca_file": "",
        "cert_file": "",
        "key_file": "",
        "keepalive_s": 60,
        "reconnect_min_s": 1,
        "reconnect_max_s": 60,
        "appsync_realtime_host": "",
        "appsync_http_host": "",
    },
    "conversation": {
        "conversation_enabled": False,
        "conversation_max_s": 180,
        "conversation_silence_s": 15,
        "conversation_mic_gain": 4.0,
        "conversation_chunk_ms": 100,
        "conversation_mute_mic_while_speaking": False,
        "conversation_connect_timeout_s": 8,
    },
}


def test_default_config_equals_the_glossary_defaults() -> None:
    assert dataclasses.asdict(Config()) == GLOSSARY_DEFAULTS


@pytest.mark.parametrize(
    ("section", "key"),
    [("pins", k) for k in ("pir_pin", "pan_pin", "tilt_pin", "lantern_pin")]
    + [("camera", "jpeg_max_bytes"), ("camera", "scan_attempts_max")]
    + [("messages", "dedup_window_size")],
)
def test_integer_keys_default_to_int(section: str, key: str) -> None:
    # R25.14 treats these keys as integers, so their defaults must be ints, not floats.
    value = getattr(getattr(Config(), section), key)
    assert type(value) is int


def test_config_is_frozen_and_hashable() -> None:
    # Config lives inside the Machine_State, which must be immutable (R1.1, R1.2).
    cfg = Config()
    with pytest.raises(dataclasses.FrozenInstanceError):
        cfg.timing = None  # type: ignore[misc]
    with pytest.raises(dataclasses.FrozenInstanceError):
        cfg.servo.pan_limit = 90.0  # type: ignore[misc]
    assert hash(cfg) == hash(Config())


def test_blocked_words_are_hidden_from_repr() -> None:
    # The owner may list family names here (R13.1, R25.9).
    cfg = dataclasses.replace(
        Config(),
        privacy=dataclasses.replace(Config().privacy, blocked_words=("ZQXJfamilyname",)),
    )
    assert "ZQXJ" not in repr(cfg)


def test_default_derived_bounds() -> None:
    cfg = Config()
    assert math.isclose(cfg.tick_s, 0.1, rel_tol=0, abs_tol=TOL)
    # ceil(2 * 30 / 2) * 30 ms
    assert math.isclose(cfg.sweep_time_s, 0.9, rel_tol=0, abs_tol=TOL)
    # 3 + 4 * (8 + 3) + 2 + 12 + 20 + 12 * 0.1 (Glossary, Encounter_Bound)
    assert math.isclose(cfg.encounter_bound_s, 82.2, rel_tol=0, abs_tol=TOL)
    # waking_timeout_s + T
    assert math.isclose(cfg.offline_bound_disconnected_s, 3.1, rel_tol=0, abs_tol=TOL)
    # waking_timeout_s + verdict_timeout_s + 2 * T
    assert math.isclose(cfg.offline_bound_silent_s, 11.2, rel_tol=0, abs_tol=TOL)


# ---------------------------------------------------------------------------------------------
# Config_Loader (task 4.2)
# ---------------------------------------------------------------------------------------------

# Prefix that occurs nowhere else, so a leaked blocked word is easy to find in a message.
MARKER = "ZQXJfamilyname"


def _rejected(result: Config | ConfigRejected) -> ConfigRejected:
    assert isinstance(result, ConfigRejected), f"expected a rejection, got {result!r}"
    return result


def _accepted(result: Config | ConfigRejected) -> Config:
    assert isinstance(result, Config), (
        f"expected acceptance, got:\n{format_rejection(result)}"
        if isinstance(result, ConfigRejected)
        else result
    )
    return result


def _violation_keys(result: Config | ConfigRejected) -> list[str]:
    return [v.key for v in _rejected(result).violations]


# --- Files (R25.1, R25.11, R25.13) -----------------------------------------------------------


def test_missing_file_with_fake_gives_defaults_and_logs(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path = tmp_path / "missing.toml"
    with caplog.at_level(logging.INFO, logger="warashi_agent.config"):
        result = load_config(path, fake=True)
    assert result == Config()
    assert any("default" in record.getMessage() for record in caplog.records)


def test_missing_file_without_fake_is_rejected_naming_the_path(tmp_path: Path) -> None:
    path = tmp_path / "missing.toml"
    message = format_rejection(_rejected(load_config(path, fake=False)))
    assert str(path) in message
    assert "missing" in message


@pytest.mark.parametrize("fake", [False, True])
def test_directory_instead_of_file_is_unreadable(tmp_path: Path, fake: bool) -> None:
    # Reading a directory raises an OSError other than FileNotFoundError, so `--fake` must
    # not fall back to the defaults here: only a missing file does (R25.11).
    message = format_rejection(_rejected(load_config(tmp_path, fake=fake)))
    assert str(tmp_path) in message
    assert "unreadable" in message


@pytest.mark.skipif(
    not hasattr(os, "geteuid") or os.geteuid() == 0,
    reason="root can read a file without read permission",
)
def test_file_without_read_permission_is_unreadable(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text("[device]\nid = 'warashi-01'\n", encoding="utf-8")
    path.chmod(0)
    try:
        message = format_rejection(_rejected(load_config(path, fake=False)))
    finally:
        path.chmod(0o600)
    assert str(path) in message
    assert "unreadable" in message


@pytest.mark.parametrize(
    "content",
    [
        b"[device\nid = 'warashi-01'\n",  # unclosed table header
        b"[timing]\ncooldown_s = = 20\n",  # broken key/value pair
        b"[device]\nid = '\xff\xfe'\n",  # not UTF-8
    ],
    ids=["unclosed-table", "broken-pair", "not-utf8"],
)
def test_invalid_toml_is_rejected_naming_the_path(tmp_path: Path, content: bytes) -> None:
    path = tmp_path / "config.toml"
    path.write_bytes(content)
    message = format_rejection(_rejected(load_config(path, fake=True)))
    assert str(path) in message
    assert "not valid TOML" in message


def test_valid_file_fills_missing_keys_with_defaults(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text("[servo]\npan_limit = 45\n", encoding="utf-8")
    cfg = _accepted(load_config(path, fake=False))
    assert cfg == dataclasses.replace(
        Config(), servo=dataclasses.replace(Config().servo, pan_limit=45.0)
    )


# --- Message format (R25.9) ------------------------------------------------------------------


def test_single_key_rule_names_key_value_and_allowed_values() -> None:
    message = format_rejection(_rejected(validate_mapping({"servo": {"pan_limit": 61}})))
    assert "servo.pan_limit = 61 (allowed: number, 0 < value <= 60)" in message


def test_cross_key_rule_names_every_key_and_value() -> None:
    result = validate_mapping({"timing": {"camera_timeout_s": 8, "verdict_timeout_s": 8}})
    message = format_rejection(_rejected(result))
    assert (
        "timing.camera_timeout_s, timing.verdict_timeout_s = 8, 8 "
        "(allowed: camera_timeout_s < verdict_timeout_s)"
    ) in message


def test_every_violation_is_reported_in_one_message() -> None:
    result = validate_mapping(
        {
            "servo": {"pan_limit": 0, "tilt_limit": 31},
            "pins": {"pir_pin": 1.5},
            "nosuch": {"x": 1},
        }
    )
    keys = _violation_keys(result)
    assert {"servo.pan_limit", "servo.tilt_limit", "pins.pir_pin", "nosuch"} <= set(keys)
    message = format_rejection(_rejected(result))
    for key in ("servo.pan_limit", "servo.tilt_limit", "pins.pir_pin", "nosuch"):
        assert key in message


@pytest.mark.parametrize(
    "mapping",
    [
        {"privacy": {"blocked_words": [MARKER, ""]}},  # empty entry breaks the rule
        {"privacy": {"blocked_words": [MARKER, 3]}},  # non-string entry
        {"privacy": {"blocked_words": MARKER}},  # not a list
        {"privacy": {"blocked_word": [MARKER]}},  # mistyped key
        {"privacy": MARKER},  # section is not a table
        {"privacy": {"blocked_words": [MARKER]}, "servo": {"pan_limit": 99}},  # other key
    ],
    ids=["empty-entry", "non-string", "not-a-list", "unknown-key", "not-a-table", "other-key"],
)
def test_no_blocked_word_in_any_rejection_message(mapping: dict[str, object]) -> None:
    rejected = _rejected(validate_mapping(mapping))
    assert MARKER not in format_rejection(rejected)
    assert MARKER not in repr(rejected)


def test_blocked_words_violation_names_the_key_and_rule() -> None:
    message = format_rejection(
        _rejected(validate_mapping({"privacy": {"blocked_words": [MARKER, ""]}}))
    )
    assert "privacy.blocked_words" in message
    assert "list of non-empty strings" in message


def test_unknown_key_value_is_not_shown() -> None:
    # A mistyped key may hold a secret (for example a Wi-Fi or AWS value).
    result = validate_mapping({"device": {"wifi_password": "ZQXJsecret"}})
    assert _violation_keys(result) == ["device.wifi_password"]
    assert "ZQXJ" not in format_rejection(_rejected(result))


# --- R25.7 cross-key rules at their boundaries ------------------------------------------------
#
# Each case sets the keys of one rule so that the rule holds with equality (accepted) and
# then moves one key by one ulp to break it (rejected, naming every key of the rule). The
# other keys keep their defaults and satisfy every other rule.

_SWEEP_KEYS = (
    "servo.pan_limit",
    "servo.tilt_limit",
    "servo.glide_step_deg",
    "servo.glide_interval_ms",
)

# Default Sweep_Time ceil(2 * 30 / 2) * 30 / 1000 and T = 100 / 1000, written as the Glossary
# formulas so that the boundary is the float the rule computes.
_SWEEP_S = math.ceil(2 * 30 / 2) * 30 / 1000
_T_S = 100 / 1000

_BOUNDARY_CASES = [
    pytest.param(
        # waking_timeout_s >= lantern_fade_in_ms / 1000; the default fade-in is 1500 ms.
        {"timing": {"waking_timeout_s": 1500 / 1000}},
        {"timing": {"waking_timeout_s": math.nextafter(1500 / 1000, 0)}},
        ["timing.waking_timeout_s", "lantern.lantern_fade_in_ms"],
        id="waking-vs-fade-in",
    ),
    pytest.param(
        # waking_timeout_s >= Sweep_Time; a short fade-in keeps the fade-in rule out of the way.
        {"timing": {"waking_timeout_s": _SWEEP_S}, "lantern": {"lantern_fade_in_ms": 100}},
        {
            "timing": {"waking_timeout_s": math.nextafter(_SWEEP_S, 0)},
            "lantern": {"lantern_fade_in_ms": 100},
        },
        ["timing.waking_timeout_s", *_SWEEP_KEYS],
        id="waking-vs-sweep",
    ),
    pytest.param(
        # glide_timeout_s >= Sweep_Time + 2 * T
        {"timing": {"glide_timeout_s": _SWEEP_S + 2 * _T_S}},
        {"timing": {"glide_timeout_s": math.nextafter(_SWEEP_S + 2 * _T_S, 0)}},
        ["timing.glide_timeout_s", *_SWEEP_KEYS, "timing.tick_interval_ms"],
        id="glide-vs-sweep-and-tick",
    ),
    pytest.param(
        # cooldown_s >= glide_timeout_s + lantern_fade_out_ms / 1000 = 3 + 2
        {"timing": {"cooldown_s": 3 + 2000 / 1000}},
        {"timing": {"cooldown_s": math.nextafter(3 + 2000 / 1000, 0)}},
        ["timing.cooldown_s", "timing.glide_timeout_s", "lantern.lantern_fade_out_ms"],
        id="cooldown-vs-glide-and-fade-out",
    ),
    pytest.param(
        # camera_timeout_s < verdict_timeout_s (strict): just below holds, equality breaks.
        {"timing": {"camera_timeout_s": math.nextafter(8.0, 0)}},
        {"timing": {"camera_timeout_s": 8.0}},
        ["timing.camera_timeout_s", "timing.verdict_timeout_s"],
        id="camera-vs-verdict",
    ),
]


@pytest.mark.parametrize(("holds", "breaks", "keys"), _BOUNDARY_CASES)
def test_cross_key_timing_rule_at_its_boundary(
    holds: dict[str, dict[str, object]],
    breaks: dict[str, dict[str, object]],
    keys: list[str],
) -> None:
    _accepted(validate_mapping(holds))
    assert _violation_keys(validate_mapping(breaks)) == [", ".join(keys)]


def test_timing_rule_is_skipped_when_one_of_its_keys_failed_earlier() -> None:
    # R25.7: a rule runs only when every key it uses passed criteria 2 to 6 and 14, so a bad
    # verdict_timeout_s is reported once, not again by the camera_timeout_s rule.
    result = validate_mapping({"timing": {"verdict_timeout_s": -1, "camera_timeout_s": 5}})
    assert _violation_keys(result) == ["timing.verdict_timeout_s"]


def test_timing_rule_with_wrong_type_does_not_raise() -> None:
    result = validate_mapping({"timing": {"cooldown_s": "20", "glide_timeout_s": True}})
    assert set(_violation_keys(result)) == {"timing.cooldown_s", "timing.glide_timeout_s"}


# --- [aws] (cloud-judgement R23.2, R23.3, R23.5) ---------------------------------------------

AWS_SECRET = "ZQXJ-private-value"


def _enabled_aws(tmp_path: Path, **overrides: object) -> dict[str, object]:
    """An enabled `[aws]` table whose three files exist, with placeholder content only."""
    files = {}
    for key in ("ca_file", "cert_file", "key_file"):
        path = tmp_path / key
        path.write_text("placeholder", encoding="utf-8")
        files[key] = str(path)
    return {"enabled": True, "endpoint": "placeholder.invalid", **files, **overrides}


def test_config_without_aws_section_is_disabled() -> None:
    cfg = _accepted(validate_mapping({}))
    assert cfg == Config()
    assert cfg.aws.enabled is False


def test_enabled_aws_table_is_typed(tmp_path: Path) -> None:
    table = _enabled_aws(tmp_path, port=443, keepalive_s=30, reconnect_min_s=2, reconnect_max_s=90)
    cfg = _accepted(validate_mapping({"aws": table}, check_files=True))
    assert cfg.aws.enabled is True
    assert cfg.aws.endpoint == "placeholder.invalid"
    assert cfg.aws.port == 443
    assert cfg.aws.keepalive_s == 30
    assert cfg.aws.reconnect_min_s == 2.0
    assert type(cfg.aws.reconnect_min_s) is float
    assert cfg.aws.reconnect_max_s == 90.0
    hash(cfg)


def test_aws_table_loads_from_a_toml_file(tmp_path: Path) -> None:
    table = _enabled_aws(tmp_path)
    path = tmp_path / "config.toml"
    lines = ["[aws]"] + [
        f"{k} = {str(v).lower() if isinstance(v, bool) else repr(v)}" for k, v in table.items()
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    cfg = _accepted(load_config(path, fake=False))
    assert cfg.aws.enabled is True
    assert cfg.aws.cert_file == table["cert_file"]


def test_aws_endpoint_and_paths_are_hidden_from_repr(tmp_path: Path) -> None:
    table = _enabled_aws(tmp_path, endpoint=AWS_SECRET)
    cfg = _accepted(validate_mapping({"aws": table}))
    text = repr(cfg)
    assert AWS_SECRET not in text
    assert str(tmp_path) not in text


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("enabled", "yes"),
        ("endpoint", 5),
        ("port", 8883.0),
        ("port", True),
        ("port", 0),
        ("port", 65536),
        ("ca_file", 1),
        ("keepalive_s", 29),
        ("keepalive_s", 1201),
        ("keepalive_s", 60.5),
        ("reconnect_min_s", 0),
        ("reconnect_min_s", float("nan")),
        ("reconnect_max_s", 3601),
        ("reconnect_max_s", "60"),
    ],
)
def test_aws_value_out_of_type_or_range_is_rejected_even_when_disabled(
    key: str, value: object
) -> None:
    result = validate_mapping({"aws": {"enabled": False, key: value}})
    if key == "enabled":
        result = validate_mapping({"aws": {key: value}})
    assert _violation_keys(result) == [f"aws.{key}"]


@pytest.mark.parametrize(("low", "high", "ok"), [(5, 5, True), (5, 4.9, False), (1, 60, True)])
def test_aws_reconnect_min_must_not_exceed_max(low: float, high: float, ok: bool) -> None:
    result = validate_mapping({"aws": {"reconnect_min_s": low, "reconnect_max_s": high}})
    if ok:
        _accepted(result)
    else:
        assert _violation_keys(result) == ["aws.reconnect_min_s, aws.reconnect_max_s"]


def test_aws_unknown_key_and_non_table_are_rejected_without_values() -> None:
    result = validate_mapping({"aws": {"secret_key": AWS_SECRET}})
    assert _violation_keys(result) == ["aws.secret_key"]
    assert AWS_SECRET not in format_rejection(_rejected(result))
    result = validate_mapping({"aws": AWS_SECRET})
    assert _violation_keys(result) == ["aws"]
    assert AWS_SECRET not in format_rejection(_rejected(result))


def test_disabled_aws_skips_endpoint_and_file_checks() -> None:
    table = {"enabled": False, "endpoint": "not a host!", "ca_file": "/nonexistent/ca.pem"}
    cfg = _accepted(validate_mapping({"aws": table}, check_files=True))
    assert cfg.aws.enabled is False


@pytest.mark.parametrize("endpoint", ["", "https://placeholder.invalid", "host:8883", "a b", "-x"])
def test_enabled_aws_rejects_a_bad_endpoint(tmp_path: Path, endpoint: str) -> None:
    table = _enabled_aws(tmp_path, endpoint=endpoint)
    result = validate_mapping({"aws": table})
    assert _violation_keys(result) == ["aws.endpoint"]
    assert endpoint not in format_rejection(_rejected(result)) or endpoint == ""


def test_enabled_aws_requires_the_three_paths() -> None:
    result = validate_mapping({"aws": {"enabled": True, "endpoint": "placeholder.invalid"}})
    assert _violation_keys(result) == ["aws.ca_file", "aws.cert_file", "aws.key_file"]


def test_enabled_aws_checks_files_only_when_asked(tmp_path: Path) -> None:
    table = _enabled_aws(tmp_path)
    missing = str(tmp_path / "gone.pem")
    table["cert_file"] = missing
    _accepted(validate_mapping({"aws": table}))  # pure mode: no file system access
    result = validate_mapping({"aws": table}, check_files=True)
    assert _violation_keys(result) == ["aws.cert_file"]
    assert missing not in format_rejection(_rejected(result))
    table["cert_file"] = str(tmp_path)  # a directory is not a file
    assert _violation_keys(validate_mapping({"aws": table}, check_files=True)) == ["aws.cert_file"]


def test_load_config_skips_file_checks_with_fake(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text(
        '[aws]\nenabled = true\nendpoint = "placeholder.invalid"\n'
        'ca_file = "/nonexistent/ca"\ncert_file = "/nonexistent/cert"\n'
        'key_file = "/nonexistent/key"\n',
        encoding="utf-8",
    )
    assert _accepted(load_config(path, fake=True)).aws.enabled is True
    result = load_config(path, fake=False)
    assert _violation_keys(result) == ["aws.ca_file", "aws.cert_file", "aws.key_file"]


def test_unknown_section_outside_aws_is_rejected() -> None:
    assert _violation_keys(validate_mapping({"aws_extra": {"x": 1}})) == ["aws_extra"]


# --- Shared generator check ------------------------------------------------------------------


@given(valid_configs())
def test_every_valid_configs_example_is_accepted(cfg: Config) -> None:
    # Keeps tests/strategies.py honest: valid_configs() must only produce Configs the loader
    # accepts, and as_mapping() must rebuild the same Config.
    assert _accepted(validate_mapping(as_mapping(cfg))) == cfg


# ----- device/config.example.toml (task 28.4, R25.12) -----
EXAMPLE_CONFIG = Path(__file__).resolve().parents[1] / "config.example.toml"


def test_example_config_loads_without_violation() -> None:
    result = load_config(EXAMPLE_CONFIG, fake=False)
    assert isinstance(result, Config), result


def test_example_config_mentions_every_glossary_key() -> None:
    # GLOSSARY_DEFAULTS is transcribed by hand from the Glossary, so this does not depend on
    # the loader's own key list. `[aws]` is off by default, so its keys appear commented out.
    text = EXAMPLE_CONFIG.read_text(encoding="utf-8")
    missing = [
        f"{section}.{key}"
        for section, keys in GLOSSARY_DEFAULTS.items()
        if isinstance(keys, dict)
        for key in keys
        if not re.search(
            rf"^{'# ' if section in ('aws', 'conversation') else ''}{re.escape(key)}\s*=",
            text,
            re.MULTILINE,
        )
    ]
    assert missing == []
    for section in GLOSSARY_DEFAULTS:
        assert f"[{section}]" in text


# --- [conversation] (voice-conversation R12.14, R12.15) -------------------------------------


def _voice_aws(**overrides: object) -> dict[str, object]:
    table: dict[str, object] = {
        "enabled": True,
        "endpoint": "placeholder.invalid",
        "ca_file": "ca",
        "cert_file": "cert",
        "key_file": "key",
        "appsync_realtime_host": "rt.placeholder.invalid",
        "appsync_http_host": "http.placeholder.invalid",
    }
    return table | overrides


def test_conversation_defaults_are_off() -> None:
    cfg = _accepted(validate_mapping({}))
    assert cfg.conversation.conversation_enabled is False
    assert type(cfg.conversation.conversation_max_s) is int
    assert cfg.encounter_bound_s == Config().encounter_bound_s


def test_enabled_conversation_extends_the_encounter_bound() -> None:
    cfg = _accepted(
        validate_mapping({"conversation": {"conversation_enabled": True}, "aws": _voice_aws()})
    )
    assert math.isclose(
        cfg.encounter_bound_s, Config().encounter_bound_s + 180 + 2 * cfg.tick_s, abs_tol=TOL
    )


@pytest.mark.parametrize(
    ("key", "good", "bad"),
    [
        ("conversation_max_s", (30, 420), (29, 421, 100.0, True)),
        ("conversation_silence_s", (5, 60), (4, 61, 10.0)),
        ("conversation_mic_gain", (0.5, 16, 4), (0.4, 16.1)),
        ("conversation_chunk_ms", (60, 200), (59, 201, 100.5)),
        ("conversation_connect_timeout_s", (2, 20), (1.9, 20.1)),
    ],
)
def test_conversation_ranges(key: str, good: tuple[object, ...], bad: tuple[object, ...]) -> None:
    for value in good:
        # Silence 60 needs a max of at least 65, so keep the pair valid.
        table = {key: value, "conversation_max_s": 420}
        _accepted(validate_mapping({"conversation": table}))
    for value in bad:
        table = {key: value}
        if key != "conversation_max_s":
            table["conversation_max_s"] = 420
        assert f"conversation.{key}" in _violation_keys(validate_mapping({"conversation": table}))


@pytest.mark.parametrize(("silence", "ok"), [(25, True), (26, False)])
def test_silence_plus_five_must_fit_in_max(silence: int, ok: bool) -> None:
    result = validate_mapping(
        {"conversation": {"conversation_max_s": 30, "conversation_silence_s": silence}}
    )
    if ok:
        _accepted(result)
    else:
        assert _violation_keys(result) == [
            "conversation.conversation_silence_s, conversation.conversation_max_s"
        ]


def test_enabled_conversation_needs_aws_and_both_hosts() -> None:
    enabled = {"conversation": {"conversation_enabled": True}}
    result = validate_mapping(enabled)
    assert _violation_keys(result) == [
        "conversation.conversation_enabled, aws.enabled",
        "conversation.conversation_enabled, aws.appsync_realtime_host",
        "conversation.conversation_enabled, aws.appsync_http_host",
    ]
    result = validate_mapping(enabled | {"aws": _voice_aws(appsync_http_host="")})
    assert _violation_keys(result) == ["conversation.conversation_enabled, aws.appsync_http_host"]
    _accepted(validate_mapping(enabled | {"aws": _voice_aws()}))


def test_disabled_conversation_needs_no_hosts() -> None:
    _accepted(validate_mapping({"conversation": {"conversation_enabled": False}}))


def test_appsync_hosts_are_typed_hidden_and_never_shown() -> None:
    result = validate_mapping({"aws": {"appsync_http_host": 5}})
    assert _violation_keys(result) == ["aws.appsync_http_host"]
    cfg = _accepted(validate_mapping({"aws": {"appsync_http_host": AWS_SECRET}}))
    assert AWS_SECRET not in repr(cfg)
    rejected = _rejected(
        validate_mapping(
            {
                "conversation": {"conversation_enabled": True},
                "aws": _voice_aws(appsync_http_host=""),
            }
        )
    )
    assert "placeholder" not in format_rejection(rejected)
