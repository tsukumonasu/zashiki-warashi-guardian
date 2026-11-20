# Implementation Plan: device-core-loop

## Overview

This plan builds **warashi-agent** in `/device` in small steps that keep `make test` and
`make lint` green after every task. It follows the approved `requirements.md` and `design.md`
in this folder. The language is Python 3.13 (stdlib, gpiozero and lgpio imported lazily on the
Pi only); tests use pytest, Hypothesis and pytest-timeout and need no hardware, network or AWS
account.

Order of work:

1. Contract first: `docs/schema.md` gets changes S1 to S12 of the design (not F1 to F4).
2. Shared model, enums and Config dataclasses.
3. Pure modules: Glide_Planner, Head_Tracker, Config_Loader, Manifest_Loader, Message_Codec
   with the inbound pipeline and Deduplicator. Checkpoint.
4. The State_Machine, built flow by flow, each flow followed by its tests and properties.
   Checkpoint.
5. Time base, ports and fakes; redaction and the Dispatcher; real adapters; Cloud_Link fake and
   local; CLI and self-test.
6. Repository files: `lines.toml`, `config.example.toml`, `.gitignore`, the systemd unit
   template, `scripts/deploy_pi.sh`, Makefile wiring. Final checkpoint.

Every test task is **required**. No task in this plan is optional. The owner's five properties
are marked **(owner property)**:

| Property | Task |
|---|---|
| Property 1: Servo safety | 3.3 (Glide_Planner clauses) and 16.5 (`step()` clause, same test) |
| Property 2: Liveness | 14.4 |
| Property 3: Stranger-warning safety | 16.4 |
| Property 4: Schema round trip and robustness | 6.6 |
| Property 5: Offline reaction | 14.3 |

Rules for every property test (R29.2, design "Correctness Properties"): Hypothesis only, at
least 100 examples (no test lowers `max_examples`), angle and time comparisons with tolerance
`1e-9`, the tag comment `# Feature: device-core-loop, Property <n>: <title>`, and for
harness-based tests `deadline=None` plus an explicit `@pytest.mark.timeout` sized for the `ci`
profile.

## Tasks

- [x] 1. Update `docs/schema.md` before any message code (contract first)
  - Edit `docs/schema.md` only; do not touch `messages.py` in this task.
  - Apply changes S1 to S12 of the design section "docs/schema.md Changes", each with its
    reason written next to the change in the document:
    - S1: add `"reason": string` to `state.changed` with the values `presence`, `arrived`,
      `verdict`, `no_face`, `timeout`, `offline`, `audio_done`, `manual`, `cooldown_done`,
      `error`.
    - S2: `encounter.ended.reason` becomes `cooldown` | `manual` | `error` (`timeout` removed).
    - S3: add `"refId": string | null` to `error.reported` (always present, null when no
      incoming message caused the error), `message` at most 200 characters truncated by the
      sender.
    - S4: add `"mode": "guard" | "sleep"` to `status.report`; it is sent on each state change,
      each change of `cameraActive`, the first Tick after start and every `status_interval_s`
      (default 60 s); `status.report` envelopes always carry `encounterId: null`.
    - S5: `micActive` is false while no feature records audio.
    - S6: `speak.audioUrl` is `https` only, a 16-bit PCM WAV of at most 2,000,000 bytes, played
      only when the encounter's accepted verdict is `family`; both or neither of `lineId` and
      `audioUrl` is malformed.
    - S7: `lantern.fadeMs` clamped to 0..10000, `lantern.level` to 0..1, face box fields to
      0..1; `gaze` angles must be finite and are clamped; finite out-of-range numbers are not
      malformed.
    - S8: commands may carry `encounterId: null`; the device matches `judgement.result` by
      `snapshotId` only.
    - S9: the device drops a duplicate `id` within the last `dedup_window_size` (default 256)
      accepted ids and ignores undefined `data` fields.
    - S10: maximum incoming message size 131,072 bytes; a `v` that is not an integer ≥ 1 is
      malformed; keep the raw JPEG limit of 90,000 bytes (the cloud spec verifies the IoT Core
      limit).
    - S11: add a separate section with the heading "Device-internal events (not on the wire)"
      listing `tick`, `pir.rising`, `pir.falling`, `servo.arrived`, `audio.finished`,
      `audio.failed`, `snapshot.ready`, `snapshot.failed`, `cloud.connected`,
      `cloud.disconnected`, `adapter.error`, each with a one-line meaning. Place it under its
      own heading after the Status table, so the R24.2 test can skip it.
    - S12: the device emits `presence.detected` with `source: "pir"` only in this spec;
      `sound` (P2) and `manual` are reserved.
  - Add the `state.changed` reason mapping table of the design (R24.4) as a subsection, with
    the "first matching row wins" rule.
  - Add the `error.reported` code table of the design (all 19 codes with emitter, cause and
    `refId` rule). Put each code and each reason value in backticks in the first column so
    the schema test (task 6.2) can parse them.
  - Keep `v` at 1 and say why (no version deployed yet). Update the status note at the top to
    say the draft was refined by the `device-core-loop` design. Leave the HTTP API section
    unchanged.
  - Do **not** apply F1 to F4 of the design; they wait for a requirements decision.
  - _Requirements: 24.1, 24.3, 24.4, 24.5_

- [x] 2. Shared model, enums and Config dataclasses
  - [x] 2.1 Create `device/warashi_agent/model.py`
    - Enums as `StrEnum` whose values are the wire strings: `State` (including `conversing`,
      never entered), `Mode`, `Category`, `Verdict`, `AcceptedVerdict`, `Reason`, `EndReason`,
      `Axis`.
    - Events as frozen `kw_only` dataclasses: `EventBase(rand=0.0, uid="")` placeholders that
      the Dispatcher replaces; the eleven Internal_Events (`Tick`, `PirRising`, `PirFalling`,
      `ServoArrived`, `AudioFinished`, `AudioFailed`, `SnapshotReady` with `jpeg` as
      `repr=False`, `SnapshotFailed`, `CloudConnected`, `CloudDisconnected`, `AdapterError`);
      `FaceBox`; the five Command_Events with `ref_id` (`Speak` carries no `ja` or `en`).
    - Actions: `LanternFade`, `GazeTarget`, `ReleaseServos`, `TakeSnapshot`, `PlayLine`,
      `PlayAudioUrl` (`url` as `repr=False`), `PublishEvent(data, encounter_id)` with a `type`
      property, `PublishStatus(data)`; the `InternalEvent`, `CommandEvent`, `Event` and
      `Action` unions.
    - Reference the payload types of `messages.py` only under `typing.TYPE_CHECKING`, so
      `messages.py` can import the enums from `model.py` without an import cycle.
    - _Requirements: 1.5, 1.6, 13.6_
  - [x] 2.2 Add the Config dataclasses to `device/warashi_agent/config.py`
    - One frozen `kw_only` dataclass per section (`DeviceConfig`, `PinsConfig`, `MotionConfig`,
      `ServoConfig`, `LanternConfig`, `CameraConfig`, `JudgementConfig`, `TimingConfig`,
      `AudioConfig`, `MessagesConfig`, `PrivacyConfig` with `blocked_words` as `repr=False`)
      with the Glossary defaults, and `Config` with an opaque `aws` tuple.
    - Derived properties: `tick_s` (T), `sweep_time_s`, `encounter_bound_s`,
      `offline_bound_disconnected_s`, `offline_bound_silent_s`.
    - No loading or validation yet (task 4.1).
    - _Requirements: 25.1, 9.2, 9.3, 10.1, 10.2_
  - [x] 2.3 Write unit tests for the model and the Config defaults
    - `device/tests/test_model.py`: enum values equal the wire strings of `docs/schema.md`
      (including the new `Reason` and `EndReason` values); events and actions are frozen;
      `repr()` of `SnapshotReady` and `PlayAudioUrl` shows neither bytes nor URL.
    - `device/tests/test_config.py`: `Config()` equals the Glossary defaults; with defaults
      `tick_s` is 0.1, `sweep_time_s` 0.9, `encounter_bound_s` 82.2, and the offline bounds
      3.1 and 11.2 (tolerance 1e-9).
    - _Requirements: 1.6, 10.2, 25.1_
  - [x] 2.4 Create the shared Hypothesis strategies in `device/tests/strategies.py`
    - `valid_configs()` as the design's "Shared generators and harness" describes: valid by
      construction for every R25 rule, Sweep_Time and T drawn first, then the R25.7 timing
      rules satisfied, timing caps as a test budget (each timeout ≤ 30 s,
      `tick_interval_ms` ≥ 50), and the default Config always among the examples.
    - `rands()` with `0.0` and `math.nextafter(1.0, 0.0)` always included.
    - A per-example uid counter giving `str(uuid.UUID(int=k, version=4))`.
    - `as_mapping(cfg)` that turns a Config back into a TOML-like mapping, used to check
      `valid_configs()` against the Config_Loader in task 4.2.
    - _Requirements: 29.2_

