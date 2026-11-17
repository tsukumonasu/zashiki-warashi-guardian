---
inclusion: manual
---

# Kiroween 2026 submission checklist

Load this file (`/kiroween-submission`) when preparing the README, the demo video script or
the Devpost texts, and when updating `docs/kiro-usage.md`.

## Facts from the official rules (re-check before submitting)
- Deadline **2026-12-04 14:00 PT** (2026-12-05 07:00 JST). No extensions, no edits afterwards.
- One category: **Frankenstein**.
- The entry is "a working software application using Kiro".
- Public **GitHub** repository with all source, assets and instructions; an open-source
  license file that GitHub shows in the repository's About section; **`/.kiro` at the root
  and not in `.gitignore`**.
- A URL to the working application plus test instructions. Reviewer login details go into the
  private field of the Devpost form, never into the repository.
- Demo video: **under 3 minutes**, public on YouTube, showing the project functioning on the
  device it was built for; no third-party trademarks or copyrighted music.
- All materials in English. The doll speaks Japanese, so the video carries English subtitles.
- The application stays available, free of charge, until judging ends
  (**2027-01-29 13:00 PT**). The organizers may ask for access to hardware-dependent projects,
  so the README explains how to test everything without the doll.
- New work only (created after 2026-10-30). Frameworks, libraries and starter templates are
  fine; any other adapted code or assets must be disclosed — keep `docs/third-party.md` current.

## Judging (20 % each)
Potential Impact · Technological Implementation (depth of Kiro usage) · Design ·
Innovation / Idea · Presentation.

## README contents
1. One-paragraph pitch, a photo or GIF of the doll, the link to the live dashboard.
2. **Reviewer quick start:** open the URL → Simulation mode → what to click and what you
   should see. No hardware and no account needed.
3. Architecture diagram and the message contract on one screen.
4. How Kiro was used (short), with links into `.kiro/` and `docs/kiro-usage.md`.
5. Build it yourself: parts list, wiring diagram, device setup, `cdk deploy`, teardown, costs.
6. Privacy and safety notes, license, third-party notices.

## "How we used Kiro" write-up — answer with evidence from this repository
- **Specs:** how each spec was structured (Requirements-First or Design-First), what the
  review steps caught, how it compared with vibe coding for the scaffold.
- **Steering:** which files, which inclusion modes and why; the single most effective rule.
- **Hooks:** what each one automated and what it prevented.
- **MCP:** what the AWS documentation server made possible (limits verified, wrong
  assumptions caught).
- **Property-based testing:** which requirements became properties, and any counterexample found.
- **Anything else** (powers, custom agents, CLI / Web) — only if it was really used.

Use concrete numbers and links to files or commits. Do not invent results.

## Demo video outline (about 2:50)
0:00 hook — dark room, the doll slowly turns to the camera · 0:20 what it is and why (the
folklore in one line) · 0:40 a family member comes home · 1:05 a stranger at night and the
phone notification · 1:30 the dashboard simulation reviewers can try · 1:55 the architecture
in one picture · 2:10 how Kiro built it (spec → properties → hooks; one real incident that
became a steering rule) · 2:40 close.

## `docs/kiro-usage.md` journal format
`YYYY-MM-DD | spec or vibe | what Kiro produced | what the human changed or rejected | evidence (file or commit)`
