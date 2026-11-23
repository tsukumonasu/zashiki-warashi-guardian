"""Sanity checks for the shared strategies in tests/strategies.py.

The rules below are transcribed from the Glossary table and R25 of
`.kiro/specs/device-core-loop/requirements.md`, independently of strategies.py, so a wrong
generator fails here instead of silently weakening every property test that uses it.
"""

from __future__ import annotations

import dataclasses
import json
import math
import re
import tempfile
import uuid
from collections import Counter
from pathlib import Path

from hypothesis import find, given
from hypothesis import strategies as st

from tests.strategies import (
    DEFAULT_CONFIG,
    LINES_PER_CATEGORY_MAX,
    RAND_EDGES,
    TIMEOUT_MAX_S,
    UidCounter,
    as_mapping,
    line_sets,
    rands,
    uid_counters,
    valid_configs,
)
from warashi_agent.config import Config
from warashi_agent.model import Category
from warashi_agent.voice import VoiceLine, load_manifest


def r25_violations(cfg: Config) -> list[str]:
    """Names of the R25 rules (Glossary allowed values) that `cfg` breaks."""
    s, t, c, ln = cfg.servo, cfg.timing, cfg.camera, cfg.lantern
    pins = [cfg.pins.pir_pin, cfg.pins.pan_pin, cfg.pins.tilt_pin, cfg.pins.lantern_pin]
    sweep = math.ceil(2 * max(s.pan_limit, s.tilt_limit) / s.glide_step_deg)
    sweep_s = sweep * s.glide_interval_ms / 1000
    tick_s = t.tick_interval_ms / 1000
    checks = {
        "device.id": re.fullmatch(r"[a-z0-9-]{1,64}", cfg.device.id) is not None,
        "pins range": all(isinstance(p, int) and 2 <= p <= 27 for p in pins),
        "pins distinct": len(set(pins)) == 4,
        "pan_limit": 0 < s.pan_limit <= 60,
        "tilt_limit": 0 < s.tilt_limit <= 30,
        "pan offset": abs(s.pan_center_offset) + s.pan_limit <= 90,
        "tilt offset": abs(s.tilt_center_offset) + s.tilt_limit <= 90,
        "glide_step_deg": 0 < s.glide_step_deg <= 2,
        "glide_interval_ms": 30 <= s.glide_interval_ms <= 1000,
        "servo_settle_ms": 0 < s.servo_settle_ms <= 2000,
        "nod_deg": 0 < s.nod_deg <= s.tilt_limit,
        "pose_file": s.pose_file != "",
        "lantern_wake_level": 0 < ln.lantern_wake_level <= 1,
        "lantern_fade_in_ms": 0 < ln.lantern_fade_in_ms <= 10000,
        "lantern_fade_out_ms": 0 < ln.lantern_fade_out_ms <= 10000,
        "camera_hfov_deg": 0 < c.camera_hfov_deg <= 180,
        "camera_vfov_deg": 0 < c.camera_vfov_deg <= 180,
        "jpeg_max_bytes": 10000 <= c.jpeg_max_bytes <= 90000,
        "scan positions": all(math.isfinite(p) for p in c.scan_pan_positions_deg),
        "scan_attempts_max": 0 <= c.scan_attempts_max <= len(c.scan_pan_positions_deg),
        "family_confidence_min": 0 < cfg.judgement.family_confidence_min <= 1,
        "stranger_confidence_min": 0 < cfg.judgement.stranger_confidence_min <= 1,
        "tick_interval_ms": 10 <= t.tick_interval_ms <= 1000,
        "pir_warmup_s": 0 <= t.pir_warmup_s <= 120,
        "pir_quiet_s": 0 <= t.pir_quiet_s <= 600,
        "remote_idle_s": 10 <= t.remote_idle_s <= 600,
        "timeouts > 0": all(
            getattr(t, f.name) > 0
            for f in dataclasses.fields(t)
            if f.name not in ("pir_warmup_s", "pir_quiet_s")
        ),
        "waking >= fade in": t.waking_timeout_s >= ln.lantern_fade_in_ms / 1000,
        "waking >= sweep": t.waking_timeout_s >= sweep_s,
        "glide >= sweep + 2T": t.glide_timeout_s >= sweep_s + 2 * tick_s,
        "cooldown >= glide + fade out": t.cooldown_s
        >= t.glide_timeout_s + ln.lantern_fade_out_ms / 1000,
        "camera < verdict": t.camera_timeout_s < t.verdict_timeout_s,
        "audio_device": re.search(r"CARD=.", cfg.audio.audio_device) is not None,
        "dedup_window_size": 16 <= cfg.messages.dedup_window_size <= 4096,
        "blocked_words": all(w != "" for w in cfg.privacy.blocked_words),
    }
    return [name for name, ok in checks.items() if not ok]


