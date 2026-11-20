# Requirements Document

## Introduction

`device-core-loop` specifies **warashi-agent**, the Python program in `/device` that runs on the
Raspberry Pi Zero W inside the doll's stand. It implements the P0 core loop from the product
steering: sleep, presence, waking, seeking, gazing, reaction (family greeting, stranger warning or
uncertain line), cooldown, and back to sleep. The loop works with no cloud at all: every
encounter ends in a spoken reaction from cached voice lines and a return to the sleeping state.

The program has five parts:

1. A pure, deterministic **State_Machine** `step(state, event, now) -> (state, actions)` with no I/O.
2. A pure **Glide_Planner** that turns gaze targets into slow, clamped servo steps.
3. Thin hardware **adapters** (servo, lantern, PIR, camera, audio), each with a fake.
4. A **Cloud_Link** interface with a fake and a local-only implementation. The real AWS IoT
   client belongs to the `cloud-judgement` spec.
5. A **Dispatcher** (main loop), a config loader, a voice-line manifest, a CLI, a systemd unit
   template and a deployment script.

Every message on the wire follows `docs/schema.md`. Requirement 24 lists the changes this spec
makes to that draft.

Decisions recorded here:

- Cooldown is a state with a deadline that `step()` checks on Tick events. There are no
  separate start-cooldown or stop-cooldown actions, so `step()` stays the only owner of time.
- After cooldown, a new encounter needs a fresh `pir.rising` edge. A PIR output that stays high
  through the end of cooldown starts no new encounter.
- The State_Machine never calls a random generator. The Dispatcher attaches a random value and a
  fresh UUID to every event, so equal inputs always give equal outputs.
- One table, in Requirement 24 criterion 4, assigns the `reason` of every `state.changed` event.
- A restart after an internal error is defined once, in Requirement 10 criteria 5 and 7.
- The stranger stare is silent: no line of any kind plays during `stare_s`, and `speak` commands
  are rejected until the stranger line has been emitted.
- `status.report` envelopes always carry `encounterId: null`.
- The systemd unit is a template. The deploy script fills in the working directory and the Pi's
  login user, so the repository holds no user names and the service never runs as root.

Out of scope: AWS resources and the real MQTT client (TLS, certificates, topics, reconnect,
last will), the dashboard, live voice conversation (`conversing` state, P1), wake on sound (P2),
nursery-rhyme playback (the owner supplies text and recording later), time-of-day line choice,
and generating the WAV files (`scripts/generate_voice_lines.*`, specified separately).

## Glossary

- **Warashi_Agent**: The whole device program in `/device/warashi_agent`, started with `python -m warashi_agent`.
- **State_Machine**: The pure function `step(state, event, now) -> (state, actions)` in `state_machine.py`. `now` is a monotonic time in seconds supplied by the caller.
- **Machine_State**: The value passed to and returned by `step()`. It holds the current State, the Mode, the cloud connectivity, the PIR level, the Start_Time, the agent version string, the current Encounter, the Accepted_Verdict, the Current_Snapshot_Id with its recorded angles and whether a Verdict for it was processed, the pending Motion_Id, the Play_Id and emit time of each unfinished `PlayLine` and `PlayAudioUrl`, whether the waking `servo.arrived` was received, all deadlines, the last emitted Gaze_Target and lantern level, the `now` of the last `PublishStatus`, the validated Config and the Available_Lines.
- **Start_Time**: The `now` the Dispatcher supplies when it creates the initial Machine_State, which is the `now` of loop entry (Requirement 20 criterion 5). A restart keeps the Start_Time (Requirement 10 criterion 7).
- **State**: One of `sleeping`, `waking`, `seeking`, `gazing`, `greeting`, `warning`, `uncertain`, `cooldown`. `conversing` is reserved for P1 and is never entered in this spec.
- **Mode**: `guard` (default) or `sleep`, set by the `mode.set` command. Mode `sleep` is different from the State `sleeping`.
- **Dispatcher**: The main loop in `__main__.py`. It owns the event queue, the clock, the random source and the adapters. It calls `step()` and hands each Action to an adapter.
- **Event**: An input to `step()`. Every Event carries `rand` (a float in [0, 1)) and `uid` (a fresh UUID v4 string), both supplied by the Dispatcher.
- **Internal_Event**: An Event that exists only inside the device and never goes on the wire: `tick`, `pir.rising`, `pir.falling`, `servo.arrived`, `audio.finished`, `audio.failed`, `snapshot.ready`, `snapshot.failed`, `cloud.connected`, `cloud.disconnected`, `adapter.error`. `adapter.error` carries only a code from the list in Requirement 24 criterion 1.
- **Command_Event**: An Event that wraps a decoded Wire_Message command: `judgement.result`, `speak`, `gaze`, `lantern` or `mode.set`.
- **Tick**: The Internal_Event `tick`, posted by the Dispatcher every `tick_interval_ms`. All deadlines are checked on Ticks.
- **Tick_Lag**: `T = tick_interval_ms / 1000` seconds, the longest delay between a deadline and the Tick that observes it.
- **Action**: An output of `step()`: `LanternFade(level, fade_ms)`, `GazeTarget(pan_deg, tilt_deg, motion_id)`, `ReleaseServos`, `TakeSnapshot(snapshot_id)`, `PlayLine(line_id, play_id)`, `PlayAudioUrl(url, play_id)`, `PublishEvent(type, data, encounter_id)`, `PublishStatus(data)`.
- **Motion_Id / Play_Id / Snapshot_Id**: Identifiers that the State_Machine derives from Event `uid` values. `servo.arrived`, `audio.finished`, `audio.failed`, `snapshot.ready` and `snapshot.failed` carry the identifier of the Action they answer.
- **Current_Snapshot_Id**: The Snapshot_Id of the most recent snapshot attempt of the current Encounter (Requirement 3 criterion 1).
- **Encounter**: One visit, from the `pir.rising` that leaves `sleeping` until the next entry into `sleeping`. Each Encounter has an `encounterId` derived from that Event's `uid`.
- **Verdict**: The `verdict` and `confidence` of a `judgement.result` whose `snapshotId` equals the Current_Snapshot_Id.
- **Accepted_Verdict**: A Verdict after the threshold rule of Requirement 4: `family`, `stranger`, `uncertain` or `no_face`.
- **Reaction**: The single greeting, warning or uncertain response of an Encounter. A Reaction publishes one `reaction.performed` event.
- **Category**: The group of a Voice_Line: `family`, `stranger` or `uncertain`. Reaction kinds and Categories use the same three names.
- **Situation_Category**: `family` while the current Encounter's Accepted_Verdict is `family`. `stranger` while it is `stranger`. `uncertain` in every other case, including outside an Encounter.
- **Offline_Reaction**: An `uncertain` Reaction performed without a Verdict (cloud disconnected, verdict timeout or snapshot failure). The State_Machine publishes it with `offline: true`.
- **Calibrated_Range**: Per axis, angles relative to the calibrated center in `[-pan_limit, +pan_limit]` and `[-tilt_limit, +tilt_limit]`. Angles in Actions and Wire_Messages use this frame.
- **Clamp**: Limiting a value to a closed range. Non-finite numbers are rejected before clamping.
- **Gaze_Target**: The `(pan_deg, tilt_deg)` of a `GazeTarget` Action, in degrees relative to the calibrated center.
- **Glide_Planner**: The pure function that turns (current commanded angle, Gaze_Target, Config) into a timed list of Commanded_Angles per axis.
- **Commanded_Angle**: One servo position written by the Servo_Adapter, produced only by the Glide_Planner.
- **Sweep_Time**: `ceil(2 × max(pan_limit, tilt_limit) / glide_step_deg) × glide_interval_ms / 1000` seconds, the Glide_Planner's time for a full limit-to-limit move.
- **Head_Tracker**: The pure function that turns a face box and the snapshot's head angles into a Gaze_Target (Requirement 5).
- **Servo_Adapter**: Adapter for the pan and tilt servos (gpiozero `AngularServo`).
- **Lantern_Adapter**: Adapter for the lantern LED (PWM through an N-MOSFET).
- **PIR_Adapter**: Adapter for the HC-SR501 PIR sensor. Posts `pir.rising` and `pir.falling`.
- **Camera_Adapter**: Adapter that runs `rpicam-still`.
- **Audio_Adapter**: Adapter that plays WAV files with `aplay` and downloads `audioUrl` files.
- **Cloud_Link**: Interface for publishing envelopes, delivering received commands and reporting connectivity.
- **Fake_Cloud_Link**: A Cloud_Link for tests and `--fake` mode. It records published envelopes and delivers scripted or typed commands.
- **Local_Cloud_Link**: A Cloud_Link for normal mode in this spec. It logs every published envelope and never delivers a command, so the device behaves as offline.
- **Message_Codec**: `messages.py`. Encodes and decodes Wire_Messages as specified in `docs/schema.md`.
- **Wire_Message**: An envelope of `docs/schema.md` (event, command or status).
- **Deduplicator**: The pure component that drops incoming Wire_Messages whose `id` it has already seen.
- **Config**: The validated contents of `config.toml`.
- **Config_Loader**: `config.py`. Loads and validates `config.toml`.
- **Voice_Line**: One manifest entry: `id`, `category`, `ja`, `en`, `wav`.
- **Voice_Manifest**: `warashi_agent/voice/lines.toml`, the list of Voice_Lines.
- **Manifest_Loader**: The component that loads and validates the Voice_Manifest.
- **WAV_File_Check**: The check of Requirement 26 criterion 6. It is enabled in every CLI mode without `--fake`, disabled with `--fake`, and may be disabled by tests.
- **Available_Line**: A valid Voice_Line whose WAV file exists and has the required format, or, while the WAV_File_Check is disabled, any valid Voice_Line.
- **CLI**: The command-line interface of `python -m warashi_agent`.
- **Deploy_Script**: `scripts/deploy_pi.sh`.
- **Systemd_Unit**: `device/systemd/warashi-agent.service`, a unit template whose `WorkingDirectory` and `User=` the Deploy_Script fills in at install time.
- **Encounter_Bound**: `L = waking_timeout_s + (scan_attempts_max + 1) × (verdict_timeout_s + glide_timeout_s) + stare_s + audio_timeout_s + cooldown_s + (2 × scan_attempts_max + 6) × T` seconds. With the defaults below, L = 3 + 4 × (8 + 3) + 2 + 12 + 20 + 12 × 0.1 = 82.2 s.
- **Offline_Bound_Disconnected**: `waking_timeout_s + T` seconds (default 3.1 s).
- **Offline_Bound_Silent**: `waking_timeout_s + verdict_timeout_s + 2 × T` seconds (default 11.2 s).

### Configuration keys and defaults

Criteria refer to these keys by name. The defaults are the only place where default numbers appear.