- [x] 3. Pure Glide_Planner and Head_Tracker
  - [x] 3.1 Create `device/warashi_agent/glide.py`
    - `clamp(value, lo, hi)` (rejects non-finite input) and `clamp_gaze(target, cfg)` for the
      Calibrated_Range; `head_tracker.py` and `state_machine.py` import them from here.
    - `GlidePlan` with `duration_s`, `plan_glide(start, target, t0, motion_id, cfg)`
      (returns `None` for a non-finite target), `commanded_at(plan, t)`,
      `to_servo_angle(axis, a, servo_cfg)` with `pan_invert` / `tilt_invert`.
    - The pure `GlideTimeline` reducer that applies `(t, GazeTarget | ReleaseServos)` items to
      a list of written `(time, axis, angle)` entries and reports which plans complete, with
      the cancellation rule of R14.6.
    - Only positional angles; no speed or duration API.
    - _Requirements: 5.7, 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9_
  - [x] 3.2 Write unit tests for the Glide_Planner in `device/tests/test_glide.py`
    - Default full sweep takes 0.9 s; `d = 0` on both axes gives an empty plan with
      `duration_s` 0; the last step equals the Clamped target exactly; inverted axis
      conversion; a `nan` or `inf` target gives `None`.
    - _Requirements: 14.2, 14.3, 14.4, 14.7, 14.9_
  - [x] 3.3 Write property test for the Glide_Planner (owner property)
    - **Property 1: Servo safety** — Glide_Planner clauses 1 to 7 of the design (start from the
      last angle scheduled at or before `t`, k-th angle at `t + k × glide_interval_ms / 1000`,
      cancellation, merged angles inside the Calibrated_Range with steps ≤ `glide_step_deg`
      and gaps ≥ `glide_interval_ms`, completed plans end at the Clamped target,
      `to_servo_angle` in [-90, 90], non-finite target gives no plan).
    - Test file: `device/tests/test_prop_servo_safety.py`, one `@given` test function. Task
      16.5 extends the same function with the `step()` clause.
    - Generators as in the design: start angles in range; in-range, out-of-range, `nan` and
      `±inf` targets; gaps in [0, 3 × Sweep_Time] including 0 and exact multiples of the
      interval.
    - **Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 29.3**
  - [x] 3.4 Create `device/warashi_agent/head_tracker.py`
    - `head_target(face, snap_pan, snap_tilt, cfg)`: Clamp the box fields to [0, 1],
      `cx = min(1, left + width / 2)`, `cy = min(1, top + height / 2)`, pan correction
      `(cx − 0.5) × camera_hfov_deg`, tilt correction `(0.5 − cy) × camera_vfov_deg`, result
      Clamped with `clamp_gaze`.
    - _Requirements: 5.1, 5.2, 5.3_
  - [x] 3.5 Write unit tests for the Head_Tracker in `device/tests/test_head_tracker.py`
    - Corner faces with the default fields of view; the `min(1, …)` center cap; a centered
      face returns the snapshot angles.
    - _Requirements: 5.1, 5.2, 5.3_
  - [x] 3.6 Write property test for the Head_Tracker
    - **Property 10: Head_Tracker** — result inside the Calibrated_Range, equal to the Clamped
      snapshot angles for a centered face, pan and tilt monotone in the face offset.
    - Test file: `device/tests/test_prop_head_tracker.py`.
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.7, 29.12**

- [x] 4. Config_Loader
  - [x] 4.1 Implement loading and validation in `device/warashi_agent/config.py`
    - A `KeySpec(section, key, kind, default, check, allowed_text)` table with one row per
      Glossary key, including the `device.id` pattern and the list rules.
    - `validate_mapping(mapping) -> Config | ConfigRejected` with passes in this order,
      collecting every `Violation(key, value, allowed)`: unknown sections and keys outside
      `[aws]` (R25.8); TOML types, non-finite values and list entries, empty `pose_file` or
      `audio_device`, the `CARD=` rule (R25.14); ranges and pins (R25.2 to R25.6); the R25.7
      cross-key rules, each evaluated only when all its keys passed and without raising.
    - `[aws]` accepted in any form or absent, kept opaque (R21.7).
    - `load_config(path, *, fake)` with `tomllib`: a missing file with `fake=True` gives the
      defaults and a log line (R25.11); otherwise a missing, unreadable or invalid TOML file is
      a violation naming the path and the cause (R25.13).
    - `format_rejection(rejected)`: one message listing every violation as
      `section.key = value (allowed: ...)`; `privacy.blocked_words` named with the broken rule
      but without its value (R25.9).
    - _Requirements: 21.7, 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.8, 25.9, 25.11, 25.13, 25.14_
  - [x] 4.2 Write unit tests for the Config_Loader in `device/tests/test_config.py`
    - Missing file with and without `fake`; unreadable file; invalid TOML; message format of
      R25.9 for one single-key and one cross-key rule; no blocked word in any message; each
      R25.7 rule at its boundary; an `[aws]` table with arbitrary content is accepted.
    - A Hypothesis check that every `valid_configs()` example, turned into a mapping with
      `as_mapping`, is accepted (keeps the shared generator honest).
    - _Requirements: 21.7, 25.7, 25.9, 25.11, 25.13_
  - [x] 4.3 Write property test for the Config_Loader
    - **Property 11: Config_Loader** — `validate_mapping` accepts exactly when the test's
      independent oracle (written from the Glossary table in the test file, not imported from
      `config.py`) finds every rule of R25.2 to R25.8 and R25.14 satisfied; accepted mappings
      fill missing keys with the defaults; every rejection message names each violating key
      and never contains a `blocked_words` entry.
    - Test file: `device/tests/test_prop_config.py`.
    - **Validates: Requirements 21.7, 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.8, 25.9, 25.14, 29.13**

- [x] 5. Voice_Manifest loader and line choice
  - [x] 5.1 Create `device/warashi_agent/voice.py`
    - `VoiceLine` (`ja` and `en` as `repr=False`), `ManifestProblem(line_ref, rule, code)`,
      `ManifestResult(available, problems)`.
    - `load_manifest(path, *, blocked_words, wav_check)`: per-line rules in the design's order
      (fields and string types, `id` pattern and first-wins uniqueness, `category`, `wav`,
      `ja` rules counted in code points, `en` rules, blocked words with `casefold()`); problems
      name the `id` or `#<position>` and the rule, never the text or the matched word; with
      `wav_check` a missing or non-16-bit-PCM-mono WAV (stdlib `wave`) is excluded and
      reported as `voice_file_missing`; a missing or invalid manifest gives no lines and one
      `voice_line_invalid` problem; `available` sorted by `id` in code-point order.
    - `choose_line(lines, category, rand)` with the `min(floor(rand × n), n − 1)` guard.
    - _Requirements: 1.3, 13.1, 26.1, 26.3, 26.4, 26.5, 26.6, 26.9, 26.10, 26.11_
  - [x] 5.2 Add `line_sets()` to `device/tests/strategies.py`
    - Available_Lines with distinct ids, zero to four lines per Category, sorted by id,
      including ids that differ only in code-point order (for example `a_1` and `a1`).
    - _Requirements: 29.2_
  - [x] 5.3 Write unit tests for the Manifest_Loader in `device/tests/test_voice.py`
    - WAV check with temporary files: missing, 8-bit, stereo, valid; a missing manifest and an
      invalid TOML manifest; a duplicate id keeps the first; problems carry no line text;
      `choose_line` with `rand = 0.0`, `nextafter(1.0, 0.0)` and an empty Category.
    - _Requirements: 1.3, 26.5, 26.6, 26.9, 26.11_
  - [x] 5.4 Write property test for the Manifest_Loader
    - **Property 12: Manifest_Loader** — with `wav_check=False` a line is rejected exactly when
      the oracle finds a broken rule of R26.3, R26.4, R26.9 or R13.1; first-wins for repeated
      ids; Available_Lines equal the kept lines sorted by id; problems name the id or position
      and the rule but no text or blocked word.
    - Test file: `device/tests/test_prop_manifest.py`.
    - **Validates: Requirements 13.1, 26.1, 26.3, 26.4, 26.5, 26.9, 26.10, 29.14**

