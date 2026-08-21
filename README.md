# kromosynth-composing

A standalone live-coding companion for **Synth.is**: browse evolved sounds, load them as
samples into a live-coding environment (**Strudel** first), and save your compositions to
your Synth.is account so you can recall them later.

**Licence: AGPL-3.0-or-later. This repository is the corresponding source** for the
instance running at [composing.synth.is](https://composing.synth.is). The app embeds
[Strudel](https://strudel.cc), which is also AGPL-3.0-or-later. Full notice at the bottom.

An exploration, and a companion to the main Synth.is app rather than part of it: it runs
on its own origin and talks to the Synth.is backends over HTTP.

## Status

Working end to end with Strudel.

- Browse the **community pool** (no sign-in) or **your garden** (after sign-in), as cards
  with spectrograms, grouped by month or type.
- **Semantic search**: describe a sound in words (CLAP and other encoders), or find more
  like any sound.
- Audition previews, add sounds to a **kit** (each becomes a Strudel `s("name")`).
- Write and run patterns in an embedded Strudel editor.
- **Per-sound render settings** (duration, pitch, velocity), rendered on demand when a
  preview is not enough.
- **Learning surfaces**: a Concepts palette, select-and-transform quick actions, and
  "explain this", all generated from `src/lib/concepts.js`.
- **Ask AI** to change the code, using your own endpoint (LM Studio, any OpenAI-compatible
  server, or Anthropic). Nothing is shared or baked in. See `docs/AI_EDIT_PLAN.md`.
- **Composition-as-trajectory**: every Play is snapshotted, and steps can be replayed or
  pruned. Saved inside the composition.
- **Save, Save As, Open** compositions on your Synth.is account (sign-in required only to
  save), with shareable `?seq=` links.
- **Bounce to WAV**, rendered offline (faster than realtime) over a chosen cycle range.
- **Ableton Live**: when opened inside the Synth.is Live extension, send the kit as stems
  or send a bounce as a single clip. See `docs/ABLETON_BRIDGE.md`.

Csound (WASM) and WebChucK are planned as sibling "environments" over the same kit and the
same persistence.

## Run

```bash
cd kromosynth-composing
npm install
npm run dev          # http://localhost:5273
```

By default it targets a local Synth.is stack:

- `kromosynth-recommend` at `http://localhost:3004` (sound listings, previews, sequences)
- `kromosynth-auth` at `http://127.0.0.1:3002` (login)
- `kromosynth-render` over WebSocket (on-demand genome rendering)

Override via a git-ignored `.env` (see `.env.example`). `npm start` runs the same app
against the deployed backends.

> Community browsing, composing, and playback need **no sign-in**. Sign-in is only used for
> the garden and for saving.

## How it works

- **Sounds to samples.** Each kit entry resolves to an audio URL: the sound's pre-rendered
  preview when it has one, otherwise a genome rendered on demand. The app builds a
  `name -> URL` map client-side and registers it with Strudel via an `await samples({...})`
  prelude prepended at play time. See `docs/SAMPLE_MAP_MANIFEST.md`.
- **Save and recall.** Compositions are stored through the existing
  `POST/GET/PATCH/DELETE /api/user/sequences` API in `kromosynth-recommend`, authed with the
  platform JWT. The code, kit, and trajectory live in the opaque `unitState`; referenced
  sounds go in `soundIds`. They are tagged `unitType: "COMPOSITION"` (engine-agnostic; the
  specific engine is recorded in `unitConfig.environment`).
- **Bounce.** Non-realtime rendering through an `OfflineAudioContext`, returning WAV bytes.
  `renderOffline` is an optional capability on the environment interface, so other engines
  can supply their own. See the notes in `src/lib/offlineRender.js`.

## Project layout

```
src/
  lib/api.js               backends: config, auth, sound listings, search, sequences
  lib/concepts.js          concept library behind the palette, transforms, and explanations
  lib/environments.js      per-language interface (docs, hints, starters, offline render)
  lib/offlineRender.js     offline bounce to WAV
  lib/llm.js               bring-your-own-endpoint AI editing
  lib/ableton.js           payloads for the Ableton Live extension
  components/StrudelPad.jsx  <strudel-editor> wrapper, kit-aware play/stop, selection API
  App.jsx                  UI: browser, kit, trajectory, learning surfaces, save/open
docs/
  ABLETON_BRIDGE.md        stems and bounce paths into Live
  AI_EDIT_PLAN.md          AI editing design, providers, and how the reference stays current
  SAMPLE_MAP_MANIFEST.md   manifest format and rollout plan
```

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