| Section | Key | Default | Allowed values | Purpose |
|---|---|---|---|---|
| `device` | `id` | `"warashi-01"` | 1–64 chars of `a-z`, `0-9`, `-` | `deviceId` in envelopes |
| `pins` | `pir_pin` | 17 | BCM 2–27, all pins distinct | PIR OUT |
| `pins` | `pan_pin` | 18 | BCM 2–27, all pins distinct | Pan servo signal |
| `pins` | `tilt_pin` | 13 | BCM 2–27, all pins distinct | Tilt servo signal |
| `pins` | `lantern_pin` | 23 | BCM 2–27, all pins distinct | Lantern MOSFET gate |
| `motion` | `motion_enabled` | `false` | boolean | Servo PWM output allowed |
| `servo` | `pan_center_offset` | 0 | number; `abs(pan_center_offset) + pan_limit ≤ 90` | Calibrated pan center (degrees) |
| `servo` | `tilt_center_offset` | 0 | number; `abs(tilt_center_offset) + tilt_limit ≤ 90` | Calibrated tilt center (degrees) |
| `servo` | `pan_limit` | 30 | 0 < value ≤ 60 | Pan travel from center (degrees) |
| `servo` | `tilt_limit` | 20 | 0 < value ≤ 30 | Tilt travel from center (degrees) |
| `servo` | `pan_invert` | `false` | boolean | Flip pan direction |
| `servo` | `tilt_invert` | `false` | boolean | Flip tilt direction |
| `servo` | `glide_step_deg` | 2 | 0 < value ≤ 2 | Largest change between Commanded_Angles (degrees) |
| `servo` | `glide_interval_ms` | 30 | 30 ≤ value ≤ 1000 | Smallest time between Commanded_Angles |
| `servo` | `servo_settle_ms` | 300 | 0 < value ≤ 2000 | Delay before auto-detach after a glide |
| `servo` | `nod_deg` | 8 | 0 < value ≤ tilt_limit | Depth of the greeting nod (degrees) |
| `servo` | `pose_file` | `"last_pose.json"` | path | Last Commanded_Angles, kept across restarts |
| `lantern` | `lantern_wake_level` | 0.8 | 0 < value ≤ 1 | Lantern level during an Encounter |
| `lantern` | `lantern_fade_in_ms` | 1500 | 0 < value ≤ 10000 | Fade-in time on waking |
| `lantern` | `lantern_fade_out_ms` | 2000 | 0 < value ≤ 10000 | Fade-out time in cooldown |
| `camera` | `camera_hfov_deg` | 54 | 0 < value ≤ 180 | Horizontal field of view |
| `camera` | `camera_vfov_deg` | 41.8 | 0 < value ≤ 180 | Vertical field of view: `2 × atan(tan(54°/2) × 3/4)` for the 4:3 image |
| `camera` | `jpeg_max_bytes` | 90000 | integer, 10000 ≤ value ≤ 90000 | Largest raw JPEG in `snapshot.captured` |
| `camera` | `scan_pan_positions_deg` | `[-15, 15, 0]` | list of finite numbers | Pan positions scanned when no face is seen |
| `camera` | `scan_attempts_max` | 3 | integer, 0 ≤ value ≤ length of `scan_pan_positions_deg` | Scan snapshots after the first snapshot |
| `judgement` | `family_confidence_min` | 0.80 | 0 < value ≤ 1 | Lowest confidence accepted as `family` |
| `judgement` | `stranger_confidence_min` | 0.80 | 0 < value ≤ 1 | Lowest confidence accepted as `stranger` |
| `timing` | `tick_interval_ms` | 100 | 10 ≤ value ≤ 1000 | Tick period |
| `timing` | `pir_warmup_s` | 60 | 0 ≤ value ≤ 120 | PIR edges ignored after startup |
| `timing` | `waking_timeout_s` | 3 | > 0 | Longest time in `waking` |
| `timing` | `verdict_timeout_s` | 8 | > 0 | Longest wait from snapshot request to Verdict, per attempt |
| `timing` | `glide_timeout_s` | 3 | > 0 | Longest wait for `servo.arrived` |
| `timing` | `stare_s` | 2 | > 0 | Silent stare before the stranger line |
| `timing` | `audio_timeout_s` | 12 | > 0 | Longest playback; also the reaction deadline after `PlayLine` |
| `timing` | `camera_timeout_s` | 5 | > 0 and < `verdict_timeout_s` | Longest `rpicam-still` run |
| `timing` | `download_timeout_s` | 5 | > 0 | Longest `audioUrl` download |
| `timing` | `probe_timeout_s` | 5 | > 0 | Longest startup device probe |
| `timing` | `cooldown_s` | 20 | > 0 and ≥ `glide_timeout_s + lantern_fade_out_ms / 1000` | Time in `cooldown` |
| `timing` | `status_interval_s` | 60 | > 0 | Period of `status.report` |
| `audio` | `audio_device` | `"plughw:CARD=Device,DEV=0"` | ALSA name selecting the card by name | Playback device |
| `messages` | `dedup_window_size` | 256 | 16 ≤ value ≤ 4096 | Remembered incoming message ids |
| `privacy` | `blocked_words` | `[]` | list of non-empty strings | Words that no Voice_Line may contain (the owner may list family names on the Pi only) |
| `aws` | (any) | absent | free-form, optional | Reserved for the `cloud-judgement` spec; unused here |

## Requirements

### Requirement 1: Pure and deterministic State_Machine

**User Story:** As the developer, I want all decisions in one pure function, so that property-based tests can check every behaviour without hardware, clocks or randomness.

#### Acceptance Criteria

1. THE State_Machine SHALL compute its result only from the Machine_State, the Event and `now`, without reading a clock, a random generator, files, the network or global mutable data.
2. FOR ALL Machine_States, Events and values of `now`, two calls of `step()` with equal arguments SHALL return equal Machine_States and equal Action lists.
3. WHEN the State_Machine must choose a Voice_Line, THE State_Machine SHALL take the `n` Available_Lines of the required Category sorted by `id` in ascending code-point order and, for `n` ≥ 1, choose the line at index `floor(rand × n)`, where `rand` is the value carried by the Event of that `step()` call. For `n` = 0, Requirement 7 criterion 7 applies.
4. WHEN the State_Machine needs a new identifier (Encounter, Snapshot_Id, Motion_Id or Play_Id), THE State_Machine SHALL derive the identifier from the current Event's `uid` only. Events with different `uid` values SHALL yield different identifiers, and two identifiers of the same kind created in one `step()` call SHALL differ.
5. THE Dispatcher SHALL attach a value `rand` in [0, 1) and a fresh UUID v4 `uid` to every Event before calling `step()`.
6. THE State_Machine SHALL accept the Internal_Events and Command_Events defined in the Glossary as its only inputs and SHALL produce only the Actions defined in the Glossary.
7. WHEN the Dispatcher creates the initial Machine_State at Warashi_Agent startup, THE State_Machine SHALL start in State `sleeping`, Mode `guard`, cloud disconnected, lantern level 0, servos released, PIR level low and no current Encounter, and SHALL record the `now` supplied at creation as the Start_Time (used by Requirement 2 criterion 1, Requirement 11 criterion 5 and `uptimeSec` in Requirement 23).
8. WHEN a `step()` call changes the State, THE State_Machine SHALL emit in that call one `PublishEvent` of type `state.changed` per State change, with `from`, `to` and the `reason` that Requirement 24 criterion 4 assigns. It SHALL also emit exactly one `PublishStatus`, whose data reflects the Machine_State returned by that call. The `state.changed` that leaves `sleeping` SHALL carry the new Encounter's `encounterId`, and the `state.changed` that enters `sleeping` SHALL carry the ending Encounter's `encounterId`.
9. IF an Event arrives for which no criterion of this document specifies a response in the current State and Mode (for example `servo.arrived` or `audio.finished` carrying a Motion_Id or Play_Id the State_Machine is not waiting for), THEN THE State_Machine SHALL return the Machine_State unchanged and emit no Action.

### Requirement 2: Encounter start and waking

**User Story:** As a family member, I want the doll to light its lantern and face forward when someone approaches, so that it looks awake and the camera can see.

#### Acceptance Criteria

1. WHILE the State is `sleeping` and the Mode is `guard`, WHEN `pir.rising` arrives with `now` minus the Start_Time at least `pir_warmup_s`, THE State_Machine SHALL start a new Encounter, enter `waking`, and emit `PublishEvent` of type `presence.detected` with `source: "pir"` and the new Encounter's `encounterId`.
2. WHEN the State_Machine enters `waking`, THE State_Machine SHALL emit `LanternFade(lantern_wake_level, lantern_fade_in_ms)` and `GazeTarget(0, 0, motion_id)`.
3. WHILE the State is `waking`, WHEN `servo.arrived` for the waking Motion_Id arrives with `now` at or after entry time + `lantern_fade_in_ms / 1000`, or a Tick arrives with `now` at or after entry time + `lantern_fade_in_ms / 1000` after that `servo.arrived` has been received, THE State_Machine SHALL leave `waking` in that `step()` call.
4. WHILE the State is `waking`, WHEN a Tick arrives at or after entry time + `waking_timeout_s`, THE State_Machine SHALL leave `waking`.
5. WHEN the State_Machine leaves `waking` and the cloud is connected in that `step()` call, THE State_Machine SHALL enter `seeking` and start the first snapshot attempt (Requirement 3 criterion 1) in the same `step()` call.
6. WHEN the State_Machine leaves `waking` and the cloud is disconnected in that `step()` call, THE State_Machine SHALL enter `uncertain` as an Offline_Reaction (Requirements 7 and 9) in the same `step()` call.
7. WHILE the State is `waking`, WHEN `cloud.connected` or `cloud.disconnected` arrives, THE State_Machine SHALL record the new connectivity and keep the State and deadlines.

### Requirement 3: Seeking and snapshots

**User Story:** As a family member, I want the doll to take one snapshot at a time and send it for a verdict, so that it learns who is there without streaming video.

#### Acceptance Criteria

1. WHEN the State_Machine enters `seeking` (Requirement 2 criterion 5) or a scan move ends (Requirement 6 criterion 2), THE State_Machine SHALL start a snapshot attempt. It SHALL emit `TakeSnapshot(snapshot_id)` with a new Snapshot_Id, make that Snapshot_Id the Current_Snapshot_Id, record the last emitted Gaze_Target as that snapshot's angles, and set the attempt deadline to the `now` of that `step()` call + `verdict_timeout_s`.
2. WHILE the State is `seeking`, WHEN `snapshot.ready` arrives for the Current_Snapshot_Id, THE State_Machine SHALL emit `PublishEvent` of type `snapshot.captured`. The event SHALL carry `snapshotId`; `width` and `height` from `snapshot.ready`; `panDeg` and `tiltDeg` equal to the snapshot's angles recorded under criterion 1 (the values Requirement 5 criterion 3 uses); and `jpegBase64` holding the Base64 encoding of the JPEG bytes from `snapshot.ready`.
3. WHILE the State is `seeking`, WHEN a Verdict arrives for the Current_Snapshot_Id and no earlier Verdict for that Snapshot_Id has been processed, THE State_Machine SHALL map the Verdict to an Accepted_Verdict (Requirement 4). It SHALL then continue with head tracking (Requirement 5) for `family` or `stranger`, scanning (Requirement 6) for `no_face`, or the `uncertain` Reaction with `offline: false` for `uncertain`. This applies also when `now` is at or after the attempt deadline but no Tick has yet observed the deadline (Requirement 10 criterion 3).
4. IF a `judgement.result` arrives whose `snapshotId` differs from the Current_Snapshot_Id, or whose `snapshotId` already had a Verdict processed under criterion 3, or that arrives outside `seeking`, THEN THE State_Machine SHALL leave the Machine_State unchanged and emit no Action.
5. WHILE the State is `seeking`, IF `snapshot.failed` arrives for the Current_Snapshot_Id, THEN THE State_Machine SHALL emit `PublishEvent` of type `error.reported` with the code carried by `snapshot.failed` (`camera_failed` or `snapshot_too_large`) and enter `uncertain` as an Offline_Reaction.
6. WHILE the State is `seeking`, IF a Tick arrives with `now` at or after the attempt deadline and no Verdict for the Current_Snapshot_Id has arrived, THEN THE State_Machine SHALL enter `uncertain` as an Offline_Reaction.
7. WHILE the State is `seeking`, WHEN `cloud.disconnected` arrives, THE State_Machine SHALL enter `uncertain` as an Offline_Reaction in the same `step()` call.
8. IF `snapshot.ready` arrives for a Snapshot_Id other than the Current_Snapshot_Id, or arrives outside `seeking`, THEN THE State_Machine SHALL emit no Action and change no State, deadline or Encounter, so that no `snapshot.captured` is published for a stale snapshot.
9. IF `snapshot.failed` arrives for a Snapshot_Id other than the Current_Snapshot_Id, or arrives outside `seeking`, THEN THE State_Machine SHALL emit only `PublishEvent` of type `error.reported` with the code carried by `snapshot.failed`, and change no State, deadline or Encounter.