- [x] 6. Message_Codec, inbound pipeline and Deduplicator
  - [x] 6.1 Implement the Message_Codec in `device/warashi_agent/messages.py`
    - Payload dataclasses for every event, command and status type of the updated
      `docs/schema.md` (design "Wire messages"), `ErrorCode` with the 19 codes, `Envelope`.
    - One type registry: wire `type` → direction (`event`, `command`, `status`), payload class
      and field specs `(wire_name, attribute, kind, nullable, allowed_values)`; encode and
      decode are generic over it.
    - `encode(envelope) -> bytes`: compact JSON, `allow_nan=False`, fields in schema order,
      `ts` as `YYYY-MM-DDTHH:MM:SS.mmmZ`, `refId` always present in `error.reported`,
      `message` cut to 200 code points.
    - `decode(raw) -> Valid | Ignored | Malformed` following the design's decode order 1 to 8,
      never raising: size limit, UTF-8, JSON with `NaN`/`Infinity` rejected and non-finite
      floats rejected after parsing, `RecursionError` mapped to `Malformed`; integer `v` > 1
      ignored before other checks; envelope field checks; unknown `type` ignored without
      validating `data`; per-field presence, type (a JSON boolean is never a number), nullability
      and enum checks; undefined `data` fields dropped; the `speak` exactly-one rule; finite
      out-of-range numbers valid. `error.reported` without `refId` decodes with `ref_id=None`.
    - Implement the interim behaviour of the design's F1 and F4 rows (a `ts` without a UTC
      offset is malformed; unknown top-level fields are dropped) without adding them to
      `docs/schema.md`. `v` stays 1.
    - _Requirements: 13.7, 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.10, 22.11, 24.3, 24.5_
  - [x] 6.2 Write the schema table test in `device/tests/test_schema_tables.py`
    - Read `docs/schema.md` from the repository root; take the first-column backtick values of
      the Events, Commands and Status tables, stopping each table at the next heading; skip the
      "Device-internal events (not on the wire)" section; assert each set equals the codec
      registry's set for that direction.
    - Compare the `error.reported` code list with `ErrorCode` and the `state.changed` reason
      values with `Reason`; fail with the differing names.
    - _Requirements: 24.2, 24.4, 24.5_
  - [x] 6.3 Write unit tests for the Message_Codec in `device/tests/test_messages.py`
    - One literal JSON example per type taken from `docs/schema.md`; `ts` formatting; message
      truncation at exactly 200 and 201 code points; `refId` absent on decode; `1e400`; nesting
      beyond the recursion limit; `true` for a number field; `speak` with both and with neither
      of `lineId` and `audioUrl`; an extra `data` field is dropped.
    - _Requirements: 13.7, 22.1, 22.3, 22.6, 22.10, 22.11_
  - [x] 6.4 Create `device/warashi_agent/inbound.py`
    - Frozen `Deduplicator(window, ids)` with `seen` and `accept` (oldest evicted first).
    - `ErrorToPublish(code, ref_id)` and `route_inbound(raw, dedup, device_id)` applying the
      R21.8 steps in order: decode (ignored → `unsupported_version` / `unknown_type`,
      malformed → `malformed_message` with the readable `id`), event or status type received as
      a command → `unknown_type`, wrong `deviceId` → `wrong_device`, duplicate → silent drop,
      otherwise accept the id and return the Command_Event.
    - `to_command_event(env)` sets `ref_id = env.id`; `Speak` drops `ja` and `en`.
    - _Requirements: 12.10, 13.6, 21.8, 22.4, 22.5, 22.7, 22.8, 22.9_
  - [x] 6.5 Write unit tests for the inbound pipeline in `device/tests/test_inbound.py`
    - One message per drop step, checking the step order of R21.8; `ja` and `en` absent from
      the `Speak` event; a duplicate is dropped without an error.
    - _Requirements: 13.6, 21.8, 22.7, 22.8_
  - [x] 6.6 Write property test for the codec and the inbound pipeline (owner property)
    - **Property 4: Schema round trip and robustness** — round trip for every registered type
      with millisecond `ts` and the `ts` regex; no raise for any bytes or JSON value; one broken
      rule gives `Ignored` for `v` > 1 or an unknown type and `Malformed` for each R22.6 rule;
      `route_inbound` maps these to `unsupported_version`, `unknown_type`, `malformed_message`
      and `wrong_device` with the right `refId`; `error.reported` truncation and missing
      `refId`.
    - Test file: `device/tests/test_prop_messages.py`, generators from the type registry and
      the mutation list of the design.
    - **Validates: Requirements 12.10, 21.8, 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7, 22.10, 22.11, 29.6**
  - [x] 6.7 Write property test for the Deduplicator
    - **Property 13: Deduplicator** — for windows in [16, 4096] and id sequences from a small
      alphabet, exactly the repeats within the last `w` accepted ids are dropped (checked
      against a reference list model) and at most `w` ids are held.
    - Test file: `device/tests/test_prop_dedup.py`.
    - **Validates: Requirements 21.8, 22.8, 22.9, 29.14**

- [x] 7. Checkpoint - pure core
  - Ensure all tests pass (`make test` and `make lint`), ask the user if questions arise.

- [x] 8. State_Machine core and test harness
  - [x] 8.1 Create the State_Machine skeleton in `device/warashi_agent/state_machine.py`
    - Phase records (`Sleeping`, `Waking`, `Seeking`, `Gazing`, `Greeting`, `WarningPhase`,
      `Uncertain`, `Cooldown`) and `SnapshotAttempt`, `ScanMove`, `ReactionLine`, `Encounter`,
      `PendingAudio`, `CameraWatch`, `MachineState` with the `state` property, as in the
      design's Data Models.
    - `initial_state(...)` for R1.7, with `mode` and `cloud_connected` parameters for R10.7.
    - `StepContext` with `new_id(kind)` giving `<kind>-<n>-<uid>`, `new_encounter_id()`
      returning the Event `uid`, and emit helpers that keep the last emitted Gaze_Target, the
      last lantern level and the `servos_released` flag up to date.
    - `step()` looking up `STATE_HANDLERS` then `GLOBAL_HANDLERS`; an Event without a handler
      returns the argument unchanged with no Actions; `finalize()` as a pass-through for now
      (completed in task 17.1); a `change_state` helper that emits `state.changed(from, to,
      reason)` first with the current `encounterId`.
    - No import of `time`, `random`, `uuid` or `os`.
    - _Requirements: 1.1, 1.2, 1.4, 1.6, 1.7, 1.8, 1.9_
  - [x] 8.2 Write unit tests for the skeleton in `device/tests/test_state_machine.py`
    - Initial state of R1.7; an `ast` import check that the module imports no `time`,
      `random`, `uuid` or `os`; unhandled Events return an equal state and no Actions; id
      format and distinctness in one call.
    - Add a `without_status(actions)` helper that later flow tests use, so task 17.1 does not
      break them.
    - _Requirements: 1.1, 1.4, 1.7, 1.9_
  - [x] 8.3 Create the reactive harness in `device/tests/harness.py`
    - `run_reactive(data, cfg, lines, *, tick_gap_max, budget)` as the design describes: draws
      Ticks, feedback for pending Actions, stale feedback, PIR edges, connectivity changes and
      Command_Events (`judgement.result` for the current or a random Snapshot_Id, `speak`,
      `gaze`, `lantern`, `mode.set`); non-decreasing `now`; forced Ticks when `tick_gap_max`
      is set; a silent tail of Ticks `T` apart until every Encounter has had Encounter_Bound +
      `T`; returns `(now, event, before, after, actions)` records.
    - Asserts that every input is a defined Event and every output a defined Action.
    - Trace helpers for later properties: split by Encounter, time spent per State.
    - _Requirements: 1.6, 29.2_

- [x] 9. State_Machine flow: waking and seeking
  - [x] 9.1 Implement waking and the first snapshot attempt in `state_machine.py`
    - `pir.rising` in `sleeping` with Mode `guard` and `now − start_time ≥ pir_warmup_s`
      starts an Encounter (`encounterId` = Event uid) and enters `waking` with reason
      `presence`: `presence.detected(source="pir")`, `LanternFade(lantern_wake_level,
      lantern_fade_in_ms)`, `GazeTarget(0, 0, m)`; `fade_done_at` and the waking deadline.
    - Leave `waking` on the waking `servo.arrived` after the fade, on a Tick after the fade once
      arrived, or on the waking deadline Tick; with the cloud connected enter `seeking` with
      reason `arrived` or `timeout` and start a snapshot attempt in the same call. The
      disconnected branch is added in task 14.1.
    - `start_snapshot_attempt`: `TakeSnapshot(s)`, the Current_Snapshot_Id, the snapshot angles
      from the last emitted Gaze_Target, attempt deadline `now + verdict_timeout_s`.
    - `snapshot.ready` for the Current_Snapshot_Id in `seeking` emits `snapshot.captured` with
      Base64 JPEG, width, height and the recorded angles; a stale or out-of-`seeking`
      `snapshot.ready` does nothing; a stale or out-of-`seeking` `snapshot.failed` emits only
      `error.reported` with its code.
    - `cloud.connected` and `cloud.disconnected` only record connectivity (in `seeking` too,
      until task 14.1 adds R3.7).
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 3.1, 3.2, 3.8, 3.9, 9.1, 9.7, 10.3, 10.4_
  - [x] 9.2 Write unit tests for waking and seeking in `device/tests/test_state_machine.py`
    - Exact Actions and order for `sleeping` → `waking` and `waking` → `seeking`; `servo.arrived`
      before and after the fade; the waking deadline; warm-up boundary; Mode `sleep` from
      `initial_state`; `snapshot.captured` Base64 and angles; stale snapshot results;
      connectivity recorded without other change.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 3.1, 3.2, 3.8, 3.9_

- [x] 10. State_Machine flow: verdict and head tracking
  - [x] 10.1 Implement Verdict handling and `gazing` in `state_machine.py`
    - `accept()` with the two thresholds; `Encounter.with_verdict` keeps `family`, `stranger`
      or `uncertain` once set.
    - `on_judgement`: only in `seeking`, no scan move pending, matching Current_Snapshot_Id and
      not yet processed (also after the attempt deadline before the observing Tick); mark the
      attempt processed.
    - `family` or `stranger` with a face → `enter_gazing` with `head_target` on the recorded
      snapshot angles, reason `verdict`; with `face: null` → `greeting` or `warning`, reason
      `verdict`; `uncertain` → `uncertain` with `offline: false`, reason `verdict`; `no_face`
      → `uncertain` with reason `no_face` (task 11.1 adds the scan moves before this).
    - `gazing`: the gazing `servo.arrived` or the deadline Tick enters `greeting` or `warning`
      with reason `arrived` or `timeout`, whatever the connectivity; stale `servo.arrived`
      changes nothing.
    - `enter_greeting`, `enter_warning` and `enter_uncertain` are phase-only helpers here
      (`state.changed` and the phase record with its deadlines); task 12.1 adds the Reaction
      Actions.
    - _Requirements: 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.4, 5.5, 5.6, 5.7, 5.8_
  - [x] 10.2 Write unit tests for Verdict handling in `device/tests/test_state_machine.py`
    - Threshold boundaries (exactly at, just below); a Verdict after the attempt deadline but
      before the observing Tick; a repeated Verdict, a wrong `snapshotId` and a Verdict outside
      `seeking` are ignored; face present and absent; `gazing` arrival and timeout; stale
      arrival in `gazing`.
    - _Requirements: 3.3, 3.4, 4.1, 4.2, 4.3, 4.6, 5.4, 5.5, 5.6, 5.8_