def test_default_config_is_valid_and_drawn() -> None:
    assert r25_violations(DEFAULT_CONFIG) == []
    assert find(valid_configs(), lambda cfg: cfg == Config()) == Config()


@given(valid_configs())
def test_valid_configs_pass_every_r25_rule_and_the_test_budget(cfg: Config) -> None:
    assert r25_violations(cfg) == []
    t = cfg.timing
    assert t.tick_interval_ms >= 50
    uncapped = {"tick_interval_ms", "pir_warmup_s", "status_interval_s", "remote_idle_s"}
    capped = [f.name for f in dataclasses.fields(t) if f.name not in uncapped]
    # 1e-9 tolerance: valid_configs() draws cooldown_s from just above glide_timeout_s +
    # lantern_fade_out_ms / 1000, which is the float just above 30 when those are 20 and 10000.
    assert all(getattr(t, name) <= TIMEOUT_MAX_S + 1e-9 for name in capped)


@given(st.booleans(), st.data())
def test_motion_enabled_can_be_forced(forced: bool, data: st.DataObject) -> None:
    cfg = data.draw(valid_configs(motion_enabled=forced))
    assert cfg.motion.motion_enabled is forced
    assert r25_violations(cfg) == []


@given(valid_configs())
def test_as_mapping_rebuilds_the_same_config(cfg: Config) -> None:
    mapping = as_mapping(cfg)
    assert "aws" not in mapping
    for values in mapping.values():
        for value in values.values():
            assert isinstance(value, bool | int | float | str | list)
    rebuilt = {
        name: type(getattr(cfg, name))(
            **{k: tuple(v) if isinstance(v, list) else v for k, v in values.items()}
        )
        for name, values in mapping.items()
    }
    assert Config(**rebuilt) == cfg


@given(rands())
def test_rands_are_in_unit_interval(rand: float) -> None:
    assert 0.0 <= rand < 1.0


def test_rand_edges_are_drawn() -> None:
    for edge in RAND_EDGES:
        assert find(rands(), lambda r, edge=edge: r == edge) == edge


@given(uid_counters())
def test_uid_counter_is_fresh_and_distinct(counter: UidCounter) -> None:
    uids = [counter() for _ in range(50)]
    assert uids[0] == str(uuid.UUID(int=1, version=4))
    assert len(set(uids)) == len(uids)
    assert all(uuid.UUID(u).version == 4 for u in uids)


def _manifest_text(lines: tuple[VoiceLine, ...]) -> str:
    """A lines.toml with one [[lines]] table per line; JSON strings are TOML basic strings."""
    chunks = []
    for line in lines:
        fields = {
            "id": line.id,
            "category": line.category.value,
            "ja": line.ja,
            "en": line.en,
            "wav": line.wav,
        }
        body = "\n".join(f"{k} = {json.dumps(v, ensure_ascii=False)}" for k, v in fields.items())
        chunks.append(f"[[lines]]\n{body}\n")
    return "\n".join(chunks)


@given(line_sets())
def test_line_sets_pass_the_manifest_loader(lines: tuple[VoiceLine, ...]) -> None:
    ids = [line.id for line in lines]
    assert ids == sorted(ids)
    assert len(set(ids)) == len(ids)
    counts = Counter(line.category for line in lines)
    assert all(counts[c] <= LINES_PER_CATEGORY_MAX for c in Category)
    # tmp_path is function-scoped, which Hypothesis does not allow inside @given.
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "lines.toml"
        path.write_text(_manifest_text(lines), encoding="utf-8")
        result = load_manifest(path, blocked_words=(), wav_check=False)
    if lines:
        assert result.problems == ()
        assert result.available == lines
    else:
        # An empty manifest has no [[lines]] array at all, which the loader reports.
        assert result.available == ()


@given(st.sets(st.sampled_from(list(Category))), st.data())
def test_line_sets_require_forces_a_line_per_category(
    required: set[Category], data: st.DataObject
) -> None:
    lines = data.draw(line_sets(require=required))
    present = {line.category for line in lines}
    assert required <= present


def test_line_sets_draw_empty_categories_and_code_point_order_ids() -> None:
    find(line_sets(), lambda lines: not any(line.category is Category.FAMILY for line in lines))

    def has_underscore_twins(lines: tuple[VoiceLine, ...]) -> bool:
        ids = [line.id for line in lines]
        return any(a != b and a.replace("_", "") == b.replace("_", "") for a in ids for b in ids)

    find(line_sets(), has_underscore_twins)