### Requirement 4: Confidence thresholds

**User Story:** As a family member, I want low-confidence verdicts treated as uncertain, so that the doll never warns me as a stranger or greets a stranger as family by mistake.

#### Acceptance Criteria

1. WHEN a Verdict is `family` with `confidence` ≥ `family_confidence_min`, THE State_Machine SHALL set the Accepted_Verdict to `family`.
2. WHEN a Verdict is `stranger` with `confidence` ≥ `stranger_confidence_min`, THE State_Machine SHALL set the Accepted_Verdict to `stranger`.
3. WHEN a Verdict is `family` with `confidence` < `family_confidence_min`, or `stranger` with `confidence` < `stranger_confidence_min`, THE State_Machine SHALL set the Accepted_Verdict to `uncertain`.
4. WHEN a Verdict is `uncertain`, THE State_Machine SHALL set the Accepted_Verdict to `uncertain`.
5. WHEN a Verdict is `no_face`, THE State_Machine SHALL set the Accepted_Verdict to `no_face`.
6. WHEN the Accepted_Verdict of an Encounter has become `family`, `stranger` or `uncertain`, THE State_Machine SHALL keep that Accepted_Verdict until the Encounter ends.

### Requirement 5: Head tracking

**User Story:** As a family member, I want the doll to turn its head toward the person it sees, so that it seems to look at them.

#### Acceptance Criteria

1. THE Head_Tracker SHALL Clamp each face box field (`left`, `top`, `width`, `height`) to [0, 1] and compute the face center `cx = min(1, left + width / 2)` and `cy = min(1, top + height / 2)`.
2. THE Head_Tracker SHALL compute the pan correction as `(cx − 0.5) × camera_hfov_deg` and the tilt correction as `(0.5 − cy) × camera_vfov_deg`, so that a face right of center gives positive pan and a face above center gives positive tilt.
3. THE Head_Tracker SHALL compute the Gaze_Target as the snapshot pan angle plus the pan correction and the snapshot tilt angle plus the tilt correction, each Clamped to the Calibrated_Range. The snapshot angles are the last emitted Gaze_Target in the `step()` call that emitted `TakeSnapshot` for the Verdict's Snapshot_Id (Requirement 3 criterion 1).
4. WHILE the State is `seeking`, WHEN a Verdict for the Current_Snapshot_Id is accepted as `family` or `stranger` and the `judgement.result` has a non-null `face`, THE State_Machine SHALL emit `GazeTarget` with the Head_Tracker result and a new Motion_Id, and enter `gazing` with `state.changed` reason `verdict`.
5. WHILE the State is `seeking`, WHEN a Verdict for the Current_Snapshot_Id is accepted as `family` or `stranger` and `face` is null, THE State_Machine SHALL enter the Reaction state directly (`greeting` for `family`, `warning` for `stranger`) with `state.changed` reason `verdict`.
6. WHILE the State is `gazing`, WHEN `servo.arrived` for the gazing Motion_Id arrives or the first Tick at or after entry time + `glide_timeout_s` arrives, THE State_Machine SHALL enter `greeting` for `family` or `warning` for `stranger`, with `state.changed` reason `arrived` or `timeout` respectively, whether or not the cloud is connected.
7. THE State_Machine SHALL Clamp every `GazeTarget` it emits to the Calibrated_Range.
8. IF `servo.arrived` arrives with a Motion_Id other than the one the current State is still waiting for under Requirement 2 criterion 3, criterion 6 of this requirement, Requirement 6 criterion 2, Requirement 7 criterion 2 or Requirement 8 criterion 2, THEN THE State_Machine SHALL leave the State, the Encounter and every deadline unchanged and emit no Action.

### Requirement 6: Scanning when no face is seen

**User Story:** As a family member, I want the doll to look around a little when it sees nobody, so that it finds a person standing to one side.

#### Acceptance Criteria

1. WHILE the State is `seeking`, WHEN a Verdict for the Current_Snapshot_Id is accepted as `no_face` and fewer than `scan_attempts_max` scan attempts have run in the Encounter, THE State_Machine SHALL emit `GazeTarget(p, 0, motion_id)` with a new Motion_Id, where `p` is entry k (counting from 1) of `scan_pan_positions_deg` Clamped to the Calibrated_Range, k is the number of scan attempts already run plus 1, and the scan attempt counts as run from this `step()` call.
2. WHILE the State is `seeking` and a scan move is pending (from the `step()` call that emitted the scan `GazeTarget` until the next snapshot attempt starts), WHEN `servo.arrived` for the scan Motion_Id arrives or the first Tick at or after the move start + `glide_timeout_s` arrives, THE State_Machine SHALL start a new snapshot attempt (Requirement 3 criterion 1) in the same `step()` call.
3. WHILE the State is `seeking`, WHEN a Verdict for the Current_Snapshot_Id is accepted as `no_face` and `scan_attempts_max` scan attempts have run in the Encounter (including the first snapshot when `scan_attempts_max` is 0), THE State_Machine SHALL enter `uncertain` with `offline: false` and `state.changed` reason `no_face`.
4. WHILE the State is `seeking` and at least one scan attempt has run in the Encounter, WHEN a Verdict for the Current_Snapshot_Id is accepted as `family`, `stranger` or `uncertain`, THE State_Machine SHALL start no further scan move and continue as Requirement 3 criterion 3 specifies.
5. THE State_Machine SHALL use the scan positions in the order of `scan_pan_positions_deg` and SHALL run at most `scan_attempts_max` scan attempts per Encounter.
6. WHILE a scan move is pending, WHEN a `judgement.result` arrives, THE State_Machine SHALL leave the Machine_State unchanged and emit no Action.

### Requirement 7: Reactions

**User Story:** As a family member, I want one clear reaction per visit (a greeting for us, a silent stare and eerie line for strangers, a cautious line otherwise), so that the doll has its character and never repeats itself.

#### Acceptance Criteria

1. WHEN the State_Machine enters `greeting`, THE State_Machine SHALL record the last emitted Gaze_Target as `pan` and `tilt`, and emit `PlayLine` with a `family` Voice_Line and a new Play_Id, `GazeTarget(pan, tilt − nod_deg, motion_id)` Clamped to the Calibrated_Range with a new Motion_Id, and `PublishEvent` of type `reaction.performed` with `kind: "family"`, the `lineId` and `offline: false`.
2. WHILE the State is `greeting` and the nod return has not been emitted, WHEN `servo.arrived` for the nod Motion_Id arrives or the first Tick at or after entry time + `glide_timeout_s` arrives, THE State_Machine SHALL emit `GazeTarget(pan, tilt, motion_id)` once, with the `pan` and `tilt` recorded in criterion 1 and a new Motion_Id, to finish the nod.
3. WHILE the State is `warning` and `now` is earlier than entry time + `stare_s`, THE State_Machine SHALL emit no `PlayLine` of any kind and no `reaction.performed`, and SHALL reject `speak` commands as Requirement 12 criterion 11 specifies.
4. WHILE the State is `warning`, WHEN the first Tick at or after entry time + `stare_s` arrives, THE State_Machine SHALL emit `PlayLine` with a `stranger` Voice_Line and a new Play_Id, and `PublishEvent` of type `reaction.performed` with `kind: "stranger"`, the `lineId` and `offline: false`.
5. WHEN the State_Machine enters `uncertain`, THE State_Machine SHALL emit `PlayLine` with an `uncertain` Voice_Line and `PublishEvent` of type `reaction.performed` with `kind: "uncertain"`, the `lineId`, and `offline: true` for an Offline_Reaction or `offline: false` otherwise.
6. WHILE the State is `greeting`, `warning` or `uncertain` and the Reaction's `PlayLine` has been emitted, WHEN `audio.finished` or `audio.failed` for that Play_Id arrives, or the first Tick at or after the `now` of the `step()` call that emitted that `PlayLine` + `audio_timeout_s` arrives, THE State_Machine SHALL enter `cooldown` with `state.changed` reason `audio_done` for the audio Event or `timeout` for the Tick.
7. IF the required Category has no Available_Line when criterion 1, 4 or 5 would emit the Reaction's `PlayLine`, THEN THE State_Machine SHALL emit no `PlayLine`, emit the other Actions of that criterion, publish `reaction.performed` with the `kind` and `offline` value of that criterion and `lineId: null`, and emit `PublishEvent` of type `error.reported` with code `voice_line_missing`.
8. THE State_Machine SHALL perform at most one Reaction and publish at most one `reaction.performed` event per Encounter.
9. WHILE the Accepted_Verdict of the Encounter is `family`, THE State_Machine SHALL emit no `PlayLine` of a `stranger` Voice_Line and no `reaction.performed` with `kind: "stranger"`.
10. WHILE the State is `greeting`, `warning` or `uncertain`, WHEN the first Tick after the `step()` call that applied criterion 7 arrives, THE State_Machine SHALL enter `cooldown` with `state.changed` reason `error`.

### Requirement 8: Cooldown and return to sleep

**User Story:** As the owner, I want every encounter to end with the head at center, the servos detached and the lantern off, so that the doll rests safely and the next start does not jump.

#### Acceptance Criteria

1. WHEN the State_Machine enters `cooldown`, THE State_Machine SHALL emit `GazeTarget(0, 0, motion_id)`.
2. WHILE the State is `cooldown` and no `ReleaseServos` has been emitted since entry, WHEN `servo.arrived` for the cooldown Motion_Id arrives or the first Tick at or after entry time + `glide_timeout_s` arrives, THE State_Machine SHALL emit `ReleaseServos` followed by `LanternFade(0, lantern_fade_out_ms)` in the same `step()` call.
3. WHILE the State is `cooldown`, WHEN the first Tick at or after entry time + `cooldown_s` arrives, THE State_Machine SHALL enter `sleeping` with `state.changed` reason `cooldown_done` and emit `PublishEvent` of type `encounter.ended`. The `encounter.ended` reason is `manual` when Requirement 12 criterion 7 started this cooldown, and `cooldown` otherwise, including when `mode.set` arrives during the cooldown (Requirement 12 criterion 8).
4. WHEN the State_Machine enters `sleeping`, THE State_Machine SHALL ensure that the last lantern Action emitted in the Encounter is `LanternFade` with level 0 and that no `GazeTarget` follows the last `ReleaseServos`, by emitting `ReleaseServos` and `LanternFade(0, 0)` in the same `step()` call when either condition is unmet.
5. WHEN the State_Machine enters `sleeping`, THE State_Machine SHALL emit every `PublishEvent` of that `step()` call (including `state.changed` and `encounter.ended`) with the ending Encounter's `encounterId`, then clear the current Encounter, so that `PublishEvent` Actions of later `step()` calls carry `encounterId: null` until a new Encounter starts.

### Requirement 9: Offline behaviour

**User Story:** As a family member, I want the doll to react even when the Wi-Fi or the cloud is down, so that it never seems broken.

#### Acceptance Criteria