- [x] 11. State_Machine flow: scanning
  - [x] 11.1 Implement scan moves in `state_machine.py`
    - `no_face` with fewer than `scan_attempts_max` scans: `start_scan_move` emits
      `GazeTarget(p, 0, m)` for entry `scans_run + 1` of `scan_pan_positions_deg` Clamped,
      increments `scans_run`, stores `ScanMove(motion_id, deadline)`.
    - The scan `servo.arrived` or the scan deadline Tick clears the move and starts a new
      snapshot attempt in the same call.
    - Scans used up → `uncertain` with `offline: false` and reason `no_face`; a
      `judgement.result` during a pending scan move is ignored; a non-`no_face` Verdict after a
      scan starts no further scan.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_
  - [x] 11.2 Write unit tests for scanning in `device/tests/test_state_machine.py`
    - Scan positions in order and Clamped; `scan_attempts_max = 0`; a judgement during a scan
      move; the new snapshot after arrival and after the deadline uses the scan angles;
      exhaustion gives `uncertain` with reason `no_face`.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

- [x] 12. State_Machine flow: reactions
  - [x] 12.1 Implement the Reaction states in `state_machine.py`
    - `enter_greeting`: record `pan`, `tilt`; `PlayLine(family line, p)`,
      `GazeTarget(pan, tilt − nod_deg)` Clamped, `reaction.performed(family, lineId, false)`;
      nod and line deadlines. Nod return once on the nod `servo.arrived` or the nod deadline.
    - `enter_warning`: nothing audible; on the first Tick at or after `stare_until` emit
      `PlayLine(stranger line, p)` and `reaction.performed(stranger, lineId, false)` and set the
      line deadline.
    - `enter_uncertain(offline)`: `PlayLine(uncertain line, p)` and
      `reaction.performed(uncertain, lineId, offline)`.
    - Line choice with `choose_line(lines, category, event.rand)`; no line → no `PlayLine`,
      `lineId: null`, `error.reported(voice_line_missing)`, and the next Tick enters `cooldown`
      with reason `error`.
    - `audio.finished` / `audio.failed` for the Reaction Play_Id → `cooldown` with reason
      `audio_done`; the line deadline Tick → `cooldown` with reason `timeout`.
    - `PendingAudio` entries for each `PlayLine` (`busy_until = now + audio_timeout_s`); any
      `audio.*` forgets its Play_Id; `audio.failed` with a code other than `interrupted` and
      every `adapter.error` emit `error.reported` with that code; stale audio feedback changes
      nothing else.
    - The `reacted` flag makes every Encounter publish at most one `reaction.performed`.
    - Transitions to `cooldown` use a phase-only `enter_cooldown` that task 13.1 completes.
    - _Requirements: 1.3, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 10.6, 20.9_
  - [x] 12.2 Write unit tests for the Reactions in `device/tests/test_state_machine.py`
    - Exact Actions for each Reaction entry; the nod return; the silent stare and the line at
      `stare_until`; missing line in each Category and the `error` transition; `audio_done`
      and `timeout` transitions; `interrupted` not reported; `adapter.error` reported.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.10, 20.9_
  - [x] 12.3 Write property test for line choice
    - **Property 19: Line choice** — `choose_line` returns `None` exactly for an empty Category,
      otherwise the line at `floor(rand × n)` computed exactly with `fractions.Fraction`; in
      every `run_reactive` trace each Reaction `PlayLine` names
      `choose_line(lines, category, event.rand)`.
    - Test file: `device/tests/test_prop_line_choice.py`.
    - **Validates: Requirements 1.3, 7.1, 7.4, 7.5**

- [x] 13. State_Machine flow: cooldown and return to sleep
  - [x] 13.1 Complete `cooldown` and `enter_sleeping` in `state_machine.py`
    - `enter_cooldown(manual)`: `GazeTarget(0, 0, m)`, glide deadline and `until`.
    - The cooldown `servo.arrived` or the glide deadline Tick emits `ReleaseServos` then
      `LanternFade(0, lantern_fade_out_ms)` once.
    - The first Tick at or after `until` enters `sleeping` with reason `cooldown_done`; one Tick
      past both deadlines applies the release first.
    - `enter_sleeping`: `encounter.ended` with reason `manual` or `cooldown`; `ReleaseServos`
      and `LanternFade(0, 0)` when the R8.4 conditions are unmet; every `PublishEvent` of the
      call carries the ending `encounterId`, then the Encounter is cleared.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 10.1, 10.3_
  - [x] 13.2 Write unit tests for cooldown in `device/tests/test_state_machine.py`
    - Release on arrival and on the deadline; one Tick past both deadlines; the R8.4 backstop
      Actions for a hand-built `cooldown` state whose servos are not released or whose last
      lantern level is not 0; `encounterId` on the sleeping call and `null` afterwards.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 14. State_Machine flow: offline behaviour
  - [x] 14.1 Implement the Offline_Reactions in `state_machine.py`
    - Leaving `waking` with the cloud disconnected enters `uncertain` with `offline: true` and
      reason `offline`, whatever the leaving cause.
    - In `seeking`: `cloud.disconnected` → `uncertain` offline, reason `offline`; `snapshot.failed`
      for the Current_Snapshot_Id → `error.reported` with its code and `uncertain` offline,
      reason `error`; the attempt deadline Tick without a Verdict → `uncertain` offline, reason
      `timeout`.
    - No `TakeSnapshot` while disconnected.
    - _Requirements: 2.6, 3.5, 3.6, 3.7, 9.2, 9.3, 9.4, 9.5, 9.8_
  - [x] 14.2 Write unit tests for offline paths in `device/tests/test_state_machine.py`
    - Disconnected at start (line within 3.1 s with defaults); connected but silent (line within
      11.2 s); disconnect during `seeking`; `camera_failed` and `snapshot_too_large`; the
      reason of each transition.
    - _Requirements: 2.6, 3.5, 3.6, 3.7, 9.2, 9.3, 9.8_
  - [x] 14.3 Write property test for the offline reaction (owner property)
    - **Property 5: Offline reaction** — under the R29.7 preconditions every Encounter emits an
      `uncertain` `PlayLine` in the same call as `reaction.performed(uncertain, same lineId,
      offline: true)`, by `t + Offline_Bound_Disconnected` when disconnected throughout and by
      `t + Offline_Bound_Silent` for any connectivity changes; and every `TakeSnapshot` is
      emitted with the cloud connected before and after the call.
    - Test file: `device/tests/test_prop_offline.py`, `run_reactive(..., tick_gap_max=T)` with
      the two connectivity sub-strategies of the design.
    - **Validates: Requirements 2.6, 3.6, 3.7, 7.5, 9.1, 9.2, 9.3, 9.4, 9.5, 29.7**
  - [x] 14.4 Write property test for liveness (owner property)
    - **Property 2: Liveness** — with no gap longer than `T` between Ticks, every Encounter stays
      in each State no longer than its R10.1 bound, reaches `sleeping` within Encounter_Bound,
      ends with at least one `ReleaseServos`, no `GazeTarget` after the last one and a last
      `LanternFade` of level 0, and emits at most `scan_attempts_max` scan `GazeTarget`s in
      `scan_pan_positions_deg` order.
    - Test file: `device/tests/test_prop_liveness.py`, `line_sets()` with empty Categories and
      Verdicts biased to arrive just before the attempt deadline.
    - **Validates: Requirements 2.4, 3.6, 5.6, 6.5, 7.6, 7.10, 8.1, 8.2, 8.3, 8.4, 10.1, 10.2, 29.4**

- [x] 15. State_Machine flow: PIR debounce
  - [x] 15.1 Implement the debounce rules in `state_machine.py`
    - A global handler records the PIR level for `pir.rising` and `pir.falling` in every State
      and Mode; `pir.falling` changes nothing else.
    - `pir.rising` outside `sleeping`, before the warm-up ends or in Mode `sleep` only records
      the level: no Encounter, no deadline change, no Action.
    - The call that enters `sleeping` never starts an Encounter, whatever the PIR level.
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7_
  - [x] 15.2 Write unit tests for debounce in `device/tests/test_state_machine.py`
    - Bursts of `pir.rising` with equal `now`; edges in every non-`sleeping` State and in
      `cooldown`; a PIR level that stays high through the end of cooldown starts nothing.
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_
  - [x] 15.3 Write property test for PIR debounce
    - **Property 6: PIR debounce** — at most one `reaction.performed` and one
      `presence.detected` per Encounter; every `presence.detected` comes from a `pir.rising` in
      `sleeping`, Mode `guard`, after the warm-up; consecutive `presence.detected` at least
      `cooldown_s` apart; no Encounter starts in a call that enters `sleeping`. The menu's
      `mode.set` toggles take effect once task 16.1 lands; the test needs no change then.
    - Test file: `device/tests/test_prop_debounce.py`.
    - **Validates: Requirements 2.1, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 12.9, 29.8**

