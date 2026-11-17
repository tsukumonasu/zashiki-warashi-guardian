---
inclusion: fileMatch
fileMatchPattern: "dashboard/**"
---

# Dashboard conventions

## Who uses it
1. **Reviewers and visitors** with no hardware and no account. They reach a moving, speaking
   virtual doll within two clicks.
2. **Signed-in reviewers** (demo account). Read-only: the simulation against the live cloud
   and a redacted timeline in which illustrations replace real snapshots. They cannot control
   the real doll or manage faces.
3. **The family.** Timeline of real encounters, doll status, manual controls, face registration.

## Simulation mode — the heart of the app
- A virtual doll in a traditional Japanese style, drawn as our own SVG/CSS artwork. Head pan, head tilt, eyes and
  lantern glow animate independently.
- It is driven by a **pure reducer over the same messages as the real doll**
  (`docs/schema.md`). Scenario scripts emit the events and commands the real system would produce.
- It mirrors the real constraints: same angle limits, same slow motion, same state names.
- The default scenarios run entirely in the browser with bundled sample responses: zero
  cost, and they keep working offline. Signed-in users can switch to "live cloud", which runs
  the same scenarios through the real backend.
- Every spoken line shows the Japanese text and an English subtitle. Audio starts only after
  a user gesture, and a mute control is always visible.

## Look and feel
- Japanese folk horror, quiet rather than loud: washi-paper texture, sumi-ink headings, deep
  indigo night, the warm glow of an andon lantern, slow fades, long pauses. Spooky but
  friendly — no gore and no jump scares.
- English UI copy with Japanese accents, for example a title in kanji with its reading and
  translation.
- Motion is slow by design. Honour `prefers-reduced-motion`.
- Accessible: keyboard operable, visible focus, WCAG AA contrast for text, captions for all audio.
- Responsive from phone to desktop; reviewers will probably open it on a laptop first.
- Only original or properly licensed assets: fonts under the OFL, our own illustrations and
  recordings. No third-party trademarks, characters or copyrighted music.

## Engineering
- React + Vite + TypeScript, function components and hooks, no heavy state library unless
  it is clearly needed.
- The core of `src/simulation/` is plain TypeScript with no React imports. It is covered by
  property-based tests (fast-check) and scenario tests.
- One typed API client module. The UI degrades clearly when the backend or the physical doll
  is offline ("the doll is asleep or out of reach").
- A persistent indicator shows whether the real doll's camera or microphone is active.