1. THE State_Machine SHALL treat the cloud as disconnected from startup until `cloud.connected` arrives, and after each `cloud.disconnected`.
2. WHILE the cloud stays disconnected and at least one `uncertain` Available_Line exists, WHEN `pir.rising` starts an Encounter at time `t`, THE State_Machine SHALL emit `PlayLine` with an `uncertain` Voice_Line, in the same `step()` call as `reaction.performed` with `offline: true`, no later than `t` + Offline_Bound_Disconnected, given Ticks at most `T` apart and no `mode.set` with `mode: "sleep"` before that `PlayLine`.
3. WHILE no `judgement.result` arrives and at least one `uncertain` Available_Line exists, WHEN `pir.rising` starts an Encounter at time `t`, THE State_Machine SHALL emit `PlayLine` with an `uncertain` Voice_Line, in the same `step()` call as `reaction.performed` with `offline: true`, no later than `t` + Offline_Bound_Silent, whatever the connectivity changes during the Encounter, given Ticks at most `T` apart and no `mode.set` with `mode: "sleep"` before that `PlayLine`.
4. WHEN the State_Machine performs an Offline_Reaction, THE State_Machine SHALL publish `reaction.performed` with `kind: "uncertain"` and `offline: true`.
5. WHILE the cloud is disconnected, THE State_Machine SHALL emit no `TakeSnapshot` Action.
6. THE State_Machine SHALL emit `PublishEvent` and `PublishStatus` Actions regardless of connectivity, and THE Dispatcher SHALL pass each resulting envelope to the Cloud_Link `publish(envelope)` in both connectivity states.
7. WHEN `cloud.connected` arrives in any State, or `cloud.disconnected` arrives in any State other than `seeking`, THE State_Machine SHALL record the connectivity, keep the State, Encounter and deadlines unchanged, and emit no Action.
8. WHEN the State_Machine enters `uncertain` as an Offline_Reaction because the cloud is disconnected (Requirement 2 criterion 6 or Requirement 3 criterion 7), THE State_Machine SHALL emit `state.changed` with `reason: "offline"`, as Requirement 24 criterion 4 assigns.

### Requirement 10: Liveness and per-state deadlines

**User Story:** As the owner, I want every state outside sleeping to have a hard time limit, so that the doll never gets stuck when expected feedback (arrival, audio, verdict) never comes.

#### Acceptance Criteria

1. THE State_Machine SHALL leave each State no later than the bound in this table, given Ticks at most `T` apart:

   | State | Leaves on | Maximum time in State |
   |---|---|---|
   | `waking` | Requirement 2 | `waking_timeout_s + T` |
   | `seeking` | Requirements 3 and 6 | `(scan_attempts_max + 1) × verdict_timeout_s + scan_attempts_max × glide_timeout_s + (2 × scan_attempts_max + 1) × T` |
   | `gazing` | Requirement 5 | `glide_timeout_s + T` |
   | `greeting` | Requirement 7 | `audio_timeout_s + T` |
   | `warning` | Requirement 7 | `stare_s + audio_timeout_s + 2 × T` |
   | `uncertain` | Requirement 7 | `audio_timeout_s + T` |
   | `cooldown` | Requirement 8 | `cooldown_s + T` |

2. FOR ALL Event sequences in which consecutive Ticks are at most `T` apart, THE State_Machine SHALL enter `sleeping` no later than Encounter_Bound seconds after the `pir.rising` that started the Encounter.
3. THE State_Machine SHALL measure every deadline from the `now` of the `step()` call that entered the State or started the attempt, scan move or Reaction line. It SHALL make deadline-driven State changes only in `step()` calls for Ticks, at the first Tick whose `now` is at or after the deadline, and handle a non-Tick Event whose `now` is at or after a deadline by that Event's own rule. Each such change SHALL emit `state.changed` with the `reason` that Requirement 24 criterion 4 assigns: `timeout`, except `cooldown_done` for `cooldown` to `sleeping` and `offline` for `waking` to `uncertain` (Requirement 9 criterion 8).
4. THE State_Machine SHALL set a new deadline only when entering a State or starting a snapshot attempt, scan move, stare or Reaction line as listed in criterion 1. It SHALL keep every deadline unchanged on manual commands (Requirement 12), stale feedback (criterion 6), cloud events and repeated `pir.rising`.
5. IF the Dispatcher catches an exception from `step()`, THEN THE Dispatcher SHALL log the exception, send `ReleaseServos` and `LanternFade(0, 0)` to the adapters, publish `error.reported` with code `internal_error`, and restart the State_Machine in `sleeping` as criterion 7 specifies. When an Encounter was active, the Dispatcher SHALL also publish `state.changed` from the last State to `sleeping` with `reason: "error"` and `encounter.ended` with reason `error`, both carrying that Encounter's `encounterId`.
6. IF `servo.arrived`, `audio.finished`, `audio.failed`, `snapshot.ready` or `snapshot.failed` arrives with a Motion_Id, Play_Id or Snapshot_Id that the current Machine_State is not waiting for (stale feedback), THEN THE State_Machine SHALL keep the State, Encounter and deadlines unchanged and emit no Action other than the `error.reported` that Requirement 3 criterion 9 requires for `snapshot.failed` and Requirement 20 criterion 9 requires for `audio.failed`.
7. WHEN the Dispatcher restarts the State_Machine under criterion 5, THE Dispatcher SHALL create the Machine_State as Requirement 1 criterion 7 specifies (State `sleeping`, lantern level 0, servos released, PIR level low, no current Encounter), except that the Start_Time, the Mode and the cloud connectivity SHALL equal those of the Machine_State passed to the failing `step()` call.

### Requirement 11: PIR debounce and one encounter per visit

**User Story:** As a family member, I want one greeting per visit even though the HC-SR501 retriggers, so that the doll does not greet me again and again.

#### Acceptance Criteria

1. WHILE the State is `waking`, `seeking`, `gazing`, `greeting`, `warning` or `uncertain`, WHEN `pir.rising` arrives, THE State_Machine SHALL keep the current Encounter, State and deadlines and emit no Action.
2. WHILE the State is `cooldown`, WHEN `pir.rising` arrives, THE State_Machine SHALL ignore the Event and emit no Action.
3. WHEN `pir.rising` or `pir.falling` arrives in any State or Mode, THE State_Machine SHALL record the PIR level as high or low respectively. A `pir.falling` SHALL change no State, deadline or Encounter and emit no Action.
4. WHEN the State_Machine enters `sleeping`, whatever the PIR level, THE State_Machine SHALL start no Encounter in that `step()` call and SHALL start the next Encounter only on a `pir.rising` processed in a later `step()` call.
5. IF `pir.rising` arrives with a `now` less than the Start_Time + `pir_warmup_s`, THEN THE State_Machine SHALL ignore the Event, keep the State, Mode, Encounter and deadlines, and emit no Action.
6. WHILE the Mode is `sleep`, WHEN `pir.rising` arrives, THE State_Machine SHALL ignore the Event, start no Encounter and emit no Action.
7. FOR ALL Event sequences, THE State_Machine SHALL start a new Encounter only from the State `sleeping`, so that two Encounters never overlap. The `now` of the `pir.rising` that starts an Encounter SHALL be at least `cooldown_s` after the previous Encounter entered `cooldown`. A restart under Requirement 10 criterion 5 is outside this property.

### Requirement 12: Manual commands

**User Story:** As the owner, I want to make the doll speak, look, light its lantern or sleep from the cloud, so that I can demonstrate and control it, while bad commands never crash it.

#### Acceptance Criteria

1. WHILE the State is `waking`, `seeking`, `gazing`, `greeting`, `warning` or `uncertain`, WHEN a `gaze` command arrives, THE State_Machine SHALL emit `GazeTarget` with `panDeg` and `tiltDeg` Clamped to the Calibrated_Range and keep the State and deadlines.
2. WHILE the State is `waking`, `seeking`, `gazing`, `greeting`, `warning` or `uncertain`, WHEN a `lantern` command arrives, THE State_Machine SHALL emit `LanternFade` with `level` Clamped to [0, 1] and `fadeMs` Clamped to [0, 10000], and keep the State and deadlines.
3. WHILE the State is `sleeping` or `cooldown`, WHEN a `gaze` or `lantern` command arrives, THE State_Machine SHALL ignore the command and emit `error.reported` with code `command_rejected_state`.
4. WHEN a `speak` command with `lineId` arrives, the line is an Available_Line permitted by Requirement 13, and none of criteria 5, 6 and 11 rejects the command, THE State_Machine SHALL emit `PlayLine` for that line with a new Play_Id without changing the State or deadlines.
5. IF a `speak` command names a `lineId` that is not an Available_Line, THEN THE State_Machine SHALL ignore the command and emit `error.reported` with code `unknown_line`.
6. IF a `speak` command arrives while either of these holds, THEN THE State_Machine SHALL ignore the command and emit `error.reported` with code `audio_busy`:
   - an earlier `PlayLine` has no `audio.finished` or `audio.failed` for its Play_Id, and the command's `now` is less than that `PlayLine`'s `now` + `audio_timeout_s`;
   - an earlier `PlayAudioUrl` has no `audio.finished` or `audio.failed` for its Play_Id, and the command's `now` is less than that `PlayAudioUrl`'s `now` + `download_timeout_s` + `audio_timeout_s`.

   This criterion applies to `speak` commands only. A Reaction `PlayLine` is emitted even while earlier audio is unfinished.
7. WHEN `mode.set` with `mode: "sleep"` arrives during an Encounter while the State is not `cooldown`, THE State_Machine SHALL set the Mode to `sleep`, enter `cooldown` with `state.changed` reason `manual`, and publish `encounter.ended` with reason `manual` on entering `sleeping`.
8. WHEN `mode.set` arrives in `sleeping` or `cooldown`, or repeats the current Mode, THE State_Machine SHALL set the Mode and keep the State.
9. WHEN `mode.set` with `mode: "guard"` arrives, THE State_Machine SHALL set the Mode to `guard` and start no Encounter until a later `pir.rising`.
10. IF a command fails validation in the Message_Codec, THEN THE Dispatcher SHALL drop the command, keep running, and publish `error.reported` with code `malformed_message` and `refId` set to the message `id` when the `id` is readable.
11. WHILE the State is `warning` and the `stranger` Reaction `PlayLine` has not been emitted, IF a `speak` command arrives, THEN THE State_Machine SHALL ignore the command and emit `error.reported` with code `command_rejected_state`.
12. WHEN the State_Machine rejects a command under criterion 3, 5, 6 or 11, or under Requirement 13 criterion 3 or 4, THE State_Machine SHALL emit exactly one `error.reported`, with `refId` set to the command's `id` and the first applicable code in the order `unknown_line`, `speak_rejected`, `command_rejected_state`, `audio_busy`. It SHALL emit no other Action and change no State, Mode, deadline or Encounter.

### Requirement 13: Privacy

**User Story:** As a family member, I want the doll never to reveal our names to a stranger, so that the guardian cannot leak who lives here.

#### Acceptance Criteria

1. THE Manifest_Loader SHALL reject every Voice_Line whose `ja` or `en` contains an entry of `blocked_words` as a substring, compared after Unicode case folding of both strings. The log line and `error.reported` for that rejection SHALL name the line `id` and the broken rule but neither the matched word nor the line text.
2. WHEN a `speak` command with `audioUrl` arrives while the Situation_Category is `family` and Requirement 12 criterion 6 does not reject it, THE State_Machine SHALL emit `PlayAudioUrl` with that URL and a new Play_Id.
3. IF a `speak` command with `audioUrl` arrives while the Situation_Category is not `family`, THEN THE State_Machine SHALL ignore the command and emit `error.reported` with code `speak_rejected`.
4. IF a `speak` command with `lineId` arrives while the line's Category is not permitted for the Situation_Category, THEN THE State_Machine SHALL ignore the command and emit `error.reported` with code `speak_rejected`. A Category is not permitted when the Situation_Category is `stranger` or `uncertain` and the Category differs from the Situation_Category, or when the Situation_Category is `family` and the Category is `stranger`.
5. WHILE the Situation_Category is `stranger` or `uncertain`, THE State_Machine SHALL play only cached Voice_Lines of the Category equal to the Situation_Category.
6. THE Warashi_Agent SHALL exclude the following from every log line (including the lines of Requirement 27 criteria 3 and 7), published event and status report: the `ja` and `en` fields of `speak` commands, the query string of every `audioUrl`, the raw bytes of incoming messages, image data, certificate contents, and any field the contract does not define. The only exception is the `jpegBase64` field of the published `snapshot.captured` event (Requirement 3 criterion 2).
7. THE Message_Codec SHALL discard `data` fields of incoming commands that `docs/schema.md` does not define, so that an extra field such as a name never reaches the State_Machine.

