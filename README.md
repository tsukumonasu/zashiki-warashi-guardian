# Zashiki-Warashi Guardian

> A traditional Japanese doll that wakes when someone approaches, lights its lantern,
> slowly turns to look at them, greets family members, and unsettles strangers —
> then notifies the family.

<!-- photo or GIF of the doll here -->

**[Live dashboard →](#)** <!-- replace with the deployed URL before submission -->

---

## Try it now (no hardware, no account needed)

> Not deployed yet. The dashboard and its simulation mode are built by the
> `dashboard-simulation` spec; this section will list the exact steps.

1. Open the dashboard URL above.
2. Click **Simulation mode**.
3. Follow the on-screen prompts. The full encounter flow runs in your browser.

## Development

```
make setup   # creates device/.venv (Python 3.13) with pytest, Hypothesis and ruff
make test
make lint
```

---

## What it is

A Kiroween 2026 entry in the **Frankenstein** category: a traditional craft doll ×
Raspberry Pi Zero W × generative AI, united by a single message contract.

The system has three parts that share one schema (`docs/schema.md`):

| Part | Description |
|---|---|
| `device/` | Python agent on a Raspberry Pi Zero W inside the doll's stand |
| `cloud/` | AWS serverless — face recognition, voice, event log, notifications |
| `dashboard/` | React web app with a simulation mode reviewers can run in-browser |

---

## Architecture

<!-- architecture diagram here (docs/architecture.md) -->

---

## How Kiro was used

See [`docs/kiro-usage.md`](docs/kiro-usage.md) and [`.kiro/`](.kiro/) for steering files,
specs, and hooks.

---

## Build it yourself

Full instructions — parts list, wiring diagram, device setup, `cdk deploy`, teardown, and
estimated costs — will be added here before submission.

See [`device/tools/README.md`](device/tools/README.md) for bring-up and hardware check scripts.

---

## Privacy and safety

- Snapshots are stored only in the owner's AWS account and expire within 7 days.
- Face registrations require explicit consent and can be deleted at any time.
- Family names are never spoken or shown to a stranger.
- The dashboard always indicates whether the doll's camera or microphone is active.
- Reviewer demo accounts are read-only: no real snapshots, no doll commands, no face management.

---

## License

MIT — see [LICENSE](LICENSE).  
Third-party notices: [`docs/third-party.md`](docs/third-party.md).