- [x] 16. State_Machine flow: manual commands and privacy
  - [x] 16.1 Implement the command handlers in `state_machine.py`
    - `gaze` and `lantern` outside `sleeping` and `cooldown` emit a Clamped `GazeTarget` with a
      new Motion_Id or `LanternFade(clamp(level, 0, 1), clamp(fadeMs, 0, 10000))` and keep the
      State and deadlines; in `sleeping` and `cooldown` they are rejected with
      `command_rejected_state`.
    - `situation_category`, `permitted`, `audio_busy` and `on_speak` in the R12.12 order
      (`unknown_line`, `speak_rejected`, `command_rejected_state`, `audio_busy`);
      `emit_play_line` and `emit_play_audio_url` (only in Situation_Category `family`) add a
      `PendingAudio` with the R12.6 busy window.
    - `reject(ctx, code)` emits exactly one `error.reported` with `refId` = command `id` and
      returns the argument state unchanged.
    - `mode.set`: `sleep` during an Encounter outside `cooldown` sets the Mode and calls
      `enter_cooldown(manual=True)` with reason `manual`; in `sleeping`, `cooldown` or with the
      current Mode only the Mode is set; `guard` never starts an Encounter.
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.11, 12.12, 13.2, 13.3, 13.4, 13.5_
  - [x] 16.2 Write unit tests for commands in `device/tests/test_state_machine.py`
    - Each rejection code with its `refId`; `speak` during the stare; `audio_busy` windows for
      `PlayLine` and `PlayAudioUrl`; `audioUrl` accepted only for `family`; `mode.set` cases
      including `encounter.ended(manual)`; a manual `GazeTarget` used by a later snapshot.
    - _Requirements: 12.1, 12.3, 12.5, 12.6, 12.7, 12.8, 12.9, 12.11, 12.12, 13.2, 13.3, 13.4_
  - [x] 16.3 Write property test for command rejection
    - **Property 20: Command rejection is exact and atomic** — when the oracle finds a code,
      `step()` returns the argument state and exactly one `error.reported` with that code and
      the command `id`; otherwise exactly the single accepted Action and no State, Encounter or
      deadline change.
    - Test file: `device/tests/test_prop_rejections.py`.
    - **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.11, 12.12, 13.2, 13.3, 13.4**
  - [x] 16.4 Write property test for stranger-warning safety (owner property)
    - **Property 3: Stranger-warning safety** — no `stranger` `PlayLine` (Reaction or `speak`)
      and no `reaction.performed(stranger)` in an Encounter whose Accepted_Verdict is `family`;
      every `family` or `stranger` reaction follows a Verdict of that kind at or above its
      threshold; at most one `reaction.performed` per Encounter; nothing audible during the
      stare.
    - Test file: `device/tests/test_prop_stranger_safety.py`, confidences concentrated around
      the thresholds and `speak` `lineId`s mostly from `stranger` lines.
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.6, 7.3, 7.8, 7.9, 13.4, 13.5, 29.5**
  - [x] 16.5 Extend the servo safety property with the `step()` clause (owner property)
    - **Property 1: Servo safety** — extend the single `@given` function in
      `device/tests/test_prop_servo_safety.py`: for all valid Configs and `run_reactive`
      traces with `gaze` commands of any finite value (including ±1e300), every emitted
      `GazeTarget` lies in the Calibrated_Range.
    - **Validates: Requirements 5.7, 6.1, 7.1, 7.2, 12.1, 29.3**

- [x] 17. State_Machine flow: status reports and whole-step properties
  - [x] 17.1 Complete `finalize()` in `state_machine.py`
    - Camera indicator: set `MachineState.camera` when `TakeSnapshot` is emitted; clear it when
      the result for that Snapshot_Id is handled in `seeking` or at the first Tick at or after
      the attempt deadline.
    - Drop finished `PendingAudio` entries only when the State changed.
    - Append exactly one `PublishStatus`, as the last Action, when the State changed,
      `cameraActive` changed, on the first Tick since the Start_Time, or on a Tick at least
      `status_interval_s` after the last one. Data from the returned state: `state`, `mode`,
      `panDeg`, `tiltDeg`, `lantern`, `cameraActive`, `micActive: false`, `motionEnabled`,
      `uptimeSec = floor(now − start_time)`, `agentVersion`.
    - _Requirements: 1.8, 23.1, 23.2, 23.3, 23.4, 23.5_
  - [x] 17.2 Write unit tests for status reports in `device/tests/test_state_machine.py`
    - Status on state change, on `cameraActive` change, on the first Tick and on the interval;
      at most one per call; `uptimeSec` flooring; late snapshot result outside `seeking` leaves
      the indicator until the deadline Tick.
    - _Requirements: 1.8, 23.1, 23.2, 23.3, 23.4, 23.5_
  - [x] 17.3 Write property test for state-change announcements
    - **Property 17: State changes are announced with the R24.4 reason** — exactly one
      `state.changed` with the reason from the test's transcription of the R24.4 table per
      State change and none otherwise; the `PublishStatus` rule and data; `encounterId` on
      every `PublishEvent`; no side effects from cloud events, PIR edges outside `sleeping`,
      stale feedback and accepted commands.
    - Test file: `device/tests/test_prop_state_changes.py`.
    - **Validates: Requirements 1.8, 1.9, 2.7, 8.5, 9.7, 9.8, 10.3, 10.4, 10.6, 23.1, 23.2, 23.3, 23.4, 23.5, 24.4**
  - [x] 17.4 Write property test for determinism
    - **Property 9: Determinism** — two `step(ms, e, now)` calls on a reachable state return
      equal results and leave `ms` equal to a copy taken before.
    - Test file: `device/tests/test_prop_determinism.py`.
    - **Validates: Requirements 1.1, 1.2, 29.11**
  - [x] 17.5 Write property test for identifier freshness
    - **Property 18: Identifier freshness** — new identifiers from two Events that differ only
      in `uid` are disjoint, new identifiers of one kind in one result are distinct, and a new
      `encounterId` equals the Event `uid`.
    - Test file: `device/tests/test_prop_identifiers.py`.
    - **Validates: Requirements 1.4**

- [x] 18. Checkpoint - State_Machine complete
  - Ensure all tests pass (`make test` and `make lint`), ask the user if questions arise.

- [x] 19. Time base, adapter ports and fakes
  - [x] 19.1 Create `device/warashi_agent/timebase.py`
    - `Clock` and `Scheduler` protocols; `MonotonicClock` and a thread-based scheduler with
      cancellable handles for production; `ManualClock` and `ManualScheduler` whose
      `advance(dt)` runs due callbacks in time order, so fakes and Dispatcher tests never sleep.
    - _Requirements: 20.3, 29.2_
  - [x] 19.2 Create `device/warashi_agent/adapters/ports.py`
    - `ServoPort`, `LanternPort`, `PirPort`, `CameraPort`, `AudioPort` protocols as in the
      design; `ProbeResult`; a thread-safe `OnceResult` that lets each Snapshot_Id or Play_Id
      get one result only; a `Runner` protocol (a `Popen` stand-in) shared by the camera and
      audio adapters.
    - _Requirements: 18.8, 19.9, 20.2_
  - [x] 19.3 Implement the fakes in `device/warashi_agent/adapters/fakes.py`
    - `FakeServoDeviceFactory` (records device creations, angle writes with scheduler time,
      detaches and PWM starts), `FakePwmDevice` (records `(time, level)`), `FakeInputDevice`
      (drives `when_activated` / `when_deactivated`), `FakePir` (`rise()` / `fall()` post
      edges), `FakeCamera` (fixed 1×1 JPEG `bytes` constant or a scripted failure after a
      scripted delay), `FakeAudio` (records requests, finishes after a scripted duration or a
      scripted failure, interruption gives `interrupted`, one result per Play_Id).
    - Imports no `gpiozero` or `lgpio`.
    - _Requirements: 15.9, 16.5, 17.4, 18.7, 19.8_
  - [x] 19.4 Write unit tests for the time base in `device/tests/test_timebase.py`
    - `ManualScheduler` runs callbacks in time order and honours cancellation; `OnceResult`
      lets only the first result through; `MonotonicClock` never decreases.
    - _Requirements: 18.8, 19.9, 20.1_
  - [x] 19.5 Write unit tests for the fakes in `device/tests/test_fakes.py`
    - Each fake records what it is given; `FakePir` posts edges in order; `FakeCamera` and
      `FakeAudio` post exactly one result per id, including an interrupted playback.
    - _Requirements: 15.9, 16.5, 17.4, 18.7, 19.8_