### Requirement 14: Glide_Planner (servo safety core)

**User Story:** As the owner, I want every servo movement to be slow and inside the neck limits, so that the cables are safe and the slow turn shows the doll's character.

#### Acceptance Criteria

1. THE Glide_Planner SHALL Clamp the Gaze_Target to the Calibrated_Range before planning.
2. THE Glide_Planner SHALL produce, per axis, `n = ceil(|d| / glide_step_deg)` Commanded_Angles, where `d` is the Clamped target minus the current commanded angle. The first Commanded_Angle SHALL differ from the current commanded angle by at most `glide_step_deg`, and consecutive Commanded_Angles SHALL differ by at most `glide_step_deg`. When `d` is 0 on both axes, the plan has no Commanded_Angles.
3. THE Glide_Planner SHALL schedule the k-th Commanded_Angle of each axis (k = 1 … n) at k × `glide_interval_ms` after the plan start, with pan and tilt sharing one plan start, so that a plan lasts `max(n_pan, n_tilt) × glide_interval_ms`.
4. THE Glide_Planner SHALL keep every Commanded_Angle inside the Calibrated_Range and SHALL end each completed plan exactly at the Clamped target.
5. WHEN a new Gaze_Target arrives during a glide, THE Glide_Planner SHALL plan from the last Commanded_Angle actually written, so that the step and interval limits also hold across plans.
6. WHEN `ReleaseServos` or a new `GazeTarget` arrives while a plan is running, THE Servo_Adapter SHALL cancel the rest of the current plan and post no `servo.arrived` for its Motion_Id.
7. THE Glide_Planner SHALL convert a Commanded_Angle `a` to the absolute servo angle `pan_center_offset + s × a` for pan and `tilt_center_offset + s × a` for tilt. `s` SHALL be −1 when the axis's `pan_invert` or `tilt_invert` is `true`, and 1 otherwise.
8. THE Glide_Planner SHALL produce only positional angle targets, never time-based rotation.
9. IF either axis of a Gaze_Target is not a finite number, THEN THE Glide_Planner SHALL produce no plan for that Gaze_Target, so that the current plan continues and no `servo.arrived` is posted for its Motion_Id.

### Requirement 15: Servo_Adapter and `motion_enabled`

**User Story:** As the owner, I want the servos to stay powered down until I enable them, and to never move at startup, so that a wrong or uncalibrated servo cannot damage the doll.

#### Acceptance Criteria

1. WHILE `motion_enabled` is `false`, THE Servo_Adapter SHALL log each intended Commanded_Angle, create no servo output device, generate no PWM signal and leave `pose_file` unchanged.
2. WHILE `motion_enabled` is `false`, THE Servo_Adapter SHALL post `servo.arrived` for each plan that is not cancelled (Requirement 14 criterion 6) when the plan's scheduled duration has elapsed.
3. WHILE `motion_enabled` is `true`, THE Servo_Adapter SHALL write only Commanded_Angles from the Glide_Planner, using `AngularServo(pin, min_angle=-90, max_angle=90, min_pulse_width=0.0005, max_pulse_width=0.0024)`. It SHALL write each Commanded_Angle no earlier than its scheduled time and no earlier than `glide_interval_ms` after the previous write on the same axis.
4. WHEN a plan completes, including a plan with no Commanded_Angles (which completes when it starts), THE Servo_Adapter SHALL post `servo.arrived` with the plan's Motion_Id. Unless a new plan starts first, it SHALL detach both servos `servo_settle_ms` after the last Commanded_Angle.
5. WHEN `ReleaseServos` arrives, THE Servo_Adapter SHALL detach both servos within 50 ms.
6. THE Servo_Adapter SHALL create servo output devices only when the first `GazeTarget` arrives, so that importing a module or starting the Warashi_Agent moves no servo.
7. WHILE `motion_enabled` is `true`, WHEN the Servo_Adapter detaches, THE Servo_Adapter SHALL write the last Commanded_Angles to `pose_file`.
8. WHEN the Servo_Adapter plans the first glide after startup, THE Servo_Adapter SHALL start from the angles in `pose_file`, or from 0, 0 when `pose_file` is missing, unreadable or outside the Calibrated_Range.
9. THE Servo_Adapter SHALL have a fake that records every servo output device creation, every Commanded_Angle with its time, every detach and every PWM start.
10. WHEN the Servo_Adapter creates a servo output device, THE Servo_Adapter SHALL create it without sending a pulse, so that the first pulse on `pan_pin` or `tilt_pin` is the first Commanded_Angle of a plan.
11. IF a Servo_Adapter worker raises an exception, THEN THE Servo_Adapter SHALL cancel the current plan, detach both servos within 50 ms, and post `adapter.error` with code `adapter_failed`.
12. IF writing `pose_file` fails, THEN THE Servo_Adapter SHALL log the failure and keep accepting Actions.

### Requirement 16: Lantern_Adapter

**User Story:** As a family member, I want the lantern to fade in and out softly, so that the doll feels alive.

#### Acceptance Criteria

1. WHEN `LanternFade(level, fade_ms)` arrives, THE Lantern_Adapter SHALL change the PWM duty cycle on `lantern_pin` from the current level to `level` Clamped to [0, 1] over `fade_ms` Clamped to [0, 10000], in steps at most 20 ms apart. Every intermediate level SHALL lie between the start level and the target level, and the target level SHALL be reached no later than the Clamped `fade_ms` + 20 ms after the Action arrives.
2. WHEN a new `LanternFade` arrives during a fade, THE Lantern_Adapter SHALL start the new fade from the current level.
3. WHEN the Lantern_Adapter starts, THE Lantern_Adapter SHALL set the lantern level to 0.
4. THE Lantern_Adapter SHALL offer an immediate off operation that cancels any running fade, sets the level to 0 within 50 ms, and keeps the level at 0 until a later `LanternFade` arrives.
5. THE Lantern_Adapter SHALL have a fake that records every level change with its time.

### Requirement 17: PIR_Adapter

**User Story:** As the developer, I want the PIR sensor reported as edges, so that the State_Machine handles all debounce rules.

#### Acceptance Criteria

1. WHEN the input on `pir_pin` changes from low to high, THE PIR_Adapter SHALL post `pir.rising`.
2. WHEN the input on `pir_pin` changes from high to low, THE PIR_Adapter SHALL post `pir.falling`.
3. THE PIR_Adapter SHALL post edges only, in the order they occur, and make no debounce or warm-up decision.
4. THE PIR_Adapter SHALL have a fake that posts scripted or typed edges.
5. WHEN the PIR_Adapter starts, THE PIR_Adapter SHALL post no Event for the current input level, so that an input that is already high at startup produces no `pir.rising` until it goes low and then high again.

### Requirement 18: Camera_Adapter

**User Story:** As the developer, I want snapshots taken with a timeout and a size limit, so that a slow or missing camera never blocks the loop and every snapshot fits in one message.

#### Acceptance Criteria

1. WHEN `TakeSnapshot(snapshot_id)` arrives, THE Camera_Adapter SHALL run `rpicam-still -n -t 500 --width 640 --height 480 -q 80 -o <file>` in a worker. It SHALL stop the whole snapshot operation, retries included, `camera_timeout_s` after the Action arrives, by terminating any running `rpicam-still` process.
2. WHEN a captured JPEG is larger than `jpeg_max_bytes`, THE Camera_Adapter SHALL capture again with `-q 60` and then `-q 40`, and SHALL post `snapshot.failed` with code `snapshot_too_large` when the quality 40 image is still larger than `jpeg_max_bytes`.
3. WHEN a JPEG of at most `jpeg_max_bytes` is available, THE Camera_Adapter SHALL post `snapshot.ready` with the Snapshot_Id, the JPEG bytes, `width` and `height`.
4. IF `rpicam-still` exits with a non-zero code or without writing a non-empty JPEG file, or the snapshot operation exceeds `camera_timeout_s` (also during a retry of criterion 2), THEN THE Camera_Adapter SHALL post `snapshot.failed` with code `camera_failed` and the Snapshot_Id.
5. IF the startup probe (`rpicam-still --list-cameras`, stopped after `probe_timeout_s`) exits with a non-zero code, lists no camera, or does not finish within `probe_timeout_s`, THEN THE Warashi_Agent SHALL log a hint to check the ribbon cable, publish `error.reported` with code `camera_missing`, and keep running.
6. THE Camera_Adapter SHALL delete every JPEG file it created for a Snapshot_Id, including files from retries and from terminated runs, after posting `snapshot.ready` or `snapshot.failed`.
7. THE Camera_Adapter SHALL have a fake that returns a small fixed JPEG or a scripted failure.
8. THE Camera_Adapter SHALL post exactly one `snapshot.ready` or `snapshot.failed` per `TakeSnapshot`.

### Requirement 19: Audio_Adapter

**User Story:** As a family member, I want cached lines to play on the speakerphone even offline, and a missing speaker to be reported clearly, so that the doll keeps working and the owner knows what to fix.

#### Acceptance Criteria

1. WHEN `PlayLine(line_id, play_id)` arrives, THE Audio_Adapter SHALL play the line's WAV file with `aplay -D <audio_device>` in a worker and stop playback after `audio_timeout_s`.
2. WHEN playback ends normally, THE Audio_Adapter SHALL post `audio.finished` with the Play_Id.
3. IF playback fails, exceeds `audio_timeout_s`, or the line's WAV file is missing, THEN THE Audio_Adapter SHALL post `audio.failed` with the Play_Id and code `audio_failed`.
4. WHEN a `PlayLine` or `PlayAudioUrl` arrives during playback or during a download of criterion 5, THE Audio_Adapter SHALL stop the current playback or download, post `audio.failed` with code `interrupted` for the old Play_Id, and start the new request.
5. WHEN `PlayAudioUrl(url, play_id)` arrives, THE Audio_Adapter SHALL download only an `https` URL, follow no redirect to a non-`https` URL, finish within `download_timeout_s`, and stop the download as soon as it exceeds 2,000,000 bytes. It SHALL accept only 16-bit PCM WAV, play the file as in criterion 1, and delete the downloaded file when playback ends, fails or is interrupted.
6. IF the URL is not `https`, or the download fails, times out, exceeds 2,000,000 bytes, or is not 16-bit PCM WAV, THEN THE Audio_Adapter SHALL play nothing, delete any partial file, and post `audio.failed` with the Play_Id and code `download_failed`.
7. IF the startup probe (`aplay -L`, stopped after `probe_timeout_s`) exits with a non-zero code, does not finish within `probe_timeout_s`, or lists no PCM name equal to `audio_device`, THEN THE Warashi_Agent SHALL log a hint that the USB cable and the power cable may be swapped between the Pi's `PWR` and `USB` ports, publish `error.reported` with code `audio_device_missing`, and keep running with lantern and gaze.
8. THE Audio_Adapter SHALL have a fake that records each play request and posts `audio.finished` or a scripted `audio.failed`.
9. THE Audio_Adapter SHALL post exactly one `audio.finished` or `audio.failed` per Play_Id.

### Requirement 20: Dispatcher, non-blocking loop, startup and shutdown

**User Story:** As the owner, I want a main loop that never blocks and always leaves the hardware safe on exit, so that the doll keeps reacting and never winds its cables.

#### Acceptance Criteria

