# kromosynth-composing

A standalone live-coding companion for **Synth.is**: browse evolved sounds, load them as
samples into a livecoding environment (**Strudel** first), and save your compositions to
your Synth.is account so you can recall them later — the same save/recall behaviour as the
live-coding unit in the Biomes view, but in its own app.

This is a **personal-exploration** project: monetisation and quota concerns are deliberately
set aside. It runs on its own origin and talks to the Synth.is backends only over HTTP
(no build-time link to the closed platform), which is also what keeps its AGPL obligation —
inherited from embedding Strudel — cleanly isolated.

## Status

**First slice — Strudel, working end to end, no backend changes required.**

- Browse the **community pool** (no sign-in) or **your garden** (after sign-in).
- Audition previews, add sounds to a **kit** (each becomes a Strudel `s("name")`).
- Write/run patterns in an embedded Strudel editor.
- **Per-sound render settings** (duration / pitch / velocity) via the parameterised
  `/evorenders` URL — custom renders are just another sample URL.
- **Composition-as-trajectory**: every Play is snapshotted; a scrubber replays the
  evolution of the piece. Saved inside the composition.
- **Save / Open** compositions on your Synth.is account (sign-in required only to save).
- **→ Live (stems)** when opened inside the Ableton extension: sends the kit as
  `SelectionItem`s (with settings) into Live. See `docs/ABLETON_BRIDGE.md`.

Csound (WASM) and WebChucK are planned as sibling "environments" over the same kit and the
same persistence — see *Next* below.

## Run

```bash
cd kromosynth-composing
npm install
npm run dev          # http://localhost:5273
```

By default it targets a local Synth.is stack:

- `kromosynth-recommend` at `http://localhost:3004` (sound listings, preview WAVs, sequences)
- `kromosynth-auth` at `http://127.0.0.1:3002` (login)

Override via a git-ignored `.env` (see `.env.example`). If your recommend service runs on a
different port (the repo has both `3004` and `3060` in places), set
`VITE_RECOMMEND_SERVICE_URL` to match the instance you're actually running.

> Community browsing, composing, and playback need **no sign-in**. Sign-in is only used for
> the garden and for saving.

## How it works

- **Sounds → samples.** Each sound is addressed by its existing public, CORS-open, immutable
  preview WAV (`/api/audio-previews/file/<id>.wav`). The app builds a `name → URL` map
  client-side and registers it with Strudel via an `await samples({...})` prelude prepended
  at play time. No sample-map endpoint is needed yet. See `docs/SAMPLE_MAP_MANIFEST.md`.
- **Save/recall.** Compositions are stored through the existing
  `POST/GET/PATCH/DELETE /api/user/sequences` API (kromosynth-recommend), authed with the
  same PocketBase JWT the platform uses. The Strudel code + kit live in the opaque
  `unitState`; referenced sounds go in `soundIds`. They're tagged `unitType: "STRUDEL_STANDALONE"`
  so they live in the same account without colliding with Biomes' tree-bound sequences.

## Project layout

```
src/
  lib/api.js              backends: config, auth, sound listings, sequences, sample naming
  components/StrudelPad.jsx  <strudel-editor> wrapper + kit-aware play/stop
  App.jsx                 UI: source toggle, sound browser, kit, save/open, login
docs/SAMPLE_MAP_MANIFEST.md  manifest format + rollout plan
```

## Next / to verify on first run

1. **Verify `/evorenders` CORS + coverage.** Custom render settings point Strudel at
   `<evoruns>/evorenders/<evoRunId>/<soundId>/<d>/<p>/<v>`. Confirm that endpoint sends
   permissive CORS (Strudel fetches it) and that community/adopted sounds carry an
   evorun id. Where they don't, the app falls back to the preview render (flagged in the
   settings panel) — the general fallback is a genome-render (server WS / in-browser),
   not yet wired.
2. **Save = versioned snapshots today.** The backend PATCH only updates metadata, so each
   Save writes a new row (which pairs naturally with the trajectory idea). If you want
   in-place overwrite instead, add a state-updating PATCH to recommend.
3. **Ableton — Option B (bounce).** Option A (stems) is wired app-side; the bounce needs a
   tiny extension addition + a Strudel→WAV capture. See `docs/ABLETON_BRIDGE.md`.
4. **More environments** — add Csound (`@csound/browser`) and WebChucK as tabs beside
   Strudel, each consuming the same kit (`name → URL`) and the same sequences store with a
   different `unitState.environment`. `ChuckEditor` is already a stub in the main app.
5. **Curated public packs** — the optional `GET /api/samplemap/*` endpoint for stable,
   shareable, versioned packs (deferred until there's a reason).

## Licence

Copyright (C) 2026  Björn Þór Jónsson

This program is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along with
this program.  If not, see <https://www.gnu.org/licenses/>.

Embeds [Strudel](https://strudel.cc) (`@strudel/repl`, `@strudel/webaudio`),
AGPL-3.0-or-later.