- [x] 20. Redaction and Dispatcher with the inbound pipeline
  - [x] 20.1 Create `device/warashi_agent/redact.py`
    - One-line formatters for Events, Actions and envelopes: `jpegBase64` and image bytes
      replaced by their length, `audioUrl` shown as `scheme://host/path`, `ja` and `en`
      removed, no colour codes.
    - _Requirements: 13.6, 21.4, 27.3, 27.7_
  - [x] 20.2 Write unit tests for redaction in `device/tests/test_redact.py`
    - `jpegBase64` replaced by its length; `audioUrl` query removed; `ja` and `en` removed;
      `SnapshotReady` bytes never printed.
    - _Requirements: 13.6, 21.4, 27.3_
  - [x] 20.3 Create `device/warashi_agent/dispatcher.py` and the `CloudLink` protocol
    - In `device/warashi_agent/adapters/cloud.py`: the `CloudLink` protocol (`start(post)`,
      `publish(envelope)`, `stop()`) and the `InboundRaw(payload)` item.
    - `Dispatcher` as in the design: one `queue.Queue`, `post()`, `pump()` for tests, `run()`,
      a Tick thread on the Scheduler, `now` read when an item is removed, `rand` from a
      `random.Random` seeded from `os.urandom` and `uid` from `uuid4()` stamped with
      `dataclasses.replace`.
    - Route Actions in order to the ports without waiting; wrap `PublishEvent` and
      `PublishStatus` in envelopes (`id`, UTC `ts`, Config `deviceId`, the Action's
      `encounterId` or null for status) and pass them to `cloud.publish` in both connectivity
      states.
    - `InboundRaw` goes through `route_inbound`; an `ErrorToPublish` is published as
      `error.reported`; a Command_Event is posted back onto the queue.
    - `step()` exception: log without the event payload, `ReleaseServos` and `LanternFade(0,
      0)`, `error.reported(internal_error)`, and with an Encounter `state.changed(→ sleeping,
      error)` and `encounter.ended(error)`; restart with `initial_state` keeping Start_Time,
      Mode and connectivity.
    - `request_shutdown()` (flag and sentinel only) and `_safe_stop()`: close the hardware gate,
      `emergency_detach()`, `off_now()`, stop Tick, PIR, camera, audio and Cloud_Link; exit code
      0 after a shutdown request and 1 after an escaped exception, which is logged.
    - Log one redacted line per Event other than `tick` and per Action; an optional Action
      observer hook for the `--fake` CLI.
    - _Requirements: 1.5, 9.6, 10.5, 10.7, 12.10, 13.6, 20.1, 20.2, 20.3, 20.4, 20.6, 20.7, 20.8, 21.8, 22.4, 22.5, 22.7, 22.8_
  - [x] 20.4 Write unit tests for the Dispatcher in `device/tests/test_dispatcher.py`
    - Use `ManualClock`, `ManualScheduler` and recording port stubs defined in the test file.
    - `rand` and `uid` stamping; routing order; envelope fields and `encounterId: null` for
      status; publishing while connected and disconnected; inbound errors with their `refId`;
      restart with an injected failing `step` (with and without an Encounter); shutdown request
      and escaped exception: detach and lantern off within the virtual 1 s, no Action after the
      gate closes, exit codes 0 and 1; `adapter.error` and `audio.failed` reported.
    - _Requirements: 1.5, 9.6, 10.5, 10.7, 12.10, 20.1, 20.2, 20.4, 20.6, 20.8, 20.9, 21.8_

- [x] 21. Servo_Adapter
  - [x] 21.1 Implement `device/warashi_agent/adapters/servo.py`
    - `ServoDeviceFactory` protocol; the real factory imports gpiozero and lgpio lazily inside
      its constructor and creates `AngularServo(pin, initial_angle=None, min_angle=-90,
      max_angle=90, min_pulse_width=0.0005, max_pulse_width=0.0024,
      pin_factory=FineLGPIOFactory())`; `FineLGPIOFactory` passes a float duty cycle to
      `lgpio.tx_pwm`.
    - Devices are created only on the first `GazeTarget` and only while `motion_enabled` is
      true; import and startup move nothing.
    - Worker on the Scheduler: plans from the last angle actually written via `plan_glide`,
      writes each angle no earlier than its scheduled time and the interval after the previous
      write, cancels the old plan without `servo.arrived` on a new `GazeTarget`, ignores a
      non-finite target, posts `servo.arrived` on completion (also for an empty plan) and
      detaches `servo_settle_ms` later unless a new plan starts.
    - `motion_enabled = false`: the same schedule, one log line per intended angle, no device,
      no PWM, `pose_file` untouched, `servo.arrived` after the plan duration.
    - `ReleaseServos` and `emergency_detach()` cancel and detach within 50 ms; pose file
      written on detach while enabled (failure logged), read at the first plan with the (0, 0)
      fallback; a worker exception cancels, detaches and posts `adapter.error(adapter_failed)`.
    - _Requirements: 14.5, 14.6, 14.9, 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.10, 15.11, 15.12, 20.10, 20.11_
  - [x] 21.2 Write unit tests in `device/tests/test_servo_adapter.py`
    - With `FakeServoDeviceFactory` and `ManualScheduler`: lazy device creation;
      `initial_angle=None` passed, so no pulse at creation; write timing; auto-detach after
      `servo_settle_ms`; `ReleaseServos` within 50 ms; pose file write, read and fallback for
      missing, garbage, non-finite and out-of-range files; failed pose write; worker exception.
    - _Requirements: 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.10, 15.11, 15.12_
  - [x] 21.3 Write property test for disabled motion
    - **Property 7: `motion_enabled` false never drives a servo** — zero device creations and
      PWM starts, `pose_file` unchanged, one `servo.arrived` at plan start + `duration_s` per
      uncancelled plan, none for cancelled plans.
    - Test file: `device/tests/test_prop_motion_disabled.py`.
    - **Validates: Requirements 14.6, 15.1, 15.2, 15.6, 29.9**
  - [x] 21.4 Write property test for glide arrival time
    - **Property 16: Glide arrival time equals the plan duration** — the last scheduled angle
      is at `t0 + duration_s` (or the plan is empty with duration 0); with motion enabled the
      adapter writes the last angle and posts `servo.arrived` at `t0 + duration_s`, never
      before that write, then detaches `servo_settle_ms` later unless a new plan started.
    - Test file: `device/tests/test_prop_glide_arrival.py`.
    - **Validates: Requirements 14.3, 15.3, 15.4**

- [x] 22. Lantern_Adapter
  - [x] 22.1 Implement `device/warashi_agent/adapters/lantern.py`
    - Pure `fade_levels(start, target, fade_ms)`: Clamp first, steps at most 20 ms apart,
      linear, last entry `(fade_ms, target)`, single `(0, target)` for a zero fade.
    - `LanternAdapter`: level 0 at start; worker plays the levels on the Scheduler; a new fade
      starts from the level last written; `off_now()` cancels and writes 0 within 50 ms and
      keeps 0 until a later `LanternFade`; worker exception posts `adapter.error(adapter_failed)`.
    - Real device factory imports gpiozero lazily: `PWMLED(lantern_pin, initial_value=0,
      frequency=100)`.
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 20.10, 20.11_
  - [x] 22.2 Write property test for lantern fades
    - **Property 21: Lantern fade levels** — offsets non-decreasing with steps ≤ 20 ms, levels
      between start and the Clamped target, the last entry at the Clamped `fade_ms` and target,
      a single entry for a zero fade.
    - Test file: `device/tests/test_prop_lantern_fade.py`.
    - **Validates: Requirements 12.2, 16.1**
  - [x] 22.3 Write unit tests in `device/tests/test_lantern_adapter.py`
    - With `FakePwmDevice`: level 0 at start; a fade interrupted by a new fade; target reached
      by `fade_ms` + 20 ms; `off_now` within 50 ms and the level kept at 0.
    - _Requirements: 16.1, 16.2, 16.3, 16.4_

- [x] 23. PIR_Adapter
  - [x] 23.1 Implement `device/warashi_agent/adapters/pir.py`
    - Input device factory; the real one imports gpiozero lazily and creates
      `DigitalInputDevice(pir_pin, pull_up=False, bounce_time=None)`.
    - `when_activated` posts `pir.rising`, `when_deactivated` posts `pir.falling`; no smoothing,
      debounce or warm-up; no Event for the level at start; `close()`.
    - _Requirements: 17.1, 17.2, 17.3, 17.5_
  - [x] 23.2 Write unit tests in `device/tests/test_pir_adapter.py`
    - With `FakeInputDevice`: edges posted in order; an input already high at start posts
      nothing until it goes low and high again.
    - _Requirements: 17.1, 17.2, 17.3, 17.5_