1. THE Dispatcher SHALL process Events one at a time from a single queue and post a Tick every `tick_interval_ms`. It SHALL pass as `now` the monotonic clock reading taken when it removes the Event from the queue, so that `now` never decreases between `step()` calls.
2. THE Dispatcher SHALL hand each Action to its adapter in the order `step()` returned them, without waiting for the Action's result, and each adapter SHALL return its result as an Internal_Event.
3. WHILE an adapter worker is blocked, THE Dispatcher SHALL continue to process Ticks and other Events.
4. THE Dispatcher SHALL wrap each `PublishEvent` and `PublishStatus` Action in an envelope with a fresh UUID `id`, the current UTC `ts` and `deviceId` from Config. The envelope of a `PublishEvent` SHALL carry the Action's `encounterId`, and the envelope of a `PublishStatus` SHALL carry `encounterId: null`.
5. WHEN the Warashi_Agent starts, THE Warashi_Agent SHALL load the Config, load the Voice_Manifest, set the lantern to 0, and run the camera and audio probes. It SHALL publish the `error.reported` events of these steps through the Cloud_Link and enter the loop with the Start_Time equal to the `now` of loop entry, without moving any servo.
6. WHEN SIGTERM or SIGINT arrives, or an exception escapes the loop, THE Dispatcher SHALL detach both servos and use the Lantern_Adapter's immediate off operation within 1 second, without gliding to center. It SHALL hand no further Action to the Servo_Adapter or the Lantern_Adapter after that. A `step()` exception handled by Requirement 10 criterion 5 does not count as escaping the loop.
7. WHEN SIGTERM or SIGINT arrives, THE Warashi_Agent SHALL stop any running `aplay` or `rpicam-still` process and exit with code 0 within 3 seconds.
8. IF an exception escapes the loop, THEN THE Warashi_Agent SHALL log the exception and exit with code 1 after criterion 6 completes.
9. WHEN an `adapter.error` Event arrives, or `audio.failed` arrives with a code other than `interrupted`, THE State_Machine SHALL emit `PublishEvent` of type `error.reported` with that code.
10. IF an adapter worker raises an exception for which this document defines no other Internal_Event, THEN THE adapter SHALL post `adapter.error` with code `adapter_failed` and keep accepting Actions.
11. THE Servo_Adapter, Lantern_Adapter, PIR_Adapter, Camera_Adapter and Audio_Adapter SHALL post `adapter.error` only with a code from the list in Requirement 24 criterion 1.

### Requirement 21: Cloud_Link interface

**User Story:** As the developer, I want the cloud behind a small interface with a fake and a local implementation, so that the core loop runs and is tested without AWS, and the cloud spec can plug in the real client later.

#### Acceptance Criteria

1. THE Cloud_Link SHALL offer `publish(envelope)` that returns without waiting for the network and without raising an exception to the Dispatcher.
2. WHEN the Cloud_Link receives a command, THE Cloud_Link SHALL deliver it to the Dispatcher as an encoded Wire_Message, without decoding it.
3. THE Cloud_Link SHALL post `cloud.connected` and `cloud.disconnected` when its connectivity changes.
4. THE Local_Cloud_Link SHALL log each published envelope as one JSON line, with the value of `jpegBase64` replaced by its number of characters, deliver no command, and post no `cloud.connected` Event.
5. THE Fake_Cloud_Link SHALL record every published envelope in publish order, deliver scripted commands as encoded Wire_Messages and post scripted `cloud.connected` and `cloud.disconnected` Events at given Dispatcher clock times (monotonic seconds), and deliver the commands and connectivity changes typed in the CLI (Requirement 27 criterion 2).
6. WHEN the Warashi_Agent runs in normal mode, THE Warashi_Agent SHALL use the Local_Cloud_Link until the `cloud-judgement` spec provides a real Cloud_Link.
7. THE Config_Loader SHALL accept a Config without an `[aws]` section in every mode of this spec.
8. WHEN the Dispatcher receives an encoded Wire_Message from the Cloud_Link, THE Dispatcher SHALL apply these steps in order and stop at the first step that drops the message: (1) decode it with the Message_Codec and drop an ignored or malformed result (Requirement 22 criteria 4 to 6, Requirement 12 criterion 10); (2) drop a message whose `type` is an event or status type and publish `error.reported` with code `unknown_type` and `refId` set to its `id`; (3) drop a command whose `deviceId` differs from Config `id` (Requirement 22 criterion 7); (4) drop a duplicate (Requirement 22 criterion 8); (5) record the `id` as accepted and post the Command_Event.

### Requirement 22: Message_Codec and Deduplicator

**User Story:** As the developer, I want one codec that matches the contract exactly and rejects bad input safely, so that all three parts agree and no message can crash the doll.

#### Acceptance Criteria

1. THE Message_Codec SHALL encode every event, command and status type of `docs/schema.md` into JSON with exactly the fields that `docs/schema.md` defines, including `refId` in every `error.reported` (null when no incoming message caused the error), and SHALL decode an `error.reported` without `refId` as `refId: null`.
2. FOR ALL valid Wire_Messages whose `ts` has millisecond precision, decoding the encoded form SHALL return a Wire_Message equal to the original (round trip).
3. THE Message_Codec SHALL encode `ts` as UTC ISO 8601 with exactly three fractional digits and a `Z` suffix.
4. IF a message is a JSON object of at most 131,072 bytes whose `v` is an integer greater than 1, THEN THE Message_Codec SHALL return an ignored result without validating the other fields, and THE Dispatcher SHALL publish `error.reported` with code `unsupported_version` and `refId` set to the message `id` when it is a string, or null otherwise.
5. IF a message has `v` equal to 1, valid envelope fields other than `type` and `data`, and a `type` that `docs/schema.md` does not define, THEN THE Message_Codec SHALL return an ignored result without validating `data`, and THE Dispatcher SHALL publish `error.reported` with code `unknown_type` and `refId` set to the message `id`.
6. IF a message is not valid UTF-8 JSON, is not a JSON object, is larger than 131,072 bytes, has a `v` that is not an integer ≥ 1, misses a required field, has a field of the wrong type (a JSON boolean counts as the wrong type for a number field), has a value outside the listed values of an enumerated field (such as `verdict`, `mode` or `source`), contains a non-finite number, or is a `speak` command without exactly one of `lineId` and `audioUrl`, THEN THE Message_Codec SHALL return a malformed result without raising.
7. IF a command's `deviceId` differs from Config `id`, THEN THE Dispatcher SHALL drop the command and publish `error.reported` with code `wrong_device` and `refId` set to the message `id`.
8. WHEN an incoming command has an `id` among the last `dedup_window_size` accepted ids (the ids recorded in Requirement 21 criterion 8, step 5), THE Deduplicator SHALL drop the message without posting a Command_Event and without publishing `error.reported`.
9. THE Deduplicator SHALL hold at most `dedup_window_size` ids, evicting the oldest first.
10. WHEN the Message_Codec encodes an `error.reported` whose `message` has more than 200 characters, THE Message_Codec SHALL keep only the first 200 Unicode code points.
11. THE Message_Codec SHALL accept finite numbers outside their documented ranges (face box fields, `confidence`, `level`, `fadeMs`, `panDeg`, `tiltDeg`) as valid, so that the State_Machine applies the Clamps of Requirements 5 and 12.

### Requirement 23: Status reports

**User Story:** As a family member, I want the doll to report its state and whether its camera or microphone is active, so that the dashboard can always show this.

#### Acceptance Criteria

1. WHEN the State changes, `cameraActive` changes value, the first Tick after the Start_Time arrives, or a Tick arrives at least `status_interval_s` after the last `PublishStatus`, THE State_Machine SHALL emit `PublishStatus` with `state`, `mode`, `panDeg`, `tiltDeg`, `lantern`, `cameraActive`, `micActive`, `motionEnabled`, `uptimeSec` and `agentVersion`.
2. THE State_Machine SHALL set `cameraActive` to true from `TakeSnapshot` until `snapshot.ready` or `snapshot.failed` for that Snapshot_Id, or until the attempt deadline.
3. THE State_Machine SHALL set `micActive` to false in this spec, because no feature here records audio.
4. THE State_Machine SHALL report `panDeg` and `tiltDeg` as the last emitted Gaze_Target, `lantern` as the `level` of the last emitted `LanternFade` (each 0 before the first such Action), `mode` as the current Mode, `motionEnabled` as Config `motion_enabled`, `uptimeSec` as `floor(now − Start_Time)`, and `agentVersion` as the `version` of the `warashi-agent` package in `device/pyproject.toml`.
5. THE State_Machine SHALL emit at most one `PublishStatus` per `step()` call, with data that reflects the Machine_State at the end of that call.

### Requirement 24: Refinement of `docs/schema.md`

**User Story:** As the developer, I want the contract updated before the code, so that `docs/schema.md` stays the single source of truth for the device, the cloud and the dashboard.

#### Acceptance Criteria

1. THE developer SHALL apply these changes to `docs/schema.md` before changing `messages.py`, each with its reason written in the document:

   | Change | Reason |
   |---|---|
   | Add `"reason": string` to `state.changed` with values `presence`, `arrived`, `verdict`, `no_face`, `timeout`, `offline`, `audio_done`, `manual`, `cooldown_done`, `error`, assigned as criterion 4 specifies | The timeline can show why a transition happened, including timeouts. |
   | Replace `encounter.ended` reason `timeout` with `error`; keep `cooldown` and `manual` | Every encounter ends through cooldown. Timeouts are visible in `state.changed`; `error` marks a reset after an internal error. |
   | Add `"refId": string \| null` to `error.reported`, always present and null when no incoming message caused the error, and list the codes `unknown_type`, `unsupported_version`, `malformed_message`, `wrong_device`, `speak_rejected`, `audio_busy`, `command_rejected_state`, `unknown_line`, `voice_line_missing`, `voice_line_invalid`, `voice_file_missing`, `audio_failed`, `download_failed`, `audio_device_missing`, `camera_missing`, `camera_failed`, `snapshot_too_large`, `internal_error`, `adapter_failed`, with `message` at most 200 characters (the sender truncates longer text) | Receivers can link an error to the message that caused it and handle codes without parsing text. |
   | Add `"mode": "guard" \| "sleep"` to `status.report`, state that it is sent on each state change, on each change of `cameraActive`, on the first Tick after start, and every `status_interval_s` (default 60 s), and state that `status.report` envelopes always carry `encounterId: null` | The dashboard shows when the doll ignores presence, the camera indicator stays current, and status stays independent of encounters. |
   | State that `micActive` is false while no feature records audio | Makes the privacy indicator exact for this spec. |
   | Specify `speak.audioUrl` as `https` only, a 16-bit PCM WAV of at most 2,000,000 bytes, played only when the encounter's accepted verdict is `family`; a message with both or neither of `lineId` and `audioUrl` is malformed | Bounds download size and makes the privacy rule enforceable on the device. |
   | Specify `lantern.fadeMs` as clamped to 0..10000, `lantern.level` as clamped to 0..1 and the `judgement.result` face box fields as clamped to 0..1; `gaze` angles must be finite and are clamped; finite numbers outside these ranges are not malformed | Defines device behaviour for out-of-range values. |
   | Specify that commands may carry `encounterId: null` and that the device matches `judgement.result` by `snapshotId` only | The cloud cannot always know the current encounter. |
   | Specify that the device drops a duplicate `id` within the last `dedup_window_size` (default 256) accepted ids and ignores undefined `data` fields | Makes duplicate handling bounded and keeps extra fields (such as names) out of the device. |
   | Specify a maximum incoming message size of 131,072 bytes, treat a `v` that is not an integer ≥ 1 as malformed, and keep the raw JPEG limit of 90,000 bytes (the cloud spec verifies the IoT Core limit) | Gives the decoder a safe input bound. |
   | Add a section "Device-internal events (not on the wire)" listing `tick`, `pir.rising`, `pir.falling`, `servo.arrived`, `audio.finished`, `audio.failed`, `snapshot.ready`, `snapshot.failed`, `cloud.connected`, `cloud.disconnected`, `adapter.error` | Prevents the cloud and the dashboard from expecting these on MQTT. |
   | State that the device emits `presence.detected` with `source: "pir"` only in this spec | `sound` (P2) and `manual` are reserved. |

