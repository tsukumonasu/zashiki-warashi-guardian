---
inclusion: always
---

# Product: Zashiki-Warashi Guardian

## What it is
A doll in a traditional Japanese style that becomes a *zashiki-warashi* — the child spirit of
Japanese folklore that protects a house and brings it good fortune. The doll wakes when
someone approaches, lights its lantern, slowly turns its head to look at them, greets family
members, and unsettles strangers while notifying the family.

It is a working software application in three parts that share one message contract:
1. **warashi-agent** (`/device`) — Python program on a Raspberry Pi Zero W inside the doll's stand.
2. **Cloud backend** (`/cloud`) — AWS serverless: recognition, voice, event log, notifications.
3. **Dashboard** (`/dashboard`) — web app with a **simulation mode**: a virtual doll that runs
   the same flow in the browser.

## Why the dashboard matters most to reviewers
This is a hackathon entry (Kiroween 2026, category **Frankenstein**: traditional doll ×
Raspberry Pi × generative AI). Reviewers cannot touch the physical doll, so the dashboard URL
is "the application" they test. Anyone must be able to experience the full flow there in
under two minutes, without hardware and without an account. Submission deadline:
2026-12-04 14:00 PT, no extensions. The stack must stay online and free to use until judging
ends (2027-01-29 13:00 PT).

## Core loop
1. **Sleep** — lantern off, servos relaxed, waiting for presence.
2. **Presence** — the PIR sensor fires → the lantern fades in.
3. **Seek and gaze** — snapshot → the cloud says where the person is → the head turns slowly
   to face them (slow is part of the character).
4. **Verdict** — family / stranger / no face / uncertain.
5. **React**
   - Family: warm greeting in Japanese, small nod. (P1: a short voice conversation.)
   - Stranger: silent stare, an eerie whisper or a traditional nursery rhyme, and a
     notification to the family.
   - No face / uncertain / offline: a cautious "is someone there?" line. It never hangs.
6. **Record** — the encounter appears on the dashboard timeline.
7. **Cooldown → Sleep.**

## Priorities
- **P0 (must ship):** device core loop with cached voice lines that also works offline; cloud
  verdict and event log; dashboard timeline and simulation mode; English README and demo video.
- **P1:** live voice conversation with family (Amazon Nova Sonic); stranger notification;
  family face registration in the dashboard; manual "call the doll" controls.
- **P2:** wake on sound; conversation tools that move the head or lantern; extra polish.

When time is short, cut P2, then P1. Never trade P0 reliability for a new feature.

## Non-goals
- No continuous video or audio recording and no video streaming to the cloud.
- No machine learning on the Pi Zero W itself (too slow) — recognition and speech run in the cloud.
- No real security-system claims: this is a guardian art piece, not an alarm product.

## Tone and safety
Spooky but family-friendly: an unsettling atmosphere, never threats, gore or cruelty.
The doll speaks Japanese; every spoken line has an English subtitle.

## Privacy principles
- Snapshots live only in the owner's AWS account and expire within days.
- Faces are registered only by family members themselves, with a consent notice, and can be deleted.
- Family names or labels are never spoken or shown to a stranger.
- The dashboard always shows whether the doll's camera or microphone is active.
- Reviewer demo accounts are read-only guests in someone's home: they can run the simulation
  against the live cloud, but they never see real snapshots (illustrations replace them),
  cannot make the real doll move or speak, and cannot change face registrations.