- [x] 24. Camera_Adapter
  - [x] 24.1 Add the pure `jpeg_size(data)` parser to `device/warashi_agent/adapters/camera.py`
    - Reads the SOF0 or SOF2 marker after any APPn segments; returns `None` on malformed input
      and never raises.
    - _Requirements: 18.3_
  - [x] 24.2 Write property test for the JPEG size parser
    - **Property 23: JPEG size parser** — `None` or a pair of positive integers for any bytes,
      and `(width, height)` for built SOF0/SOF2 headers with optional APPn segments.
    - Test file: `device/tests/test_prop_jpeg_size.py`.
    - **Validates: Requirements 18.3**
  - [x] 24.3 Implement the Camera_Adapter in `device/warashi_agent/adapters/camera.py`
    - `_snapshot` as in the design: `rpicam-still -n -t 500 --width 640 --height 480 -q <q> -o
      <file>` through the `Runner`, qualities 80, 60, 40, one deadline of `camera_timeout_s`
      for the whole operation (terminate, then kill after 0.5 s), `camera_failed` on non-zero
      exit, timeout or a missing or empty file, `snapshot_too_large` after quality 40, files in
      a `TemporaryDirectory` deleted afterwards, one result per Snapshot_Id via `OnceResult`.
    - `probe()`: `rpicam-still --list-cameras` bounded by `probe_timeout_s`, camera line regex,
      hint "Camera not found: check the camera ribbon cable".
    - Unexpected worker exceptions post `adapter.error(adapter_failed)`.
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.8, 20.10, 20.11_
  - [x] 24.4 Write unit tests in `device/tests/test_camera_adapter.py`
    - Create `device/tests/scripted.py` with a `ScriptedRunner` (scripted exit codes,
      durations and written files) for the camera and audio tests.
    - Command line of R18.1; the quality retries; the timeout during a retry; probe parsing and
      the ribbon-cable hint; file deletion.
    - _Requirements: 18.1, 18.2, 18.4, 18.5, 18.6_
  - [x] 24.5 Write property test for camera results
    - **Property 14: Exactly one camera result** — for `TakeSnapshot` sequences at least
      `camera_timeout_s` apart with scripted outcomes, each Snapshot_Id gets exactly one result
      after the scheduler has passed every deadline, each `snapshot.ready` has at most
      `jpeg_max_bytes`, and no temporary file remains. One test function parametrized over the
      Camera_Adapter with `ScriptedRunner` and `FakeCamera`.
    - Test file: `device/tests/test_prop_camera_results.py`.
    - **Validates: Requirements 18.1, 18.2, 18.4, 18.6, 18.8, 29.15**

- [x] 25. Audio_Adapter
  - [x] 25.1 Implement `device/warashi_agent/adapters/audio.py`
    - `PlayLine`: WAV path `voice/<wav>` from the manifest; missing file → `audio_failed`;
      `aplay -q -D <audio_device> <file>` through the `Runner` bounded by `audio_timeout_s`.
    - Interruption: a new request stops the running playback or download and posts
      `audio.failed(interrupted)` for the old Play_Id through `OnceResult`.
    - `PlayAudioUrl`: `HttpsOnlyRedirect`, `download(url, dest, timeout_s, cancel)` with an
      injectable opener, per-read timeout ≤ 2 s, total deadline `download_timeout_s`, cut above
      2,000,000 bytes, `is_pcm16_wav` with the `wave` module; any failure deletes the partial
      file and posts `download_failed`; the file is deleted after playback, failure or
      interruption; URLs logged only as `scheme://host/path`.
    - `probe()`: `aplay -L` bounded by `probe_timeout_s`, PCM names are lines without leading
      whitespace, hint about swapped USB and power cables.
    - Unexpected worker exceptions post `adapter.error(adapter_failed)`.
    - _Requirements: 13.6, 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.9, 20.10, 20.11_
  - [x] 25.2 Write unit tests in `device/tests/test_audio_adapter.py`
    - Add a `ScriptedOpener` to `device/tests/scripted.py`.
    - The `aplay -q -D` command line; timeout; missing WAV; the redirect handler refusing an
      `http` target (called directly); a non-`https` URL; the 2,000,000-byte cut; a non-WAV
      download; file deletion; probe parsing and the hint.
    - _Requirements: 19.1, 19.3, 19.5, 19.6, 19.7_
  - [x] 25.3 Write property test for audio results
    - **Property 15: Exactly one audio result** — for `PlayLine` and `PlayAudioUrl` sequences at
      any spacing with scripted outcomes, each Play_Id gets exactly one result after the
      scheduler has passed every deadline, and no downloaded file remains. One test function
      parametrized over the Audio_Adapter (with `ScriptedRunner` and `ScriptedOpener`) and
      `FakeAudio`.
    - Test file: `device/tests/test_prop_audio_results.py`.
    - **Validates: Requirements 19.3, 19.4, 19.6, 19.9, 29.15**

- [x] 26. Cloud_Link fake and local implementations
  - [x] 26.1 Implement `LocalCloudLink` and `FakeCloudLink`
    - `LocalCloudLink` in `device/warashi_agent/adapters/cloud.py`: `publish` encodes the
      envelope, replaces the `jpegBase64` value with its character count, logs one JSON line;
      delivers no command and never posts `cloud.connected`.
    - `FakeCloudLink` in `device/warashi_agent/adapters/fakes.py`: thread-safe record of
      envelopes in publish order; scripted encoded commands and connectivity changes at given
      clock times through the Scheduler; `type_command(...)`, `go_online()`, `go_offline()`.
    - Both wrap `publish` so it never waits on the network and never raises.
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6_
  - [x] 26.2 Write unit tests in `device/tests/test_cloud_link.py`
    - Local link logs one JSON line with the `jpegBase64` length and never connects; fake link
      records in order and posts scripted connectivity at the given times; `publish` never
      raises when encoding fails.
    - _Requirements: 21.1, 21.4, 21.5_
  - [x] 26.3 Write property test for privacy at Dispatcher level
    - **Property 8: Privacy at Dispatcher level** — with `speak` commands whose `ja`, `en`,
      `audioUrl` query string and an extra `data` field hold `ZQXJ` markers, no published
      envelope and no captured log or printed line contains a marker; every `PlayAudioUrl` is
      emitted in Situation_Category `family`; every `PlayLine` in `stranger` or `uncertain`
      names a line of that Category; every published `error.reported` has a code from the
      R24.1 list.
    - Run through the Dispatcher with the fakes (real Servo and Lantern adapters on fake
      devices), `FakeCloudLink.type_command` and `ManualClock`; install a per-example logging
      handler and `redirect_stdout` / `redirect_stderr`, removed in `finally`.
    - Test file: `device/tests/test_prop_privacy.py`.
    - **Validates: Requirements 13.2, 13.3, 13.5, 13.6, 13.7, 24.5, 29.10**

- [x] 27. CLI and self-test
  - [x] 27.1 Create the keyboard parser in `device/warashi_agent/cli.py`
    - `parse_line(text) -> KeyCommand | HelpRequest | Quit | ParseError` for the R27.2 grammar;
      finite numbers only, `fadeMs` an integer, no clamping; `HELP_TEXT`.
    - A builder that turns a verdict or command into an encoded Wire_Message with a fresh `id`,
      Config `deviceId`, `encounterId: null` and the latest Snapshot_Id, and reports "no
      snapshot is pending" when there is none.
    - _Requirements: 27.2, 27.4_
  - [x] 27.2 Write property test for the keyboard parser
    - **Property 22: Keyboard parser** — `parse_line` never raises; printed grammar lines parse
      back to the same command with unchanged numbers; one non-numeric or non-finite argument,
      or one argument too many or too few, gives `ParseError`.
    - Test file: `device/tests/test_prop_cli_parser.py`.
    - **Validates: Requirements 27.2, 27.4**
  - [x] 27.3 Create `device/warashi_agent/selftest.py`
    - The self-test steps of the design (lantern, servos, PIR for 10 s, camera, audio with the
      first `uncertain` Available_Line, Cloud_Link publish), each bounded by its timeout, with
      PASS, FAIL and SKIP rules, the `motion_enabled` hint, the battery-rail hint, detach and
      lantern off within 1 s at the end, on failure and on a signal, exit 0 or 1.
    - _Requirements: 27.5, 27.6, 27.8, 27.9, 27.10_
  - [x] 27.4 Write unit tests in `device/tests/test_selftest.py`
    - With fakes and `ManualScheduler`: PASS, FAIL and SKIP rows; the hints; exit codes;
      detach and lantern off on interruption.
    - _Requirements: 27.5, 27.6, 27.9, 27.10_
  - [x] 27.5 Implement the entry point in `device/warashi_agent/__main__.py`
    - `argparse` with `--config`, `--fake` and `--selftest`; load the Config and on rejection
      write the message to stderr and exit 2 before any adapter is built.
    - `agent_version` from `importlib.metadata.version("warashi-agent")`, falling back to
      `device/pyproject.toml` with `tomllib`.
    - The startup sequence of the design with injectable factories: Cloud_Link, Voice_Manifest
      (WAV_File_Check off with `--fake`), lantern at 0, Servo_Adapter (pose file read, no
      device), camera and audio probes in parallel, every startup `error.reported` published
      with `encounterId: null`, initial state at loop entry, then PIR and Tick start.
    - Normal mode: real adapters and `LocalCloudLink`, one log line per non-tick Event and per
      Action. `--fake`: fakes, `FakeCloudLink`, `pir_warmup_s` 0, real clock, a stdin reader
      thread mapping keyboard lines to the fakes, one printed line per Action and envelope,
      `quit` or end of input shuts down like SIGINT with exit 0. `--selftest` and
      `--fake --selftest` run `selftest.py`. SIGTERM and SIGINT call `request_shutdown()`.
    - _Requirements: 20.5, 20.6, 20.7, 21.6, 23.4, 25.1, 25.10, 25.11, 26.6, 27.1, 27.2, 27.3, 27.4, 27.7, 27.8, 27.11_
  - [x] 27.6 Write CLI and startup tests
    - `device/tests/test_cli.py`: exit 2 on a rejected Config before any factory is called;
      the `--fake` keyboard flow through a fake stdin with `quit`; unknown input prints help;
      a verdict before any snapshot prints "no snapshot is pending". One subprocess smoke test
      runs `python -m warashi_agent --fake --config <tmp_path>/missing.toml` with `p`,
      `offline` and `quit` on stdin and checks exit 0 and the printed Actions; it is the only
      test that uses the real clock and is bounded by pytest-timeout.
    - `device/tests/test_dispatcher.py`: startup order and the published probe errors, with
      lantern 0 before the loop and no servo device created.
    - _Requirements: 20.5, 25.10, 25.11, 27.1, 27.2, 27.3, 27.4, 27.11_

