# kromosynth-composing

A standalone live-coding companion for **Synth.is**: browse evolved sounds, load them as
samples into a live-coding environment (**Strudel** first), and save your compositions to
your Synth.is account so you can recall them later.

This is a **personal-exploration** project: monetisation and quota concerns are deliberately
set aside. It runs on its own origin and talks to the Synth.is backends over HTTP, which
keeps its AGPL obligation — inherited from embedding Strudel — cleanly isolated from the
platform's own frontend.

Its one build-time dependency on the rest of the project is the sibling **`kromosynth`**
package (`file:../kromosynth`), used to render sounds in the browser instead of on the
render server. That package is itself AGPL-3.0-or-later, so it carries no obligation this
app doesn't already have. It is lazily imported — a session that never renders locally
never loads it.

An exploration, and a companion to the main Synth.is app rather than part of it: it runs
on its own origin and talks to the Synth.is backends over HTTP.

This repository is the source for the instance at
[composing.synth.is](https://composing.synth.is).

## Status

Working end to end with Strudel.

- Browse the **community pool** (no sign-in) or **your garden** (after sign-in), as cards
  with spectrograms, grouped by month or type.
- **Semantic search**: describe a sound in words (CLAP and other encoders), or find more
  like any sound.
- Audition previews, add sounds to a **kit** (each becomes a Strudel `s("name")`).
- Write/run patterns in an embedded Strudel editor.
- **Per-sound render settings** (duration, pitch, velocity), rendered on demand when a
  preview is not enough. Render mode can be chosen in the header, with server and browser
  options where available. See “Render modes” in `docs/RUNNING.md`.
- **Learning surfaces**: a Concepts palette, select-and-transform quick actions, and
  "explain this", all generated from `src/lib/concepts.js`.
- **Ask AI** to change the code, using your own endpoint (LM Studio, any OpenAI-compatible
  server, or Anthropic). Nothing is shared or baked in. See `docs/AI_EDIT_PLAN.md`.
- **Composition-as-trajectory**: every Play is snapshotted; a scrubber replays the
-  evolution of the piece. Saved inside the composition.
- **Save, Save As, Open** compositions on your Synth.is account (sign-in required only to
  save), with shareable `?seq=` links.
- **Bounce to WAV**, rendered offline (faster than realtime) over a chosen cycle range.
- **Ableton Live**: when opened inside the Synth.is Live extension, send the kit as stems
  or send a bounce as a single clip. See `docs/ABLETON_BRIDGE.md`.
- **→ Live (stems)** when opened inside the Ableton extension: sends the kit as
  `SelectionItem`s (with settings) into Live. See `docs/ABLETON_BRIDGE.md`.

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

If your recommend service runs on a different port (the repo has both `3004` and `3060`
in places), set `VITE_RECOMMEND_SERVICE_URL` to match the instance you're actually running.

> Community browsing, composing, and playback need **no sign-in**. Sign-in is only used for
> the garden and for saving.

## How it works

- **Sounds → samples.** Each kit entry resolves to an audio URL: the sound's pre-rendered
  preview when it has one, otherwise a genome rendered on demand. The app builds a
  `name -> URL` map client-side and registers it with Strudel via an `await samples({...})`
  prelude prepended at play time. See `docs/SAMPLE_MAP_MANIFEST.md`.
- **Save / recall.** Compositions are stored through the existing
  `POST/GET/PATCH/DELETE /api/user/sequences` API in `kromosynth-recommend`, authed with the
  platform JWT. The code, kit, and trajectory live in the opaque `unitState`; referenced
  sounds go in `soundIds`. They are tagged `unitType: "COMPOSITION"` (engine-agnostic; the
  specific engine is recorded in `unitConfig.environment`).
- **Bounce.** Non-realtime rendering through an `OfflineAudioContext`, returning WAV bytes.
  `renderOffline` is an optional capability on the environment interface, so other engines
  can supply their own. See the notes in `src/lib/offlineRender.js`.

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

Licensed under the GNU Affero General Public License, version 3 or later. See
[`LICENSE`](LICENSE), or <https://www.gnu.org/licenses/>.

Embeds [Strudel](https://strudel.cc) (`@strudel/repl`, `@strudel/webaudio`),
AGPL-3.0-or-later.