2. THE Message_Codec SHALL define exactly the event, command and status types listed in the Events, Commands and Status tables of `docs/schema.md`, and a test SHALL parse those three tables, excluding the "Device-internal events (not on the wire)" section, and compare them with the Message_Codec's type registry.
3. THE developer SHALL keep `v` at 1, because no version of the contract has been deployed yet.
4. WHEN the State_Machine emits `state.changed`, or the Dispatcher publishes `state.changed` under Requirement 10 criterion 5, THE Warashi_Agent SHALL set `reason` by the first row of this table whose transition and cause both match:

   | From → To | Cause | `reason` |
   |---|---|---|
   | `sleeping` → `waking` | `pir.rising` (Requirement 2 criterion 1) | `presence` |
   | any State other than `sleeping` → `sleeping` | restart after a `step()` exception, published by the Dispatcher (Requirement 10 criterion 5) | `error` |
   | `cooldown` → `sleeping` | cooldown deadline (Requirement 8 criterion 3) | `cooldown_done` |
   | `waking`, `seeking`, `gazing`, `greeting`, `warning` or `uncertain` → `cooldown` | `mode.set` with `mode: "sleep"` (Requirement 12 criterion 7) | `manual` |
   | `waking` → `uncertain` | cloud disconnected when leaving `waking`, whatever the leaving cause (Requirement 2 criterion 6) | `offline` |
   | `waking` → `seeking` | `servo.arrived` and fade elapsed (Requirement 2 criterion 3) | `arrived` |
   | `waking` → `seeking` | waking deadline (Requirement 2 criterion 4) | `timeout` |
   | `seeking` → `uncertain` | `cloud.disconnected` (Requirement 3 criterion 7) | `offline` |
   | `seeking` → `uncertain` | `snapshot.failed` (Requirement 3 criterion 5) | `error` |
   | `seeking` → `uncertain` | attempt deadline (Requirement 3 criterion 6) | `timeout` |
   | `seeking` → `uncertain` | scan attempts used up with `no_face` (Requirement 6 criterion 3) | `no_face` |
   | `seeking` → `gazing`, `greeting`, `warning` or `uncertain` | Verdict (Requirement 3 criterion 3; Requirement 5 criteria 4 and 5) | `verdict` |
   | `gazing` → `greeting` or `warning` | `servo.arrived` (Requirement 5 criterion 6) | `arrived` |
   | `gazing` → `greeting` or `warning` | gazing deadline (Requirement 5 criterion 6) | `timeout` |
   | `greeting`, `warning` or `uncertain` → `cooldown` | no Available_Line (Requirement 7 criteria 7 and 10) | `error` |
   | `greeting`, `warning` or `uncertain` → `cooldown` | `audio.finished` or `audio.failed` (Requirement 7 criterion 6) | `audio_done` |
   | `greeting`, `warning` or `uncertain` → `cooldown` | audio deadline (Requirement 7 criterion 6) | `timeout` |

5. THE Warashi_Agent SHALL publish `error.reported` only with a code from the list in criterion 1.

### Requirement 25: Configuration loading and validation

**User Story:** As the owner, I want a wrong `config.toml` rejected at startup with a clear message, so that a typo cannot drive the head past its safe range.

#### Acceptance Criteria

1. THE Config_Loader SHALL read `config.toml` from the path given by `--config`, defaulting to `config.toml` in the working directory, and fill each missing key with the default in the Glossary table.
2. IF `pan_limit` is ≤ 0 or > 60, or `tilt_limit` is ≤ 0 or > 30, THEN THE Config_Loader SHALL reject the Config.
3. IF `abs(pan_center_offset) + pan_limit` > 90 or `abs(tilt_center_offset) + tilt_limit` > 90, THEN THE Config_Loader SHALL reject the Config.
4. IF any `*_s` or `*_ms` key other than `pir_warmup_s` is ≤ 0, or any key is outside the allowed values in the Glossary table, THEN THE Config_Loader SHALL reject the Config.
5. IF `glide_step_deg` > 2 or `glide_interval_ms` < 30, THEN THE Config_Loader SHALL reject the Config.
6. IF a pin is outside BCM 2–27 or two pin keys share a value, THEN THE Config_Loader SHALL reject the Config.
7. IF `waking_timeout_s` < `lantern_fade_in_ms / 1000`, `waking_timeout_s` < Sweep_Time, `glide_timeout_s` < Sweep_Time + 2 × T, `cooldown_s` < `glide_timeout_s + lantern_fade_out_ms / 1000`, or `camera_timeout_s` ≥ `verdict_timeout_s`, THEN THE Config_Loader SHALL reject the Config, evaluating each of these rules without raising and only when every key it uses has passed criteria 2 to 6 and 14. The `glide_timeout_s` rule exists so that the cooldown `ReleaseServos` (Requirement 8 criterion 2) does not cut the return-to-center glide short.
8. IF the Config contains an unknown section or key outside `[aws]`, THEN THE Config_Loader SHALL reject the Config.
9. WHEN the Config_Loader rejects a Config, THE Config_Loader SHALL write one message to stderr that reports every violation found by criteria 2 to 8, 13 and 14, naming for each the `section.key` (every key involved for a rule of criterion 7), its value and the allowed values, except that for `privacy.blocked_words` it SHALL name the key and the broken rule without the value, and for criterion 13 it SHALL name the file path and whether the file is missing, unreadable or not valid TOML.
10. WHEN the Config is rejected, THE Warashi_Agent SHALL exit with code 2 before touching any GPIO pin.
11. WHERE `--fake` is given and the Config file does not exist, THE Config_Loader SHALL use the defaults and log that it did so.
12. THE repository SHALL contain `device/config.example.toml` with every key of the Glossary table and its default, which the Config_Loader SHALL accept with no violation, and `config.toml` and the default `pose_file` SHALL stay in `.gitignore`.
13. IF the Config file does not exist while `--fake` is not given, cannot be read, or is not valid TOML, THEN THE Config_Loader SHALL reject the Config.
14. IF a key outside `[aws]` has a value of the wrong TOML type (a boolean, string or list for a number key; a non-integer for a pin key, `jpeg_max_bytes`, `scan_attempts_max` or `dedup_window_size`; a non-boolean for a boolean key), a non-finite number (`nan`, `inf`, `-inf`) as its value or as a list entry, an empty string for `pose_file` or `audio_device`, or an `audio_device` without `CARD=` followed by at least one character, THEN THE Config_Loader SHALL reject the Config.

### Requirement 26: Voice_Manifest

**User Story:** As a family member, I want a small set of cached lines in each category that follow the persona, so that the doll sounds like a zashiki-warashi even offline.

#### Acceptance Criteria

1. THE Voice_Manifest SHALL list each Voice_Line with `id` (matching `[a-z0-9_]+`, unique), `category` (`family`, `stranger` or `uncertain`), `ja`, `en` and `wav` (a file name ending in `.wav`, without a path separator, in the `voice` directory).
2. THE Voice_Manifest in the repository SHALL contain at least 3 Voice_Lines in each Category, written per the persona steering, and no line SHALL threaten harm, mention death or injury, insult anyone, or contain a personal name or personal detail.
3. THE Manifest_Loader SHALL reject a Voice_Line whose `ja` is empty or has more than 40 characters (Unicode code points, including spaces and punctuation), more than two sentence-ending marks from `。？！?!`, any Latin letter (ASCII or full-width), or any code point in U+1F000–U+1FAFF, U+2600–U+27BF or U+FE0F.
4. THE Manifest_Loader SHALL reject a Voice_Line whose `en` is empty or longer than 120 characters.
5. WHEN the Manifest_Loader rejects a Voice_Line, THE Manifest_Loader SHALL skip the line, log its `id` (or its 1-based position in the Voice_Manifest when the `id` is missing or invalid) and the broken rule, publish `error.reported` with code `voice_line_invalid`, and keep loading.
6. WHERE the WAV_File_Check is enabled, IF a Voice_Line's WAV file is missing or is not 16-bit PCM mono, THEN THE Manifest_Loader SHALL exclude the line from the Available_Lines, log the `id` and the file name, publish `error.reported` with code `voice_file_missing`, and keep running.
7. THE repository test suite SHALL load the repository Voice_Manifest with the WAV_File_Check disabled and assert zero rejected lines and at least 3 lines per Category.
8. THE `.gitignore` SHALL exclude the WAV files in the `voice` directory.
9. THE Manifest_Loader SHALL reject a Voice_Line that misses one of the fields of criterion 1, has a non-string field, or breaks the `id`, `category` or `wav` rule of criterion 1, and, for a repeated `id`, SHALL keep the first line in file order and reject each later one.
10. WHERE the WAV_File_Check is disabled, THE Manifest_Loader SHALL treat every Voice_Line that passes criteria 3, 4 and 9 and Requirement 13 criterion 1 as an Available_Line whether or not its WAV file exists, and SHALL publish no `voice_file_missing`.
11. IF the Voice_Manifest file is missing or is not valid TOML, THEN THE Manifest_Loader SHALL log the problem, publish `error.reported` with code `voice_line_invalid`, and return no Available_Lines, so that the Warashi_Agent keeps running and Requirement 7 criterion 7 applies to every Reaction.

### Requirement 27: Command-line interface

**User Story:** As the developer, I want a fake mode on my laptop, a slow self-test on the Pi and a service mode, so that I can try the loop without hardware and check the hardware without the loop.

#### Acceptance Criteria

1. WHERE `--fake` is given, THE CLI SHALL run the Dispatcher with every fake adapter, the Fake_Cloud_Link, `pir_warmup_s` set to 0, the WAV_File_Check disabled, and the real clock.
2. WHERE `--fake` is given, THE CLI SHALL read keyboard lines and post the matching input:
   - `p` and `u`: `pir.rising` and `pir.falling`, posted through the PIR_Adapter fake.
   - `family [<confidence> [<left> <top> <width> <height>]]` and `stranger [<confidence> [<left> <top> <width> <height>]]`: a `judgement.result` with that `verdict`, the given `confidence` (1.0 when omitted), and the given face box (`face: null` when the four box values are omitted).
   - `noface` and `unsure`: a `judgement.result` with `verdict` `no_face` or `uncertain`, `confidence` 1.0 and `face: null`.
   - `speak <lineId>` (with `audioUrl` null and empty `ja` and `en`), `gaze <pan> <tilt>`, `lantern <level> <fadeMs>` and `mode sleep|guard`: the matching command.
   - `online` and `offline`: a connectivity change of the Fake_Cloud_Link, which posts `cloud.connected` or `cloud.disconnected`.
   - `help`: print the list of keyboard lines. `quit`: criterion 11.

   Every `judgement.result` SHALL carry the Snapshot_Id of the most recent `TakeSnapshot` Action. Every `judgement.result` and command SHALL go through the Fake_Cloud_Link as an encoded Wire_Message with a fresh `id`, `deviceId` from Config and `encounterId: null`. Numeric arguments SHALL pass through unchanged, without clamping.