- [x] 28. Voice manifest, example config and git ignores
  - [x] 28.1 Rewrite `device/warashi_agent/voice/lines.toml`
    - The header comment of the design and the eleven lines of the design table verbatim
      (four `family`, four `stranger`, three `uncertain`), each with `id`, `category`, `ja`,
      `en` and `wav = "<id>.wav"`.
    - _Requirements: 26.1, 26.2_
  - [x] 28.2 Rewrite `device/config.example.toml`
    - The design's version: every Glossary key with its default, `pan_center_offset` and
      `tilt_center_offset` instead of the draft keys, `[aws]` only as comments.
    - _Requirements: 25.12_
  - [x] 28.3 Update `.gitignore`
    - Add `device/warashi_agent/voice/*.wav` and `last_pose.json` on their own lines without
      trailing comments; keep `config.toml`.
    - _Requirements: 25.12, 26.8_
  - [x] 28.4 Write repository tests
    - `device/tests/test_repository.py`: the repository Voice_Manifest loaded with the
      WAV_File_Check disabled has zero rejected lines and at least 3 lines per Category;
      `.gitignore` covers `config.toml`, `last_pose.json` and
      `device/warashi_agent/voice/*.wav`.
    - `device/tests/test_config.py`: `device/config.example.toml` loads with no violation and
      contains every Glossary key.
    - _Requirements: 25.12, 26.2, 26.7, 26.8_

- [x] 29. Systemd unit template and deploy script
  - [x] 29.1 Create `device/systemd/warashi-agent.service`
    - The design's template with `@USER@` and `@WORKDIR@` placeholders, `python3 -m
      warashi_agent`, `Restart=on-failure`, `RestartSec=5`, `RestartPreventExitStatus=2`,
      `KillSignal=SIGTERM`, `TimeoutStopSec=5`, `SupplementaryGroups=gpio video audio`, journal
      output; no host, user or certificate values.
    - _Requirements: 28.1, 28.7_
  - [x] 29.2 Create `scripts/deploy_pi.sh`
    - Bash with `set -euo pipefail`, executable. Steps in the design's order: `PI_HOST` check
      with a placeholder example and exit 1; `PI_DIR` default `~/warashi/device`; `rsync -a`
      with the `mkdir -p` `--rsync-path` and the excludes, no `--delete`; `ssh id -un` with the
      user-name pattern and the root refusal; unit installation with the absolute working
      directory, `sed` on the copied template, `sudo tee`, `daemon-reload` and `enable`;
      restart. Each failing step prints its name and exits non-zero; no later step runs.
    - _Requirements: 28.2, 28.3, 28.4, 28.5, 28.6, 28.7, 28.8_
  - [x] 29.3 Write tests for the unit and the deploy script
    - `device/tests/test_deploy_script.py`: run the script with `bash` and a `PATH` of stub
      `rsync` and `ssh` scripts that record their arguments; `PI_HOST` unset (exit 1, no stub
      called); the excludes and the `PI_DIR` default; user `root` (exit 1, no install); a
      failing step stops later steps; the installed unit has `WorkingDirectory` and `User=`
      filled in.
    - `device/tests/test_repository.py`: the unit template has the R28.1 keys and the two
      placeholders and no host name, user name or certificate value.
    - _Requirements: 28.1, 28.2, 28.3, 28.4, 28.5, 28.6, 28.7, 28.8_

- [x] 30. Makefile wiring
  - [x] 30.1 Update the `Makefile`
    - Keep `setup`, `test` and `lint` working on a laptop with no hardware; pass
      `HYPOTHESIS_PROFILE` through to pytest and document it in the header.
    - Add a `fake` target (`cd device && $(DEVICE_PY) -m warashi_agent --fake`), a `deploy`
      target that runs `scripts/deploy_pi.sh`, and `bash -n scripts/deploy_pi.sh` in
      `lint`.
    - _Requirements: 27.1, 28.3, 29.2_
  - [x] 30.2 Extend `device/tests/test_scaffold.py`
    - Add every new module (`model`, `glide`, `head_tracker`, `voice`, `inbound`, `redact`,
      `timebase`, `dispatcher`, `cli`, `selftest`, every adapter) to the import list and assert
      that importing them loads neither `gpiozero` nor `lgpio`.
    - _Requirements: 15.6, 29.2_

- [x] 31. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass (`make test` and `make lint`), ask the user if questions arise.

## Notes

- No task is optional. Property-based tests are required tasks (R29.1, tech.md), and the plain
  unit and example tests are required too.
- Each property test sub-task names its property number and title from `design.md`, its test
  file from the design's testing table, and the requirement criteria it validates. Property 1
  has one test function that tasks 3.3 and 16.5 build in two steps.
- Task 1 applies S1 to S12 only. F1 to F4 wait for a requirements decision; until then
  `messages.py` implements the interim behaviour of the design's F-table (task 6.1).
- On-device checks (PWM jitter and duty resolution, Q1; real camera, audio and battery rail)
  stay in the design's Risks and Open Questions and the `--selftest` run by the owner. They are
  not tasks here.
- WAV generation (`scripts/generate_voice_lines.*`) is a separate spec; tests and `--fake` run
  with the WAV_File_Check disabled.
- Until task 28.1 rewrites `lines.toml`, `--fake` runs load no Available_Lines (the draft
  manifest has no `category`), so every Reaction follows R7.7. The CLI smoke test in task 27.6
  does not depend on spoken lines.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "2.2"] },
    { "id": 2, "tasks": ["2.3", "2.4", "3.1", "4.1", "5.1", "6.1"] },
    { "id": 3, "tasks": ["3.2", "3.3", "3.4", "4.2", "4.3", "5.2", "5.3", "5.4", "6.2", "6.3", "6.4"] },
    { "id": 4, "tasks": ["3.5", "3.6", "6.5", "6.6", "6.7"] },
    { "id": 5, "tasks": ["7"] },
    { "id": 6, "tasks": ["8.1"] },
    { "id": 7, "tasks": ["8.2", "8.3"] },
    { "id": 8, "tasks": ["9.1"] },
    { "id": 9, "tasks": ["9.2"] },
    { "id": 10, "tasks": ["10.1"] },
    { "id": 11, "tasks": ["10.2"] },
    { "id": 12, "tasks": ["11.1"] },
    { "id": 13, "tasks": ["11.2"] },
    { "id": 14, "tasks": ["12.1"] },
    { "id": 15, "tasks": ["12.2", "12.3"] },
    { "id": 16, "tasks": ["13.1"] },
    { "id": 17, "tasks": ["13.2"] },
    { "id": 18, "tasks": ["14.1"] },
    { "id": 19, "tasks": ["14.2", "14.3", "14.4"] },
    { "id": 20, "tasks": ["15.1"] },
    { "id": 21, "tasks": ["15.2", "15.3"] },
    { "id": 22, "tasks": ["16.1"] },
    { "id": 23, "tasks": ["16.2", "16.3", "16.4", "16.5"] },
    { "id": 24, "tasks": ["17.1"] },
    { "id": 25, "tasks": ["17.2", "17.3", "17.4", "17.5"] },
    { "id": 26, "tasks": ["18"] },
    { "id": 27, "tasks": ["19.1", "19.2", "20.1"] },
    { "id": 28, "tasks": ["19.3", "19.4", "20.2"] },
    { "id": 29, "tasks": ["19.5", "20.3"] },
    { "id": 30, "tasks": ["20.4"] },
    { "id": 31, "tasks": ["21.1", "22.1", "23.1", "24.1", "25.1"] },
    { "id": 32, "tasks": ["21.2", "21.3", "21.4", "22.2", "22.3", "23.2", "24.2", "24.3"] },
    { "id": 33, "tasks": ["24.4"] },
    { "id": 34, "tasks": ["24.5", "25.2"] },
    { "id": 35, "tasks": ["25.3"] },
    { "id": 36, "tasks": ["26.1"] },
    { "id": 37, "tasks": ["26.2", "26.3"] },
    { "id": 38, "tasks": ["27.1", "27.3"] },
    { "id": 39, "tasks": ["27.2", "27.4", "27.5"] },
    { "id": 40, "tasks": ["27.6"] },
    { "id": 41, "tasks": ["28.1", "28.2", "28.3"] },
    { "id": 42, "tasks": ["28.4"] },
    { "id": 43, "tasks": ["29.1", "29.2"] },
    { "id": 44, "tasks": ["29.3"] },
    { "id": 45, "tasks": ["30.1", "30.2"] },
    { "id": 46, "tasks": ["31"] }
  ]
}
```