3. WHERE `--fake` is given, THE CLI SHALL print each Action and each published envelope as one line, with `jpegBase64` replaced by its length and with the exclusions of Requirement 13 criterion 6 applied.
4. IF a keyboard line is not recognised, has the wrong number of arguments, or has a non-numeric or non-finite value where a number is expected, THEN THE CLI SHALL print the `help` text, post nothing and keep running. IF `family`, `stranger`, `noface` or `unsure` is typed before any `TakeSnapshot` Action, THEN THE CLI SHALL print that no snapshot is pending and post nothing.
5. WHERE `--selftest` is given, THE CLI SHALL exercise each adapter once: lantern fade to 0.5 over 1000 ms and back to 0 over 1000 ms; pan glide to +10° Clamped to the Calibrated_Range and back to 0°, then tilt glide to +10° Clamped to the Calibrated_Range and back to 0°, then detach; PIR edge count over 10 s; one snapshot with its byte size; the first `uncertain` Available_Line by `id`; and one envelope published to the Cloud_Link.
6. WHERE `--selftest` is given, THE CLI SHALL print PASS, FAIL or SKIP for each adapter, report SKIP for the servos with the hint to set `motion_enabled` when it is `false`, print the hint "If the head and lantern did nothing, check the battery rail", and exit with code 0 when no adapter failed or code 1 otherwise.
7. WHERE neither `--fake` nor `--selftest` is given, THE CLI SHALL run the Dispatcher with the real adapters and the Local_Cloud_Link and log one line per Event other than `tick` and one line per Action to stdout without colour codes, with image bytes replaced by their length and with the exclusions of Requirement 13 criterion 6 applied.
8. WHERE `--fake` and `--selftest` are both given, THE CLI SHALL run the self-test against the fake adapters.
9. WHERE `--selftest` is given, THE CLI SHALL report FAIL for an adapter whose step raises an exception or posts `adapter.error`. It SHALL also report FAIL when the servo gets no `servo.arrived` within `glide_timeout_s` of a glide, when the camera posts `snapshot.failed` or no result within `camera_timeout_s`, and when the audio posts `audio.failed`, the `audio_device_missing` probe fails, or no `uncertain` Available_Line exists. It SHALL report PASS for the PIR with any edge count, including 0, and PASS for the Cloud_Link when `publish` returns without an exception.
10. WHERE `--selftest` is given, WHEN the self-test finishes, an adapter step fails, or SIGINT or SIGTERM arrives, THE CLI SHALL detach both servos and set the lantern to 0 within 1 second before exiting, and SHALL exit with code 1 when interrupted.
11. WHERE `--fake` is given, WHEN `quit` is typed or standard input reaches end of file, THE CLI SHALL shut down as Requirement 20 criteria 6 and 7 specify for SIGINT and exit with code 0.

### Requirement 28: Systemd service and deployment

**User Story:** As the owner, I want one command to deploy to the Pi and a service that restarts on failure, so that the doll runs unattended and my Pi settings stay intact.

#### Acceptance Criteria

1. THE Systemd_Unit SHALL be a template that runs `python3 -m warashi_agent`, with placeholders for `WorkingDirectory` and `User=` that the Deploy_Script fills in (criterion 5), so that `config.toml` and the default `pose_file` resolve in the deployed `device` directory. It SHALL use `Restart=on-failure`, `RestartSec=5`, `RestartPreventExitStatus=2`, `KillSignal=SIGTERM`, `TimeoutStopSec=5` and `SupplementaryGroups=gpio video audio`, and log to the journal through stdout.
2. IF `PI_HOST` is unset or empty, THEN THE Deploy_Script SHALL print "PI_HOST is not set" with an example value and exit with code 1 before contacting any host.
3. WHEN `PI_HOST` is set, THE Deploy_Script SHALL copy `/device` with `rsync` to `$PI_HOST:$PI_DIR`, where `PI_DIR` defaults to `~/warashi/device`.
4. THE Deploy_Script SHALL exclude `config.toml`, `.venv`, `__pycache__`, `.pytest_cache`, `.ruff_cache`, `*.egg-info` and `last_pose.json` (the default `pose_file`) from the copy, so that the Pi's `config.toml` and pose file are never overwritten or deleted.
5. WHEN the copy succeeds, THE Deploy_Script SHALL query the login user of `$PI_HOST` over ssh, install the Systemd_Unit on `$PI_HOST` with `WorkingDirectory` set to `$PI_DIR` expanded on the Pi and `User=` set to that login user, reload the service manager, and then restart the `warashi-agent` service over ssh.
6. IF `rsync`, the user query, the unit installation or the restart fails, THEN THE Deploy_Script SHALL print the failing step, run no later step, and exit with a non-zero code.
7. THE Deploy_Script and the Systemd_Unit SHALL contain no host names, user names, Wi-Fi details, certificates or account IDs.
8. IF the login user queried in criterion 5 is `root`, THEN THE Deploy_Script SHALL print that the service must not run as root, install no unit, and exit with code 1, so that the service never runs as root.

### Requirement 29: Property-based tests (required)

**User Story:** As the developer, I want the safety and liveness rules checked by property-based tests, so that random event sequences prove the rules instead of a few examples.

#### Acceptance Criteria

1. THE repository SHALL contain the property-based tests in criteria 3 to 15 as required tasks; none of them is optional.
2. THE property-based tests SHALL use Hypothesis, run at least 100 examples each, run in `device/tests` through `make test`, and need no hardware, network or AWS account. Every generated Event sequence SHALL have non-decreasing `now`, `rand` in [0, 1) and pairwise distinct `uid` values. Comparisons of angles (degrees) and times (seconds) SHALL use a tolerance of 1e-9.
3. FOR ALL valid Configs and all Event sequences, every `GazeTarget` emitted by the State_Machine SHALL lie inside the Calibrated_Range. FOR ALL valid Configs, start angles inside the Calibrated_Range, and sequences of finite Gaze_Targets and `ReleaseServos` given to the Glide_Planner at non-decreasing times, the following SHALL hold:
   - A plan arriving at time `t` starts from the last Commanded_Angle per axis scheduled at or before `t`.
   - The plan schedules its k-th Commanded_Angle (k ≥ 1) of both axes at `t + k × glide_interval_ms / 1000`.
   - `ReleaseServos` cancels the Commanded_Angles scheduled after its arrival.
   - The written Commanded_Angles of each axis, merged across consecutive plans, stay inside the Calibrated_Range. Consecutive angles differ by at most `glide_step_deg` and are at least `glide_interval_ms` apart.
   - Every plan not cut short by a later Gaze_Target or `ReleaseServos` ends exactly at its Clamped target.

   (Servo safety; Requirements 5, 6, 7, 12, 14.)
4. FOR ALL valid Configs and all Event sequences in which no interval longer than `T` after the starting `pir.rising` passes without a Tick, the following SHALL hold (liveness; Requirements 8, 10):
   - Every Encounter stays in each State no longer than the bound of Requirement 10 criterion 1.
   - Every Encounter reaches `sleeping` within Encounter_Bound of its starting `pir.rising`.
   - At each entry into `sleeping`, the Encounter's Actions contain at least one `ReleaseServos`, no `GazeTarget` follows the last `ReleaseServos`, and the last `LanternFade` has level 0.
5. FOR ALL Event sequences, including `speak` commands with any `lineId`, the following SHALL hold (Requirements 4, 7, 13):
   - No Encounter whose Accepted_Verdict is `family` contains a `PlayLine` of a `stranger` Voice_Line, from a Reaction or a `speak` command, or a `reaction.performed` with `kind: "stranger"`.
   - Every `reaction.performed` with `kind: "family"` or `kind: "stranger"` follows, in the same Encounter, a Verdict of that kind with `confidence` ≥ `family_confidence_min` or `stranger_confidence_min` respectively.
   - Every Encounter contains at most one `reaction.performed`.
6. The following SHALL hold for the Message_Codec (Requirement 22):
   - FOR ALL valid Wire_Messages whose `ts` has millisecond precision, `decode(encode(m))` equals `m`, and the encoded `ts` is UTC ISO 8601 with exactly three fractional digits and a `Z` suffix.
   - FOR ALL byte strings and JSON values, the Message_Codec returns a valid, ignored or malformed result without raising.
   - FOR ALL valid messages changed to break exactly one rule, the result is ignored for `v` > 1 or an unknown `type`, and malformed for each rule of Requirement 22 criterion 6.
7. FOR ALL valid Configs and all Event sequences that meet the preconditions below, an Encounter started by `pir.rising` at time `t` SHALL contain a `PlayLine` of an `uncertain` Voice_Line. That `PlayLine` SHALL be emitted in the same `step()` call as `reaction.performed` with `kind: "uncertain"`, the same `lineId` and `offline: true`. It SHALL come by `t` + Offline_Bound_Disconnected when the cloud is disconnected at `t` and stays disconnected until that `PlayLine`, and by `t` + Offline_Bound_Silent for any connectivity changes (Requirement 9). The preconditions are:
   - At least one `uncertain` Available_Line exists.
   - The sequence contains no `judgement.result`.
   - No `mode.set` with `mode: "sleep"` arrives in [`t`, `t` + Offline_Bound_Silent].
   - No interval longer than `T` after `t` passes without a Tick.
8. FOR ALL Event sequences, any number of `pir.rising` and `pir.falling` Events during one Encounter SHALL produce at most one `reaction.performed` and at most one `presence.detected` for that Encounter. Every `presence.detected` SHALL be emitted in the `step()` call of a `pir.rising` that arrived in `sleeping`, with Mode `guard`, at least `pir_warmup_s` after the Start_Time. The `now` values of consecutive `presence.detected` events SHALL be at least `cooldown_s` apart. (Debounce; Requirement 11.)
9. FOR ALL Action sequences sent to the Servo_Adapter with `motion_enabled` false, the fake SHALL record zero PWM starts and zero servo output devices (Requirement 15).
10. FOR ALL Event sequences run through the Dispatcher with the fake adapters and the Fake_Cloud_Link, the following SHALL hold (privacy; Requirement 13):
    - The sequences contain `speak` commands whose `ja`, `en`, `audioUrl` query string and an extra undefined `data` field hold random marker strings. Each marker is at least 12 characters and starts with a prefix that occurs nowhere else in the test.
    - No published envelope and no captured log line contains a marker.
    - Every `PlayAudioUrl` is emitted while the Situation_Category is `family`.
    - Every `PlayLine` emitted while the Situation_Category is `stranger` or `uncertain` names a Voice_Line of that Category.
11. FOR ALL Machine_States, Events and values of `now`, two `step()` calls with equal arguments SHALL return equal results (determinism; Requirement 1).
12. FOR ALL face boxes (including values outside 0..1) and finite snapshot angles, with `p` and `q` being the snapshot's `panDeg` and `tiltDeg` Clamped to the Calibrated_Range, the Head_Tracker result SHALL satisfy the following (Requirement 5):
    - It lies inside the Calibrated_Range.
    - It equals (`p`, `q`) when the computed center (`cx`, `cy`) is (0.5, 0.5).
    - Its pan is ≥ `p` when `cx` > 0.5 and ≤ `p` when `cx` < 0.5.
    - Its tilt is ≥ `q` when `cy` < 0.5 and ≤ `q` when `cy` > 0.5.
13. FOR ALL Config values, the Config_Loader SHALL accept a Config exactly when every rule of Requirement 25 holds, and every rejection message SHALL name each violating key (Requirement 25).
14. FOR ALL Voice_Line texts and fields, the Manifest_Loader SHALL reject a line exactly when at least one rule of Requirement 26 criteria 3, 4 and 9 or Requirement 13 criterion 1 is broken. FOR ALL message id sequences, the Deduplicator SHALL drop exactly the repeats within the last `dedup_window_size` accepted ids and hold at most `dedup_window_size` ids. (Requirements 13, 22, 26.)
15. FOR ALL sequences of `TakeSnapshot` Actions at least `camera_timeout_s` apart sent to the Camera_Adapter fake with scripted successes and failures, every `TakeSnapshot` SHALL yield exactly one `snapshot.ready` or `snapshot.failed` with its Snapshot_Id. FOR ALL sequences of `PlayLine` and `PlayAudioUrl` Actions sent to the Audio_Adapter fake with scripted successes, failures and interruptions, every Play_Id SHALL yield exactly one `audio.finished` or `audio.failed` with that Play_Id. Both are counted after all fake workers have finished (exactly one result; Requirements 18, 19).
